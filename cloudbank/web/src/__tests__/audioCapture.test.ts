// Tests the push-to-talk mute mechanism in createAudioCapture.
//
// The global setup stubs cover AudioContext for PLAYBACK only — no
// getUserMedia, no audioWorklet, no AudioWorkletNode. The harness below fills
// that gap and is scoped to this file rather than added to setup.ts, so it
// cannot perturb the other suites.
//
// What matters here is not just "is it silent" but "does the frame stream keep
// its cadence and size". CES has no client-side turn control for audio, so the
// endpointer closing a turn depends on continuing to receive frames that
// happen to contain silence. A mute that stopped the stream would look correct
// in a unit test and hang the agent in a demo.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createAudioCapture } from '../agent/audio'

interface FakeTrack { enabled: boolean; stop: () => void }
let tracks: FakeTrack[] = []
let workletPort: { onmessage: ((e: { data: Float32Array }) => void) | null } | null = null

const originals = {
  AudioContext: globalThis.AudioContext,
  AudioWorkletNode: (globalThis as Record<string, unknown>).AudioWorkletNode,
  mediaDevices: navigator.mediaDevices,
}

beforeEach(() => {
  tracks = [{ enabled: true, stop: vi.fn() }]
  workletPort = null

  class CaptureContextStub {
    state = 'running'
    audioWorklet = { addModule: () => Promise.resolve() }
    constructor(_o?: unknown) {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    resume() { return Promise.resolve() }
    close() { return Promise.resolve() }
  }
  class WorkletNodeStub {
    port: { onmessage: ((e: { data: Float32Array }) => void) | null } = { onmessage: null }
    constructor(_ctx: unknown, _name: string) { workletPort = this.port }
    disconnect() {}
  }
  ;(globalThis as Record<string, unknown>).AudioContext = CaptureContextStub
  ;(globalThis as Record<string, unknown>).AudioWorkletNode = WorkletNodeStub
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => Promise.resolve({ getTracks: () => tracks, getAudioTracks: () => tracks }) },
  })
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).AudioContext = originals.AudioContext
  ;(globalThis as Record<string, unknown>).AudioWorkletNode = originals.AudioWorkletNode
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true, value: originals.mediaDevices,
  })
})

/** Push a frame of loud audio through the worklet and decode what was sent. */
function emitLoudFrame(samples = 160): Int16Array {
  const captured = new Float32Array(samples).fill(0.5)
  workletPort!.onmessage!({ data: captured })
  return decode(lastFrame!)
}

let lastFrame: string | null = null
function decode(b64: string): Int16Array {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return new Int16Array(bytes.buffer)
}

async function makeCapture(opts?: Parameters<typeof createAudioCapture>[1]) {
  lastFrame = null
  return createAudioCapture((b64) => { lastFrame = b64 }, opts)
}

describe('createAudioCapture — push-to-talk muting', () => {
  it('passes samples through when unmuted', async () => {
    await makeCapture()
    const pcm = emitLoudFrame()
    expect(pcm.every((v) => v === 16383)).toBe(true) // 0.5 * 32767
  })

  it('emits silence when muted', async () => {
    const cap = await makeCapture()
    cap.setMuted(true)
    const pcm = emitLoudFrame()
    expect(pcm.every((v) => v === 0)).toBe(true)
  })

  it('keeps frame size and cadence identical while muted', async () => {
    // The endpointer needs a continuous stream to hear speech stop. If muting
    // dropped frames or changed their length, a released hold might never end
    // the turn.
    const cap = await makeCapture()
    emitLoudFrame(160)
    const unmutedLength = lastFrame!.length
    let framesWhileMuted = 0
    const orig = workletPort!.onmessage!
    workletPort!.onmessage = (e) => { framesWhileMuted++; orig(e) }

    cap.setMuted(true)
    emitLoudFrame(160)
    emitLoudFrame(160)

    expect(framesWhileMuted).toBe(2)          // stream did not stop
    expect(lastFrame!.length).toBe(unmutedLength) // size unchanged
  })

  it('disables the underlying track as well as substituting silence', async () => {
    // Belt and braces: the substitution makes behaviour deterministic, the
    // disabled track means the browser itself stops delivering audio.
    const cap = await makeCapture()
    expect(tracks[0].enabled).toBe(true)
    cap.setMuted(true)
    expect(tracks[0].enabled).toBe(false)
    cap.setMuted(false)
    expect(tracks[0].enabled).toBe(true)
  })

  it('can start muted, so the mic is never hot before the first press', async () => {
    const cap = await makeCapture({ startMuted: true })
    expect(cap.isMuted()).toBe(true)
    expect(tracks[0].enabled).toBe(false)
    expect(emitLoudFrame().every((v) => v === 0)).toBe(true)
  })

  it('emits an inaudible noise floor in dither mode', async () => {
    // The contingency if CES's endpointer ignores pure digital silence.
    const cap = await makeCapture({ mutedFill: 'dither', startMuted: true })
    expect(cap.isMuted()).toBe(true)
    const pcm = emitLoudFrame(400)
    const peak = Math.max(...Array.from(pcm, Math.abs))
    expect(peak).toBeGreaterThan(0)   // signal path stays alive
    expect(peak).toBeLessThan(200)    // ≈ -60 dBFS: inaudible, unintelligible
  })

  it('unmuting restores real audio', async () => {
    const cap = await makeCapture({ startMuted: true })
    expect(emitLoudFrame().every((v) => v === 0)).toBe(true)
    cap.setMuted(false)
    expect(emitLoudFrame().every((v) => v === 16383)).toBe(true)
  })
})
