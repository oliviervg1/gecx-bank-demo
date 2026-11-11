import { describe, it, expect, vi } from 'vitest'
import audioWorkletSource from '../../public/audio-worklet.js?raw'
import {
  CHUNK_SAMPLES_100MS,
  TARGET_SAMPLE_RATE,
  createStatefulResampler,
} from '../agent/resampler'
import {
  MAX_TRAILING_SILENCE_MS,
  SILENCE_100MS_B64,
  TRAILING_SILENCE_INTERVAL_MS,
  createTrailingSilenceController,
} from '../agent/audio'

describe('createStatefulResampler — cross-rate 128-sample Web Audio blocks', () => {
  it.each([16000, 44100, 48000])(
    'resamples 1.0s of %i Hz 128-sample blocks into exact 1,600-sample 16 kHz chunks',
    (inRate) => {
      const resampler = createStatefulResampler(inRate, TARGET_SAMPLE_RATE, CHUNK_SAMPLES_100MS)
      const chunks: Float32Array[] = []

      let remaining = inRate // Exactly 1.0 second of input samples
      while (remaining > 0) {
        const blockLen = Math.min(128, remaining)
        const block = new Float32Array(blockLen).fill(0.5)
        chunks.push(...resampler.push(block))
        remaining -= blockLen
      }
      chunks.push(...resampler.flush())

      // Every full chunk emitted before flush must be 1,600 samples (100 ms at 16 kHz).
      for (let i = 0; i < chunks.length - 1; i++) {
        expect(chunks[i].length).toBe(CHUNK_SAMPLES_100MS)
      }

      const totalOut = chunks.reduce((sum, c) => sum + c.length, 0)
      expect(totalOut).toBe(TARGET_SAMPLE_RATE)

      // Constant DC 0.5 signal must stay 0.5 across fractional block boundaries.
      for (const chunk of chunks) {
        for (let i = 0; i < chunk.length; i++) {
          expect(chunk[i]).toBeCloseTo(0.5, 5)
        }
      }
    },
  )

  it('flushes sub-100ms partial speech immediately on release and resets cleanly', () => {
    const resampler = createStatefulResampler(48000)
    // 2,400 samples at 48 kHz = 50 ms = 800 output samples (< 1,600 chunk threshold).
    const pushed = resampler.push(new Float32Array(2400).fill(0.25))
    expect(pushed).toHaveLength(0)

    const flushed = resampler.flush()
    expect(flushed).toHaveLength(1)
    expect(flushed[0].length).toBe(800)
    expect(flushed[0][0]).toBeCloseTo(0.25, 5)

    // Second flush with empty buffer emits nothing.
    expect(resampler.flush()).toHaveLength(0)
  })
})

describe('public/audio-worklet.js — PcmCapture processor at 16 / 44.1 / 48 kHz', () => {
  function instantiateWorkletProcessor(hardwareSampleRate: number) {
    const source = audioWorkletSource
    const posted: Array<Float32Array | { type: 'flushed'; samples: Float32Array }> = []
    let registeredCtor: (new () => {
      port: {
        onmessage: ((ev: { data: unknown }) => void) | null
        postMessage: (d: Float32Array | { type: 'flushed'; samples: Float32Array }) => void
      }
      process: (inputs: Float32Array[][]) => boolean
    }) | null = null

    class BaseAudioWorkletProcessor {
      port = {
        onmessage: null as ((ev: { data: unknown }) => void) | null,
        postMessage: (data: Float32Array | { type: 'flushed'; samples: Float32Array }) => {
          posted.push(data)
        },
      }
    }

    const factory = new Function(
      'AudioWorkletProcessor',
      'sampleRate',
      'registerProcessor',
      source,
    )
    factory(
      BaseAudioWorkletProcessor,
      hardwareSampleRate,
      (_name: string, ctor: typeof registeredCtor) => {
        registeredCtor = ctor
      },
    )

    expect(registeredCtor).not.toBeNull()
    const instance = new registeredCtor!()
    return { instance, posted }
  }

  it.each([16000, 44100, 48000])(
    'emits 1,600-sample chunks and flushes partial speech at %i Hz',
    (rate) => {
      const { instance, posted } = instantiateWorkletProcessor(rate)
      // Feed 0.55 seconds in 128-sample Web Audio quanta -> 5 full 100ms chunks + 50ms tail.
      const totalInput = Math.floor(rate * 0.55)
      let sent = 0
      while (sent < totalInput) {
        const len = Math.min(128, totalInput - sent)
        const keepAlive = instance.process([[new Float32Array(len).fill(0.4)]])
        expect(keepAlive).toBe(true)
        sent += len
      }

      expect(posted).toHaveLength(5)
      for (const chunk of posted) {
        expect(chunk).toBeInstanceOf(Float32Array)
        expect((chunk as Float32Array)).toHaveLength(1600)
      }

      // Trigger PTT release flush via port message.
      instance.port.onmessage?.({ data: { type: 'flush' } })
      expect(posted).toHaveLength(6)
      const flushedMsg = posted[5] as { type: 'flushed'; samples: Float32Array }
      expect(flushedMsg.type).toBe('flushed')
      expect(flushedMsg.samples.length).toBeGreaterThan(750)
      expect(flushedMsg.samples.length).toBeLessThan(850)
    },
  )

  it('proves genuine box-averaging (not point-sampling) and 440 Hz sine fidelity with bit-identical worklet/TS parity', () => {
    // 1. [1, 0, 0] pulse train at 48 kHz -> 16 kHz (ratio = 3):
    // Box average of [1, 0, 0] is strictly 1/3 (~0.333333); point-sampling gives 0 or 1!
    const pulse48k = new Float32Array(4800)
    for (let i = 0; i < pulse48k.length; i += 3) {
      pulse48k[i] = 1.0
    }
    const tsPulse = createStatefulResampler(48000)
    const tsPulseOut = tsPulse.push(pulse48k)
    expect(tsPulseOut).toHaveLength(1)
    expect(tsPulseOut[0]).toHaveLength(1600)
    for (let k = 0; k < tsPulseOut[0].length; k++) {
      expect(tsPulseOut[0][k]).toBeCloseTo(1 / 3, 5)
    }

    const { instance: wkPulse, posted: wkPulsePosted } = instantiateWorkletProcessor(48000)
    for (let off = 0; off < pulse48k.length; off += 128) {
      wkPulse.process([[pulse48k.subarray(off, off + 128)]])
    }
    expect(wkPulsePosted).toHaveLength(1)
    const wkPulseChunk = wkPulsePosted[0] as Float32Array
    for (let k = 0; k < 1600; k++) {
      expect(wkPulseChunk[k]).toBeCloseTo(1 / 3, 5)
      expect(wkPulseChunk[k]).toBe(tsPulseOut[0][k])
    }

    // 2. 440 Hz sine wave at both 44,100 Hz and 48,000 Hz -> 16,000 Hz:
    // Sampling mid-interval (n + 0.5) / inRate aligns the box-average centroid with (k + 0.5) / 16000,
    // giving < 0.005 max error vs ideal sinc-attenuated 16 kHz sine (whereas point-sampling shifts phase > 0.05).
    for (const inRate of [44100, 48000]) {
      const numIn = Math.floor(inRate * 0.25) // 250 ms -> 2 full 1,600-sample chunks + 800 tail
      const sineIn = new Float32Array(numIn)
      for (let n = 0; n < numIn; n++) {
        sineIn[n] = Math.sin((2 * Math.PI * 440 * (n + 0.5)) / inRate)
      }

      const tsRes = createStatefulResampler(inRate)
      const tsChunks: Float32Array[] = []
      const { instance: wkSine, posted: wkSinePosted } = instantiateWorkletProcessor(inRate)

      for (let off = 0; off < numIn; off += 128) {
        const block = sineIn.subarray(off, Math.min(numIn, off + 128))
        tsChunks.push(...tsRes.push(block))
        wkSine.process([[block]])
      }
      tsChunks.push(...tsRes.flush())
      wkSine.port.onmessage?.({ data: { type: 'flush' } })

      const tsFlat = new Float32Array(tsChunks.reduce((s, c) => s + c.length, 0))
      let cursor = 0
      for (const c of tsChunks) {
        tsFlat.set(c, cursor)
        cursor += c.length
      }

      const wkArrays = wkSinePosted.map((p) =>
        p instanceof Float32Array ? p : p.samples,
      )
      const wkFlat = new Float32Array(wkArrays.reduce((s, c) => s + c.length, 0))
      let wkCursor = 0
      for (const c of wkArrays) {
        wkFlat.set(c, wkCursor)
        wkCursor += c.length
      }

      expect(tsFlat.length).toBe(4000)
      expect(wkFlat.length).toBe(4000)

      let maxErr = 0
      for (let k = 0; k < 3995; k++) {
        // Exact worklet == TS resampler parity
        expect(wkFlat[k]).toBe(tsFlat[k])
        const ideal = Math.sin((2 * Math.PI * 440 * (k + 0.5)) / 16000)
        const err = Math.abs(tsFlat[k] - ideal)
        if (err > maxErr) maxErr = err
      }
      expect(maxErr).toBeLessThan(0.005)
    }
  })
})

describe('createTrailingSilenceController — post-release VAD silence', () => {
  it('streams 100 ms silence frames immediately and caps strictly at 2,500 ms (25 frames)', () => {
    vi.useFakeTimers()
    try {
      const frames: string[] = []
      const ctrl = createTrailingSilenceController((b64) => frames.push(b64))

      ctrl.beginTrailingSilence()
      expect(frames).toHaveLength(1)
      expect(frames[0]).toBe(SILENCE_100MS_B64)
      expect(ctrl.isActive()).toBe(true)

      vi.advanceTimersByTime(MAX_TRAILING_SILENCE_MS + 1000)
      expect(frames).toHaveLength(MAX_TRAILING_SILENCE_MS / TRAILING_SILENCE_INTERVAL_MS)
      expect(frames).toHaveLength(25)
      expect(ctrl.isActive()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops streaming silence immediately upon server reaction', () => {
    vi.useFakeTimers()
    try {
      const frames: string[] = []
      const ctrl = createTrailingSilenceController((b64) => frames.push(b64))

      ctrl.beginTrailingSilence()
      vi.advanceTimersByTime(350) // 1 initial + 3 interval frames = 4 frames
      expect(frames).toHaveLength(4)

      ctrl.cancelTrailingSilence()
      expect(ctrl.isActive()).toBe(false)

      vi.advanceTimersByTime(3000)
      expect(frames).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
  })
})
