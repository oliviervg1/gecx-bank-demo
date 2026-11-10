import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import audioWorkletSource from '../../public/audio-worklet.js?raw'
import { createAudioCapture, SILENCE_100MS_B64 } from '../agent/audio'

interface FakeTrack {
  enabled: boolean
  stop: ReturnType<typeof vi.fn>
}
let tracks: FakeTrack[] = []
let lastAudioContextOptions: unknown = 'UNSET'
let contextClosed = false
let mediaSourceThrow: Error | null = null
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
  lastAudioContextOptions = 'UNSET'
  contextClosed = false
  mediaSourceThrow = null
  workletPort = null

  class CaptureContextStub {
    state = 'running'
    sampleRate = 48000
    audioWorklet = { addModule: () => Promise.resolve() }
    constructor(opts?: unknown) {
      lastAudioContextOptions = opts
    }
    createMediaStreamSource() {
      if (mediaSourceThrow) throw mediaSourceThrow
      return { connect() {}, disconnect() {} }
    }
    resume() {
      return Promise.resolve()
    }
    close() {
      contextClosed = true
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

describe('createAudioCapture — hardware-rate context, real 48 kHz worklet, and flush ordering', () => {
  it('W-1: creates AudioContext at native hardware rate (no forced 16 kHz) and cleans up stream/context if createMediaStreamSource throws', async () => {
    const sent: string[] = []
    const cap = await createAudioCapture((b64) => sent.push(b64), { startMuted: true })
    // Must NOT pass { sampleRate: 16000 }, which crashes Firefox when mic is 44.1/48 kHz!
    expect(lastAudioContextOptions).toBeUndefined()
    cap.stop()

    // Simulate Firefox MediaStreamSource graph error: tracks and context must be cleaned up!
    tracks = [{ enabled: true, stop: vi.fn() }]
    contextClosed = false
    mediaSourceThrow = new Error('Connecting AudioNodes from AudioContexts with different sample-rate')
    await expect(createAudioCapture(() => {})).rejects.toThrow(/different sample-rate/)
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(contextClosed).toBe(true)
  })

  it('W-1 end-to-end: 48,000 Hz AudioContext + real public/audio-worklet.js yields exact 1,600-sample 16 kHz PCM16 frames', async () => {
    let realProcessor: {
      port: { onmessage: ((ev: { data: unknown }) => void) | null }
      process: (inputs: Float32Array[][]) => boolean
    } | null = null

    class RealWorkletNodeStub {
      port = {
        onmessage: null as
          | ((e: { data: Float32Array | { type: 'flushed'; samples: Float32Array } }) => void)
          | null,
        postMessage: (msg: unknown) => {
          realProcessor?.port.onmessage?.({ data: msg })
        },
      }
      constructor() {
        const selfPort = this.port
        class BaseAudioWorkletProcessor {
          port = {
            onmessage: null as ((ev: { data: unknown }) => void) | null,
            postMessage: (data: Float32Array | { type: 'flushed'; samples: Float32Array }) => {
              selfPort.onmessage?.({ data })
            },
          }
        }
        const factory = new Function(
          'AudioWorkletProcessor',
          'sampleRate',
          'registerProcessor',
          audioWorkletSource,
        )
        factory(
          BaseAudioWorkletProcessor,
          48000,
          (_name: string, Ctor: new () => typeof realProcessor) => {
            realProcessor = new Ctor()
          },
        )
      }
      disconnect() {}
    }

    ;(globalThis as Record<string, unknown>).AudioWorkletNode = RealWorkletNodeStub

    const frames: string[] = []
    const cap = await createAudioCapture((b64) => frames.push(b64))
    expect(realProcessor).not.toBeNull()

    // Feed 9,600 samples at 48 kHz (200 ms) in 128-sample blocks -> must emit 2 chunks of 1,600 samples (16 kHz).
    for (let i = 0; i < 9600 / 128; i++) {
      realProcessor!.process([[new Float32Array(128).fill(0.5)]])
    }

    expect(frames).toHaveLength(2)
    for (const b64 of frames) {
      const pcm = decode(b64)
      expect(pcm).toHaveLength(1600)
      expect(pcm.every((v) => v === 16383)).toBe(true)
    }
    cap.stop()
  })

  it('waits for async worklet flushed tail BEFORE sending the first 100ms trailing-silence frame', async () => {
    vi.useFakeTimers()
    try {
      const sent: string[] = []
      const cap = await createAudioCapture((b64) => sent.push(b64))

      // Simulate real cross-thread AudioWorklet port delivering 'flushed' 5ms AFTER postMessage('flush').
      workletPort!.postMessage.mockImplementation((msg: { type?: string }) => {
        if (msg?.type === 'flush') {
          setTimeout(() => {
            workletPort!.onmessage!({
              data: { type: 'flushed', samples: new Float32Array(80).fill(0.25) },
            })
          }, 5)
        }
      })

      cap.flushAndSendTrailingSilence()
      expect(workletPort!.postMessage).toHaveBeenCalledWith({ type: 'flush' })
      // Before 'flushed' arrives at t=5ms, NO silence frame has jumped ahead of the speech tail!
      expect(sent).toHaveLength(0)

      vi.advanceTimersByTime(5)
      // At t=5ms: sent[0] is the 80-sample speech tail, sent[1] is the first 100ms silence frame!
      expect(sent).toHaveLength(2)
      expect(decode(sent[0])).toHaveLength(80)
      expect(decode(sent[0])[0]).toBeGreaterThan(8000)
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
