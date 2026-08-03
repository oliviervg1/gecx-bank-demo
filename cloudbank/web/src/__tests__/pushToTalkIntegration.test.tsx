// What actually reaches CES, end to end through AgentProvider.
//
// The other push-to-talk suites test pieces: the mute mechanism, the flag, the
// input handling. This one asserts the property the feature is judged on — that
// the audio frames leaving the WebSocket are silent unless the presenter is
// deliberately holding, and are silent while the agent has the floor no matter
// what the presenter is doing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'
import { AgentProvider, useAgent } from '../agent/AgentProvider'
import { PersonaProvider } from '../personas/PersonaProvider'

// ── harness ────────────────────────────────────────────────────────────────

let tracks: Array<{ enabled: boolean; stop: () => void }> = []
let workletPort: { onmessage: ((e: { data: Float32Array }) => void) | null } | null = null
let sockets: FakeSocket[] = []

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState = FakeSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  sent: string[] = []
  constructor(public url: string) { sockets.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.readyState = FakeSocket.CLOSED; this.onclose?.() }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.() }
  deliver(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent)
  }
}

const originals = {
  AudioContext: globalThis.AudioContext,
  AudioWorkletNode: (globalThis as Record<string, unknown>).AudioWorkletNode,
  WebSocket: globalThis.WebSocket,
  mediaDevices: navigator.mediaDevices,
}

beforeEach(() => {
  tracks = [{ enabled: true, stop: vi.fn() }]
  workletPort = null
  sockets = []

  // One stub serving both playback (AgentProvider builds a player on mount)
  // and capture.
  class CtxStub {
    currentTime = 0
    state = 'running'
    destination = {}
    audioWorklet = { addModule: () => Promise.resolve() }
    constructor(_o?: unknown) {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    createBuffer(_c: number, length: number) {
      return { length, duration: length / 24000, copyToChannel() {} }
    }
    createBufferSource() {
      return { buffer: null, onended: null, connect() {}, start() {}, stop() {} }
    }
    resume() { return Promise.resolve() }
    close() { return Promise.resolve() }
  }
  class WorkletNodeStub {
    port: { onmessage: ((e: { data: Float32Array }) => void) | null } = { onmessage: null }
    constructor() { workletPort = this.port }
    disconnect() {}
  }
  ;(globalThis as Record<string, unknown>).AudioContext = CtxStub
  ;(globalThis as Record<string, unknown>).AudioWorkletNode = WorkletNodeStub
  ;(globalThis as Record<string, unknown>).WebSocket = FakeSocket
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => Promise.resolve({ getTracks: () => tracks, getAudioTracks: () => tracks }) },
  })
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(),
  })
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  cleanup()
  ;(globalThis as Record<string, unknown>).AudioContext = originals.AudioContext
  ;(globalThis as Record<string, unknown>).AudioWorkletNode = originals.AudioWorkletNode
  ;(globalThis as Record<string, unknown>).WebSocket = originals.WebSocket
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: originals.mediaDevices })
  window.history.replaceState({}, '', '/')
})

function Probe() {
  const a = useAgent()
  return (
    <div>
      <span data-testid="mic">{a.micState}</span>
      <span data-testid="ptt">{String(a.pushToTalk)}</span>
      <button data-testid="begin" onClick={() => { void a.beginTalking() }}>begin</button>
      <button data-testid="end" onClick={a.endTalking}>end</button>
    </div>
  )
}

async function mount() {
  await act(async () => {
    render(<PersonaProvider><AgentProvider><Probe /></AgentProvider></PersonaProvider>)
    await Promise.resolve()
  })
  const ws = sockets[sockets.length - 1]
  await act(async () => { ws.open(); ws.deliver({ type: 'ready' }); await Promise.resolve() })
  return ws
}

/** Push a loud frame through the worklet; return true if what was SENT was silence. */
function sentSilence(ws: FakeSocket): boolean {
  const before = ws.sent.length
  act(() => { workletPort!.onmessage!({ data: new Float32Array(160).fill(0.5) }) })
  const frames = ws.sent.slice(before).map((s) => JSON.parse(s)).filter((m) => m.type === 'audio')
  if (frames.length === 0) return true // nothing sent at all is also not speech
  const bytes = Uint8Array.from(atob(frames[0].data), (c) => c.charCodeAt(0))
  return new Int16Array(bytes.buffer).every((v) => v === 0)
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('push-to-talk over the wire', () => {
  it('is on by default', async () => {
    await mount()
    expect(screen.getByTestId('ptt').textContent).toBe('true')
  })

  it('sends silence before the presenter holds', async () => {
    const ws = await mount()
    await act(async () => { fireEvent.click(screen.getByTestId('begin')); await Promise.resolve() })
    await act(async () => { fireEvent.click(screen.getByTestId('end')); await Promise.resolve() })
    expect(sentSilence(ws)).toBe(true)
  })

  it('sends real audio while held', async () => {
    const ws = await mount()
    await act(async () => { fireEvent.click(screen.getByTestId('begin')); await Promise.resolve() })
    expect(screen.getByTestId('mic').textContent).toBe('held')
    expect(sentSilence(ws)).toBe(false)
  })

  it('goes silent again on release', async () => {
    const ws = await mount()
    await act(async () => { fireEvent.click(screen.getByTestId('begin')); await Promise.resolve() })
    expect(sentSilence(ws)).toBe(false)
    await act(async () => { fireEvent.click(screen.getByTestId('end')); await Promise.resolve() })
    expect(sentSilence(ws)).toBe(true)
    expect(screen.getByTestId('mic').textContent).toBe('idle')
  })

  it('half-duplex: stays silent while the agent speaks even if still held', async () => {
    // This is the echo fix. A room PA playing the agent's voice must not be
    // able to reach the endpointer, regardless of what the presenter's finger
    // is doing.
    const ws = await mount()
    await act(async () => { fireEvent.click(screen.getByTestId('begin')); await Promise.resolve() })
    expect(sentSilence(ws)).toBe(false)
    await act(async () => { ws.deliver({ type: 'audio', data: 'AAAA' }); await Promise.resolve() })
    expect(screen.getByTestId('mic').textContent).toBe('speaking')
    expect(sentSilence(ws)).toBe(true)
  })

  it('disables the track too, not just the samples', async () => {
    await mount()
    await act(async () => { fireEvent.click(screen.getByTestId('begin')); await Promise.resolve() })
    expect(tracks[0].enabled).toBe(true)
    await act(async () => { fireEvent.click(screen.getByTestId('end')); await Promise.resolve() })
    expect(tracks[0].enabled).toBe(false)
  })

  it('barge-in survives audio chunks still in flight', async () => {
    // The agent's speech arrives as a STREAM. Flushing the player only clears
    // what is already queued; chunks already on the wire keep coming. If each
    // one re-asserts "agent is speaking", it re-mutes the mic mid-hold and the
    // presenter has to press again — and again — until CES happens to stop
    // sending. Holding must claim the floor, not just empty the queue.
    const ws = await mount()
    await act(async () => { ws.deliver({ type: 'audio', data: 'AAAA' }); await Promise.resolve() })
    await act(async () => { fireEvent.click(screen.getByTestId('begin')); await Promise.resolve() })
    expect(screen.getByTestId('mic').textContent).toBe('held')

    // Two more chunks land after the barge-in.
    await act(async () => {
      ws.deliver({ type: 'audio', data: 'AAAA' })
      ws.deliver({ type: 'audio', data: 'AAAA' })
      await Promise.resolve()
    })

    expect(screen.getByTestId('mic').textContent).toBe('held')
    expect(sentSilence(ws)).toBe(false)
  })

  it('releasing after a barge-in lets the agent speak again', async () => {
    const ws = await mount()
    await act(async () => { fireEvent.click(screen.getByTestId('begin')); await Promise.resolve() })
    await act(async () => { fireEvent.click(screen.getByTestId('end')); await Promise.resolve() })
    await act(async () => { ws.deliver({ type: 'audio', data: 'AAAA' }); await Promise.resolve() })
    expect(screen.getByTestId('mic').textContent).toBe('speaking')
  })

  it('barge-in: holding during agent speech takes the floor back', async () => {
    const ws = await mount()
    await act(async () => { ws.deliver({ type: 'audio', data: 'AAAA' }); await Promise.resolve() })
    expect(screen.getByTestId('mic').textContent).toBe('speaking')
    await act(async () => { fireEvent.click(screen.getByTestId('begin')); await Promise.resolve() })
    expect(screen.getByTestId('mic').textContent).toBe('held')
    expect(sentSilence(ws)).toBe(false)
  })
})

describe('?ptt=0 — always-on regression path', () => {
  it('reports push-to-talk off and transmits once the mic starts', async () => {
    window.history.replaceState({}, '', '/?ptt=0')
    const ws = await mount()
    expect(screen.getByTestId('ptt').textContent).toBe('false')
    await act(async () => { fireEvent.click(screen.getByTestId('begin')); await Promise.resolve() })
    expect(screen.getByTestId('mic').textContent).toBe('listening')
    expect(sentSilence(ws)).toBe(false)
  })

  it('still applies half-duplex while the agent speaks', async () => {
    // Even in always-on mode, muting during playback is the part that stops
    // the agent interrupting itself.
    window.history.replaceState({}, '', '/?ptt=0')
    const ws = await mount()
    await act(async () => { fireEvent.click(screen.getByTestId('begin')); await Promise.resolve() })
    await act(async () => { ws.deliver({ type: 'audio', data: 'AAAA' }); await Promise.resolve() })
    expect(sentSilence(ws)).toBe(true)
  })
})
