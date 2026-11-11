// Pure deterministic reducer and effect descriptors for BidiRunSession voice + text lifecycle.
// Covers all 11 transition rows from agreed_plan_resolutions.md §5.3.

import type {
  PersonaId,
  ServerMsg,
  ServerSearchSuggestionsMsg,
  ServerTurnDiagnosticsMsg,
  UiViewStatePayload,
} from './protocol'
import { sanitizeAgentProse } from './streamSanitizer'

export const THINKING_WATCHDOG_MS = 15_000

export type SessionPhase =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'capturing'
  | 'thinking'
  | 'agentSpeaking'
  | 'drainingFarewell'
  | 'paused'
  | 'ended'
  | 'error'

export interface ConversationTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
  partial: boolean
  interrupted: boolean
  searchSuggestions?: ServerSearchSuggestionsMsg
}

export type PendingPostConnectAction =
  | { kind: 'capture' }
  | { kind: 'text'; text: string }
  | null

export interface SessionMachineState {
  phase: SessionPhase
  persona: PersonaId
  connectionEpoch: number
  playbackEpoch: number
  sessionId: string | null
  resumeSessionId: string | null
  seenUiSeqKey: { sessionId: string; maxSeq: number }
  playerActive: boolean
  turnCompletedWhileSpeaking: boolean
  pendingGoAwaySessionId: string | null
  pendingPostConnect: PendingPostConnectAction
  userHasFloor: boolean
  micDenied: boolean
  errorMessage: string | null
  turns: ConversationTurn[]
  activeAgentName: string
  latestUiState: UiViewStatePayload | null
  latestUiTier: 1 | 2 | 3 | null
}

export type SessionEffect =
  | { type: 'OPEN_WS'; epoch: number; persona: PersonaId; sessionId: string | null }
  | { type: 'CLOSE_WS' }
  | { type: 'START_MIC_CAPTURE' }
  | { type: 'FLUSH_MIC_AND_SEND_SILENCE' }
  | { type: 'STOP_TRAILING_SILENCE' }
  | { type: 'STOP_MIC_CAPTURE' }
  | { type: 'ENQUEUE_AUDIO'; data: string; playbackEpoch: number }
  | { type: 'FLUSH_PLAYER' }
  | { type: 'SEND_CLIENT_TEXT'; text: string }
  | { type: 'APPLY_UI_STATE'; state: UiViewStatePayload; tier: 1 | 2 | 3 }
  | { type: 'RESET_UI_FOR_PERSONA'; persona: PersonaId }
  | { type: 'START_THINKING_WATCHDOG'; epoch: number; timeoutMs: number }
  | { type: 'CLEAR_THINKING_WATCHDOG' }

export type SessionEvent =
  | { type: 'CONNECT_REQUESTED' }
  | { type: 'DISCONNECT_REQUESTED' }
  | { type: 'PERSONA_SWITCH'; persona: PersonaId }
  | { type: 'PTT_PRESS' }
  | { type: 'PTT_RELEASE' }
  | { type: 'STOP_MIC_ONLY' }
  | { type: 'MIC_DENIED'; message?: string }
  | { type: 'CLIENT_TEXT_SUBMIT'; text: string }
  | { type: 'SERVER_MESSAGE'; epoch: number; msg: ServerMsg }
  | { type: 'WS_CLOSED'; epoch: number; reason?: string }
  | { type: 'PLAYER_DRAINED'; playbackEpoch: number }
  | { type: 'THINKING_WATCHDOG_FIRED'; epoch: number }

export interface TransitionResult {
  state: SessionMachineState
  effects: SessionEffect[]
}

export function createInitialSessionState(persona: PersonaId = 'chloe'): SessionMachineState {
  return {
    phase: 'disconnected',
    persona,
    connectionEpoch: 0,
    playbackEpoch: 0,
    sessionId: null,
    resumeSessionId: null,
    seenUiSeqKey: { sessionId: '', maxSeq: 0 },
    playerActive: false,
    turnCompletedWhileSpeaking: false,
    pendingGoAwaySessionId: null,
    pendingPostConnect: null,
    userHasFloor: false,
    micDenied: false,
    errorMessage: null,
    turns: [],
    activeAgentName: 'root_agent',
    latestUiState: null,
    latestUiTier: null,
  }
}

function appendOrUpdateUserTranscript(
  turns: ConversationTurn[],
  text: string,
  isFinal: boolean,
): ConversationTurn[] {
  const clean = text.trim()
  if (!clean) return turns
  const next = [...turns]
  const last = next[next.length - 1]
  if (last && last.role === 'user' && last.partial) {
    next[next.length - 1] = { ...last, text: clean, partial: !isFinal }
    return next
  }
  next.push({
    id: `u-${next.length + 1}`,
    role: 'user',
    text: clean,
    partial: !isFinal,
    interrupted: false,
  })
  return next
}

function appendOrUpdateAssistantText(
  turns: ConversationTurn[],
  rawText: string,
  partial: boolean,
): ConversationTurn[] {
  const clean = sanitizeAgentProse(rawText)
  if (!clean) return turns
  const next = [...turns]
  const last = next[next.length - 1]
  if (last && last.role === 'assistant' && !last.interrupted && last.partial) {
    if (
      !last.text ||
      clean.startsWith(last.text) ||
      clean.toLowerCase().startsWith(last.text.toLowerCase())
    ) {
      // Cumulative text growth: replace with extended prefix.
      next[next.length - 1] = { ...last, text: clean, partial }
      return next
    }
    if (last.text.endsWith(clean)) {
      // Final repeat of an already-appended trailing segment.
      next[next.length - 1] = { ...last, partial }
      return next
    }
    // Per-segment / incremental text (e.g. pacing phrase then answer): append cleanly.
    const needsSpace = !/^[,.;:!?)]/.test(clean)
    next[next.length - 1] = {
      ...last,
      text: `${last.text}${needsSpace ? ' ' : ''}${clean}`,
      partial,
    }
    return next
  }
  if (last && last.role === 'assistant' && !last.interrupted && last.text === clean) {
    next[next.length - 1] = { ...last, partial }
    return next
  }
  next.push({
    id: `a-${next.length + 1}`,
    role: 'assistant',
    text: clean,
    partial,
    interrupted: false,
  })
  return next
}

function finalizeOpenTurns(turns: ConversationTurn[]): ConversationTurn[] {
  if (turns.length === 0 || !turns.some((t) => t.partial)) return turns
  return turns.map((t) => (t.partial ? { ...t, partial: false } : t))
}

function markActiveAssistantInterrupted(turns: ConversationTurn[]): ConversationTurn[] {
  if (turns.length === 0) return turns
  const next = [...turns]
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role === 'assistant') {
      next[i] = { ...next[i], interrupted: true, partial: false }
      break
    }
  }
  return next
}

function attachSearchSuggestions(
  turns: ConversationTurn[],
  suggestions: ServerSearchSuggestionsMsg,
): ConversationTurn[] {
  const next = [...turns]
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role === 'assistant') {
      next[i] = { ...next[i], searchSuggestions: suggestions }
      return next
    }
  }
  next.push({
    id: `a-${next.length + 1}`,
    role: 'assistant',
    text: '',
    partial: true,
    interrupted: false,
    searchSuggestions: suggestions,
  })
  return next
}

function inferActiveAgentFromDiagnostics(
  current: string,
  diag: ServerTurnDiagnosticsMsg,
): string {
  let active = current
  for (const xfer of diag.agentTransfers) {
    const rawTarget = String(
      xfer.targetAgent ?? xfer.target_agent ?? xfer.displayName ?? xfer.agent ?? '',
    )
    const tail = rawTarget.split('/').filter(Boolean).pop()
    if (tail) active = tail
  }
  return active
}

export function reduceSessionMachine(
  state: SessionMachineState,
  event: SessionEvent,
): TransitionResult {
  switch (event.type) {
    // Row 8: StrictMode idempotent mount — ignore duplicate connect if already connecting/live.
    case 'CONNECT_REQUESTED': {
      if (
        state.phase === 'connecting' ||
        state.phase === 'ready' ||
        state.phase === 'capturing' ||
        state.phase === 'thinking' ||
        state.phase === 'agentSpeaking'
      ) {
        return { state, effects: [] }
      }
      const nextEpoch = state.connectionEpoch + 1
      const sessionIdToJoin = state.resumeSessionId
      return {
        state: {
          ...state,
          phase: 'connecting',
          connectionEpoch: nextEpoch,
          errorMessage: null,
          micDenied: false,
        },
        effects: [
          {
            type: 'OPEN_WS',
            epoch: nextEpoch,
            persona: state.persona,
            sessionId: sessionIdToJoin,
          },
        ],
      }
    }

    case 'DISCONNECT_REQUESTED': {
      const nextEpoch = state.connectionEpoch + 1
      return {
        state: {
          ...state,
          phase: 'disconnected',
          connectionEpoch: nextEpoch,
          playbackEpoch: state.playbackEpoch + 1,
          sessionId: null,
          resumeSessionId: null,
          playerActive: false,
          turnCompletedWhileSpeaking: false,
          pendingGoAwaySessionId: null,
          pendingPostConnect: null,
          userHasFloor: false,
        },
        effects: [
          { type: 'CLEAR_THINKING_WATCHDOG' },
          { type: 'STOP_MIC_CAPTURE' },
          { type: 'FLUSH_PLAYER' },
          { type: 'CLOSE_WS' },
        ],
      }
    }

    // Row 11: PERSONA_SWITCH valid from ANY state; tears down WS, resets UI/seq/stream, opens fresh session.
    case 'PERSONA_SWITCH': {
      if (event.persona === state.persona && state.phase === 'ready' && state.turns.length === 0) {
        return { state, effects: [] }
      }
      const nextEpoch = state.connectionEpoch + 1
      const nextPlaybackEpoch = state.playbackEpoch + 1
      return {
        state: {
          ...createInitialSessionState(event.persona),
          phase: 'connecting',
          connectionEpoch: nextEpoch,
          playbackEpoch: nextPlaybackEpoch,
        },
        effects: [
          { type: 'CLEAR_THINKING_WATCHDOG' },
          { type: 'STOP_MIC_CAPTURE' },
          { type: 'FLUSH_PLAYER' },
          { type: 'CLOSE_WS' },
          { type: 'RESET_UI_FOR_PERSONA', persona: event.persona },
          {
            type: 'OPEN_WS',
            epoch: nextEpoch,
            persona: event.persona,
            sessionId: null,
          },
        ],
      }
    }

    // Rows 1, 4, 9, 10: PTT_PRESS handles key-repeat ignore, barge-in epoch flush, drainingFarewell/ended/paused/error fresh start.
    case 'PTT_PRESS': {
      // Row 10: Ignore auto-repeat while already capturing.
      if (state.phase === 'capturing') {
        return { state, effects: [] }
      }

      // Row 4 / Row 9 / paused / disconnected: connect fresh (clearing micDenied) and queue capture.
      if (
        state.phase === 'disconnected' ||
        state.phase === 'ended' ||
        state.phase === 'paused' ||
        state.phase === 'drainingFarewell' ||
        state.phase === 'error'
      ) {
        // If error was solely micDenied while WS is still open (sessionId !== null), retry mic directly without tearing down WS!
        if (state.phase === 'error' && state.micDenied && state.sessionId !== null) {
          return {
            state: {
              ...state,
              phase: 'capturing',
              micDenied: false,
              errorMessage: null,
              userHasFloor: false,
            },
            effects: [{ type: 'START_MIC_CAPTURE' }],
          }
        }

        const nextEpoch = state.connectionEpoch + 1
        const nextPlayback = state.playbackEpoch + 1
        const effects: SessionEffect[] = [
          { type: 'CLEAR_THINKING_WATCHDOG' },
          { type: 'FLUSH_PLAYER' },
        ]
        if (state.phase === 'drainingFarewell') {
          effects.push({ type: 'CLOSE_WS' })
        }
        effects.push({
          type: 'OPEN_WS',
          epoch: nextEpoch,
          persona: state.persona,
          sessionId: null,
        })
        return {
          state: {
            ...state,
            phase: 'connecting',
            connectionEpoch: nextEpoch,
            playbackEpoch: nextPlayback,
            sessionId: null,
            resumeSessionId: null,
            playerActive: false,
            turnCompletedWhileSpeaking: false,
            pendingGoAwaySessionId: null,
            pendingPostConnect: { kind: 'capture' },
            userHasFloor: false,
            micDenied: false,
            errorMessage: null,
          },
          effects,
        }
      }

      if (state.phase === 'connecting') {
        return {
          state: {
            ...state,
            pendingPostConnect: { kind: 'capture' },
            userHasFloor: false,
          },
          effects: [],
        }
      }

      // Row 1: Deliberate barge-in during agentSpeaking flushes player + increments playbackEpoch + marks interrupted.
      if (state.phase === 'agentSpeaking') {
        return {
          state: {
            ...state,
            phase: 'capturing',
            playbackEpoch: state.playbackEpoch + 1,
            playerActive: false,
            turnCompletedWhileSpeaking: false,
            userHasFloor: true,
            turns: markActiveAssistantInterrupted(state.turns),
          },
          effects: [
            { type: 'CLEAR_THINKING_WATCHDOG' },
            { type: 'FLUSH_PLAYER' },
            { type: 'START_MIC_CAPTURE' },
          ],
        }
      }

      // Ready or thinking -> start capturing immediately.
      return {
        state: {
          ...state,
          phase: 'capturing',
          userHasFloor: false,
          micDenied: false,
          errorMessage: null,
        },
        effects: [
          { type: 'CLEAR_THINKING_WATCHDOG' },
          { type: 'START_MIC_CAPTURE' },
        ],
      }
    }

    // Row 10 + Row 3: PTT_RELEASE flushes worklet, sends trailing silence (<=2.5s), and starts 15s thinking watchdog.
    case 'PTT_RELEASE': {
      if (state.phase === 'connecting' && state.pendingPostConnect?.kind === 'capture') {
        return {
          state: { ...state, pendingPostConnect: null, userHasFloor: false },
          effects: [],
        }
      }
      if (state.phase !== 'capturing') {
        return { state: { ...state, userHasFloor: false }, effects: [] }
      }
      return {
        state: {
          ...state,
          phase: 'thinking',
          userHasFloor: false,
        },
        effects: [
          { type: 'FLUSH_MIC_AND_SEND_SILENCE' },
          {
            type: 'START_THINKING_WATCHDOG',
            epoch: state.connectionEpoch,
            timeoutMs: THINKING_WATCHDOG_MS,
          },
        ],
      }
    }

    case 'STOP_MIC_ONLY': {
      if (state.phase === 'capturing') {
        return {
          state: { ...state, phase: 'ready', userHasFloor: false },
          effects: [{ type: 'STOP_MIC_CAPTURE' }],
        }
      }
      return { state, effects: [{ type: 'STOP_MIC_CAPTURE' }] }
    }

    // Row 9: Mic permission denied surfaces actionable error and retries cleanly on next press.
    case 'MIC_DENIED': {
      return {
        state: {
          ...state,
          phase: 'error',
          micDenied: true,
          userHasFloor: false,
          errorMessage:
            event.message ??
            'Microphone access denied. Allow microphone access and press Hold to talk again.',
        },
        effects: [{ type: 'CLEAR_THINKING_WATCHDOG' }, { type: 'STOP_MIC_CAPTURE' }],
      }
    }

    // Row 11: Text input bar submit barges in if agentSpeaking or connects-then-sends if disconnected/ended/paused.
    case 'CLIENT_TEXT_SUBMIT': {
      const clean = event.text.trim()
      if (!clean) return { state, effects: [] }

      const updatedTurns: ConversationTurn[] = [
        ...(state.phase === 'agentSpeaking'
          ? markActiveAssistantInterrupted(state.turns)
          : state.turns),
        {
          id: `u-${state.turns.length + 1}`,
          role: 'user',
          text: clean,
          partial: false,
          interrupted: false,
        },
      ]

      if (
        state.phase === 'disconnected' ||
        state.phase === 'ended' ||
        state.phase === 'paused' ||
        state.phase === 'drainingFarewell' ||
        (state.phase === 'error' && state.sessionId === null)
      ) {
        const nextEpoch = state.connectionEpoch + 1
        const effects: SessionEffect[] = [
          { type: 'CLEAR_THINKING_WATCHDOG' },
          { type: 'FLUSH_PLAYER' },
        ]
        if (state.phase === 'drainingFarewell') {
          effects.push({ type: 'CLOSE_WS' })
        }
        effects.push({
          type: 'OPEN_WS',
          epoch: nextEpoch,
          persona: state.persona,
          sessionId: null,
        })
        return {
          state: {
            ...state,
            phase: 'connecting',
            connectionEpoch: nextEpoch,
            playbackEpoch: state.playbackEpoch + 1,
            sessionId: null,
            resumeSessionId: null,
            playerActive: false,
            pendingPostConnect: { kind: 'text', text: clean },
            userHasFloor: false,
            errorMessage: null,
            micDenied: false,
            turns: updatedTurns,
          },
          effects,
        }
      }

      if (state.phase === 'connecting') {
        return {
          state: {
            ...state,
            pendingPostConnect: { kind: 'text', text: clean },
            turns: updatedTurns,
          },
          effects: [],
        }
      }

      const effects: SessionEffect[] = [{ type: 'STOP_TRAILING_SILENCE' }]
      let nextPlaybackEpoch = state.playbackEpoch
      if (state.phase === 'agentSpeaking') {
        nextPlaybackEpoch += 1
        effects.push({ type: 'FLUSH_PLAYER' })
      }
      effects.push({ type: 'SEND_CLIENT_TEXT', text: clean })
      effects.push({
        type: 'START_THINKING_WATCHDOG',
        epoch: state.connectionEpoch,
        timeoutMs: THINKING_WATCHDOG_MS,
      })

      return {
        state: {
          ...state,
          phase: 'thinking',
          playbackEpoch: nextPlaybackEpoch,
          playerActive: false,
          turnCompletedWhileSpeaking: false,
          userHasFloor: false,
          errorMessage: null,
          turns: updatedTurns,
        },
        effects,
      }
    }

    // Row 7: Connection epochs drop stale events from any closed/superseded socket.
    case 'SERVER_MESSAGE': {
      if (event.epoch !== state.connectionEpoch) {
        return { state, effects: [] }
      }
      return reduceServerMessage(state, event.msg)
    }

    case 'PLAYER_DRAINED': {
      if (event.playbackEpoch !== state.playbackEpoch) {
        return { state, effects: [] }
      }

      // Row 4: Farewell audio finished draining -> transition cleanly to 'ended'.
      if (state.phase === 'drainingFarewell') {
        return {
          state: {
            ...state,
            phase: 'ended',
            playerActive: false,
            sessionId: null,
            resumeSessionId: null,
          },
          effects: [{ type: 'CLOSE_WS' }],
        }
      }

      // Row 6: Deferred GoAway reconnect fires now that agent speech has finished playing!
      if (state.pendingGoAwaySessionId) {
        const nextEpoch = state.connectionEpoch + 1
        const resumeId = state.pendingGoAwaySessionId
        return {
          state: {
            ...state,
            phase: 'connecting',
            connectionEpoch: nextEpoch,
            playerActive: false,
            turnCompletedWhileSpeaking: false,
            pendingGoAwaySessionId: null,
            resumeSessionId: resumeId,
          },
          effects: [
            { type: 'CLOSE_WS' },
            {
              type: 'OPEN_WS',
              epoch: nextEpoch,
              persona: state.persona,
              sessionId: resumeId,
            },
          ],
        }
      }

      // Row 2: turnCompleted arrived earlier while player was still active -> now return to 'ready'.
      if (state.phase === 'agentSpeaking') {
        return {
          state: {
            ...state,
            phase: state.turnCompletedWhileSpeaking ? 'ready' : 'agentSpeaking',
            playerActive: false,
            turnCompletedWhileSpeaking: false,
          },
          effects: [],
        }
      }

      return { state: { ...state, playerActive: false }, effects: [] }
    }

    // Row 3: 15s thinking watchdog unfreezes the session if an upstream turn produces zero output/turnComplete.
    case 'THINKING_WATCHDOG_FIRED': {
      if (event.epoch !== state.connectionEpoch || state.phase !== 'thinking') {
        return { state, effects: [] }
      }
      return {
        state: {
          ...state,
          phase: 'ready',
        },
        effects: [{ type: 'STOP_TRAILING_SILENCE' }],
      }
    }

    // Row 5: Normal WS close after 'end' / 'drainingFarewell' / 'paused' never triggers an error.
    case 'WS_CLOSED': {
      if (event.epoch !== state.connectionEpoch) {
        return { state, effects: [] }
      }
      if (
        state.phase === 'ended' ||
        state.phase === 'drainingFarewell' ||
        state.phase === 'paused' ||
        state.phase === 'disconnected'
      ) {
        return { state, effects: [{ type: 'STOP_MIC_CAPTURE' }] }
      }
      // If GoAway arrived while speaking and audio is still draining, let PLAYER_DRAINED open the resumed WS once.
      if (state.pendingGoAwaySessionId && state.playerActive) {
        return { state, effects: [{ type: 'STOP_MIC_CAPTURE' }] }
      }
      // If GoAway set resumeSessionId right before upstream closed the socket, reconnect with same sessionId!
      if (state.resumeSessionId) {
        const nextEpoch = state.connectionEpoch + 1
        const resumeId = state.resumeSessionId
        return {
          state: {
            ...state,
            phase: 'connecting',
            connectionEpoch: nextEpoch,
            pendingGoAwaySessionId: null,
          },
          effects: [
            {
              type: 'OPEN_WS',
              epoch: nextEpoch,
              persona: state.persona,
              sessionId: resumeId,
            },
          ],
        }
      }
      return {
        state: {
          ...state,
          phase: 'error',
          sessionId: null,
          playerActive: false,
          userHasFloor: false,
          errorMessage:
            state.errorMessage ??
            event.reason ??
            'Connection lost. Check that the localhost proxy is running on port 8080.',
        },
        effects: [
          { type: 'CLEAR_THINKING_WATCHDOG' },
          { type: 'STOP_MIC_CAPTURE' },
        ],
      }
    }
  }
}

function reduceServerMessage(
  state: SessionMachineState,
  msg: ServerMsg,
): TransitionResult {
  switch (msg.type) {
    case 'ready': {
      const seenUiSeqKey = { sessionId: msg.sessionId, maxSeq: 0 }

      const pending = state.pendingPostConnect
      if (pending?.kind === 'capture') {
        return {
          state: {
            ...state,
            phase: 'capturing',
            sessionId: msg.sessionId,
            resumeSessionId: null,
            seenUiSeqKey,
            pendingPostConnect: null,
            errorMessage: null,
          },
          effects: [{ type: 'START_MIC_CAPTURE' }],
        }
      }
      if (pending?.kind === 'text') {
        return {
          state: {
            ...state,
            phase: 'thinking',
            sessionId: msg.sessionId,
            resumeSessionId: null,
            seenUiSeqKey,
            pendingPostConnect: null,
            errorMessage: null,
          },
          effects: [
            { type: 'SEND_CLIENT_TEXT', text: pending.text },
            {
              type: 'START_THINKING_WATCHDOG',
              epoch: state.connectionEpoch,
              timeoutMs: THINKING_WATCHDOG_MS,
            },
          ],
        }
      }
      return {
        state: {
          ...state,
          phase: 'ready',
          sessionId: msg.sessionId,
          resumeSessionId: null,
          seenUiSeqKey,
          errorMessage: null,
        },
        effects: [],
      }
    }

    case 'transcript': {
      const effects: SessionEffect[] = msg.isFinal ? [{ type: 'STOP_TRAILING_SILENCE' }] : []
      return {
        state: {
          ...state,
          turns: appendOrUpdateUserTranscript(state.turns, msg.text, msg.isFinal),
        },
        effects,
      }
    }

    case 'text': {
      return {
        state: {
          ...state,
          turns: appendOrUpdateAssistantText(state.turns, msg.text, msg.partial),
        },
        effects: [
          { type: 'STOP_TRAILING_SILENCE' },
          { type: 'CLEAR_THINKING_WATCHDOG' },
        ],
      }
    }

    case 'audio': {
      if (state.userHasFloor) {
        // User barged in and is still holding PTT: drop residual server audio chunks.
        return { state, effects: [{ type: 'STOP_TRAILING_SILENCE' }] }
      }
      const nextPhase: SessionPhase =
        state.phase === 'drainingFarewell' ? 'drainingFarewell' : 'agentSpeaking'
      return {
        state: {
          ...state,
          phase: nextPhase,
          playerActive: true,
          turnCompletedWhileSpeaking: false,
        },
        effects: [
          { type: 'STOP_TRAILING_SILENCE' },
          { type: 'CLEAR_THINKING_WATCHDOG' },
          { type: 'ENQUEUE_AUDIO', data: msg.data, playbackEpoch: state.playbackEpoch },
        ],
      }
    }

    case 'ui_state': {
      const effects: SessionEffect[] = [{ type: 'STOP_TRAILING_SILENCE' }]
      const rawSeq = Number(msg.state.seq)
      if (!Number.isFinite(rawSeq)) {
        return { state, effects }
      }
      const seq = Math.trunc(rawSeq)
      const currentSession = state.sessionId ?? ''
      const maxSeen =
        state.seenUiSeqKey.sessionId === currentSession ? state.seenUiSeqKey.maxSeq : 0

      if (seq < 1 || seq <= maxSeen) {
        return { state, effects }
      }

      effects.push({ type: 'APPLY_UI_STATE', state: { ...msg.state, seq }, tier: msg.tier })
      const inferredAgent =
        msg.state.page === 'spending'
          ? 'everyday_banking_agent'
          : msg.state.page === 'savings'
            ? 'savings_agent'
            : msg.state.page === 'mortgage'
              ? 'mortgage_agent'
              : state.activeAgentName
      return {
        state: {
          ...state,
          seenUiSeqKey: { sessionId: currentSession, maxSeq: seq },
          latestUiState: { ...msg.state, seq },
          latestUiTier: msg.tier,
          activeAgentName: inferredAgent,
        },
        effects,
      }
    }

    case 'turn_diagnostics': {
      return {
        state: {
          ...state,
          activeAgentName: inferActiveAgentFromDiagnostics(state.activeAgentName, msg),
        },
        effects: [],
      }
    }

    case 'search_suggestions': {
      return {
        state: {
          ...state,
          turns: attachSearchSuggestions(state.turns, msg),
        },
        effects: [],
      }
    }

    // Rows 2 & 3: turn_complete waits for player drain if playerActive, else transitions immediately to 'ready'.
    case 'turn_complete': {
      const finalizedTurns = finalizeOpenTurns(state.turns)
      const effects: SessionEffect[] = [
        { type: 'STOP_TRAILING_SILENCE' },
        { type: 'CLEAR_THINKING_WATCHDOG' },
      ]
      if (state.phase === 'drainingFarewell') {
        return { state: { ...state, turns: finalizedTurns }, effects }
      }
      if (state.playerActive) {
        return {
          state: {
            ...state,
            phase: 'agentSpeaking',
            turnCompletedWhileSpeaking: true,
            turns: finalizedTurns,
          },
          effects,
        }
      }
      return {
        state: {
          ...state,
          phase: state.phase === 'capturing' ? 'capturing' : 'ready',
          turnCompletedWhileSpeaking: false,
          turns: finalizedTurns,
        },
        effects,
      }
    }

    // Row 6: ServerGoAway reconnects with the SAME sessionId (deferred if agentSpeaking / playerActive).
    case 'go_away': {
      if (state.phase === 'agentSpeaking' || state.playerActive) {
        return {
          state: {
            ...state,
            pendingGoAwaySessionId: msg.sessionId,
            resumeSessionId: msg.sessionId,
          },
          effects: [],
        }
      }
      const nextEpoch = state.connectionEpoch + 1
      const rearmCapture =
        state.phase === 'capturing' ? ({ kind: 'capture' } as const) : state.pendingPostConnect
      return {
        state: {
          ...state,
          phase: 'connecting',
          connectionEpoch: nextEpoch,
          resumeSessionId: msg.sessionId,
          pendingPostConnect: rearmCapture,
        },
        effects: [
          { type: 'CLEAR_THINKING_WATCHDOG' },
          { type: 'CLOSE_WS' },
          {
            type: 'OPEN_WS',
            epoch: nextEpoch,
            persona: state.persona,
            sessionId: msg.sessionId,
          },
        ],
      }
    }

    case 'session_expired': {
      return {
        state: {
          ...state,
          phase: 'paused',
          sessionId: null,
          resumeSessionId: null,
          playerActive: false,
          userHasFloor: false,
          errorMessage: null,
        },
        effects: [
          { type: 'CLEAR_THINKING_WATCHDOG' },
          { type: 'STOP_MIC_CAPTURE' },
          { type: 'CLOSE_WS' },
        ],
      }
    }

    case 'interrupt': {
      return {
        state: {
          ...state,
          playbackEpoch: state.playbackEpoch + 1,
          playerActive: false,
          turnCompletedWhileSpeaking: false,
          phase: state.phase === 'capturing' ? 'capturing' : 'ready',
          turns: markActiveAssistantInterrupted(state.turns),
        },
        effects: [
          { type: 'STOP_TRAILING_SILENCE' },
          { type: 'FLUSH_PLAYER' },
        ],
      }
    }

    // Row 4: ServerEnd waits for farewell audio drain if playerActive, else transitions straight to 'ended'.
    case 'end': {
      const effects: SessionEffect[] = [
        { type: 'STOP_TRAILING_SILENCE' },
        { type: 'CLEAR_THINKING_WATCHDOG' },
        { type: 'STOP_MIC_CAPTURE' },
      ]
      if (state.playerActive) {
        return {
          state: {
            ...state,
            phase: 'drainingFarewell',
            resumeSessionId: null,
          },
          effects,
        }
      }
      effects.push({ type: 'CLOSE_WS' })
      return {
        state: {
          ...state,
          phase: 'ended',
          sessionId: null,
          resumeSessionId: null,
          playerActive: false,
          userHasFloor: false,
        },
        effects,
      }
    }

    case 'error': {
      return {
        state: {
          ...state,
          phase: 'error',
          sessionId: null,
          resumeSessionId: null,
          playerActive: false,
          userHasFloor: false,
          errorMessage: msg.message,
        },
        effects: [
          { type: 'STOP_TRAILING_SILENCE' },
          { type: 'CLEAR_THINKING_WATCHDOG' },
          { type: 'STOP_MIC_CAPTURE' },
        ],
      }
    }
  }
}
