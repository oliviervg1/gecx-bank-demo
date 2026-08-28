// Browser ↔ proxy WS protocol. Mirrors cloudbank/proxy/src/proxy/protocol.py.

export type ClientMsg =
  // `sessionId` names the CES conversation to (re)join. The browser owns it so
  // that a reconnect after CES's ~20-30s inactivity close resumes the same
  // conversation rather than opening a blank one. See agent/sessionId.ts.
  | { type: 'start'; persona: 'chloe' | 'david' | 'tom' | 'sarah'; variables: Record<string, string>; sessionId: string }
  | { type: 'audio'; data: string } // base64 PCM16 16k
  | { type: 'text'; text: string }
  | { type: 'tool_response'; id: string; response: { output: Record<string, unknown> } | { error: string } }
  | { type: 'stop' }

export type ServerMsg =
  | { type: 'ready' }
  | { type: 'transcript'; text: string; isFinal: boolean }
  | { type: 'text'; text: string }
  | { type: 'audio'; data: string } // base64 PCM16 24k
  | { type: 'client_function'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'interrupt' }
  | { type: 'end' }
  | { type: 'error'; message: string }

const SERVER_TYPES = new Set([
  'ready', 'transcript', 'text', 'audio', 'client_function', 'interrupt', 'end', 'error',
])

export function parseServerMsg(raw: string): ServerMsg {
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
    throw new Error('unknown server message: missing type')
  }
  if (!SERVER_TYPES.has(parsed.type)) {
    throw new Error(`unknown server message: ${parsed.type}`)
  }
  // Validate the payload of the variants whose fields are dereferenced without
  // a guard downstream. Checking the discriminator alone is not enough: a
  // {"type":"audio"} frame with no `data` would reach atob(undefined) inside an
  // async onmessage handler, surfacing as an unhandled rejection rather than a
  // caught, logged parse failure.
  switch (parsed.type) {
    case 'audio':
      if (typeof parsed.data !== 'string') throw new Error('audio frame: missing data')
      break
    case 'transcript':
    case 'text':
      if (typeof parsed.text !== 'string') throw new Error(`${parsed.type} frame: missing text`)
      break
    case 'error':
      if (typeof parsed.message !== 'string') throw new Error('error frame: missing message')
      break
    case 'client_function':
      if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string') {
        throw new Error('client_function frame: missing id/name')
      }
      if (parsed.args !== undefined && (typeof parsed.args !== 'object' || parsed.args === null)) {
        throw new Error('client_function frame: args must be an object')
      }
      break
  }
  return parsed as ServerMsg
}

export function serializeClientMsg(msg: ClientMsg): string {
  return JSON.stringify(msg)
}
