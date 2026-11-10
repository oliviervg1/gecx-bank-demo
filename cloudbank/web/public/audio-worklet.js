// Stateful cross-rate AudioWorkletProcessor resampling arbitrary hardware sampleRate
// (e.g. 16000, 44100, 48000 Hz) to 16000 Hz in 1600-sample (100 ms) chunks.
// Sending { type: 'flush' } over port immediately flushes any buffered speech as
// { type: 'flushed', samples: Float32Array } on PTT release.

const TARGET_RATE = 16000
const CHUNK_SAMPLES = 1600

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    const inRate = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : TARGET_RATE
    this._ratio = inRate / TARGET_RATE
    this._accSum = 0
    this._accWeight = 0
    this._outBuffer = new Float32Array(CHUNK_SAMPLES)
    this._outIndex = 0

    this.port.onmessage = (ev) => {
      const msg = ev && ev.data
      if (msg && msg.type === 'flush') {
        this._flushPartial()
      }
    }
  }

  _flushPartial() {
    if (this._accWeight > 1e-6) {
      this._outBuffer[this._outIndex++] = this._accSum / this._accWeight
      this._accSum = 0
      this._accWeight = 0
      if (this._outIndex === CHUNK_SAMPLES) {
        this.port.postMessage({ type: 'flushed', samples: this._outBuffer })
        this._outBuffer = new Float32Array(CHUNK_SAMPLES)
        this._outIndex = 0
        return
      }
    }
    if (this._outIndex > 0) {
      const tail = this._outBuffer.slice(0, this._outIndex)
      this._outBuffer = new Float32Array(CHUNK_SAMPLES)
      this._outIndex = 0
      this.port.postMessage({ type: 'flushed', samples: tail })
      return
    }
    this.port.postMessage({ type: 'flushed', samples: new Float32Array(0) })
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch || !ch.length) {
      return true
    }

    const ratio = this._ratio
    for (let i = 0; i < ch.length; i++) {
      const sample = ch[i]
      let rem = 1.0
      while (rem > 1e-9) {
        const need = ratio - this._accWeight
        if (rem >= need - 1e-9) {
          this._accSum += sample * need
          this._outBuffer[this._outIndex++] = this._accSum / ratio
          if (this._outIndex === CHUNK_SAMPLES) {
            this.port.postMessage(this._outBuffer)
            this._outBuffer = new Float32Array(CHUNK_SAMPLES)
            this._outIndex = 0
          }
          rem -= need
          this._accSum = 0
          this._accWeight = 0
        } else {
          this._accSum += sample * rem
          this._accWeight += rem
          rem = 0
        }
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCapture)
