import { describe, it, expect } from 'vitest'
import {
  THINKING_WATCHDOG_MS,
  createInitialSessionState,
  reduceSessionMachine,
  type SessionEffect,
  type SessionEvent,
  type SessionMachineState,
} from '../agent/sessionMachine'
import { sanitizeAgentProse } from '../agent/streamSanitizer'

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

function connectedReadyState(sessionId = 'sess-1'): SessionMachineState {
  const init = createInitialSessionState('chloe')
  const c = step(
    init,
    { type: 'CONNECT_REQUESTED' },
    { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'ready', sessionId } },
  )
  return c.state
}

describe('sessionMachine.ts — All 11 transition rows & invariants', () => {
  // Row 1: PTT barge-in during agentSpeaking flushes player + increments playbackEpoch + drops residual audio.
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
    const oldPlaybackEpoch = speaking.playbackEpoch

    const barged = reduceSessionMachine(speaking, { type: 'PTT_PRESS' })
    expect(barged.state.phase).toBe('capturing')
    expect(barged.state.playbackEpoch).toBe(oldPlaybackEpoch + 1)
    expect(barged.state.userHasFloor).toBe(true)
    expect(barged.state.turns[0].interrupted).toBe(true)
    expect(barged.effects).toContainEqual({ type: 'FLUSH_PLAYER' })
    expect(barged.effects).toContainEqual({ type: 'START_MIC_CAPTURE' })

    // Stale PLAYER_DRAINED from previous playbackEpoch is ignored.
    const staleDrain = reduceSessionMachine(barged.state, {
      type: 'PLAYER_DRAINED',
      playbackEpoch: oldPlaybackEpoch,
    })
    expect(staleDrain.state.phase).toBe('capturing')

    // Residual in-flight server audio while holding is dropped instead of reclaiming agentSpeaking.
    const residualAudio = reduceSessionMachine(barged.state, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'audio', data: 'AAAA' },
    })
    expect(residualAudio.state.phase).toBe('capturing')
    expect(residualAudio.effects.some((e) => e.type === 'ENQUEUE_AUDIO')).toBe(false)
  })

  // Row 2: turn_complete waits for player drain before leaving agentSpeaking.
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

    // Reverse order: PLAYER_DRAINED arrives before turn_complete.
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

  // Row 3: Zero-audio turn thinking -> ready + 15s thinking watchdog.
  it('Row 3: zero-audio turn_complete and 15,000ms THINKING_WATCHDOG_FIRED both recover thinking -> ready', () => {
    expect(THINKING_WATCHDOG_MS).toBe(15_000)
    const ready = connectedReadyState()
    const released = step(ready, { type: 'PTT_PRESS' }, { type: 'PTT_RELEASE' })
    expect(released.state.phase).toBe('thinking')
    expect(released.effects).toContainEqual({ type: 'FLUSH_MIC_AND_SEND_SILENCE' })
    expect(released.effects).toContainEqual({
      type: 'START_THINKING_WATCHDOG',
      epoch: 1,
      timeoutMs: 15_000,
    })

    // Zero-audio turn_complete -> ready.
    const completed = reduceSessionMachine(released.state, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'turn_complete' },
    })
    expect(completed.state.phase).toBe('ready')

    // Stale watchdog epoch is ignored; matching epoch recovers thinking -> ready.
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

  // Row 4: ServerEnd waits for farewell audio drain before showing ended; pressing PTT during drain starts fresh session.
  it('Row 4: end waits for farewell audio drain, and PTT_PRESS during drainingFarewell flushes and opens a fresh session', () => {
    const ready = connectedReadyState('sess-farewell')
    const draining = step(
      ready,
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'audio', data: 'AAAA' } },
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'end' } },
    )
    expect(draining.state.phase).toBe('drainingFarewell')
    expect(draining.effects.some((e) => e.type === 'CLOSE_WS')).toBe(false)

    // Draining finishes normally -> ended + CLOSE_WS.
    const finished = reduceSessionMachine(draining.state, {
      type: 'PLAYER_DRAINED',
      playbackEpoch: draining.state.playbackEpoch,
    })
    expect(finished.state.phase).toBe('ended')
    expect(finished.state.sessionId).toBeNull()
    expect(finished.effects).toContainEqual({ type: 'CLOSE_WS' })

    // Pressing PTT mid-drain flushes farewell audio, closes WS, and opens a fresh sessionId: null!
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

  // Row 5: WS close after end / drainingFarewell / paused never triggers error.
  it('Row 5: WS_CLOSED after end, drainingFarewell, or session_expired is normal and never enters error', () => {
    const ready = connectedReadyState()
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
  })

  // Row 6: ServerGoAway reconnects with the SAME sessionId (deferred if agentSpeaking); other reconnects use null.
  it('Row 6: go_away reconnects with same sessionId immediately when idle and defers until PLAYER_DRAINED when speaking', () => {
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

    // Deferred while speaking, even if upstream closes WS before audio finishes draining!
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

    // GoAway mid-capturing re-arms mic capture automatically once resumed socket is ready!
    const capturing = reduceSessionMachine(ready, { type: 'PTT_PRESS' }).state
    expect(capturing.phase).toBe('capturing')
    const goAwayMidHold = step(
      capturing,
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'go_away', sessionId: 'sess-keep' } },
      { type: 'SERVER_MESSAGE', epoch: 2, msg: { type: 'ready', sessionId: 'sess-keep' } },
    )
    expect(goAwayMidHold.state.phase).toBe('capturing')
    expect(goAwayMidHold.effects).toContainEqual({ type: 'START_MIC_CAPTURE' })
  })

  // Row 7: Connection epochs ignore stale socket events.
  it('Row 7: ignores SERVER_MESSAGE and WS_CLOSED from stale connectionEpoch', () => {
    const ready = connectedReadyState()
    const switched = reduceSessionMachine(ready, {
      type: 'PERSONA_SWITCH',
      persona: 'david',
    }).state
    expect(switched.connectionEpoch).toBe(2)

    const staleMsg = reduceSessionMachine(switched, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'error', message: 'stale socket failure' },
    })
    expect(staleMsg.state).toBe(switched)

    const staleClose = reduceSessionMachine(switched, {
      type: 'WS_CLOSED',
      epoch: 1,
      reason: 'stale close',
    })
    expect(staleClose.state).toBe(switched)
  })

  // Row 8: React StrictMode idempotent mount — duplicate CONNECT_REQUESTED is a no-op.
  it('Row 8: duplicate CONNECT_REQUESTED while connecting or ready opens no second socket', () => {
    const init = createInitialSessionState('chloe')
    const first = reduceSessionMachine(init, { type: 'CONNECT_REQUESTED' })
    expect(first.effects).toHaveLength(1)
    expect(first.state.connectionEpoch).toBe(1)

    const duplicate = reduceSessionMachine(first.state, { type: 'CONNECT_REQUESTED' })
    expect(duplicate.state).toBe(first.state)
    expect(duplicate.effects).toEqual([])
  })

  // Row 9: Mic denied surfaces actionable error and retries cleanly on next PTT_PRESS.
  it('Row 9: MIC_DENIED enters actionable error and retries START_MIC_CAPTURE on next PTT_PRESS', () => {
    const ready = connectedReadyState('sess-mic')
    const denied = step(
      ready,
      { type: 'PTT_PRESS' },
      { type: 'MIC_DENIED' },
    )
    expect(denied.state.phase).toBe('error')
    expect(denied.state.micDenied).toBe(true)
    expect(denied.state.errorMessage).toMatch(/microphone/i)

    const retried = reduceSessionMachine(denied.state, { type: 'PTT_PRESS' })
    expect(retried.state.phase).toBe('capturing')
    expect(retried.state.micDenied).toBe(false)
    expect(retried.effects).toEqual([{ type: 'START_MIC_CAPTURE' }])
  })

  // Row 10: Key-repeat PTT_PRESS while capturing is ignored.
  it('Row 10: ignores repeated PTT_PRESS while already capturing', () => {
    const ready = connectedReadyState()
    const capturing = reduceSessionMachine(ready, { type: 'PTT_PRESS' }).state
    const repeat = reduceSessionMachine(capturing, { type: 'PTT_PRESS' })
    expect(repeat.state).toBe(capturing)
    expect(repeat.effects).toEqual([])
  })

  // Row 11: PERSONA_SWITCH from any state + ClientText barge-in and auto-connect.
  it('Row 11: PERSONA_SWITCH resets UI/turns/seq from any phase, and CLIENT_TEXT_SUBMIT barges in or auto-connects', () => {
    const ready = connectedReadyState('sess-chloe')
    const withTurnAndUi = step(
      ready,
      {
        type: 'SERVER_MESSAGE',
        epoch: 1,
        msg: { type: 'ui_state', tier: 1, state: { seq: 3, page: 'savings', extra_monthly_pence: 4500 } },
      },
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'audio', data: 'AAAA' } },
    ).state

    const switched = reduceSessionMachine(withTurnAndUi, {
      type: 'PERSONA_SWITCH',
      persona: 'tom',
    })
    expect(switched.state.persona).toBe('tom')
    expect(switched.state.phase).toBe('connecting')
    expect(switched.state.turns).toEqual([])
    expect(switched.state.seenUiSeqKey).toEqual({ sessionId: '', maxSeq: 0 })
    expect(switched.effects).toContainEqual({ type: 'RESET_UI_FOR_PERSONA', persona: 'tom' })
    expect(switched.effects).toContainEqual({
      type: 'OPEN_WS',
      epoch: 2,
      persona: 'tom',
      sessionId: null,
    })

    // ClientText during agentSpeaking barges in cleanly.
    const speaking = step(
      ready,
      {
        type: 'SERVER_MESSAGE',
        epoch: 1,
        msg: { type: 'text', text: 'Let me check that.', partial: true },
      },
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'audio', data: 'AAAA' } },
    ).state
    const textBarged = reduceSessionMachine(speaking, {
      type: 'CLIENT_TEXT_SUBMIT',
      text: 'Show savings instead',
    })
    expect(textBarged.state.phase).toBe('thinking')
    expect(textBarged.state.turns[0].interrupted).toBe(true)
    expect(textBarged.effects).toContainEqual({ type: 'FLUSH_PLAYER' })
    expect(textBarged.effects).toContainEqual({
      type: 'SEND_CLIENT_TEXT',
      text: 'Show savings instead',
    })

    // ClientText from ended connects first and sends text upon ready.
    const ended = reduceSessionMachine(ready, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'end' },
    }).state
    const queued = step(
      ended,
      { type: 'CLIENT_TEXT_SUBMIT', text: 'Hello again' },
      { type: 'SERVER_MESSAGE', epoch: 2, msg: { type: 'ready', sessionId: 'sess-new' } },
    )
    expect(queued.state.phase).toBe('thinking')
    expect(queued.effects).toContainEqual({ type: 'SEND_CLIENT_TEXT', text: 'Hello again' })
  })

  it('deduplicates ui_state by (sessionId, Math.trunc(Number(seq))) and resets on ready & PERSONA_SWITCH', () => {
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

    // Duplicate seq=2 (e.g. Tier 2 / Tier 3 echo) is dropped!
    const dup = reduceSessionMachine(u1.state, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'ui_state', tier: 3, state: { seq: 2, page: 'spending' } },
    })
    expect(dup.effects.some((e) => e.type === 'APPLY_UI_STATE')).toBe(false)

    // Stale seq=1 is dropped!
    const stale = reduceSessionMachine(u1.state, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'ui_state', tier: 2, state: { seq: 1, page: 'home' } },
    })
    expect(stale.effects.some((e) => e.type === 'APPLY_UI_STATE')).toBe(false)

    // New ready frame resets maxSeq to 0 EVEN IF sessionId is identical ('sess-a'), as well as for 'sess-b'!
    const reReadySameId = reduceSessionMachine(u1.state, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'ready', sessionId: 'sess-a' },
    }).state
    expect(reReadySameId.seenUiSeqKey).toEqual({ sessionId: 'sess-a', maxSeq: 0 })
    const seq1SameId = reduceSessionMachine(reReadySameId, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'ui_state', tier: 1, state: { seq: 1, page: 'mortgage' } },
    })
    expect(seq1SameId.effects).toContainEqual({
      type: 'APPLY_UI_STATE',
      state: { seq: 1, page: 'mortgage' },
      tier: 1,
    })

    const reReadyNewId = reduceSessionMachine(seq1SameId.state, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'ready', sessionId: 'sess-b' },
    }).state
    const freshSeq1 = reduceSessionMachine(reReadyNewId, {
      type: 'SERVER_MESSAGE',
      epoch: 1,
      msg: { type: 'ui_state', tier: 1, state: { seq: 1, page: 'savings' } },
    })
    expect(freshSeq1.effects).toContainEqual({
      type: 'APPLY_UI_STATE',
      state: { seq: 1, page: 'savings' },
      tier: 1,
    })
  })
})

describe('Assistant text accumulation (W-2) & sanitizeAgentProse (W-3)', () => {
  it('W-2: supports BOTH cumulative prefix snapshots and per-segment chunks, finalizing on turn_complete', () => {
    const ready = connectedReadyState()

    // 1. Cumulative streaming (new text starts with old text -> replaces cleanly)
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
    expect(cum.turns[0].text).toBe('In November you spent £2,018.64.')
    expect(cum.turns[0].partial).toBe(false)

    // 2. Per-segment streaming on Turn 2 (pacing phrase, then post-tool answer -> appends without losing pacing phrase!)
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
      { type: 'SERVER_MESSAGE', epoch: 1, msg: { type: 'turn_complete', turnIndex: 2 } },
    ).state
    expect(seg.turns).toHaveLength(2)
    expect(seg.turns[1].text).toBe(
      'One moment while I check Netflix. Sign in to Account settings and select Cancel Membership.',
    )
    expect(seg.turns[1].partial).toBe(false)
  })

  it('W-3: strips arbitrary <word> and <multi word> audio tags generically while preserving < £50 prose', () => {
    const raw =
      '<neutral> <reassuring> In November you spent £2,018.64, with coffee < £50. ' +
      '<excited> <gentle reassuring tone> Do you recognise Netflix? </neutral> ' +
      '[Diagnosis context: November total £2,018.64; flagged subscription Netflix £45.00.] ' +
      '{@AGENT: savings_agent} <state_update>{"x":1}</state_update>'
    expect(sanitizeAgentProse(raw)).toBe(
      'In November you spent £2,018.64, with coffee < £50. Do you recognise Netflix?',
    )
  })

  it('normalises 4+-letter ALL-CAPS TTS lexical-stress words while preserving banking & geographic acronyms', () => {
    expect(sanitizeAgentProse('HIGHER')).toBe('higher')
    expect(sanitizeAgentProse('FLAGGED')).toBe('flagged')
    expect(sanitizeAgentProse('FREEZE')).toBe('freeze')
    expect(
      sanitizeAgentProse(
        '<warm> In November you spent £2,018.64, which is £77.15 HIGHER than October. ' +
          'One charge was FLAGGED on screen, and you can FREEZE your card inside your FEE-FREE app.',
      ),
    ).toBe(
      'In November you spent £2,018.64, which is £77.15 higher than October. ' +
        'One charge was flagged on screen, and you can freeze your card inside your fee-free app.',
    )

    // Sentence-opening stressed words capitalise cleanly rather than leaving a lowercase sentence opener.
    expect(
      sanitizeAgentProse("FREEZE your card immediately if needed. NEVER share your PIN."),
    ).toBe('Freeze your card immediately if needed. Never share your PIN.')

    // Genuine banking, regulatory, payment, and geographic acronyms remain uppercase.
    const acronyms =
      'Rates use 4.50% AER, 3.89% APR, SVR, ERC, ISA, GBP in the UK under FCA rules via BACS, CHAPS, and PIN.'
    expect(sanitizeAgentProse(acronyms)).toBe(acronyms)
  })
})
