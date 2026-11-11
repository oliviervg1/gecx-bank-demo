// Bundled TypeScript AudioWorkletProcessor resampling arbitrary hardware sampleRate
// (16000 / 44100 / 48000 Hz) to 16000 Hz in 1600-sample (100 ms) chunks with
// zero-copy transferable ArrayBuffers.

import {
  CHUNK_SAMPLES_100MS,
  TARGET_SAMPLE_RATE,
  createStatefulResampler,
  type StatefulResampler,
} from './pcmResampler'

export interface WorkletPortLike {
  onmessage: ((ev: { data: unknown }) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

export interface AudioWorkletProcessorLike {
  readonly port: WorkletPortLike
  process(inputs: Float32Array[][]): boolean
}

export type AudioWorkletProcessorConstructor = new () => AudioWorkletProcessorLike

declare const AudioWorkletProcessor: AudioWorkletProcessorConstructor | undefined
declare const sampleRate: number | undefined
declare const registerProcessor:
  | ((name: string, processorCtor: AudioWorkletProcessorConstructor) => void)
  | undefined

export function createPcmCaptureProcessorClass(
  BaseProcessor: AudioWorkletProcessorConstructor,
  resolveSampleRate: () => number,
): AudioWorkletProcessorConstructor {
  return class PcmCaptureProcessor extends BaseProcessor {
    private readonly resampler: StatefulResampler

    constructor() {
      super()
      const hwRate = resolveSampleRate()
      const inRate = typeof hwRate === 'number' && hwRate > 0 ? hwRate : TARGET_SAMPLE_RATE
      this.resampler = createStatefulResampler(inRate, TARGET_SAMPLE_RATE, CHUNK_SAMPLES_100MS)

      this.port.onmessage = (ev: { data: unknown }) => {
        const msg = ev?.data
        if (
          typeof msg === 'object' &&
          msg !== null &&
          (msg as { type?: unknown }).type === 'flush'
        ) {
          this.flushPartial()
        }
      }
    }

    private flushPartial(): void {
      const flushedChunks = this.resampler.flush()
      if (flushedChunks.length === 0) {
        const empty = new Float32Array(0)
        this.port.postMessage({ type: 'flushed', samples: empty }, [empty.buffer])
        return
      }

      for (let i = 0; i < flushedChunks.length - 1; i++) {
        const full = flushedChunks[i]
        if (full) {
          this.port.postMessage(full, [full.buffer])
        }
      }

      const tail = flushedChunks[flushedChunks.length - 1]
      if (tail) {
        this.port.postMessage({ type: 'flushed', samples: tail }, [tail.buffer])
      }
    }

    override process(inputs: Float32Array[][]): boolean {
      const ch = inputs[0]?.[0]
      if (!ch || ch.length === 0) {
        return true
      }

      const emitted = this.resampler.push(ch)
      for (const out of emitted) {
        this.port.postMessage(out, [out.buffer])
      }
      return true
    }
  }
}

if (
  typeof AudioWorkletProcessor === 'function' &&
  typeof registerProcessor === 'function'
) {
  const ProcessorClass = createPcmCaptureProcessorClass(
    AudioWorkletProcessor,
    () => (typeof sampleRate === 'number' ? sampleRate : TARGET_SAMPLE_RATE),
  )
  registerProcessor('pcm-capture', ProcessorClass)
}
