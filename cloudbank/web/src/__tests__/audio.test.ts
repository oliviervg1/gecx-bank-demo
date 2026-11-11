import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  base64Pcm16ToFloat32,
  createAudioPlayer,
  float32ToPcm16Base64,
} from '../agent/audio'

describe('float32ToPcm16Base64 & base64Pcm16ToFloat32', () => {
  const origAudioContext = globalThis.AudioContext

  afterEach(() => {
    ;(globalThis as unknown as { AudioContext: typeof AudioContext }).AudioContext =
      origAudioContext
    vi.useRealTimers()
  })

  it('encodes silence as base64', () => {
    const silence = new Float32Array(160)
    const encoded = float32ToPcm16Base64(silence)
    expect(encoded).toHaveLength(428)
    expect(encoded.startsWith('AAAA')).toBe(true)
  })

  it('clamps values above 1.0 to int16 max and round-trips known values', () => {
    const loud = new Float32Array([1.5, -1.5, 0.5])
    const encoded = float32ToPcm16Base64(loud)
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
    const view = new DataView(bytes.buffer)
    expect(view.getInt16(0, true)).toBe(32767)
    expect(view.getInt16(2, true)).toBe(-32768)
    expect(view.getInt16(4, true)).toBe(16383)
  })

  it('guards empty, malformed, and odd-byte PCM payloads without throwing RangeError', () => {
    expect(base64Pcm16ToFloat32('')).toHaveLength(0)
    expect(base64Pcm16ToFloat32('***not-base64***')).toHaveLength(0)
    // 1 byte (odd length) -> safely returns 0 samples instead of throwing!
    expect(base64Pcm16ToFloat32(btoa('x'))).toHaveLength(0)
    // 3 bytes (odd length) -> decodes the 1 complete int16 sample cleanly!
    expect(base64Pcm16ToFloat32(btoa('\x00\x00\xff'))).toHaveLength(1)
  })

  it('opens playback AudioContext at native hardware rate, buffers at 24 kHz, and drains even when suspended', () => {
    vi.useFakeTimers()
    let passedOptions: unknown = 'UNSET'
    let bufferRate = 0
    class SuspendedCtxStub {
      currentTime = 0
      state: 'running' | 'suspended' | 'closed' = 'suspended'
      destination = {}
      constructor(opts?: unknown) {
        passedOptions = opts
      }
      createBuffer(_channels: number, length: number, sampleRate: number) {
        bufferRate = sampleRate
        return { length, duration: length / sampleRate, copyToChannel(): void {} }
      }
      createBufferSource() {
        return {
          buffer: null,
          onended: null as null | (() => void),
          connect(): void {},
          start(): void {},
          stop(): void {},
        }
      }
      resume(): Promise<void> {
        return Promise.reject(new Error('Autoplay blocked'))
      }
      close(): Promise<void> {
        this.state = 'closed'
        return Promise.resolve()
      }
    }
    ;(globalThis as unknown as { AudioContext: typeof SuspendedCtxStub }).AudioContext =
      SuspendedCtxStub

    const onIdle = vi.fn()
    const onError = vi.fn()
    const player = createAudioPlayer({ onIdle, onError })
    expect(passedOptions).toBeUndefined()

    player.enqueue(float32ToPcm16Base64(new Float32Array(240)))
    expect(bufferRate).toBe(24000)
    expect(onError).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)
    expect(onIdle).toHaveBeenCalledTimes(1)
    player.close()
  })
})
