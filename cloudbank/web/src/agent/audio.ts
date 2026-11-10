import { CHUNK_SAMPLES_100MS, TARGET_SAMPLE_RATE } from './resampler'

export const INPUT_SAMPLE_RATE = TARGET_SAMPLE_RATE
export const OUTPUT_SAMPLE_RATE = 24000
export const TRAILING_SILENCE_INTERVAL_MS = 100
export const MAX_TRAILING_SILENCE_MS = 2500

export function float32ToPcm16Base64(samples: Float32Array): string {
  const buf = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buf)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
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

export const SILENCE_100MS_B64 = float32ToPcm16Base64(new Float32Array(CHUNK_SAMPLES_100MS))

export interface TrailingSilenceController {
  beginTrailingSilence(): void
  cancelTrailingSilence(): void
  isActive(): boolean
}

/**
 * Streams 100 ms silence frames after PTT release so CES's server-side VAD closes
 * the turn promptly, stopping immediately upon server reaction or at 2,500 ms.
 */
export function createTrailingSilenceController(
  sendFrame: (base64: string) => void,
  opts: {
    intervalMs?: number
    maxDurationMs?: number
  } = {},
): TrailingSilenceController {
  const intervalMs = opts.intervalMs ?? TRAILING_SILENCE_INTERVAL_MS
  const maxDurationMs = opts.maxDurationMs ?? MAX_TRAILING_SILENCE_MS
  const maxFrames = Math.max(1, Math.floor(maxDurationMs / intervalMs))
  let timerId: ReturnType<typeof setInterval> | null = null
  let sentFrames = 0

  function cancelTrailingSilence() {
    if (timerId !== null) {
      clearInterval(timerId)
      timerId = null
    }
    sentFrames = 0
  }

  function beginTrailingSilence() {
    cancelTrailingSilence()
    // Emit first 100 ms silence frame immediately after flushed speech, then every 100 ms up to cap.
    sentFrames = 1
    sendFrame(SILENCE_100MS_B64)
    if (sentFrames >= maxFrames) return

    timerId = setInterval(() => {
      sentFrames += 1
      sendFrame(SILENCE_100MS_B64)
      if (sentFrames >= maxFrames) {
        cancelTrailingSilence()
      }
    }, intervalMs)
  }

  return {
    beginTrailingSilence,
    cancelTrailingSilence,
    isActive: () => timerId !== null,
  }
}

export type MutedFill = 'silence' | 'dither'
export type AudioFrameHandler = (base64: string) => void

export interface AudioCapture {
  start(): Promise<void>
  stop(): void
  setMuted(muted: boolean): void
  isMuted(): boolean
  flushAndSendTrailingSilence(): void
  notifyServerReaction(): void
}

export async function createAudioCapture(
  onFrame: AudioFrameHandler,
  opts: { startMuted?: boolean } = {},
): Promise<AudioCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: INPUT_SAMPLE_RATE,
      echoCancellation: true,
      noiseSuppression: true,
    },
  })
  let ctx: AudioContext | null = null
  try {
    ctx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE })
    await ctx.audioWorklet.addModule('/audio-worklet.js')
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    if (ctx) void ctx.close()
    throw err
  }
  const audioCtx = ctx
  const source = audioCtx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(audioCtx, 'pcm-capture')

  let muted = opts.startMuted ?? false

  const trailingSilence = createTrailingSilenceController((silenceB64) => {
    if (!stopped) onFrame(silenceB64)
  })

  function applyTrackEnabled() {
    for (const t of stream.getAudioTracks()) t.enabled = !muted
  }
  applyTrackEnabled()

  node.port.onmessage = (
    e: MessageEvent<Float32Array | { type: 'flushed'; samples: Float32Array }>,
  ) => {
    if (stopped) return
    const payload = e.data
    if (
      payload &&
      !(payload instanceof Float32Array) &&
      payload.type === 'flushed'
    ) {
      if (payload.samples.length > 0) {
        onFrame(float32ToPcm16Base64(payload.samples))
      }
      return
    }
    if (muted) {
      // Under PTT idle, suppress background frames so the 900s proxy idle clock stays accurate.
      return
    }
    if (payload instanceof Float32Array && payload.length > 0) {
      onFrame(float32ToPcm16Base64(payload))
    }
  }

  source.connect(node)
  let stopped = false

  return {
    async start() {
      if (audioCtx.state === 'suspended') await audioCtx.resume()
    },
    stop() {
      if (stopped) return
      stopped = true
      trailingSilence.cancelTrailingSilence()
      node.disconnect()
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      void audioCtx.close()
    },
    setMuted(next: boolean) {
      if (!next) {
        trailingSilence.cancelTrailingSilence()
      }
      if (muted === next) return
      muted = next
      applyTrackEnabled()
    },
    isMuted() {
      return muted
    },
    flushAndSendTrailingSilence() {
      if (stopped) return
      muted = true
      applyTrackEnabled()
      try {
        node.port.postMessage({ type: 'flush' })
      } catch {
        // Ignore if port unsupported in minimal test stub.
      }
      trailingSilence.beginTrailingSilence()
    },
    notifyServerReaction() {
      trailingSilence.cancelTrailingSilence()
    },
  }
}

export interface AudioPlayer {
  enqueue(base64: string): void
  flush(): void
  close(): void
  isPlaying(): boolean
}

export interface AudioPlayerOptions {
  onIdle?: () => void
}

const DRAIN_DEBOUNCE_MS = 120

export function createAudioPlayer(opts: AudioPlayerOptions = {}): AudioPlayer {
  const { onIdle } = opts
  const ctx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE })
  let cursor = ctx.currentTime
  const sources: AudioBufferSourceNode[] = []
  let closed = false
  let playing = false
  let drainTimer: ReturnType<typeof setTimeout> | null = null

  function clearDrainTimer() {
    if (drainTimer !== null) {
      clearTimeout(drainTimer)
      drainTimer = null
    }
  }

  function scheduleDrainCheck() {
    clearDrainTimer()
    const msUntilDrained = Math.max(0, (cursor - ctx.currentTime) * 1000) + DRAIN_DEBOUNCE_MS
    drainTimer = setTimeout(() => {
      drainTimer = null
      if (!closed && cursor - ctx.currentTime <= 0) {
        playing = false
        onIdle?.()
      }
    }, msUntilDrained)
  }

  return {
    enqueue(base64: string) {
      if (closed) return
      if (ctx.state === 'suspended') void ctx.resume()
      const samples = base64Pcm16ToFloat32(base64)
      const buf = ctx.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE)
      buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      const startAt = Math.max(ctx.currentTime, cursor)
      src.start(startAt)
      cursor = startAt + buf.duration
      playing = true
      sources.push(src)
      src.onended = () => {
        const i = sources.indexOf(src)
        if (i >= 0) sources.splice(i, 1)
      }
      scheduleDrainCheck()
    },
    flush() {
      clearDrainTimer()
      playing = false
      for (const s of sources.splice(0)) {
        try {
          s.stop()
        } catch {
          // Source may already have ended.
        }
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
    isPlaying() {
      return playing
    },
  }
}
