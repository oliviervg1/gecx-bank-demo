import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { parseServerMsg, serializeClientMsg, type ServerMsg } from './protocol'
import { createAudioCapture, createAudioPlayer, type AudioCapture, type AudioPlayer } from './audio'
import { createRegistry, type Registry } from './clientFunctions'
import { AgentRegistryContext } from './AgentRegistryContext'
import { usePersona } from '../personas/PersonaProvider'
import { getFixture } from '../data/fixture'
import { buildSessionVariables } from './sessionVariables'
import { readPushToTalkFromLocation } from './pushToTalk'

type ConnState = 'idle' | 'connecting' | 'ready' | 'error'
// 'held' is push-to-talk transmitting; 'listening' is the always-on mode
// (?ptt=0). Both mean "the user's voice is reaching CES"; they differ only in
// what the pill shows and how transmission ends.
export type MicState = 'idle' | 'listening' | 'held' | 'speaking' | 'muted'

interface AgentContextValue {
  connState: ConnState
  micState: MicState
  transcript: string | null
  agentText: string | null
  errorMessage: string | null
  registry: Registry
  startMic: () => Promise<void>
  stopMic: () => void
  reconnect: () => void
  disconnect: () => void
  // Push-to-talk. beginTalking is async because the very first press may still
  // need to acquire the microphone.
  pushToTalk: boolean
  beginTalking: () => Promise<void>
  endTalking: () => void
}

export const AgentContext = createContext<AgentContextValue | null>(null)

// Default to a same-origin WS URL so the Vite dev server (or any reverse
// proxy in production) can forward /ws/agent to the FastAPI proxy. This
// avoids cross-origin and port-forwarding quirks in hosted dev environments
// like Cloud Workstations / Codespaces. Override with VITE_PROXY_URL if the
// proxy lives elsewhere.
const PROXY_URL = (import.meta as ImportMeta & { env: Record<string, string> }).env.VITE_PROXY_URL
  || (typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/agent`
    : 'ws://localhost:8080/ws/agent')

// Auto-retry budget before surfacing the Retry pill. CES BidiRunSession
// occasionally enters a transient `failed_precondition` state where new
// sessions close immediately after handshake; a few quick retries usually
// clear it. Beyond that the user (or a re-push) needs to intervene.
const MAX_AUTO_RETRIES = 3

// Retries back off 400ms, 800ms, 1600ms rather than re-firing synchronously
// from onclose, so an upstream that rejects every session is not hammered as
// fast as the browser can open sockets.
const RETRY_BASE_DELAY_MS = 400

export function AgentProvider({ children }: { children: ReactNode }) {
  const [connState, setConnState] = useState<ConnState>('idle')
  const [micState, setMicState] = useState<MicState>('idle')
  const [transcript, setTranscript] = useState<string | null>(null)
  const [agentText, setAgentText] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // Bumped by `reconnect` to force the connection effect to re-run. The
  // effect's dependency array includes this counter, so incrementing it
  // closes the old ws and opens a new one.
  const [connectionAttempt, setConnectionAttempt] = useState(0)

  const { persona } = usePersona()

  const wsRef = useRef<WebSocket | null>(null)
  const captureRef = useRef<AudioCapture | null>(null)
  const playerRef = useRef<AudioPlayer | null>(null)
  // Push-to-talk is locked in at mount, like the persona. Not reactive: the
  // demo picks a mode before it starts.
  const pushToTalkRef = useRef<boolean>(readPushToTalkFromLocation())
  const pushToTalk = pushToTalkRef.current
  // The two inputs to the transmit decision. Refs, not state, because the
  // audio callback and the event handlers both need the current value
  // synchronously — a stale closure here would mean a hot mic.
  const isHeldRef = useRef(false)
  const agentSpeakingRef = useRef(false)
  // Set when the user barges in, cleared when they release. The agent's speech
  // arrives as a STREAM, so flushing the player only clears what is already
  // queued — chunks already on the wire keep arriving for a beat afterwards.
  // Without this, each one re-asserted "agent is speaking" and re-muted the mic
  // mid-hold, so barge-in appeared to need several presses.
  const userHasFloorRef = useRef(false)

  // The ONE place that decides whether the user's voice reaches CES.
  //   push-to-talk : transmit only while held
  //   always-on    : transmit whenever capture exists
  // In both modes, never transmit while the agent is speaking — that is the
  // half-duplex rule that stops a room PA feeding the agent its own voice.
  const applyMute = useCallback(() => {
    const capture = captureRef.current
    if (!capture) return
    const wantsToTalk = pushToTalkRef.current ? isHeldRef.current : true
    capture.setMuted(!wantsToTalk || agentSpeakingRef.current)
  }, [])
  // Set when the user taps the pill while the ws is closed (e.g. after the
  // agent ended the session). startMic flips this on + triggers a
  // reconnect; the connState='ready' effect below auto-starts the mic.
  const pendingMicStartRef = useRef(false)
  // Auto-retry bookkeeping. Counts retries since the last successful 'ready'
  // (or last manual reconnect). Reset on success and on user intent.
  const autoRetryAttemptsRef = useRef(0)
  // Carries the most informative error message across the auto-retry loop so
  // the Retry pill can show what the server actually said when retries are
  // exhausted (rather than a generic "connection lost" fallback).
  const lastErrorMessageRef = useRef<string | null>(null)
  // Set by `disconnect` (which lives outside the connection effect) so the
  // current WS's onclose handler skips the auto-retry branch. The effect's own
  // cleanup uses a per-attempt local instead — a provider-wide flag was being
  // reset by the next attempt before the previous socket's async close event
  // had fired.
  const intentionalCloseRef = useRef(false)
  // Pending backoff timer, cleared on cleanup so a queued retry can't outlive
  // the effect that scheduled it.
  const retryTimerRef = useRef<number | null>(null)
  // Lazy-init: `useRef(createRegistry())` evaluates the initializer on
  // every render (value is discarded after the first set). Build once.
  const registryRef = useRef<Registry | null>(null)
  if (registryRef.current === null) registryRef.current = createRegistry()
  const registry = registryRef.current

  // Open WS on mount, send `start`.
  useEffect(() => {
    setConnState('connecting')
    intentionalCloseRef.current = false
    const ws = new WebSocket(PROXY_URL)
    wsRef.current = ws
    // Per-attempt local: tracks whether the server signalled 'end' (clean)
    // or 'error' (retry candidate) before the close arrived.
    let closeReason: 'end' | 'error' | null = null
    // Per-attempt: set by this effect's cleanup. See intentionalCloseRef.
    let intentionalClose = false
    // Per-attempt: whether this session ever produced real upstream traffic.
    // The retry budget resets on this rather than on 'ready' — the proxy emits
    // 'ready' immediately after pushing config, before CES has validated
    // anything, and the transient `failed_precondition` closes the socket
    // AFTER that. Resetting on 'ready' meant every retry zeroed the counter
    // and the Retry pill could never appear: an unbounded reconnect loop.
    let sawUpstreamData = false
    const markSessionHealthy = () => {
      if (sawUpstreamData) return
      sawUpstreamData = true
      autoRetryAttemptsRef.current = 0
      lastErrorMessageRef.current = null
    }
    playerRef.current = createAudioPlayer({
      // The drain-debounce here is already the "agent finished talking"
      // signal, so it doubles as the half-duplex release: lift the forced
      // mute and return the pill to whatever the user's hold state implies.
      onIdle: () => {
        agentSpeakingRef.current = false
        applyMute()
        if (captureRef.current === null) return
        setMicState(
          pushToTalkRef.current
            ? (isHeldRef.current ? 'held' : 'idle')
            : 'listening',
        )
      },
    })

    ws.onopen = () => {
      // Clear any error left over from a previous connection attempt that
      // failed during handshake (notably React 18 StrictMode's dev double-mount,
      // which opens a WS, closes it mid-handshake, and triggers ws.onerror —
      // we don't want that stale error pill to mask a successful retry).
      setErrorMessage(null)
      ws.send(serializeClientMsg({
        type: 'start',
        persona,
        variables: buildSessionVariables(getFixture(persona)),
      }))
    }
    ws.onclose = () => {
      // A close event from a socket we have already replaced must not stop the
      // LIVE session's microphone or burn a retry. React runs cleanup and the
      // next effect body in one synchronous commit, so the previous socket's
      // close event always lands after its replacement exists.
      if (wsRef.current !== null && wsRef.current !== ws) return

      captureRef.current?.stop()
      captureRef.current = null
      setMicState('idle')

      if (intentionalClose || intentionalCloseRef.current || closeReason === 'end') {
        // Effect cleanup, manual disconnect, or agent-initiated end_session.
        // Don't retry — the close was expected.
        setConnState('idle')
        return
      }

      // Either the server sent an explicit 'error' envelope (proxy upstream
      // failure) or the transport dropped without warning. Burn an auto-retry
      // budget entry; if exhausted, surface the Retry pill.
      if (autoRetryAttemptsRef.current < MAX_AUTO_RETRIES) {
        autoRetryAttemptsRef.current += 1
        // Bumping the attempt counter re-runs this effect, which sets
        // connState back to 'connecting' on the next WebSocket construction.
        const delay = RETRY_BASE_DELAY_MS * 2 ** (autoRetryAttemptsRef.current - 1)
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null
          setConnectionAttempt((n) => n + 1)
        }, delay)
      } else {
        setConnState('error')
        setErrorMessage(
          lastErrorMessageRef.current
            ?? 'Connection lost. Is the proxy running on port 8080?',
        )
      }
    }
    ws.onerror = () => {
      // Stash a fallback message but defer the state change to onclose, which
      // owns the retry-vs-pill decision. onerror fires immediately before
      // onclose on most transport failures, so the message is in place by
      // the time onclose checks it.
      lastErrorMessageRef.current = 'Connection error. Is the proxy running on port 8080?'
    }
    ws.onmessage = async (e) => {
      let msg: ServerMsg
      try { msg = parseServerMsg(e.data as string) }
      catch (err) { console.warn('drop unparseable message', err); return }

      switch (msg.type) {
        case 'ready':
          // Handshake accepted by the PROXY. Deliberately does not reset the
          // retry budget — see sawUpstreamData above.
          setConnState('ready')
          break
        case 'transcript': markSessionHealthy(); setTranscript(msg.text); break
        case 'text': markSessionHealthy(); setAgentText(msg.text); break
        case 'audio':
          markSessionHealthy()
          // The user has barged in and is still holding: drop this chunk
          // rather than letting it take the floor back. CES will stop sending
          // shortly, once it hears the interruption.
          if (userHasFloorRef.current) break
          // Half-duplex: the agent has the floor, so the mic goes silent even
          // if the user is still holding. Without this, a room PA is fed
          // straight back into the endpointer and the agent interrupts itself.
          agentSpeakingRef.current = true
          applyMute()
          playerRef.current?.enqueue(msg.data)
          setMicState('speaking')
          break
        case 'client_function': {
          markSessionHealthy()
          // Run the handler and send the response back so the agent's turn
          // can continue. Handler errors are surfaced as { error: ... }.
          const envelope = await registry.dispatch({
            id: msg.id,
            name: msg.name,
            args: msg.args,
          })
          const currentWs = wsRef.current
          if (currentWs && currentWs.readyState === WebSocket.OPEN) {
            currentWs.send(serializeClientMsg({
              type: 'tool_response',
              id: envelope.id,
              response: envelope.response,
            }))
          }
          break
        }
        case 'interrupt':
          // User barged in mid-reply. Stop the queued agent audio and flip
          // the pill back to Listening so the user sees the correct state.
          playerRef.current?.flush()
          agentSpeakingRef.current = false
          applyMute()
          if (captureRef.current !== null) {
            setMicState(
              pushToTalkRef.current
                ? (isHeldRef.current ? 'held' : 'idle')
                : 'listening',
            )
          }
          break
        case 'end':
          closeReason = 'end'
          ws.close()
          break
        case 'error':
          // Record the message; onclose decides whether to retry silently or
          // surface the Retry pill. Don't flip connState here — that would
          // expose every transient upstream blip as a user-facing error.
          closeReason = 'error'
          lastErrorMessageRef.current = msg.message
          break
      }
    }

    return () => {
      intentionalClose = true
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      ws.close()
      captureRef.current?.stop()
      playerRef.current?.close()
    }
    // applyMute and registry are both stable (a useCallback([]) and a
    // ref-held object), so listing them satisfies exhaustive-deps without
    // risking the effect re-running and churning the WebSocket.
  }, [persona, connectionAttempt, applyMute, registry])

  const startMic = useCallback(async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      // No live session. Most commonly: the agent ended the previous
      // session via end_session and we never reopened a ws. Queue the mic
      // start and trigger a reconnect; the connState='ready' effect below
      // will pick this flag up and start the mic on the new session.
      pendingMicStartRef.current = true
      setConnectionAttempt((n) => n + 1)
      return
    }
    try {
      if (!captureRef.current) {
        captureRef.current = await createAudioCapture((b64) => {
          // Audio worklet keeps producing frames for ~one quantum after the
          // WS closes (e.g. agent called end_session). Drop those frames
          // instead of sending into a closed socket.
          const ws = wsRef.current
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(serializeClientMsg({ type: 'audio', data: b64 }))
          }
        }, {
          // Comes up silent under push-to-talk. The mic is never hot until
          // the user asks for it — the whole point of the feature.
          startMuted: pushToTalkRef.current,
        })
      }
      await captureRef.current.start()
      applyMute()
      setMicState(pushToTalkRef.current ? 'idle' : 'listening')
    } catch (err) {
      console.error('mic permission denied', err)
      setMicState('muted')
      setErrorMessage('Microphone access denied. Check browser permissions.')
    }
  }, [applyMute])

  // When the new session arrives at 'ready' and we queued a mic start
  // (because the user tapped the pill while the previous session was
  // closed), kick the mic off automatically.
  useEffect(() => {
    if (connState === 'ready' && pendingMicStartRef.current) {
      pendingMicStartRef.current = false
      void startMic()
    }
  }, [connState, startMic])

  // Hold started. Acquires the mic on first use, so the first press of the
  // session is slightly slower than subsequent ones.
  const beginTalking = useCallback(async () => {
    isHeldRef.current = true
    if (!captureRef.current) {
      await startMic()          // sets state and calls applyMute itself
      if (!captureRef.current) return   // permission denied
    }
    // Deliberate barge-in: taking the floor while the agent is talking stops
    // its playback locally. This replaces the accidental, echo-triggered
    // interruption that the old always-on mic suffered from.
    if (agentSpeakingRef.current) {
      playerRef.current?.flush()
      agentSpeakingRef.current = false
      // Hold the floor until release, so in-flight chunks cannot reclaim it.
      userHasFloorRef.current = true
    }
    applyMute()
    // 'held' only means something under push-to-talk. In always-on mode the
    // mic is simply live, so report the state that mode actually has.
    setMicState(pushToTalkRef.current ? 'held' : 'listening')
  }, [applyMute, startMic])

  // Hold ended. The capture stays open and simply goes silent — CES's
  // endpointer hears speech stop and closes the turn.
  const endTalking = useCallback(() => {
    isHeldRef.current = false
    // Hand the floor back — the agent may answer immediately.
    userHasFloorRef.current = false
    applyMute()
    setMicState((prev) => {
      if (prev === 'speaking') return prev          // agent still has the floor
      if (!pushToTalkRef.current) return prev       // always-on: mic stays live
      return 'idle'
    })
  }, [applyMute])

  const stopMic = useCallback(() => {
    isHeldRef.current = false
    userHasFloorRef.current = false
    captureRef.current?.stop()
    captureRef.current = null
    setMicState('idle')
  }, [])

  // Force the connection effect to re-run by bumping the attempt counter.
  // Used by the ConciergePill's Retry state after a transport error. Resets
  // the auto-retry budget so the user gets a full fresh cycle.
  const reconnect = useCallback(() => {
    autoRetryAttemptsRef.current = 0
    lastErrorMessageRef.current = null
    setErrorMessage(null)
    setConnectionAttempt((n) => n + 1)
  }, [])

  // Tear down the live session without re-opening one. Used by Log out in
  // the ProfilePage so the customer can leave the agent loop cleanly.
  const disconnect = useCallback(() => {
    autoRetryAttemptsRef.current = 0
    lastErrorMessageRef.current = null
    // Mark the close as intentional so the WS's onclose handler goes idle
    // instead of taking the auto-retry branch.
    isHeldRef.current = false
    userHasFloorRef.current = false
    intentionalCloseRef.current = true
    wsRef.current?.close()
    wsRef.current = null
    captureRef.current?.stop()
    captureRef.current = null
    playerRef.current?.flush()
    setConnState('idle')
    setMicState('idle')
  }, [])

  const value = useMemo<AgentContextValue>(
    () => ({ connState, micState, transcript, agentText, errorMessage, registry, startMic, stopMic, reconnect, disconnect, pushToTalk, beginTalking, endTalking }),
    [connState, micState, transcript, agentText, errorMessage, registry, startMic, stopMic, reconnect, disconnect, pushToTalk, beginTalking, endTalking],
  )

  return (
    <AgentContext.Provider value={value}>
      <AgentRegistryContext.Provider value={registry}>
        {children}
      </AgentRegistryContext.Provider>
    </AgentContext.Provider>
  )
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error('useAgent must be used within <AgentProvider>')
  return ctx
}
