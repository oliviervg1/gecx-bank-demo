import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createAudioCapture, SILENCE_100MS_B64 } from '../agent/audio'

interface FakeTrack {
  enabled: boolean
  stop: () => void
}
let tracks: FakeTrack[] = []
let workletPort: {
  onmessage:
    | ((e: { data: Float32Array | { type: 'flushed'; samples: Float32Array } }) => void)
    | null
  postMessage: ReturnType<typeof vi.fn>
} | null = null

const originals = {
  AudioContext: globalThis.AudioContext,
  AudioWorkletNode: (globalThis as Record<string, unknown>).AudioWorkletNode,
  mediaDevices: navigator.mediaDevices,
}

beforeEach(() => {
  tracks = [{ enabled: true, stop: vi.fn() }]
  workletPort = null

  class CaptureContextStub {
    state = 'running'
    audioWorklet = { addModule: () => Promise.resolve() }
    constructor(_o?: unknown) {}
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} }
    }
    resume() {
      return Promise.resolve()
    }
    close() {
      return Promise.resolve()
    }
  }
  class WorkletNodeStub {
    port = {
      onmessage: null as
        | ((e: { data: Float32Array | { type: 'flushed'; samples: Float32Array } }) => void)
        | null,
      postMessage: vi.fn(),
    }
    constructor(_ctx: unknown, _name: string) {
      workletPort = this.port
    }
    disconnect() {}
  }
  ;(globalThis as Record<string, unknown>).AudioContext = CaptureContextStub
  ;(globalThis as Record<string, unknown>).AudioWorkletNode = WorkletNodeStub
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: () =>
        Promise.resolve({ getTracks: () => tracks, getAudioTracks: () => tracks }),
    },
  })
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).AudioContext = originals.AudioContext
  ;(globalThis as Record<string, unknown>).AudioWorkletNode = originals.AudioWorkletNode
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: originals.mediaDevices,
  })
})

function decode(b64: string): Int16Array {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return new Int16Array(bytes.buffer)
}

describe('createAudioCapture — PTT muting, release flush, and <=2.5s trailing silence', () => {
  it('passes 16 kHz PCM samples when unmuted and suppresses idle frames when muted', async () => {
    const sent: string[] = []
    const cap = await createAudioCapture((b64) => sent.push(b64), { startMuted: true })
    expect(cap.isMuted()).toBe(true)
    expect(tracks[0].enabled).toBe(false)

    // Muted idle worklet blocks do not flood the proxy.
    workletPort!.onmessage!({ data: new Float32Array(160).fill(0.5) })
    expect(sent).toHaveLength(0)

    // Unmuting enables track and forwards speech samples.
    cap.setMuted(false)
    expect(tracks[0].enabled).toBe(true)
    workletPort!.onmessage!({ data: new Float32Array(160).fill(0.5) })
    expect(sent).toHaveLength(1)
    expect(decode(sent[0]).every((v) => v === 16383)).toBe(true)
  })

  it('flushes partial speech on PTT release, streams 100ms silence up to 2.5s, and stops on server reaction', async () => {
    vi.useFakeTimers()
    try {
      const sent: string[] = []
      const cap = await createAudioCapture((b64) => sent.push(b64))
      workletPort!.postMessage.mockImplementation((msg: { type?: string }) => {
        if (msg?.type === 'flush') {
          workletPort!.onmessage!({
            data: { type: 'flushed', samples: new Float32Array(80).fill(0.25) },
          })
        }
      })

      cap.flushAndSendTrailingSilence()
      expect(workletPort!.postMessage).toHaveBeenCalledWith({ type: 'flush' })
      expect(cap.isMuted()).toBe(true)
      // Flushed partial speech frame + immediate first 100ms silence frame.
      expect(sent).toHaveLength(2)
      expect(sent[1]).toBe(SILENCE_100MS_B64)

      vi.advanceTimersByTime(300)
      expect(sent).toHaveLength(5)

      cap.notifyServerReaction()
      vi.advanceTimersByTime(3000)
      expect(sent).toHaveLength(5)
    } finally {
      vi.useRealTimers()
    }
  })
})
