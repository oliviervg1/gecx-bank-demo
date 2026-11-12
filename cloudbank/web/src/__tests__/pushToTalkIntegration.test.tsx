// End-to-end voice floor and microphone transmission invariants through AgentProvider.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'
import {
  AgentProvider,
  PTT_MIC_IDLE_RELEASE_MS,
  useAgent,
} from '../agent/AgentProvider'
import { BankingViewStateProvider } from '../agent/BankingViewStateProvider'
import { PersonaProvider } from '../personas/PersonaProvider'

let tracks: Array<{ enabled: boolean; stop: ReturnType<typeof vi.fn>; onended?: (() => void) | null }> = []
let workletPort: { onmessage: ((e: { data: Float32Array }) => void) | null } | null = null
let sockets: FakeSocket[] = []
let audioContextsCreated = 0

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
  constructor(public url: string) {
    sockets.push(this)
  }
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  }
  open() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
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
  tracks = [{ enabled: true, stop: vi.fn(), onended: null }]
  workletPort = null
  sockets = []
  audioContextsCreated = 0

  class CtxStub {
    currentTime = 0
    state = 'running'
    destination = {}
    audioWorklet = { addModule: () => Promise.resolve() }
    constructor(_o?: unknown) {
      audioContextsCreated += 1
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} }
    }
    createBuffer(_c: number, length: number) {
      return { length, duration: length / 24000, copyToChannel() {} }
    }
    createBufferSource() {
      return { buffer: null, onended: null, connect() {}, start() {}, stop() {} }
    }
    resume() {
      return Promise.resolve()
    }
    close() {
      return Promise.resolve()
    }
  }
  class WorkletNodeStub {
    port: {
      onmessage: ((e: { data: Float32Array }) => void) | null
      postMessage: (msg: unknown) => void
    } = { onmessage: null, postMessage: vi.fn() }
    constructor() {
      workletPort = this.port
    }
    disconnect() {}
  }
  ;(globalThis as Record<string, unknown>).AudioContext = CtxStub
  ;(globalThis as Record<string, unknown>).AudioWorkletNode = WorkletNodeStub
  ;(globalThis as Record<string, unknown>).WebSocket = FakeSocket
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: () => {
        const streamTracks = tracks
        return Promise.resolve({
          getTracks: () => streamTracks,
          getAudioTracks: () => streamTracks,
        })
      },
    },
  })
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  })
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  cleanup()
  ;(globalThis as Record<string, unknown>).AudioContext = originals.AudioContext
  ;(globalThis as Record<string, unknown>).AudioWorkletNode = originals.AudioWorkletNode
  ;(globalThis as Record<string, unknown>).WebSocket = originals.WebSocket
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: originals.mediaDevices,
  })
  window.history.replaceState({}, '', '/')
})

function Probe() {
  const a = useAgent()
  return (
    <div>
      <span data-testid="phase">{a.phase}</span>
      <span data-testid="mic">{a.micState}</span>
      <span data-testid="ptt">{String(a.pushToTalk)}</span>
      <button data-testid="begin" onClick={() => void a.beginTalking()}>
        begin
      </button>
      <button data-testid="end" onClick={a.endTalking}>
        end
      </button>
      <button data-testid="stop" onClick={a.stopMic}>
        stop
      </button>
    </div>
  )
}

async function mount() {
  await act(async () => {
    render(
      <PersonaProvider>
        <BankingViewStateProvider>
          <AgentProvider>
            <Probe />
          </AgentProvider>
        </BankingViewStateProvider>
      </PersonaProvider>,
    )
    await Promise.resolve()
  })
  const ws = sockets[sockets.length - 1]!
  await act(async () => {
    ws.open()
    ws.deliver({ type: 'ready', sessionId: 'sess-ptt' })
    await Promise.resolve()
  })
  return ws
}

function sentSilence(ws: FakeSocket): boolean {
  const before = ws.sent.length
  act(() => {
    workletPort?.onmessage?.({ data: new Float32Array(160).fill(0.5) })
  })
  const frames = ws.sent
    .slice(before)
    .map((s) => JSON.parse(s) as { type: string; data?: string })
    .filter((m) => m.type === 'audio')
  if (frames.length === 0) return true
  const bytes = Uint8Array.from(atob(frames[0]!.data!), (c) => c.charCodeAt(0))
  return new Int16Array(bytes.buffer).every((v) => v === 0)
}

describe('push-to-talk over the wire', () => {
  it('is on by default and lazily defers AudioContext creation until user gesture or playback', async () => {
    await mount()
    expect(screen.getByTestId('ptt').textContent).toBe('true')
    expect(audioContextsCreated).toBe(0)
  })

  it('sends silence before the presenter holds', async () => {
    const ws = await mount()
    await act(async () => {
      fireEvent.click(screen.getByTestId('begin'))
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('end'))
      await Promise.resolve()
    })
    expect(sentSilence(ws)).toBe(true)
  })

  it('sends real audio while held, goes silent on release, and releases hardware mic tracks after PTT idle window', async () => {
    vi.useFakeTimers()
    try {
      const ws = await mount()
      await act(async () => {
        fireEvent.click(screen.getByTestId('begin'))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByTestId('mic').textContent).toBe('held')
      expect(tracks[0]!.enabled).toBe(true)
      expect(sentSilence(ws)).toBe(false)

      await act(async () => {
        fireEvent.click(screen.getByTestId('end'))
        await Promise.resolve()
      })
      expect(tracks[0]!.enabled).toBe(false)
      expect(sentSilence(ws)).toBe(true)
      expect(screen.getByTestId('mic').textContent).toBe('idle')

      await act(async () => {
        vi.advanceTimersByTime(PTT_MIC_IDLE_RELEASE_MS + 100)
      })
      expect(tracks[0]!.stop).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns to ready instead of freezing in thinking when blur/release fires while getUserMedia prompt is pending', async () => {
    let resolveGum!: (stream: unknown) => void
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () =>
          new Promise((resolve) => {
            resolveGum = resolve
          }),
      },
    })

    await mount()
    await act(async () => {
      fireEvent.click(screen.getByTestId('begin'))
      // Simulate immediate window.blur from browser permission prompt BEFORE getUserMedia resolves!
      fireEvent.click(screen.getByTestId('end'))
      await Promise.resolve()
    })
    expect(screen.getByTestId('phase').textContent).toBe('ready')

    // When the user later clicks Allow on the dialog, orphaned stream tracks are stopped immediately.
    await act(async () => {
      resolveGum({ getTracks: () => tracks, getAudioTracks: () => tracks })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId('phase').textContent).toBe('ready')
    expect(tracks[0]!.stop).toHaveBeenCalledTimes(1)
  })

  it('half-duplex: mutes mic when agent replies after release, and barge-in survives in-flight chunks', async () => {
    const ws = await mount()
    await act(async () => {
      ws.deliver({ type: 'audio', data: 'AAAA' })
      await Promise.resolve()
    })
    expect(screen.getByTestId('mic').textContent).toBe('speaking')

    await act(async () => {
      fireEvent.click(screen.getByTestId('begin'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId('mic').textContent).toBe('held')

    await act(async () => {
      ws.deliver({ type: 'audio', data: 'AAAA' })
      ws.deliver({ type: 'audio', data: 'AAAA' })
      await Promise.resolve()
    })
    expect(screen.getByTestId('mic').textContent).toBe('held')
    expect(sentSilence(ws)).toBe(false)
  })
})

describe('?ptt=0: continuous listening mode round-trip', () => {
  it('mutes during agent speech, returns to listening after PLAYER_DRAINED, and stops cleanly on stopMic', async () => {
    vi.useFakeTimers()
    try {
      window.history.replaceState({}, '', '/?ptt=0')
      const ws = await mount()
      expect(screen.getByTestId('ptt').textContent).toBe('false')

      await act(async () => {
        fireEvent.click(screen.getByTestId('begin'))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByTestId('mic').textContent).toBe('listening')
      expect(sentSilence(ws)).toBe(false)

      // Agent starts speaking -> half-duplex mute engages.
      await act(async () => {
        ws.deliver({ type: 'audio', data: 'AAAA' })
        ws.deliver({ type: 'turn_complete', turnIndex: 1 })
      })
      expect(screen.getByTestId('mic').textContent).toBe('speaking')
      expect(sentSilence(ws)).toBe(true)

      // Player finishes draining -> continuous mode returns to capturing ('listening'), NOT 'idle'!
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
      expect(screen.getByTestId('phase').textContent).toBe('capturing')
      expect(screen.getByTestId('mic').textContent).toBe('listening')
      expect(sentSilence(ws)).toBe(false)

      // Clicking stopMic turns off the microphone cleanly.
      await act(async () => {
        fireEvent.click(screen.getByTestId('stop'))
      })
      expect(screen.getByTestId('phase').textContent).toBe('ready')
      expect(screen.getByTestId('mic').textContent).toBe('idle')
      expect(tracks[0]!.stop).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
