// Stateful cross-rate fractional box-average resampler (16 / 44.1 / 48 kHz -> 16 kHz)
// emitting fixed 1,600-sample (100 ms) chunks and flushing partial speech on PTT release.

export const TARGET_SAMPLE_RATE = 16000
export const CHUNK_SAMPLES_100MS = 1600

export interface StatefulResampler {
  push(input: Float32Array): Float32Array[]
  flush(): Float32Array[]
  reset(): void
}

export function createStatefulResampler(
  inputSampleRate: number,
  targetSampleRate: number = TARGET_SAMPLE_RATE,
  chunkSize: number = CHUNK_SAMPLES_100MS,
): StatefulResampler {
  const ratio =
    inputSampleRate > 0 && targetSampleRate > 0 ? inputSampleRate / targetSampleRate : 1
  let accSum = 0
  let accWeight = 0
  let outBuffer = new Float32Array(chunkSize)
  let outIndex = 0

  return {
    push(input: Float32Array): Float32Array[] {
      const emitted: Float32Array[] = []
      if (!input || input.length === 0) return emitted

      for (let i = 0; i < input.length; i++) {
        const sample = input[i]
        let rem = 1.0
        while (rem > 1e-9) {
          const need = ratio - accWeight
          if (rem >= need - 1e-9) {
            accSum += sample * need
            outBuffer[outIndex++] = accSum / ratio
            if (outIndex === chunkSize) {
              emitted.push(outBuffer)
              outBuffer = new Float32Array(chunkSize)
              outIndex = 0
            }
            rem -= need
            accSum = 0
            accWeight = 0
          } else {
            accSum += sample * rem
            accWeight += rem
            rem = 0
          }
        }
      }

      return emitted
    },

    flush(): Float32Array[] {
      const emitted: Float32Array[] = []
      if (accWeight > 1e-6) {
        outBuffer[outIndex++] = accSum / accWeight
        accSum = 0
        accWeight = 0
        if (outIndex === chunkSize) {
          emitted.push(outBuffer)
          outBuffer = new Float32Array(chunkSize)
          outIndex = 0
        }
      }
      if (outIndex > 0) {
        emitted.push(outBuffer.slice(0, outIndex))
        outBuffer = new Float32Array(chunkSize)
        outIndex = 0
      }
      return emitted
    },

    reset(): void {
      accSum = 0
      accWeight = 0
      outBuffer = new Float32Array(chunkSize)
      outIndex = 0
    },
  }
}
