import { describe, it, expect } from 'vitest'
import { parseServerMsg, serializeClientMsg, type ServerMsg } from '../agent/protocol'
import { getFixture } from '../data/fixture'
import { buildSessionVariables } from '../agent/sessionVariables'

describe('protocol.ts — symmetric with cloudbank/proxy/src/proxy/protocol.py', () => {
  it('parses all 13 server message variants cleanly', () => {
    const ready: ServerMsg = parseServerMsg(
      JSON.stringify({ type: 'ready', sessionId: 'sess-123' }),
    )
    expect(ready).toEqual({ type: 'ready', sessionId: 'sess-123' })

    expect(parseServerMsg(JSON.stringify({ type: 'audio', data: 'AAAA' }))).toEqual({
      type: 'audio',
      data: 'AAAA',
    })
    expect(
      parseServerMsg(JSON.stringify({ type: 'transcript', text: 'hi', isFinal: true })),
    ).toEqual({ type: 'transcript', text: 'hi', isFinal: true })
    expect(
      parseServerMsg(JSON.stringify({ type: 'text', text: 'Hello', partial: true })),
    ).toEqual({ type: 'text', text: 'Hello', partial: true })
    expect(
      parseServerMsg(
        JSON.stringify({ type: 'ui_state', tier: 2, state: { seq: 1, page: 'savings' } }),
      ),
    ).toEqual({ type: 'ui_state', tier: 2, state: { seq: 1, page: 'savings' } })
    expect(
      parseServerMsg(JSON.stringify({ type: 'turn_diagnostics', turnIndex: 1 })),
    ).toEqual({
      type: 'turn_diagnostics',
      turnIndex: 1,
      agentTransfers: [],
      toolCalls: [],
      toolResponses: [],
      updatedVariables: {},
      rootSpan: undefined,
    })
    expect(
      parseServerMsg(
        JSON.stringify({
          type: 'search_suggestions',
          htmls: ['<div>q</div>'],
          webSearchQueries: ['cancel netflix'],
        }),
      ),
    ).toEqual({
      type: 'search_suggestions',
      htmls: ['<div>q</div>'],
      webSearchQueries: ['cancel netflix'],
      citations: [],
    })
    expect(parseServerMsg(JSON.stringify({ type: 'turn_complete', turnIndex: 2 }))).toEqual({
      type: 'turn_complete',
      turnIndex: 2,
    })
    expect(parseServerMsg(JSON.stringify({ type: 'go_away', sessionId: 's1' }))).toEqual({
      type: 'go_away',
      sessionId: 's1',
    })
    expect(
      parseServerMsg(JSON.stringify({ type: 'session_expired', message: 'idle' })),
    ).toEqual({ type: 'session_expired', message: 'idle' })
    expect(parseServerMsg(JSON.stringify({ type: 'interrupt' }))).toEqual({
      type: 'interrupt',
    })
    expect(parseServerMsg(JSON.stringify({ type: 'end' }))).toEqual({ type: 'end' })
    expect(
      parseServerMsg(
        JSON.stringify({ type: 'error', message: 'bad field', field: 'demo_date' }),
      ),
    ).toEqual({ type: 'error', message: 'bad field', field: 'demo_date' })
  })

  it('rejects removed client_function and malformed frames', () => {
    expect(() =>
      parseServerMsg(JSON.stringify({ type: 'client_function', id: '1', name: 'x', args: {} })),
    ).toThrow(/unknown server message/i)
    expect(() => parseServerMsg(JSON.stringify({ type: 'ready' }))).toThrow(/ready frame/)
    expect(() => parseServerMsg(JSON.stringify({ type: 'audio' }))).toThrow(/audio frame/)
    expect(() =>
      parseServerMsg(JSON.stringify({ type: 'ui_state', state: { seq: 1, page: 'bogus' } })),
    ).toThrow(/ui_state frame/)
    expect(() => parseServerMsg(JSON.stringify({ type: 'go_away' }))).toThrow(/go_away frame/)
  })

  it('omits null/undefined sessionId on start serialization and preserves GoAway sessionId', () => {
    const vars = buildSessionVariables('chloe', getFixture('chloe'), {
      demoDate: '2026-11-24',
      timeOfDay: 'morning',
    })
    const fresh = JSON.parse(
      serializeClientMsg({ type: 'start', persona: 'chloe', variables: vars, sessionId: null }),
    )
    expect(fresh).not.toHaveProperty('sessionId')

    const resumed = JSON.parse(
      serializeClientMsg({
        type: 'start',
        persona: 'chloe',
        variables: vars,
        sessionId: 'sess-goaway',
      }),
    )
    expect(resumed.sessionId).toBe('sess-goaway')
  })
})
