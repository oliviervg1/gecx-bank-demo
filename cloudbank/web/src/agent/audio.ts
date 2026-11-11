import pcmCaptureWorkletUrl from './pcmCaptureWorklet?worker&url'
import { CHUNK_SAMPLES_100MS, TARGET_SAMPLE_RATE } from './pcmResampler'

export const INPUT_SAMPLE_RATE = TARGET_SAMPLE_RATE
export const OUTPUT_SAMPLE_RATE = 24000
export const TRAILING_SILENCE_INTERVAL_MS = 100
export const MAX_TRAILING_SILENCE_MS = 2500
const FLUSH_REPLY_FALLBACK_MS = 25

export function float32ToPcm16Base64(samples: Float32Array): string {
  const buf = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buf)
  for (let i = 0; i < samples.length; i++) {
    const raw = samples[i] ?? 0
    const s = Math.max(-1, Math.min(1, raw))
    view.setInt16(i * 2, s < 0 ? Math.trunc(s * 32768) : Math.trunc(s * 32767), true)
  }
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i] ?? 0)
  }
  return btoa(bin)
}

export function base64Pcm16ToFloat32(b64: string): Float32Array {
  if (!b64) return new Float32Array(0)
  let bin: string
  try {
    bin = atob(b64)
  } catch {
    return new Float32Array(0)
  }
  // Guard against empty or odd-byte PCM16 payloads so DataView never throws RangeError.
  const evenByteLen = bin.length - (bin.length % 2)
  if (evenByteLen <= 0) {
    return new Float32Array(0)
  }
  const buf = new ArrayBuffer(evenByteLen)
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < evenByteLen; i++) {
    bytes[i] = bin.charCodeAt(i)
  }
  const view = new DataView(buf)
  const samples = new Float32Array(evenByteLen / 2)
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
 * Streams 100 ms silence frames after PTT release so server-side VAD closes
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

export type AudioFrameHandler = (base64: string) => void

export interface AudioCapture {
  start(): Promise<void>
  stop(): void
  setMuted(muted: boolean): void
  isMuted(): boolean
  flushAndSendTrailingSilence(): void
  notifyServerReaction(): void
}

function resolveAudioContextCtor(): typeof AudioContext | null {
  if (typeof AudioContext === 'function') return AudioContext
  const webkit = (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  return typeof webkit === 'function' ? webkit : null
}

export async function createAudioCapture(
  onFrame: AudioFrameHandler,
  opts: { startMuted?: boolean; signal?: AbortSignal } = {},
): Promise<AudioCapture> {
  if (opts.signal?.aborted) {
    throw new DOMException('Audio capture aborted before start', 'AbortError')
  }

  // Open microphone and AudioContext at native hardware sampleRate (e.g. 44.1 / 48 kHz)
  // so Firefox never throws a cross-rate MediaStreamSource mismatch; the bundled
  // pcm-capture worklet resamples to 16 kHz in 1,600-sample (100 ms) chunks.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  })

  if (opts.signal?.aborted) {
    stream.getTracks().forEach((t) => t.stop())
    throw new DOMException('Audio capture aborted during getUserMedia', 'AbortError')
  }

  const Ctx = resolveAudioContextCtor()
  if (!Ctx) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('Web Audio API is unavailable in this browser.')
  }

  let ctx: AudioContext | null = null
  let source: MediaStreamAudioSourceNode
  let node: AudioWorkletNode
  try {
    ctx = new Ctx()
    await ctx.audioWorklet.addModule(pcmCaptureWorkletUrl)
    if (opts.signal?.aborted) {
      throw new DOMException('Audio capture aborted during worklet load', 'AbortError')
    }
    source = ctx.createMediaStreamSource(stream)
    node = new AudioWorkletNode(ctx, 'pcm-capture')
    source.connect(node)
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    if (ctx) void ctx.close()
    throw err
  }

  const audioCtx = ctx
  let muted = opts.startMuted ?? false
  let stopped = false
  let awaitingFlushForSilence = false
  let flushFallbackTimer: ReturnType<typeof setTimeout> | null = null

  const trailingSilence = createTrailingSilenceController((silenceB64) => {
    if (!stopped) onFrame(silenceB64)
  })

  function clearPendingFlushSilence() {
    awaitingFlushForSilence = false
    if (flushFallbackTimer !== null) {
      clearTimeout(flushFallbackTimer)
      flushFallbackTimer = null
    }
  }

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
      if (flushFallbackTimer !== null) {
        clearTimeout(flushFallbackTimer)
        flushFallbackTimer = null
      }
      if (payload.samples.length > 0) {
        onFrame(float32ToPcm16Base64(payload.samples))
      }
      if (awaitingFlushForSilence) {
        awaitingFlushForSilence = false
        trailingSilence.beginTrailingSilence()
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

  return {
    async start() {
      if (audioCtx.state === 'suspended') await audioCtx.resume()
    },
    stop() {
      if (stopped) return
      stopped = true
      clearPendingFlushSilence()
      trailingSilence.cancelTrailingSilence()
      node.disconnect()
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      void audioCtx.close()
    },
    setMuted(next: boolean) {
      if (!next) {
        clearPendingFlushSilence()
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
      clearPendingFlushSilence()
      trailingSilence.cancelTrailingSilence()
      awaitingFlushForSilence = true
      try {
        node.port.postMessage({ type: 'flush' })
        // Fallback in case a minimal test stub has a no-op postMessage that never replies 'flushed'.
        flushFallbackTimer = setTimeout(() => {
          flushFallbackTimer = null
          if (awaitingFlushForSilence && !stopped) {
            awaitingFlushForSilence = false
            trailingSilence.beginTrailingSilence()
          }
        }, FLUSH_REPLY_FALLBACK_MS)
      } catch {
        awaitingFlushForSilence = false
        trailingSilence.beginTrailingSilence()
      }
    },
    notifyServerReaction() {
      clearPendingFlushSilence()
      trailingSilence.cancelTrailingSilence()
    },
  }
}

export interface AudioPlayer {
  enqueue(base64: string): void
  flush(): void
  close(): void
}

export interface AudioPlayerOptions {
  onIdle?: () => void
  onError?: (err: Error) => void
}

const DRAIN_DEBOUNCE_MS = 120

export function createAudioPlayer(opts: AudioPlayerOptions = {}): AudioPlayer {
  const { onIdle, onError } = opts
  const Ctx = resolveAudioContextCtor()
  if (!Ctx) {
    throw new Error('Web Audio API is unavailable in this browser.')
  }
  // Open at native hardware sampleRate so OS audio drivers never reject 24000 Hz;
  // AudioBufferSourceNode natively resamples 24000 Hz AudioBuffers to ctx.sampleRate.
  const ctx = new Ctx()
  let cursor = ctx.currentTime
  let expectedDrainWallMs = Date.now()
  const sources: AudioBufferSourceNode[] = []
  let closed = false
  let drainTimer: ReturnType<typeof setTimeout> | null = null

  function clearDrainTimer() {
    if (drainTimer !== null) {
      clearTimeout(drainTimer)
      drainTimer = null
    }
  }

  function scheduleDrainCheck(msHint?: number) {
    clearDrainTimer()
    const audioRemainingMs = Math.max(0, (cursor - ctx.currentTime) * 1000)
    const waitMs = (msHint !== undefined ? Math.max(0, msHint) : audioRemainingMs) + DRAIN_DEBOUNCE_MS
    drainTimer = setTimeout(() => {
      drainTimer = null
      if (closed) return
      // Guard against suspended contexts where ctx.currentTime stays frozen at 0:
      // once either the audio clock or wall-clock playback duration has elapsed, release idle.
      const contextStalled = ctx.state !== 'running' && Date.now() >= expectedDrainWallMs
      if (cursor - ctx.currentTime <= 0.005 || contextStalled) {
        cursor = ctx.currentTime
        onIdle?.()
      } else {
        scheduleDrainCheck()
      }
    }, waitMs)
  }

  return {
    enqueue(base64: string) {
      if (closed) return
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {
          // Autoplay restriction: scheduleDrainCheck wall-clock guard prevents stall.
        })
      }
      const samples = base64Pcm16ToFloat32(base64)
      if (samples.length === 0) {
        scheduleDrainCheck(0)
        return
      }
      try {
        const buf = ctx.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE)
        buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
        const src = ctx.createBufferSource()
        src.buffer = buf
        src.connect(ctx.destination)
        const startAt = Math.max(ctx.currentTime, cursor)
        src.start(startAt)
        cursor = startAt + buf.duration
        const wallDurationMs = Math.max(0, (cursor - ctx.currentTime) * 1000)
        expectedDrainWallMs = Date.now() + wallDurationMs
        sources.push(src)
        src.onended = () => {
          const i = sources.indexOf(src)
          if (i >= 0) sources.splice(i, 1)
        }
        scheduleDrainCheck(wallDurationMs)
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        onError?.(error)
        scheduleDrainCheck(0)
      }
    },
    flush() {
      clearDrainTimer()
      for (const s of sources.splice(0)) {
        try {
          s.stop()
        } catch {
          // Source may already have ended.
        }
      }
      cursor = ctx.currentTime
      expectedDrainWallMs = Date.now()
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
