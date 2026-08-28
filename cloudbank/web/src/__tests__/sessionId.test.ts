import { describe, it, expect, afterEach } from 'vitest'
import { newSessionId } from '../agent/sessionId'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('newSessionId', () => {
  const realCrypto = globalThis.crypto

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true })
  })

  it('returns a v4 UUID', () => {
    expect(newSessionId()).toMatch(UUID_RE)
  })

  it('returns a distinct id each call', () => {
    const ids = new Set(Array.from({ length: 50 }, newSessionId))
    expect(ids.size).toBe(50)
  })

  it('falls back to a v4 UUID when crypto.randomUUID is unavailable', () => {
    // crypto.randomUUID only exists in a SECURE context. Serving the demo over
    // plain HTTP from a LAN IP (not localhost) leaves it undefined, and an
    // uncaught TypeError there would break the whole agent connection rather
    // than just the id. The proxy rejects anything that is not a UUID, so the
    // fallback has to produce the real shape, not a random string.
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })
    expect(newSessionId()).toMatch(UUID_RE)
  })
})
