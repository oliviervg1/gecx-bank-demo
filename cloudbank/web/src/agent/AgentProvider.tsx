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
  type UiViewStatePayload,
} from './protocol'
import {
  createAudioCapture,
  createAudioPlayer,
  type AudioCapture,
  type AudioPlayer,
} from './audio'
import {
  WS_CONNECT_TIMEOUT_MS,
  computeReconnectDelayMs,
  createInitialSessionState,
  reduceSessionMachine,
  type ConversationTurn,
  type SessionEffect,
  type SessionEvent,
  type SessionMachineState,
  type SessionPhase,
} from './sessionMachine'
import { usePersona } from '../personas/PersonaProvider'
import { buildClientStart } from './sessionVariables'
import { readPushToTalkFromLocation } from './pushToTalk'
import { useBankingViewState } from './BankingViewStateProvider'

export type ConnState = 'idle' | 'connecting' | 'ready' | 'error'
export type MicState = 'idle' | 'listening' | 'held' | 'speaking' | 'muted'

export interface AgentContextValue {
  phase: SessionPhase
  connState: ConnState
  micState: MicState
  sessionId: string | null
  turns: ConversationTurn[]
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
  disconnect: (opts?: { clearTurns?: boolean }) => void
}

export const AgentContext = createContext<AgentContextValue | null>(null)

const PROXY_URL =
  (import.meta as ImportMeta & { env: Record<string, string> }).env.VITE_PROXY_URL ||
  (typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/agent`
    : 'ws://127.0.0.1:8765/ws/agent')

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
}

function createSessionRuntime(
  initialPersona: PersonaId,
  initialDemoDate: string,
  initialCallbacks: RuntimeCallbacks,
): SessionRuntime {
  const pushToTalk = readPushToTalkFromLocation()
  let state: SessionMachineState = createInitialSessionState(
    initialPersona,
    pushToTalk ? 'ptt' : 'continuous',
  )
  let demoDate = initialDemoDate
  let callbacks = initialCallbacks
  const listeners = new Set<() => void>()

  let ws: WebSocket | null = null
  let connectTimeoutTimer: number | null = null
  let reconnectTimer: number | null = null
  let capture: AudioCapture | null = null
  let captureInitPromise: Promise<AudioCapture | null> | null = null
  let captureAbortController: AbortController | null = null
  let captureEpoch = 0
  let pendingCaptureStart: Promise<void> = Promise.resolve()
  let player: AudioPlayer | null = null
  let watchdogTimer: number | null = null
  let unmountTimer: number | null = null
  let isMounted = false

  // FIFO event queue eliminates re-entrant dispatch interleaving when synchronous
  // socket/audio effects emit follow-up events inside runEffect.
  const eventQueue: SessionEvent[] = []
  let isDispatching = false

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

  function clearConnectTimeout() {
    if (connectTimeoutTimer !== null) {
      clearTimeout(connectTimeoutTimer)
      connectTimeoutTimer = null
    }
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function abortAndStopCapture() {
    captureEpoch += 1
    if (captureAbortController) {
      captureAbortController.abort()
      captureAbortController = null
    }
    capture?.stop()
    capture = null
    captureInitPromise = null
  }

  function ensurePlayer(): AudioPlayer | null {
    if (player) return player
    if (typeof AudioContext === 'undefined') return null
    try {
      player = createAudioPlayer({
        onIdle: () => {
          dispatch({ type: 'PLAYER_DRAINED', playbackEpoch: state.playbackEpoch })
        },
        onError: (err) => {
          console.warn('[Cloudbank Concierge] Audio playback error:', err.message)
        },
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.warn('[Cloudbank Concierge] Unable to initialize Web Audio playback:', detail)
      player = null
    }
    return player
  }

  async function ensureCaptureAndStart(): Promise<void> {
    const requestedEpoch = captureEpoch
    try {
      if (!capture) {
        if (!captureInitPromise) {
          const abortCtrl = new AbortController()
          captureAbortController = abortCtrl
          captureInitPromise = createAudioCapture(
            (b64) => {
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(serializeClientMsg({ type: 'audio', data: b64 }))
              }
            },
            { startMuted: pushToTalk, signal: abortCtrl.signal },
          )
            .then((created) => {
              if (requestedEpoch !== captureEpoch || abortCtrl.signal.aborted) {
                created.stop()
                return null
              }
              capture = created
              captureInitPromise = null
              captureAbortController = null
              return created
            })
            .catch((err) => {
              if (captureAbortController === abortCtrl) {
                captureAbortController = null
              }
              captureInitPromise = null
              throw err
            })
        }
        const created = await captureInitPromise
        if (!created) return
      }
      const activeCapture = capture
      if (!activeCapture || requestedEpoch !== captureEpoch) {
        activeCapture?.stop()
        return
      }
      if (state.phase !== 'capturing') {
        activeCapture.setMuted(true)
        return
      }
      await activeCapture.start()
      if (requestedEpoch !== captureEpoch) {
        activeCapture.stop()
        return
      }
      if (state.phase === 'capturing') {
        activeCapture.setMuted(false)
      }
    } catch (err) {
      if (requestedEpoch !== captureEpoch) return
      if (err instanceof Error && err.name === 'AbortError') return
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
    clearConnectTimeout()
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
        const lastUiSeq = effect.lastUiSeq
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

        connectTimeoutTimer = window.setTimeout(() => {
          connectTimeoutTimer = null
          if (ws === socket && epoch === state.connectionEpoch && state.phase === 'connecting') {
            ws = null
            socket.onopen = null
            socket.onmessage = null
            socket.onerror = null
            socket.onclose = null
            try {
              socket.close()
            } catch {
              // Ignore close errors on stalled socket.
            }
            dispatch({
              type: 'WS_CLOSED',
              epoch,
              reason: 'Connection timed out while connecting to the localhost proxy.',
            })
          }
        }, WS_CONNECT_TIMEOUT_MS)

        socket.onopen = () => {
          if (epoch !== state.connectionEpoch) return
          const startMsg = buildClientStart(targetPersona, {
            demoDate,
            sessionId: resumeId,
            lastUiSeq,
          })
          socket.send(serializeClientMsg(startMsg))
        }

        socket.onmessage = (ev: MessageEvent) => {
          if (epoch !== state.connectionEpoch) return
          let msg: ServerMsg
          try {
            msg = parseServerMsg(String(ev.data))
          } catch {
            return
          }
          if (msg.type === 'ready') {
            clearConnectTimeout()
          }
          dispatch({ type: 'SERVER_MESSAGE', epoch, msg })
        }

        socket.onerror = () => {
          lastErrorReason = 'Connection error. Check that the localhost proxy is running.'
        }

        socket.onclose = () => {
          clearConnectTimeout()
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

      case 'SCHEDULE_RECONNECT': {
        clearReconnectTimer()
        const ep = effect.epoch
        const delayMs = computeReconnectDelayMs(effect.attempt)
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null
          dispatch({ type: 'RECONNECT_TIMER_FIRED', epoch: ep })
        }, delayMs)
        break
      }

      case 'CLEAR_RECONNECT_TIMER': {
        clearReconnectTimer()
        break
      }

      case 'START_MIC_CAPTURE': {
        pendingCaptureStart = ensureCaptureAndStart()
        break
      }

      case 'UNMUTE_MIC': {
        if (state.phase === 'capturing') {
          capture?.setMuted(false)
        }
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
        abortAndStopCapture()
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
    eventQueue.push(event)
    if (isDispatching) return
    isDispatching = true
    try {
      while (eventQueue.length > 0) {
        const nextEvent = eventQueue.shift()
        if (!nextEvent) continue
        const prev = state
        const result = reduceSessionMachine(prev, nextEvent)
        state = result.state
        if (state.errorMessage && state.errorMessage !== prev.errorMessage) {
          console.warn('[Cloudbank Concierge]', state.errorMessage)
        }
        if (state !== prev) {
          notify()
        }
        for (const eff of result.effects) {
          runEffect(eff)
        }
      }
    } finally {
      isDispatching = false
    }
  }

  function destroy() {
    clearReconnectTimer()
    clearWatchdog()
    closeActiveSocket()
    abortAndStopCapture()
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
        // remount reuses the single in-flight WebSocket.
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
    const turn = turns[i]
    if (turn && turn.role === role && turn.text) {
      return turn.text
    }
  }
  return null
}

export function AgentProvider({ children }: { children: ReactNode }) {
  const { persona, demoDate } = usePersona()
  const { applyServerUiState, resetUiState } = useBankingViewState()

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
    runtime.dispatch({ type: 'STOP_MIC_ONLY' })
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

  const disconnect = useCallback(
    (opts?: { clearTurns?: boolean }) => {
      runtime.dispatch({ type: 'DISCONNECT_REQUESTED', clearTurns: opts?.clearTurns })
    },
    [runtime],
  )

  const value = useMemo<AgentContextValue>(() => {
    const connState = deriveConnState(machineState)
    const micState = deriveMicState(machineState, runtime.pushToTalk)
    return {
      phase: machineState.phase,
      connState,
      micState,
      sessionId: machineState.sessionId,
      turns: machineState.turns,
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
