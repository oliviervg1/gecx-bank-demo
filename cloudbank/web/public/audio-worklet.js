class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0]
    if (ch && ch.length) {
      // Copy because the underlying buffer is reused by the worklet.
      this.port.postMessage(new Float32Array(ch))
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)
