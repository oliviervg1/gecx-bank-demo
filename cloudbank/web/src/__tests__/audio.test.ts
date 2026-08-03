import { describe, it, expect } from 'vitest'
import { float32ToPcm16Base64 } from '../agent/audio'

describe('float32ToPcm16Base64', () => {
  it('encodes silence as base64', () => {
    const silence = new Float32Array(160) // 10ms at 16k
    const encoded = float32ToPcm16Base64(silence)
    // 160 samples * 2 bytes = 320 bytes → base64 length = ceil(320/3)*4 = 428
    expect(encoded).toHaveLength(428)
    // All zeros encode to 'AAAA...'
    expect(encoded.startsWith('AAAA')).toBe(true)
  })

  it('clamps values above 1.0 to int16 max', () => {
    const loud = new Float32Array([1.5, -1.5])
    const encoded = float32ToPcm16Base64(loud)
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0))
    const view = new DataView(bytes.buffer)
    expect(view.getInt16(0, true)).toBe(32767)
    expect(view.getInt16(2, true)).toBe(-32768)
  })

  it('round-trips a known value', () => {
    const input = new Float32Array([0.5])
    const encoded = float32ToPcm16Base64(input)
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0))
    const view = new DataView(bytes.buffer)
    // 0.5 * 32767 = 16383 (rounded down)
    expect(view.getInt16(0, true)).toBe(16383)
  })
})
