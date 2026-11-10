import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  parseServerMsg,
  serializeClientMsg,
  type PersonaId,
  type ServerMsg,
  type ServerTurnDiagnosticsMsg,
  type UiViewStatePayload,
} from './protocol'
import {
  createAudioCapture,
  createAudioPlayer,
  type AudioCapture,
  type AudioPlayer,
} from './audio'
import {
  createInitialSessionState,
  reduceSessionMachine,
  type ConversationTurn,
  type SessionEffect,
  type SessionEvent,
  type SessionMachineState,
  type SessionPhase,
} from './sessionMachine'
import { usePersona } from '../personas/PersonaProvider'
import { getFixture } from '../data/fixture'
import { buildSessionVariables } from './sessionVariables'
import { readPushToTalkFromLocation } from './pushToTalk'
import { useSpendingView } from './SpendingViewProvider'

export type ConnState = 'idle' | 'connecting' | 'ready' | 'error'
export type MicState = 'idle' | 'listening' | 'held' | 'speaking' | 'muted'

export interface AgentContextValue {
  phase: SessionPhase
  connState: ConnState
  micState: MicState
  sessionId: string | null
  turns: ConversationTurn[]
  diagnostics: ServerTurnDiagnosticsMsg[]
  activeAgentName: string
  latestUiState: UiViewStatePayload | null
  latestUiTier: 1 | 2 | 3 | null
  transcript: string | null
  agentText: string | null
  errorMessage: string | null
  micDenied: boolean
  pushToTalk: boolean
  beginTalking: () => Promise<void>
  endTalking: () => void
  startMic: () => Promise<void>
  stopMic: () => void
  submitText: (text: string) => void
  reconnect: () => void
  disconnect: () => void
}

export const AgentContext = createContext<AgentContextValue | null>(null)

const PROXY_URL =
  (import.meta as ImportMeta & { env: Record<string, string> }).env.VITE_PROXY_URL ||
  (typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/agent`
    : 'ws://localhost:8080/ws/agent')

interface RuntimeCallbacks {
  applyServerUiState: (payload: UiViewStatePayload) => void
  resetUiState: () => void
}

interface SessionRuntime {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => SessionMachineState
  pushToTalk: boolean
  mount: () => () => void
  syncExternalConfig: (
    persona: PersonaId,
    demoDate: string,
    callbacks: RuntimeCallbacks,
  ) => void
  dispatch: (event: SessionEvent) => void
  awaitPendingCapture: () => Promise<void>
  stopMicOnly: () => void
}

function createSessionRuntime(
  initialPersona: PersonaId,
  initialDemoDate: string,
  initialCallbacks: RuntimeCallbacks,
): SessionRuntime {
  let state: SessionMachineState = createInitialSessionState(initialPersona)
  let demoDate = initialDemoDate
  let callbacks = initialCallbacks
  const pushToTalk = readPushToTalkFromLocation()
  const listeners = new Set<() => void>()

  let ws: WebSocket | null = null
  let capture: AudioCapture | null = null
  let captureInitPromise: Promise<AudioCapture | null> | null = null
  let pendingCaptureStart: Promise<void> = Promise.resolve()
  let player: AudioPlayer | null = null
  let watchdogTimer: number | null = null
  let unmountTimer: number | null = null
  let isMounted = false

  function notify() {
    for (const listener of listeners) {
      listener()
    }
  }

  function clearWatchdog() {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
  }

  function ensurePlayer(): AudioPlayer | null {
    if (player) return player
    if (typeof AudioContext === 'undefined') return null
    try {
      player = createAudioPlayer({
        onIdle: () => {
          dispatch({ type: 'PLAYER_DRAINED', playbackEpoch: state.playbackEpoch })
        },
      })
    } catch {
      player = null
    }
    return player
  }

  async function ensureCaptureAndStart(): Promise<void> {
    try {
      if (!capture) {
        if (!captureInitPromise) {
          captureInitPromise = createAudioCapture(
            (b64) => {
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(serializeClientMsg({ type: 'audio', data: b64 }))
              }
            },
            { startMuted: pushToTalk },
          )
            .then((created) => {
              capture = created
              captureInitPromise = null
              return created
            })
            .catch((err) => {
              captureInitPromise = null
              throw err
            })
        }
        const created = await captureInitPromise
        if (!created) return
      }
      const activeCapture = capture
      if (!activeCapture) return
      // Guard against stop having fired while awaiting getUserMedia.
      if (state.phase !== 'capturing') {
        activeCapture.setMuted(true)
        return
      }
      await activeCapture.start()
      if (state.phase === 'capturing') {
        activeCapture.setMuted(false)
      }
    } catch (err) {
      const detail = err instanceof Error ? `${err.name} ${err.message}` : ''
      const isNonPermissionError =
        Boolean(detail) && !/denied|permission|notallowed|security/i.test(detail)
      dispatch({
        type: 'MIC_DENIED',
        message: isNonPermissionError
          ? `Audio capture failed (${(err as Error).message}). Hold to retry.`
          : 'Microphone access denied. Allow microphone access and hold to retry.',
      })
    }
  }

  function closeActiveSocket() {
    if (!ws) return
    const active = ws
    ws = null
    active.onopen = null
    active.onmessage = null
    active.onerror = null
    active.onclose = null
    try {
      if (active.readyState === WebSocket.OPEN) {
        active.send(serializeClientMsg({ type: 'stop' }))
      }
      active.close()
    } catch {
      // Socket already closing/closed.
    }
  }

  function runEffect(effect: SessionEffect) {
    switch (effect.type) {
      case 'OPEN_WS': {
        closeActiveSocket()
        ensurePlayer()
        const epoch = effect.epoch
        const targetPersona = effect.persona
        const resumeId = effect.sessionId
        let lastErrorReason: string | undefined

        let socket: WebSocket
        try {
          socket = new WebSocket(PROXY_URL)
        } catch {
          dispatch({
            type: 'WS_CLOSED',
            epoch,
            reason: 'Unable to open WebSocket to localhost proxy.',
          })
          return
        }
        ws = socket

        socket.onopen = () => {
          if (epoch !== state.connectionEpoch) return
          const fixture = getFixture(targetPersona)
          const variables = buildSessionVariables(targetPersona, fixture, { demoDate })
          socket.send(
            serializeClientMsg({
              type: 'start',
              persona: targetPersona,
              variables,
              sessionId: resumeId,
            }),
          )
        }

        socket.onmessage = (ev: MessageEvent) => {
          if (epoch !== state.connectionEpoch) return
          let msg: ServerMsg
          try {
            msg = parseServerMsg(String(ev.data))
          } catch {
            return
          }
          dispatch({ type: 'SERVER_MESSAGE', epoch, msg })
        }

        socket.onerror = () => {
          lastErrorReason = 'Connection error. Check that the localhost proxy is running on port 8080.'
        }

        socket.onclose = () => {
          if (ws === socket) {
            ws = null
          }
          dispatch({ type: 'WS_CLOSED', epoch, reason: lastErrorReason })
        }
        break
      }

      case 'CLOSE_WS': {
        closeActiveSocket()
        break
      }

      case 'START_MIC_CAPTURE': {
        pendingCaptureStart = ensureCaptureAndStart()
        break
      }

      case 'FLUSH_MIC_AND_SEND_SILENCE': {
        if (pushToTalk) {
          capture?.flushAndSendTrailingSilence()
        }
        break
      }

      case 'STOP_TRAILING_SILENCE': {
        capture?.notifyServerReaction()
        break
      }

      case 'STOP_MIC_CAPTURE': {
        capture?.stop()
        capture = null
        captureInitPromise = null
        break
      }

      case 'ENQUEUE_AUDIO': {
        if (effect.playbackEpoch !== state.playbackEpoch) break
        // Half-duplex echo protection: mute microphone while agent TTS plays.
        capture?.setMuted(true)
        const p = ensurePlayer()
        if (p) {
          p.enqueue(effect.data)
        } else {
          // Headless/test environment without Web Audio API: drain on next microtask.
          const ep = effect.playbackEpoch
          queueMicrotask(() => {
            dispatch({ type: 'PLAYER_DRAINED', playbackEpoch: ep })
          })
        }
        break
      }

      case 'FLUSH_PLAYER': {
        player?.flush()
        if (state.phase === 'capturing') {
          capture?.setMuted(false)
        }
        break
      }

      case 'SEND_CLIENT_TEXT': {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(serializeClientMsg({ type: 'text', text: effect.text }))
        }
        break
      }

      case 'APPLY_UI_STATE': {
        callbacks.applyServerUiState(effect.state)
        break
      }

      case 'RESET_UI_FOR_PERSONA': {
        callbacks.resetUiState()
        break
      }

      case 'START_THINKING_WATCHDOG': {
        clearWatchdog()
        const ep = effect.epoch
        watchdogTimer = window.setTimeout(() => {
          watchdogTimer = null
          dispatch({ type: 'THINKING_WATCHDOG_FIRED', epoch: ep })
        }, effect.timeoutMs)
        break
      }

      case 'CLEAR_THINKING_WATCHDOG': {
        clearWatchdog()
        break
      }
    }
  }

  function dispatch(event: SessionEvent) {
    const prev = state
    const result = reduceSessionMachine(prev, event)
    state = result.state
    // Lift forced playback mute once agent finishes speaking in always-on (?ptt=0) mode.
    if (
      !pushToTalk &&
      prev.phase === 'agentSpeaking' &&
      state.phase === 'ready' &&
      capture !== null
    ) {
      capture.setMuted(false)
    }
    if (state !== prev) {
      notify()
    }
    for (const eff of result.effects) {
      runEffect(eff)
    }
  }

  function destroy() {
    clearWatchdog()
    closeActiveSocket()
    capture?.stop()
    capture = null
    captureInitPromise = null
    player?.close()
    player = null
  }

  return {
    pushToTalk,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot() {
      return state
    },
    mount() {
      isMounted = true
      if (unmountTimer !== null) {
        clearTimeout(unmountTimer)
        unmountTimer = null
      }
      dispatch({ type: 'CONNECT_REQUESTED' })
      return () => {
        isMounted = false
        // Defer full teardown by one macrotask so React StrictMode's immediate
        // remount reuses the single in-flight WebSocket (Row 8).
        unmountTimer = window.setTimeout(() => {
          unmountTimer = null
          if (!isMounted) {
            destroy()
          }
        }, 0)
      }
    },
    syncExternalConfig(
      nextPersona: PersonaId,
      nextDemoDate: string,
      nextCallbacks: RuntimeCallbacks,
    ) {
      const dateChanged = demoDate !== nextDemoDate
      demoDate = nextDemoDate
      callbacks = nextCallbacks
      if (nextPersona !== state.persona || dateChanged) {
        dispatch({ type: 'PERSONA_SWITCH', persona: nextPersona })
      }
    },
    dispatch,
    awaitPendingCapture() {
      return pendingCaptureStart
    },
    stopMicOnly() {
      capture?.stop()
      capture = null
      captureInitPromise = null
      if (state.phase === 'capturing') {
        state = { ...state, phase: 'ready', userHasFloor: false }
        notify()
      }
    },
  }
}

function deriveConnState(state: SessionMachineState): ConnState {
  switch (state.phase) {
    case 'connecting':
      return 'connecting'
    case 'error':
      return state.micDenied && state.sessionId !== null ? 'ready' : 'error'
    case 'ready':
    case 'capturing':
    case 'thinking':
    case 'agentSpeaking':
    case 'drainingFarewell':
      return 'ready'
    case 'disconnected':
    case 'paused':
    case 'ended':
      return 'idle'
  }
}

function deriveMicState(state: SessionMachineState, pushToTalk: boolean): MicState {
  if (state.micDenied) return 'muted'
  if (state.phase === 'capturing') return pushToTalk ? 'held' : 'listening'
  if (state.phase === 'agentSpeaking' || state.phase === 'drainingFarewell') return 'speaking'
  return 'idle'
}

function latestTurnText(turns: ConversationTurn[], role: 'user' | 'assistant'): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === role && turns[i].text) {
      return turns[i].text
    }
  }
  return null
}

export function AgentProvider({ children }: { children: ReactNode }) {
  const { persona, demoDate } = usePersona()
  const { applyServerUiState, resetUiState } = useSpendingView()

  const [runtime] = useState<SessionRuntime>(() =>
    createSessionRuntime(persona, demoDate, { applyServerUiState, resetUiState }),
  )

  const machineState = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  )

  useEffect(() => runtime.mount(), [runtime])

  useEffect(() => {
    runtime.syncExternalConfig(persona, demoDate, { applyServerUiState, resetUiState })
  }, [runtime, persona, demoDate, applyServerUiState, resetUiState])

  const beginTalking = useCallback(async () => {
    runtime.dispatch({ type: 'PTT_PRESS' })
    await runtime.awaitPendingCapture()
  }, [runtime])

  const endTalking = useCallback(() => {
    if (!runtime.pushToTalk) return
    runtime.dispatch({ type: 'PTT_RELEASE' })
  }, [runtime])

  const startMic = useCallback(async () => {
    runtime.dispatch({ type: 'PTT_PRESS' })
    await runtime.awaitPendingCapture()
  }, [runtime])

  const stopMic = useCallback(() => {
    runtime.stopMicOnly()
  }, [runtime])

  const submitText = useCallback(
    (text: string) => {
      runtime.dispatch({ type: 'CLIENT_TEXT_SUBMIT', text })
    },
    [runtime],
  )

  const reconnect = useCallback(() => {
    runtime.dispatch({ type: 'DISCONNECT_REQUESTED' })
    runtime.dispatch({ type: 'CONNECT_REQUESTED' })
  }, [runtime])

  const disconnect = useCallback(() => {
    runtime.dispatch({ type: 'DISCONNECT_REQUESTED' })
  }, [runtime])

  const value = useMemo<AgentContextValue>(() => {
    const connState = deriveConnState(machineState)
    const micState = deriveMicState(machineState, runtime.pushToTalk)
    return {
      phase: machineState.phase,
      connState,
      micState,
      sessionId: machineState.sessionId,
      turns: machineState.turns,
      diagnostics: machineState.diagnostics,
      activeAgentName: machineState.activeAgentName,
      latestUiState: machineState.latestUiState,
      latestUiTier: machineState.latestUiTier,
      transcript: latestTurnText(machineState.turns, 'user'),
      agentText: latestTurnText(machineState.turns, 'assistant'),
      errorMessage: machineState.errorMessage,
      micDenied: machineState.micDenied,
      pushToTalk: runtime.pushToTalk,
      beginTalking,
      endTalking,
      startMic,
      stopMic,
      submitText,
      reconnect,
      disconnect,
    }
  }, [
    machineState,
    runtime.pushToTalk,
    beginTalking,
    endTalking,
    startMic,
    stopMic,
    submitText,
    reconnect,
    disconnect,
  ])

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error('useAgent must be used within <AgentProvider>')
  return ctx
}
