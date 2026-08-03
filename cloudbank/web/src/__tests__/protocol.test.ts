import { describe, it, expect } from 'vitest'
import { parseServerMsg, serializeClientMsg, type ServerMsg } from '../agent/protocol'

describe('parseServerMsg', () => {
  it('parses a ready frame', () => {
    const msg: ServerMsg = parseServerMsg(JSON.stringify({ type: 'ready' }))
    expect(msg).toEqual({ type: 'ready' })
  })

  it('parses an audio frame with base64 data', () => {
    const msg = parseServerMsg(JSON.stringify({ type: 'audio', data: 'AAAA' }))
    expect(msg).toEqual({ type: 'audio', data: 'AAAA' })
  })

  it('parses a transcript frame', () => {
    const msg = parseServerMsg(
      JSON.stringify({ type: 'transcript', text: 'hello', isFinal: true }),
    )
    expect(msg).toEqual({ type: 'transcript', text: 'hello', isFinal: true })
  })

  it('parses a text frame', () => {
    const msg = parseServerMsg(JSON.stringify({ type: 'text', text: 'Hi Chloe' }))
    expect(msg).toEqual({ type: 'text', text: 'Hi Chloe' })
  })

  it('parses an error frame', () => {
    const msg = parseServerMsg(JSON.stringify({ type: 'error', message: 'auth' }))
    expect(msg).toEqual({ type: 'error', message: 'auth' })
  })

  it('throws on an unknown type', () => {
    expect(() => parseServerMsg(JSON.stringify({ type: 'mystery' }))).toThrow(
      /unknown server message/i,
    )
  })

  it('throws on malformed JSON', () => {
    expect(() => parseServerMsg('not-json')).toThrow()
  })

  it('parses a client_function server message', () => {
    const raw = JSON.stringify({ type: 'client_function', id: 'tc_1', name: 'navigate_to', args: { pageId: 'spending' } })
    const msg = parseServerMsg(raw)
    expect(msg).toEqual({ type: 'client_function', id: 'tc_1', name: 'navigate_to', args: { pageId: 'spending' } })
  })

  it('serializes a tool_response client message', () => {
    const raw = serializeClientMsg({ type: 'tool_response', id: 'tc_1', response: { output: {} } })
    expect(JSON.parse(raw)).toEqual({ type: 'tool_response', id: 'tc_1', response: { output: {} } })
  })

  // A recognised discriminator with a missing payload must be rejected here,
  // where the caller logs and drops the frame. Left to blow up downstream, an
  // audio frame with no `data` reaches atob(undefined) inside an async handler
  // and surfaces as an unhandled rejection.
  it.each([
    ['audio with no data', { type: 'audio' }, /audio frame/],
    ['audio with non-string data', { type: 'audio', data: 42 }, /audio frame/],
    ['transcript with no text', { type: 'transcript' }, /transcript frame/],
    ['text with no text', { type: 'text' }, /text frame/],
    ['error with no message', { type: 'error' }, /error frame/],
    ['client_function with no id', { type: 'client_function', name: 'x' }, /client_function frame/],
    ['client_function with no name', { type: 'client_function', id: 'tc_1' }, /client_function frame/],
  ])('rejects %s', (_label, frame, pattern) => {
    expect(() => parseServerMsg(JSON.stringify(frame))).toThrow(pattern as RegExp)
  })

  it('still accepts the payload-free variants', () => {
    for (const type of ['ready', 'interrupt', 'end']) {
      expect(parseServerMsg(JSON.stringify({ type }))).toEqual({ type })
    }
  })
})
