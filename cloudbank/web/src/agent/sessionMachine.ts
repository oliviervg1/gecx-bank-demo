// Pure deterministic reducer and effect descriptors for BidiRunSession voice and text lifecycle.

import { getFixture } from '../data/fixture'
import type {
  PersonaId,
  ServerMsg,
  ServerSearchSuggestionsMsg,
  ServerTurnDiagnosticsMsg,
  UiViewStatePayload,
} from './protocol'
import { sanitizeAgentProse } from './streamSanitizer'

export const THINKING_WATCHDOG_MS = 15_000
export const WS_CONNECT_TIMEOUT_MS = 10_000
export const MAX_RESUME_ATTEMPTS = 3
export const RESUME_BACKOFF_DELAYS_MS = [250, 500, 1000] as const

export type InputMode = 'ptt' | 'continuous'

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
  inputMode: InputMode
  micActive: boolean
  connectionEpoch: number
  playbackEpoch: number
  sessionId: string | null
  resumeSessionId: string | null
  resumeAttempts: number
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
  | {
      type: 'OPEN_WS'
      epoch: number
      persona: PersonaId
      sessionId: string | null
      lastUiSeq?: number
    }
  | { type: 'CLOSE_WS' }
  | { type: 'SCHEDULE_RECONNECT'; epoch: number; attempt: number; baseDelayMs: number }
  | { type: 'CLEAR_RECONNECT_TIMER' }
  | { type: 'START_MIC_CAPTURE' }
  | { type: 'UNMUTE_MIC' }
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
  | { type: 'DISCONNECT_REQUESTED'; clearTurns?: boolean }
  | { type: 'PERSONA_SWITCH'; persona: PersonaId }
  | { type: 'PTT_PRESS' }
  | { type: 'PTT_RELEASE' }
  | { type: 'STOP_MIC_ONLY' }
  | { type: 'MIC_DENIED'; message?: string }
  | { type: 'CLIENT_TEXT_SUBMIT'; text: string }
  | { type: 'SERVER_MESSAGE'; epoch: number; msg: ServerMsg }
  | { type: 'WS_CLOSED'; epoch: number; reason?: string }
  | { type: 'RECONNECT_TIMER_FIRED'; epoch: number }
  | { type: 'PLAYER_DRAINED'; playbackEpoch: number }
  | { type: 'THINKING_WATCHDOG_FIRED'; epoch: number }

export interface TransitionResult {
  state: SessionMachineState
  effects: SessionEffect[]
}

export function computeReconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const idx = Math.max(0, Math.min(RESUME_BACKOFF_DELAYS_MS.length - 1, attempt - 1))
  const base = RESUME_BACKOFF_DELAYS_MS[idx] ?? 1000
  const jitterFactor = 0.85 + Math.max(0, Math.min(1, random())) * 0.3
  return Math.max(50, Math.trunc(base * jitterFactor))
}

export function createInitialSessionState(
  persona: PersonaId = 'chloe',
  inputMode: InputMode = 'ptt',
): SessionMachineState {
  return {
    phase: 'disconnected',
    persona,
    inputMode,
    micActive: false,
    connectionEpoch: 0,
    playbackEpoch: 0,
    sessionId: null,
    resumeSessionId: null,
    resumeAttempts: 0,
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

function buildOpenWsEffect(
  epoch: number,
  persona: PersonaId,
  sessionId: string | null,
  seenUiSeqKey: { sessionId: string; maxSeq: number },
): SessionEffect {
  if (sessionId && seenUiSeqKey.sessionId === sessionId && seenUiSeqKey.maxSeq > 0) {
    return {
      type: 'OPEN_WS',
      epoch,
      persona,
      sessionId,
      lastUiSeq: seenUiSeqKey.maxSeq,
    }
  }
  return {
    type: 'OPEN_WS',
    epoch,
    persona,
    sessionId,
  }
}

function finishAgentTurnPhase(state: SessionMachineState): {
  nextPhase: SessionPhase
  extraEffects: SessionEffect[]
} {
  if (state.inputMode === 'continuous' && state.micActive) {
    return {
      nextPhase: 'capturing',
      extraEffects: [{ type: 'UNMUTE_MIC' }],
    }
  }
  return {
    nextPhase: 'ready',
    extraEffects: [],
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
  persona: PersonaId,
): ConversationTurn[] {
  const clean = sanitizeAgentProse(rawText, getFixture(persona))
  if (!clean) return turns
  const next = [...turns]
  const last = next[next.length - 1]
  if (last && last.role === 'assistant' && !last.interrupted && last.partial) {
    if (
      !last.text ||
      clean.startsWith(last.text) ||
      clean.toLowerCase().startsWith(last.text.toLowerCase())
    ) {
      next[next.length - 1] = { ...last, text: clean, partial }
      return next
    }
    if (last.text.endsWith(clean)) {
      next[next.length - 1] = { ...last, partial }
      return next
    }
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

function finalizeOpenTurns(
  turns: ConversationTurn[],
  preserveUserPartial: boolean = false,
): ConversationTurn[] {
  if (turns.length === 0 || !turns.some((t) => t.partial)) return turns
  return turns.map((t) => {
    if (!t.partial) return t
    if (preserveUserPartial && t.role === 'user') return t
    return { ...t, partial: false }
  })
}

function markActiveAssistantInterrupted(turns: ConversationTurn[]): ConversationTurn[] {
  if (turns.length === 0) return turns
  const next = [...turns]
  for (let i = next.length - 1; i >= 0; i--) {
    const item = next[i]
    if (item && item.role === 'assistant') {
      next[i] = { ...item, interrupted: true, partial: false }
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
    const item = next[i]
    if (item && item.role === 'assistant') {
      next[i] = { ...item, searchSuggestions: suggestions }
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
          resumeAttempts: 0,
          errorMessage: null,
          micDenied: false,
        },
        effects: [
          { type: 'CLEAR_RECONNECT_TIMER' },
          buildOpenWsEffect(nextEpoch, state.persona, sessionIdToJoin, state.seenUiSeqKey),
        ],
      }
    }

    case 'DISCONNECT_REQUESTED': {
      const nextEpoch = state.connectionEpoch + 1
      return {
        state: {
          ...state,
          phase: 'disconnected',
          micActive: false,
          connectionEpoch: nextEpoch,
          playbackEpoch: state.playbackEpoch + 1,
          sessionId: null,
          resumeSessionId: null,
          resumeAttempts: 0,
          seenUiSeqKey: { sessionId: '', maxSeq: 0 },
          playerActive: false,
          turnCompletedWhileSpeaking: false,
          pendingGoAwaySessionId: null,
          pendingPostConnect: null,
          userHasFloor: false,
          ...(event.clearTurns
            ? {
                turns: [],
                activeAgentName: 'root_agent',
                latestUiState: null,
                latestUiTier: null,
                errorMessage: null,
                micDenied: false,
              }
            : {}),
        },
        effects: [
          { type: 'CLEAR_RECONNECT_TIMER' },
          { type: 'CLEAR_THINKING_WATCHDOG' },
          { type: 'STOP_MIC_CAPTURE' },
          { type: 'FLUSH_PLAYER' },
          { type: 'CLOSE_WS' },
        ],
      }
    }

    case 'PERSONA_SWITCH': {
      if (event.persona === state.persona && state.phase === 'ready' && state.turns.length === 0) {
        return { state, effects: [] }
      }
      const nextEpoch = state.connectionEpoch + 1
      const nextPlaybackEpoch = state.playbackEpoch + 1
      return {
        state: {
          ...createInitialSessionState(event.persona, state.inputMode),
          phase: 'connecting',
          connectionEpoch: nextEpoch,
          playbackEpoch: nextPlaybackEpoch,
        },
        effects: [
          { type: 'CLEAR_RECONNECT_TIMER' },
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

    case 'PTT_PRESS': {
      if (state.phase === 'capturing') {
        return { state, effects: [] }
      }

      if (
        state.phase === 'disconnected' ||
        state.phase === 'ended' ||
        state.phase === 'paused' ||
        state.phase === 'drainingFarewell' ||
        state.phase === 'error'
      ) {
        if (state.phase === 'error' && state.micDenied && state.sessionId !== null) {
          return {
            state: {
              ...state,
              phase: 'capturing',
              micActive: true,
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
          { type: 'CLEAR_RECONNECT_TIMER' },
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
            micActive: true,
            connectionEpoch: nextEpoch,
            playbackEpoch: nextPlayback,
            sessionId: null,
            resumeSessionId: null,
            resumeAttempts: 0,
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
            micActive: true,
            pendingPostConnect: { kind: 'capture' },
            userHasFloor: false,
          },
          effects: [],
        }
      }

      // Deliberate barge-in during agentSpeaking flushes player, bumps playbackEpoch, and claims floor.
      if (state.phase === 'agentSpeaking') {
        return {
          state: {
            ...state,
            phase: 'capturing',
            micActive: true,
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

      // Pressing PTT during `thinking` immediately claims the floor and bumps playbackEpoch so
      // an arriving audio chunk from the previous turn cannot mute the user's held utterance.
      if (state.phase === 'thinking') {
        return {
          state: {
            ...state,
            phase: 'capturing',
            micActive: true,
            playbackEpoch: state.playbackEpoch + 1,
            playerActive: false,
            turnCompletedWhileSpeaking: false,
            userHasFloor: true,
            micDenied: false,
            errorMessage: null,
          },
          effects: [
            { type: 'CLEAR_THINKING_WATCHDOG' },
            { type: 'STOP_TRAILING_SILENCE' },
            { type: 'START_MIC_CAPTURE' },
          ],
        }
      }

      // Ready -> start capturing immediately.
      return {
        state: {
          ...state,
          phase: 'capturing',
          micActive: true,
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

    case 'PTT_RELEASE': {
      if (state.inputMode === 'continuous') {
        return { state, effects: [] }
      }
      if (state.phase === 'connecting' && state.pendingPostConnect?.kind === 'capture') {
        return {
          state: { ...state, micActive: false, pendingPostConnect: null, userHasFloor: false },
          effects: [],
        }
      }
      if (state.phase !== 'capturing') {
        return { state: { ...state, micActive: false, userHasFloor: false }, effects: [] }
      }
      return {
        state: {
          ...state,
          phase: 'thinking',
          micActive: false,
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
          state: { ...state, phase: 'ready', micActive: false, userHasFloor: false },
          effects: [{ type: 'STOP_MIC_CAPTURE' }],
        }
      }
      if (state.phase === 'agentSpeaking' && state.inputMode === 'continuous') {
        return {
          state: {
            ...state,
            phase: 'ready',
            micActive: false,
            userHasFloor: false,
            playbackEpoch: state.playbackEpoch + 1,
            playerActive: false,
            turnCompletedWhileSpeaking: false,
            turns: markActiveAssistantInterrupted(state.turns),
          },
          effects: [{ type: 'FLUSH_PLAYER' }, { type: 'STOP_MIC_CAPTURE' }],
        }
      }
      return {
        state: { ...state, micActive: false, userHasFloor: false },
        effects: [{ type: 'STOP_MIC_CAPTURE' }],
      }
    }

    case 'MIC_DENIED': {
      return {
        state: {
          ...state,
          phase: 'error',
          micActive: false,
          micDenied: true,
          userHasFloor: false,
          errorMessage:
            event.message ??
            'Microphone access denied. Allow microphone access and press Hold to talk again.',
        },
        effects: [{ type: 'CLEAR_THINKING_WATCHDOG' }, { type: 'STOP_MIC_CAPTURE' }],
      }
    }

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
          { type: 'CLEAR_RECONNECT_TIMER' },
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
            resumeAttempts: 0,
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

      if (state.phase === 'drainingFarewell') {
        return {
          state: {
            ...state,
            phase: 'ended',
            micActive: false,
            playerActive: false,
            sessionId: null,
            resumeSessionId: null,
            resumeAttempts: 0,
          },
          effects: [{ type: 'CLOSE_WS' }],
        }
      }

      if (state.pendingGoAwaySessionId) {
        const nextEpoch = state.connectionEpoch + 1
        const resumeId = state.pendingGoAwaySessionId
        const rearmCapture =
          state.inputMode === 'continuous' && state.micActive
            ? ({ kind: 'capture' } as const)
            : state.pendingPostConnect
        return {
          state: {
            ...state,
            phase: 'connecting',
            connectionEpoch: nextEpoch,
            playerActive: false,
            turnCompletedWhileSpeaking: false,
            pendingGoAwaySessionId: null,
            resumeSessionId: resumeId,
            resumeAttempts: 0,
            pendingPostConnect: rearmCapture,
          },
          effects: [
            { type: 'CLEAR_RECONNECT_TIMER' },
            { type: 'CLOSE_WS' },
            buildOpenWsEffect(nextEpoch, state.persona, resumeId, state.seenUiSeqKey),
          ],
        }
      }

      if (state.phase === 'agentSpeaking') {
        if (!state.turnCompletedWhileSpeaking) {
          return {
            state: {
              ...state,
              playerActive: false,
            },
            effects: [],
          }
        }
        const { nextPhase, extraEffects } = finishAgentTurnPhase(state)
        return {
          state: {
            ...state,
            phase: nextPhase,
            playerActive: false,
            turnCompletedWhileSpeaking: false,
          },
          effects: extraEffects,
        }
      }

      return { state: { ...state, playerActive: false }, effects: [] }
    }

    case 'THINKING_WATCHDOG_FIRED': {
      if (event.epoch !== state.connectionEpoch || state.phase !== 'thinking') {
        return { state, effects: [] }
      }
      const { nextPhase, extraEffects } = finishAgentTurnPhase(state)
      return {
        state: {
          ...state,
          phase: nextPhase,
        },
        effects: [{ type: 'STOP_TRAILING_SILENCE' }, ...extraEffects],
      }
    }

    case 'RECONNECT_TIMER_FIRED': {
      if (
        event.epoch !== state.connectionEpoch ||
        state.phase !== 'connecting' ||
        state.resumeSessionId === null
      ) {
        return { state, effects: [] }
      }
      return {
        state,
        effects: [
          buildOpenWsEffect(
            state.connectionEpoch,
            state.persona,
            state.resumeSessionId,
            state.seenUiSeqKey,
          ),
        ],
      }
    }

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
      if (state.pendingGoAwaySessionId && state.playerActive) {
        return { state, effects: [{ type: 'STOP_MIC_CAPTURE' }] }
      }
      if (state.resumeSessionId) {
        if (state.resumeAttempts < MAX_RESUME_ATTEMPTS) {
          const attempt = state.resumeAttempts + 1
          const baseDelayMs = RESUME_BACKOFF_DELAYS_MS[attempt - 1] ?? 1000
          const nextEpoch = state.connectionEpoch + 1
          return {
            state: {
              ...state,
              phase: 'connecting',
              connectionEpoch: nextEpoch,
              resumeAttempts: attempt,
              pendingGoAwaySessionId: null,
            },
            effects: [
              {
                type: 'SCHEDULE_RECONNECT',
                epoch: nextEpoch,
                attempt,
                baseDelayMs,
              },
            ],
          }
        }
      }
      return {
        state: {
          ...state,
          phase: 'error',
          micActive: false,
          sessionId: null,
          resumeSessionId: null,
          resumeAttempts: 0,
          playerActive: false,
          userHasFloor: false,
          errorMessage:
            state.errorMessage ??
            event.reason ??
            'Connection lost. Check that the localhost proxy is running.',
        },
        effects: [
          { type: 'CLEAR_RECONNECT_TIMER' },
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
      // Preserve seenUiSeqKey.maxSeq when GoAway resumes on the identical sessionId so stale
      // Tier 3 updatedVariables cannot replay old tab navigation; reset to 0 on new sessionIds.
      const seenUiSeqKey =
        state.seenUiSeqKey.sessionId === msg.sessionId
          ? state.seenUiSeqKey
          : { sessionId: msg.sessionId, maxSeq: 0 }

      const pending = state.pendingPostConnect
      if (pending?.kind === 'capture' || (state.inputMode === 'continuous' && state.micActive)) {
        return {
          state: {
            ...state,
            phase: 'capturing',
            micActive: true,
            sessionId: msg.sessionId,
            resumeSessionId: null,
            resumeAttempts: 0,
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
            resumeAttempts: 0,
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
          resumeAttempts: 0,
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
          turns: appendOrUpdateAssistantText(state.turns, msg.text, msg.partial, state.persona),
        },
        effects: [
          { type: 'STOP_TRAILING_SILENCE' },
          { type: 'CLEAR_THINKING_WATCHDOG' },
        ],
      }
    }

    case 'audio': {
      if (state.userHasFloor) {
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

    case 'turn_complete': {
      const preserveHeldUser = state.phase === 'capturing' && state.userHasFloor
      const finalizedTurns = finalizeOpenTurns(state.turns, preserveHeldUser)
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
      if (state.phase === 'capturing') {
        return {
          state: {
            ...state,
            phase: 'capturing',
            turnCompletedWhileSpeaking: false,
            turns: finalizedTurns,
          },
          effects,
        }
      }
      const { nextPhase, extraEffects } = finishAgentTurnPhase(state)
      return {
        state: {
          ...state,
          phase: nextPhase,
          turnCompletedWhileSpeaking: false,
          turns: finalizedTurns,
        },
        effects: [...effects, ...extraEffects],
      }
    }

    case 'go_away': {
      if (state.phase === 'agentSpeaking' || state.playerActive) {
        return {
          state: {
            ...state,
            pendingGoAwaySessionId: msg.sessionId,
            resumeSessionId: msg.sessionId,
            resumeAttempts: 0,
          },
          effects: [],
        }
      }
      const nextEpoch = state.connectionEpoch + 1
      const rearmCapture =
        state.phase === 'capturing' || (state.inputMode === 'continuous' && state.micActive)
          ? ({ kind: 'capture' } as const)
          : state.pendingPostConnect
      return {
        state: {
          ...state,
          phase: 'connecting',
          connectionEpoch: nextEpoch,
          resumeSessionId: msg.sessionId,
          resumeAttempts: 0,
          pendingPostConnect: rearmCapture,
        },
        effects: [
          { type: 'CLEAR_RECONNECT_TIMER' },
          { type: 'CLEAR_THINKING_WATCHDOG' },
          { type: 'CLOSE_WS' },
          buildOpenWsEffect(nextEpoch, state.persona, msg.sessionId, state.seenUiSeqKey),
        ],
      }
    }

    case 'session_expired': {
      return {
        state: {
          ...state,
          phase: 'paused',
          micActive: false,
          sessionId: null,
          resumeSessionId: null,
          resumeAttempts: 0,
          playerActive: false,
          userHasFloor: false,
          errorMessage: null,
        },
        effects: [
          { type: 'CLEAR_RECONNECT_TIMER' },
          { type: 'CLEAR_THINKING_WATCHDOG' },
          { type: 'STOP_MIC_CAPTURE' },
          { type: 'CLOSE_WS' },
        ],
      }
    }

    case 'interrupt': {
      const nextPhase =
        state.phase === 'capturing'
          ? 'capturing'
          : state.inputMode === 'continuous' && state.micActive
            ? 'capturing'
            : 'ready'
      const extra: SessionEffect[] =
        nextPhase === 'capturing' && state.phase !== 'capturing' ? [{ type: 'UNMUTE_MIC' }] : []
      return {
        state: {
          ...state,
          playbackEpoch: state.playbackEpoch + 1,
          playerActive: false,
          turnCompletedWhileSpeaking: false,
          phase: nextPhase,
          turns: markActiveAssistantInterrupted(state.turns),
        },
        effects: [
          { type: 'STOP_TRAILING_SILENCE' },
          { type: 'FLUSH_PLAYER' },
          ...extra,
        ],
      }
    }

    case 'end': {
      const effects: SessionEffect[] = [
        { type: 'CLEAR_RECONNECT_TIMER' },
        { type: 'STOP_TRAILING_SILENCE' },
        { type: 'CLEAR_THINKING_WATCHDOG' },
        { type: 'STOP_MIC_CAPTURE' },
      ]
      if (state.playerActive) {
        return {
          state: {
            ...state,
            phase: 'drainingFarewell',
            micActive: false,
            resumeSessionId: null,
            resumeAttempts: 0,
          },
          effects,
        }
      }
      effects.push({ type: 'CLOSE_WS' })
      return {
        state: {
          ...state,
          phase: 'ended',
          micActive: false,
          sessionId: null,
          resumeSessionId: null,
          resumeAttempts: 0,
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
          micActive: false,
          sessionId: null,
          resumeSessionId: null,
          resumeAttempts: 0,
          playerActive: false,
          userHasFloor: false,
          errorMessage: msg.message,
        },
        effects: [
          { type: 'CLEAR_RECONNECT_TIMER' },
          { type: 'STOP_TRAILING_SILENCE' },
          { type: 'CLEAR_THINKING_WATCHDOG' },
          { type: 'STOP_MIC_CAPTURE' },
        ],
      }
    }
  }
}
