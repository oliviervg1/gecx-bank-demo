// Identifier for the CES conversation this tab is having.
//
// CES closes a BidiRunSession that receives no speech after ~20-30s. The
// browser reconnects through that, and reconnecting with the SAME session id
// is what makes the new socket resume the existing conversation instead of
// starting a blank one — verified against CES: a reused id recalls the prior
// turn, a fresh id answers "you haven't asked about any shops yet".
//
// The proxy re-parses this as a UUID and substitutes its own if it does not
// parse (it is interpolated into the CES resource path), so the shape here is
// a hard requirement, not a convention.

export function newSessionId(): string {
  // Only defined in a secure context. Serving the app over plain HTTP from a
  // LAN IP leaves it undefined, and letting that throw would take down the
  // whole agent connection rather than degrade one id.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40   // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80   // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20),
  ].join('-')
}
