import { describe, it, expect } from 'vitest'
import {
  MAX_RESUME_ATTEMPTS,
  THINKING_WATCHDOG_MS,
  createInitialSessionState,
  reduceSessionMachine,
  type InputMode,
  type SessionEffect,
  type SessionEvent,
  type SessionMachineState,
} from '../agent/sessionMachine'
import { sanitizeAgentProse, stripDiagnosisBlocks } from '../agent/streamSanitizer'
import { getFixture } from '../data/fixture'

function step(
  state: SessionMachineState,
  ...events: SessionEvent[]
): { state: SessionMachineState; effects: SessionEffect[] } {
  let cur = state
  const allEffects: SessionEffect[] = []
  for (const ev of events) {
    const res = reduceSessionMachine(cur, ev)
    cur = res.state
    allEffects.push(...res.effects)
  }
  return { state: cur, effects: allEffects }
}

function connectedReadyState(
  sessionId = 'sess-1',
  inputMode: InputMode = 'ptt',
): SessionMachineState {
  const init = createInitialSessionState('chloe', inputMode)
  const c = step(
    init,
    { type: 'CONNECT_REQUESTED' },
    { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'ready', sessionId } },
  )
  return c.state
}

describe('sessionMachine.ts: transition invariants, voice floor, continuous mode, and GoAway', () => {
  it('Row 1: PTT_PRESS during agentSpeaking flushes player, bumps playbackEpoch, marks interrupted, and ignores stale audio/drain', () => {
    const ready = connectedReadyState()
    const speaking = step(
      ready,
      {
        type: 'SERVER_MESSAGE',
        epoch: 1,
        msg: { type: 'text', text: '<warm> In November you spent £2,018.64.', partial: true },
      },
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'audio', data: 'AAAA' } },
    ).state

    expect(speaking.phase).toBe('agentSpeaking')
    expect(speaking.turns[0]?.hadAudio).toBe(true)
    const oldPlaybackEpoch = speaking.playbackEpoch

    const barged = reduceSessionMachine(speaking, { type: 'PTT_PRESS' })
    expect(barged.state.phase).toBe('capturing')
    expect(barged.state.playbackEpoch).toBe(oldPlaybackEpoch + 1)
    expect(barged.state.userHasFloor).toBe(true)
    expect(barged.state.turns[0]?.interrupted).toBe(true)
    expect(barged.effects).toContainEqual({ type: 'FLUSH_PLAYER' })
    expect(barged.effects).toContainEqual({ type: 'START_MIC_CAPTURE' })

    const staleDrain = reduceSessionMachine(barged.state, {
      type: 'PLAYER_DRAINED',
      playbackEpoch: oldPlaybackEpoch,
    })
    expect(staleDrain.state.phase).toBe('capturing')

    const residualAudio = reduceSessionMachine(barged.state, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'audio', data: 'AAAA' },
    })
    expect(residualAudio.state.phase).toBe('capturing')
    expect(residualAudio.effects.some((e) => e.type === 'ENQUEUE_AUDIO')).toBe(false)
  })

  it('P1-9: PTT_RELEASE before MIC_CAPTURE_ACTIVE (e.g. getUserMedia permission prompt blur) returns cleanly to ready without freezing in thinking', () => {
    const ready = connectedReadyState()
    const releasedBeforeCapture = step(ready, { type: 'PTT_PRESS' }, { type: 'PTT_RELEASE' })
    expect(releasedBeforeCapture.state.phase).toBe('ready')
    expect(releasedBeforeCapture.state.hasCapturedAudioInTurn).toBe(false)
    expect(releasedBeforeCapture.effects).toContainEqual({ type: 'STOP_MIC_CAPTURE' })
    expect(
      releasedBeforeCapture.effects.some((e) => e.type === 'START_THINKING_WATCHDOG'),
    ).toBe(false)
    expect(
      releasedBeforeCapture.effects.some((e) => e.type === 'FLUSH_MIC_AND_SEND_SILENCE'),
    ).toBe(false)

    // MIC_DEVICE_ENDED (unplugged headset) also returns cleanly to ready.
    const unplugged = step(
      ready,
      { type: 'PTT_PRESS' },
      { type: 'MIC_CAPTURE_ACTIVE' },
      { type: 'MIC_DEVICE_ENDED' },
    )
    expect(unplugged.state.phase).toBe('ready')
    expect(unplugged.state.micActive).toBe(false)
    expect(unplugged.effects).toContainEqual({ type: 'STOP_MIC_CAPTURE' })
  })

  it('PTT_PRESS during thinking grants userHasFloor and bumps playbackEpoch so late audio never mutes speech', () => {
    const ready = connectedReadyState()
    const thinking = step(
      ready,
      { type: 'PTT_PRESS' },
      { type: 'MIC_CAPTURE_ACTIVE' },
      { type: 'PTT_RELEASE' },
    ).state
    expect(thinking.phase).toBe('thinking')

    const heldDuringThinking = step(
      thinking,
      { type: 'PTT_PRESS' },
      { type: 'MIC_CAPTURE_ACTIVE' },
    ).state
    expect(heldDuringThinking.phase).toBe('capturing')
    expect(heldDuringThinking.userHasFloor).toBe(true)
    expect(heldDuringThinking.playbackEpoch).toBe(thinking.playbackEpoch + 1)

    // Arriving audio chunk from prior turn is dropped while user holds floor.
    const lateAudio = reduceSessionMachine(heldDuringThinking, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'audio', data: 'AAAA' },
    })
    expect(lateAudio.state.phase).toBe('capturing')
    expect(lateAudio.effects.some((e) => e.type === 'ENQUEUE_AUDIO')).toBe(false)

    // Releasing sends the new utterance and allows subsequent agent audio to play.
    const released = reduceSessionMachine(lateAudio.state, { type: 'PTT_RELEASE' })
    expect(released.state.phase).toBe('thinking')
    expect(released.state.userHasFloor).toBe(false)
  })

  it('continuous mode (?ptt=0) returns cleanly to capturing + UNMUTE_MIC after PLAYER_DRAINED and stops on STOP_MIC_ONLY', () => {
    const ready = connectedReadyState('sess-cont', 'continuous')
    const listening = reduceSessionMachine(ready, { type: 'PTT_PRESS' })
    expect(listening.state.phase).toBe('capturing')
    expect(listening.state.micActive).toBe(true)

    const afterReply = step(
      listening.state,
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'audio', data: 'AAAA' } },
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'turn_complete', turnIndex: 1 } },
    ).state
    expect(afterReply.phase).toBe('agentSpeaking')

    const drained = reduceSessionMachine(afterReply, {
      type: 'PLAYER_DRAINED',
      playbackEpoch: afterReply.playbackEpoch,
    })
    expect(drained.state.phase).toBe('capturing')
    expect(drained.state.micActive).toBe(true)
    expect(drained.effects).toContainEqual({ type: 'UNMUTE_MIC' })

    // Clicking the Listening pill dispatches STOP_MIC_ONLY -> ready + STOP_MIC_CAPTURE.
    const stopped = reduceSessionMachine(drained.state, { type: 'STOP_MIC_ONLY' })
    expect(stopped.state.phase).toBe('ready')
    expect(stopped.state.micActive).toBe(false)
    expect(stopped.effects).toContainEqual({ type: 'STOP_MIC_CAPTURE' })
  })

  it('Row 2: turn_complete waits for PLAYER_DRAINED when audio is still playing (and handles reverse order)', () => {
    const ready = connectedReadyState()
    const afterTurnComplete = step(
      ready,
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'audio', data: 'AAAA' } },
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'turn_complete', turnIndex: 1 } },
    ).state

    expect(afterTurnComplete.phase).toBe('agentSpeaking')
    expect(afterTurnComplete.turnCompletedWhileSpeaking).toBe(true)

    const drained = reduceSessionMachine(afterTurnComplete, {
      type: 'PLAYER_DRAINED',
      playbackEpoch: afterTurnComplete.playbackEpoch,
    })
    expect(drained.state.phase).toBe('ready')
    expect(drained.state.playerActive).toBe(false)

    const drainFirst = step(
      ready,
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'audio', data: 'AAAA' } },
      { type: 'PLAYER_DRAINED', playbackEpoch: ready.playbackEpoch },
    ).state
    expect(drainFirst.phase).toBe('agentSpeaking')
    const completedAfter = reduceSessionMachine(drainFirst, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'turn_complete', turnIndex: 1 },
    })
    expect(completedAfter.state.phase).toBe('ready')
  })

  it('Row 3: zero-audio turn_complete, mid-turn ServerError, and 15,000ms THINKING_WATCHDOG_FIRED recover thinking -> ready', () => {
    expect(THINKING_WATCHDOG_MS).toBe(15_000)
    const ready = connectedReadyState()
    const released = step(
      ready,
      { type: 'PTT_PRESS' },
      { type: 'MIC_CAPTURE_ACTIVE' },
      { type: 'PTT_RELEASE' },
    )
    expect(released.state.phase).toBe('thinking')
    expect(released.effects).toContainEqual({ type: 'FLUSH_MIC_AND_SEND_SILENCE' })
    expect(released.effects).toContainEqual({
      type: 'START_THINKING_WATCHDOG',
      epoch: 1,
      timeoutMs: 15_000,
    })

    const completed = reduceSessionMachine(released.state, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'turn_complete' },
    })
    expect(completed.state.phase).toBe('ready')

    const midTurnValidationErr = reduceSessionMachine(released.state, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'error', message: 'text frame too large', field: 'text' },
    })
    expect(midTurnValidationErr.state.phase).toBe('ready')
    expect(midTurnValidationErr.state.sessionId).toBe('sess-1')
    expect(midTurnValidationErr.effects).toContainEqual({ type: 'CLEAR_THINKING_WATCHDOG' })

    const wrongEpoch = reduceSessionMachine(released.state, {
      type: 'THINKING_WATCHDOG_FIRED',
      epoch: 999,
    })
    expect(wrongEpoch.state.phase).toBe('thinking')

    const watchdogFired = reduceSessionMachine(released.state, {
      type: 'THINKING_WATCHDOG_FIRED',
      epoch: 1,
    })
    expect(watchdogFired.state.phase).toBe('ready')
  })

  it('Row 4: end waits for farewell audio drain, and PTT_PRESS during drainingFarewell flushes and opens a fresh session', () => {
    const ready = connectedReadyState('sess-farewell')
    const draining = step(
      ready,
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'audio', data: 'AAAA' } },
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'end' } },
    )
    expect(draining.state.phase).toBe('drainingFarewell')
    expect(draining.effects.some((e) => e.type === 'CLOSE_WS')).toBe(false)

    const finished = reduceSessionMachine(draining.state, {
      type: 'PLAYER_DRAINED',
      playbackEpoch: draining.state.playbackEpoch,
    })
    expect(finished.state.phase).toBe('ended')
    expect(finished.state.sessionId).toBeNull()
    expect(finished.effects).toContainEqual({ type: 'CLOSE_WS' })

    const interruptedDrain = reduceSessionMachine(draining.state, { type: 'PTT_PRESS' })
    expect(interruptedDrain.state.phase).toBe('connecting')
    expect(interruptedDrain.effects).toContainEqual({ type: 'FLUSH_PLAYER' })
    expect(interruptedDrain.effects).toContainEqual({ type: 'CLOSE_WS' })
    expect(interruptedDrain.effects).toContainEqual({
      type: 'OPEN_WS',
      epoch: 2,
      persona: 'chloe',
      sessionId: null,
    })
  })

  it('Row 5: WS_CLOSED after end, drainingFarewell, or session_expired is normal, while transient WS_CLOSED in active phases resumes with backoff', () => {
    const ready = connectedReadyState('sess-transient')
    const endedImmediate = reduceSessionMachine(ready, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'end' },
    }).state
    expect(endedImmediate.phase).toBe('ended')

    const afterClose = reduceSessionMachine(endedImmediate, { type: 'WS_CLOSED', epoch: 1 })
    expect(afterClose.state.phase).toBe('ended')
    expect(afterClose.state.errorMessage).toBeNull()

    const paused = reduceSessionMachine(ready, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'session_expired', message: 'Session paused due to inactivity' },
    }).state
    expect(paused.phase).toBe('paused')
    const pausedClose = reduceSessionMachine(paused, { type: 'WS_CLOSED', epoch: 1 })
    expect(pausedClose.state.phase).toBe('paused')

    // Transient Wi-Fi / socket drop in ready sets resumeSessionId and schedules reconnect!
    const droppedReady = reduceSessionMachine(ready, { type: 'WS_CLOSED', epoch: 1 })
    expect(droppedReady.state.phase).toBe('connecting')
    expect(droppedReady.state.resumeSessionId).toBe('sess-transient')
    expect(droppedReady.state.resumeAttempts).toBe(1)
    expect(droppedReady.effects).toContainEqual({
      type: 'SCHEDULE_RECONNECT',
      epoch: 2,
      attempt: 1,
      baseDelayMs: 250,
    })
  })

  it('Row 6: go_away reconnects with same sessionId + lastUiSeq and caps WS_CLOSED retries with backoff', () => {
    const ready = connectedReadyState('sess-keep')
    const goAwayIdle = reduceSessionMachine(ready, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'go_away', sessionId: 'sess-keep' },
    })
    expect(goAwayIdle.state.phase).toBe('connecting')
    expect(goAwayIdle.effects).toContainEqual({
      type: 'OPEN_WS',
      epoch: 2,
      persona: 'chloe',
      sessionId: 'sess-keep',
    })

    // Repeated WS_CLOSED failures schedule 250ms, 500ms, 1000ms backoff then transition to error.
    let cur = goAwayIdle.state
    const expectedDelays = [250, 500, 1000]
    for (let i = 0; i < MAX_RESUME_ATTEMPTS; i++) {
      const closed = reduceSessionMachine(cur, {
        type: 'WS_CLOSED',
        epoch: cur.connectionEpoch,
      })
      expect(closed.state.phase).toBe('connecting')
      expect(closed.state.resumeAttempts).toBe(i + 1)
      expect(closed.effects).toContainEqual({
        type: 'SCHEDULE_RECONNECT',
        epoch: closed.state.connectionEpoch,
        attempt: i + 1,
        baseDelayMs: expectedDelays[i],
      })
      const timerFired = reduceSessionMachine(closed.state, {
        type: 'RECONNECT_TIMER_FIRED',
        epoch: closed.state.connectionEpoch,
      })
      expect(timerFired.effects).toContainEqual({
        type: 'OPEN_WS',
        epoch: closed.state.connectionEpoch,
        persona: 'chloe',
        sessionId: 'sess-keep',
      })
      cur = timerFired.state
    }
    const exhausted = reduceSessionMachine(cur, {
      type: 'WS_CLOSED',
      epoch: cur.connectionEpoch,
    })
    expect(exhausted.state.phase).toBe('error')
    expect(exhausted.state.resumeSessionId).toBeNull()

    // Deferred while speaking until PLAYER_DRAINED.
    const speaking = reduceSessionMachine(ready, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'audio', data: 'AAAA' },
    }).state
    const deferred = step(
      speaking,
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'go_away', sessionId: 'sess-keep' } },
      { type: 'WS_CLOSED', epoch: 1 },
    )
    expect(deferred.state.phase).toBe('agentSpeaking')
    expect(deferred.effects.some((e) => e.type === 'OPEN_WS')).toBe(false)

    const resumedAfterDrain = reduceSessionMachine(deferred.state, {
      type: 'PLAYER_DRAINED',
      playbackEpoch: deferred.state.playbackEpoch,
    })
    expect(resumedAfterDrain.state.phase).toBe('connecting')
    expect(resumedAfterDrain.effects).toContainEqual({
      type: 'OPEN_WS',
      epoch: 2,
      persona: 'chloe',
      sessionId: 'sess-keep',
    })
  })

  it('Row 7, 8, 9, 10, 11: connection epochs, StrictMode idempotency, MIC_DENIED retry, key-repeat, and PERSONA_SWITCH', () => {
    const ready = connectedReadyState('sess-chloe')
    const switched = reduceSessionMachine(ready, {
      type: 'PERSONA_SWITCH',
      persona: 'david',
    }).state
    expect(switched.connectionEpoch).toBe(2)
    expect(
      reduceSessionMachine(switched, {
        type: 'SERVER_MESSAGE',
        epoch: 1,
        msg: { type: 'error', message: 'stale' },
      }).state,
    ).toBe(switched)

    const init = createInitialSessionState('chloe')
    const first = reduceSessionMachine(init, { type: 'CONNECT_REQUESTED' })
    expect(reduceSessionMachine(first.state, { type: 'CONNECT_REQUESTED' }).effects).toEqual([])

    const denied = step(ready, { type: 'PTT_PRESS' }, { type: 'MIC_DENIED' })
    expect(denied.state.phase).toBe('error')
    expect(denied.state.micDenied).toBe(true)
    const retried = reduceSessionMachine(denied.state, { type: 'PTT_PRESS' })
    expect(retried.state.phase).toBe('capturing')
    expect(retried.effects).toEqual([{ type: 'START_MIC_CAPTURE' }])

    const capturing = reduceSessionMachine(ready, { type: 'PTT_PRESS' }).state
    expect(reduceSessionMachine(capturing, { type: 'PTT_PRESS' }).effects).toEqual([])
  })

  it('preserves seenUiSeqKey.maxSeq across GoAway ready on the SAME sessionId, and resets on new sessionId / PERSONA_SWITCH', () => {
    const ready = connectedReadyState('sess-a')
    const u1 = reduceSessionMachine(ready, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'ui_state', tier: 1, state: { seq: 2.9, page: 'spending' } },
    })
    expect(u1.effects).toContainEqual({
      type: 'APPLY_UI_STATE',
      state: { seq: 2, page: 'spending' },
      tier: 1,
    })

    const dup = reduceSessionMachine(u1.state, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'ui_state', tier: 3, state: { seq: 2, page: 'spending' } },
    })
    expect(dup.effects.some((e) => e.type === 'APPLY_UI_STATE')).toBe(false)

    // GoAway resume on identical 'sess-a' preserves maxSeq === 2 and passes lastUiSeq: 2!
    const goAway = reduceSessionMachine(u1.state, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'go_away', sessionId: 'sess-a' },
    })
    expect(goAway.effects).toContainEqual({
      type: 'OPEN_WS',
      epoch: 2,
      persona: 'chloe',
      sessionId: 'sess-a',
      lastUiSeq: 2,
    })
    const reReadySameId = reduceSessionMachine(goAway.state, {
      type: 'SERVER_MESSAGE',
      epoch: 2,
      msg: { type: 'ready', sessionId: 'sess-a' },
    }).state
    expect(reReadySameId.seenUiSeqKey).toEqual({ sessionId: 'sess-a', maxSeq: 2 })

    // Stale Tier 3 echo seq=2 after GoAway is rejected, whereas seq=3 applies cleanly!
    const staleAfterResume = reduceSessionMachine(reReadySameId, {
      type: 'SERVER_MESSAGE',
      epoch: 2,
      msg: { type: 'ui_state', tier: 3, state: { seq: 2, page: 'spending' } },
    })
    expect(staleAfterResume.effects.some((e) => e.type === 'APPLY_UI_STATE')).toBe(false)

    const freshSeq3 = reduceSessionMachine(reReadySameId, {
      type: 'SERVER_MESSAGE',
      epoch: 2,
      msg: { type: 'ui_state', tier: 1, state: { seq: 3, page: 'mortgage' } },
    })
    expect(freshSeq3.effects).toContainEqual({
      type: 'APPLY_UI_STATE',
      state: { seq: 3, page: 'mortgage' },
      tier: 1,
    })

    // Fresh sessionId ('sess-b') resets maxSeq to 0!
    const reReadyNewId = reduceSessionMachine(freshSeq3.state, {
      type: 'SERVER_MESSAGE',
      epoch: 2,
      msg: { type: 'ready', sessionId: 'sess-b' },
    }).state
    expect(reReadyNewId.seenUiSeqKey).toEqual({ sessionId: 'sess-b', maxSeq: 0 })
  })

  it('halts pending reconnects on AUTH_SESSION_EXPIRED and uses environment-neutral fallback error copy', () => {
    const ready = connectedReadyState('sess-iap')
    const reconnecting = reduceSessionMachine(ready, { type: 'WS_CLOSED', epoch: 1 })
    expect(reconnecting.state.phase).toBe('connecting')
    expect(reconnecting.state.resumeSessionId).toBe('sess-iap')

    const expired = reduceSessionMachine(reconnecting.state, { type: 'AUTH_SESSION_EXPIRED' })
    expect(expired.state.phase).toBe('error')
    expect(expired.state.authExpired).toBe(true)
    expect(expired.state.resumeSessionId).toBeNull()
    expect(expired.state.errorMessage).toContain('Reload the page')
    expect(expired.effects).toContainEqual({ type: 'CLEAR_RECONNECT_TIMER' })
    expect(expired.effects).toContainEqual({ type: 'CLOSE_WS' })

    // Ignored when a live session is already active
    expect(reduceSessionMachine(ready, { type: 'AUTH_SESSION_EXPIRED' }).state).toBe(ready)

    // Environment-neutral WS_CLOSED fallback copy (no "localhost proxy")
    const initConnecting = reduceSessionMachine(createInitialSessionState('chloe'), {
      type: 'CONNECT_REQUESTED',
    }).state
    const closedInitial = reduceSessionMachine(initConnecting, {
      type: 'WS_CLOSED',
      epoch: initConnecting.connectionEpoch,
    }).state
    expect(closedInitial.errorMessage).toBe(
      'Connection lost. Unable to reach the concierge service.',
    )
    expect(closedInitial.errorMessage).not.toContain('localhost proxy')
  })
})

describe('Assistant text accumulation and sanitizeAgentProse hardening', () => {
  it('supports cumulative prefix snapshots, per-segment chunks, and repeated trailing digits (£450 + 0 -> £4500)', () => {
    const ready = connectedReadyState()
    const cum = step(
      ready,
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'text', text: 'In November', partial: true } },
      {
        type: 'SERVER_MESSAGE',
        epoch: 1,
        msg: { type: 'text', text: 'In November you spent £2,018.64.', partial: false },
      },
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'turn_complete', turnIndex: 1 } },
    ).state
    expect(cum.turns).toHaveLength(1)
    expect(cum.turns[0]?.text).toBe('In November you spent £2,018.64.')
    expect(cum.turns[0]?.partial).toBe(false)

    const seg = step(
      cum,
      {
        type: 'SERVER_MESSAGE',
        epoch: 1,
        msg: { type: 'text', text: 'One moment while I check Netflix.', partial: true },
      },
      {
        type: 'SERVER_MESSAGE',
        epoch: 1,
        msg: {
          type: 'text',
          text: 'Sign in to Account settings and select Cancel Membership.',
          partial: true,
        },
      },
      {
        type: 'SERVER_MESSAGE',
        epoch: 1,
        msg: {
          type: 'text',
          text: 'Sign in to Account settings and select Cancel Membership.',
          partial: false,
        },
      },
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'turn_complete', turnIndex: 2 } },
    ).state
    expect(seg.turns).toHaveLength(2)
    expect(seg.turns[1]?.text).toBe(
      'One moment while I check Netflix. Sign in to Account settings and select Cancel Membership.',
    )

    // P1-10: single-digit delta '0' after '£450' MUST NOT be swallowed by endsWith!
    const numericDelta = step(
      seg,
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'text', text: 'Target £450', partial: true } },
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'text', text: '0', partial: false } },
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'turn_complete', turnIndex: 3 } },
    ).state
    expect(numericDelta.turns[2]?.text).toBe('Target £4500')
  })

  it('strips Composite v2 inline stage tags and nested [Diagnosis context: ...] while preserving x<y and y>z comparisons', () => {
    const raw =
      '<neutral> <positive> <reassuring> In November you spent £2,018.64, with coffee < £50. ' +
      '<excited> <gentle reassuring tone> If x<y and y>z or a < b and c > d, do you recognise Netflix? </neutral> ' +
      '[Diagnosis context: November [nested [detail]] total £2,018.64; flagged Netflix £45.00.] ' +
      '{@AGENT: savings_agent} <state_update>{"x":1}</state_update>'
    expect(sanitizeAgentProse(raw)).toBe(
      'In November you spent £2,018.64, with coffee < £50. If x<y and y>z or a < b and c > d, do you recognise Netflix?',
    )
    expect(stripDiagnosisBlocks('Hello [Diagnosis context: a [nested] b] world').trim()).toBe(
      'Hello   world',
    )
  })

  it('preserves Sarah fixture vendors (BT, OVO), UK acronyms (TSB, NHS, GWR, NOW), and dynamic custom fixture tokens while lowercasing stress caps', () => {
    expect(sanitizeAgentProse('HIGHER')).toBe('higher')
    expect(sanitizeAgentProse('FLAGGED')).toBe('flagged')
    expect(
      sanitizeAgentProse(
        'Your BT broadband and OVO Energy bills plus TSB, NHS, GWR, and NOW charges were NOT FLAGGED.',
      ),
    ).toBe(
      'Your BT broadband and OVO Energy bills plus TSB, NHS, GWR, and NOW charges were not flagged.',
    )

    // Dynamic custom fixture vendor token preservation:
    const customFixture = structuredClone(getFixture('sarah'))
    customFixture.transactions.push({
      id: 'txn-custom-kfc',
      month_offset: 0,
      day: 12,
      vendor: 'KFC Bristol',
      category: 'eating_out',
      amount_pence: 1250,
    })
    expect(sanitizeAgentProse('Your KFC Bristol charge was CONFIRMED.', customFixture)).toBe(
      'Your KFC Bristol charge was confirmed.',
    )
  })
})
