export const INPUT_SAMPLE_RATE = 16000
export const OUTPUT_SAMPLE_RATE = 24000

export function float32ToPcm16Base64(samples: Float32Array): string {
  const buf = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buf)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    // Asymmetric int16 range; multiply differently for positive vs negative.
    // Truncate toward zero to match the documented round-down behavior
    // (e.g. 0.5 * 32767 = 16383.5 → 16383, not 16384 as Math.round would give).
    view.setInt16(i * 2, s < 0 ? Math.trunc(s * 32768) : Math.trunc(s * 32767), true)
  }
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export function base64Pcm16ToFloat32(b64: string): Float32Array {
  const bin = atob(b64)
  const buf = new ArrayBuffer(bin.length)
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const view = new DataView(buf)
  const samples = new Float32Array(bin.length / 2)
  for (let i = 0; i < samples.length; i++) {
    const v = view.getInt16(i * 2, true)
    samples[i] = v < 0 ? v / 32768 : v / 32767
  }
  return samples
}

export interface AudioCapture {
  start(): Promise<void>
  stop(): void
  // Push-to-talk. Muting does NOT stop the frame stream: it replaces the
  // captured samples with silence at the same cadence and size. That matters
  // because CES exposes no client-side turn control for audio —
  // SessionInput.will_continue explicitly excludes it, and InputAudioConfig has
  // no VAD settings — so the only way to end a turn is for the endpointer to
  // hear speech stop. Sending nothing at all risks it simply waiting.
  setMuted(muted: boolean): void
  isMuted(): boolean
}

export type AudioFrameHandler = (base64: string) => void

// What we transmit while muted.
//
// `silence` is digital zero, and is the mode in use: verified live on
// 2026-08-03 that CES's endpointer treats it as end-of-speech, so releasing a
// hold ends the turn. That was not a given — some VADs key off a noise floor
// and read digital zero as "no signal" rather than "speech ended".
//
// `dither` is kept as insurance for that case: an inaudible ~-60 dBFS floor
// that keeps the signal path alive. Switching is one argument at the
// createAudioCapture call site.
export type MutedFill = 'silence' | 'dither'

const DITHER_AMPLITUDE = 0.001 // ≈ -60 dBFS

function fillMuted(out: Float32Array, mode: MutedFill): Float32Array {
  if (mode === 'dither') {
    for (let i = 0; i < out.length; i++) {
      out[i] = (Math.random() * 2 - 1) * DITHER_AMPLITUDE
    }
  }
  // 'silence': a fresh Float32Array is already zero-filled.
  return out
}

export async function createAudioCapture(
  onFrame: AudioFrameHandler,
  opts: { mutedFill?: MutedFill; startMuted?: boolean } = {},
): Promise<AudioCapture> {
  const mutedFill: MutedFill = opts.mutedFill ?? 'silence'
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, sampleRate: INPUT_SAMPLE_RATE, echoCancellation: true, noiseSuppression: true },
  })
  let ctx: AudioContext
  try {
    ctx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE })
    await ctx.audioWorklet.addModule('/audio-worklet.js')
  } catch (err) {
    // addModule can fail with 404/network/MIME — release the mic and ctx
    // so the browser doesn't keep the recording indicator on a half-built capture.
    stream.getTracks().forEach((t) => t.stop())
    if (ctx!) void ctx.close()
    throw err
  }
  const source = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'pcm-capture')

  let muted = opts.startMuted ?? false

  function applyTrackEnabled() {
    // Belt: a disabled track produces silence per spec. The braces is the
    // substitution in onmessage below — together they make the behaviour
    // deterministic regardless of how a given browser treats a disabled track
    // feeding a MediaStreamAudioSourceNode.
    for (const t of stream.getAudioTracks()) t.enabled = !muted
  }
  applyTrackEnabled()

  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const samples = muted
      ? fillMuted(new Float32Array(e.data.length), mutedFill)
      : e.data
    onFrame(float32ToPcm16Base64(samples))
  }
  source.connect(node)
  let stopped = false
  return {
    async start() {
      if (ctx.state === 'suspended') await ctx.resume()
    },
    stop() {
      if (stopped) return
      stopped = true
      node.disconnect()
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
    },
    setMuted(next: boolean) {
      if (muted === next) return
      muted = next
      applyTrackEnabled()
    },
    isMuted() {
      return muted
    },
  }
}

export interface AudioPlayer {
  enqueue(base64: string): void
  flush(): void
  close(): void
}

export interface AudioPlayerOptions {
  // Fired when the scheduled audio queue drains — i.e. the agent has
  // finished speaking and no new chunk has arrived in the meantime.
  // Used to flip the ConciergePill back to "Listening" so the user can
  // reply without a refresh.
  onIdle?: () => void
}

// Small grace window after the last scheduled chunk finishes, to absorb
// network jitter / chunk-arrival pauses without flickering through Idle.
const DRAIN_DEBOUNCE_MS = 120

export function createAudioPlayer(opts: AudioPlayerOptions = {}): AudioPlayer {
  const { onIdle } = opts
  const ctx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE })
  let cursor = ctx.currentTime
  const sources: AudioBufferSourceNode[] = []
  let closed = false
  let drainTimer: number | null = null

  function clearDrainTimer() {
    if (drainTimer !== null) {
      clearTimeout(drainTimer)
      drainTimer = null
    }
  }

  function scheduleDrainCheck() {
    if (!onIdle) return
    clearDrainTimer()
    const msUntilDrained = Math.max(0, (cursor - ctx.currentTime) * 1000) + DRAIN_DEBOUNCE_MS
    drainTimer = window.setTimeout(() => {
      drainTimer = null
      // Verify the cursor hasn't moved past `now` since (a new enqueue would
      // have pushed cursor forward).
      if (!closed && cursor - ctx.currentTime <= 0) {
        onIdle()
      }
    }, msUntilDrained)
  }

  return {
    enqueue(base64: string) {
      if (closed) return
      // Safari constructs AudioContext in 'suspended' state even after a user
      // gesture elsewhere on the page; resume lazily on first chunk.
      if (ctx.state === 'suspended') void ctx.resume()
      const samples = base64Pcm16ToFloat32(base64)
      const buf = ctx.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE)
      // copyToChannel requires Float32Array<ArrayBuffer> (TS 5.7+ tightened
      // typed-array typing); the underlying buffer is already a plain
      // ArrayBuffer, so a structural cast is safe here.
      buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      const startAt = Math.max(ctx.currentTime, cursor)
      src.start(startAt)
      cursor = startAt + buf.duration
      sources.push(src)
      src.onended = () => {
        const i = sources.indexOf(src)
        if (i >= 0) sources.splice(i, 1)
      }
      scheduleDrainCheck()
    },
    flush() {
      clearDrainTimer()
      for (const s of sources.splice(0)) {
        try { s.stop() } catch {/* may have ended */}
      }
      cursor = ctx.currentTime
    },
    close() {
      if (closed) return
      closed = true
      clearDrainTimer()
      this.flush()
      void ctx.close()
    },
  }
}
