import { describe, it, expect } from 'vitest'
import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020'
import uiViewStateSchema from '../../../shared/ui_view_state.schema.json'
import wsProtocolSchema from '../../../shared/ws_protocol.schema.json'
import {
  MAX_AUDIO_B64_LEN,
  MAX_CLIENT_TEXT_CHARS,
  parseServerMsg,
  parseUiViewStatePayload,
  serializeClientMsg,
  type ClientMsg,
  type ServerMsg,
} from '../agent/protocol'
import { buildClientStart } from '../agent/sessionVariables'

function createProtocolValidators() {
  const schemaDialect = String((wsProtocolSchema as { $schema?: string }).$schema ?? '')
  const ajv = schemaDialect.includes('2020-12')
    ? new Ajv2020({ allErrors: true, strict: false })
    : new Ajv({ allErrors: true, strict: false })

  ajv.addSchema(uiViewStateSchema)
  ajv.addSchema(wsProtocolSchema)

  const wsId =
    (wsProtocolSchema as { $id?: string }).$id ??
    'https://cloudbank.example.com/schemas/ws_protocol.schema.json'

  const validateRoot = ajv.getSchema(wsId)
  const validateClient =
    ajv.getSchema(`${wsId}#/definitions/ClientMsg`) ??
    ajv.getSchema(`${wsId}#/$defs/ClientMsg`)
  const validateServer =
    ajv.getSchema(`${wsId}#/definitions/ServerMsg`) ??
    ajv.getSchema(`${wsId}#/$defs/ServerMsg`)

  if (!validateRoot || !validateClient || !validateServer) {
    throw new Error('Failed to compile ws_protocol.schema.json validators with Ajv')
  }

  return { ajv, validateRoot, validateClient, validateServer }
}

const { ajv, validateRoot, validateClient, validateServer } = createProtocolValidators()

describe('protocol.ts: validated with Ajv against shared/ws_protocol.schema.json', () => {
  it('serializes all ClientMsg variants in strict conformance with ws_protocol.schema.json', () => {
    const clientSamples: ClientMsg[] = [
      buildClientStart('chloe', { demoDate: '2026-11-24', timeOfDay: 'morning' }),
      buildClientStart('sarah', {
        demoDate: '2026-11-24',
        timeOfDay: 'evening',
        sessionId: 'sess-resume-1',
        lastUiSeq: 4,
      }),
      { type: 'audio', data: 'AAAA' },
      { type: 'text', text: 'Show my savings pot' },
      { type: 'stop' },
    ]

    for (const sample of clientSamples) {
      const wireObj: unknown = JSON.parse(serializeClientMsg(sample))
      expect(validateClient(wireObj), ajv.errorsText(validateClient.errors)).toBe(true)
      expect(validateRoot(wireObj), ajv.errorsText(validateRoot.errors)).toBe(true)
    }
  })

  it('parses all 13 ServerMsg variants in strict conformance with ws_protocol.schema.json', () => {
    const serverPayloads: Array<Record<string, unknown>> = [
      { type: 'ready', sessionId: 'sess-123' },
      { type: 'audio', data: 'AAAA' },
      { type: 'transcript', text: 'hi', isFinal: true },
      { type: 'text', text: 'Hello', partial: true },
      {
        type: 'ui_state',
        tier: 2,
        state: {
          seq: 1,
          page: 'spending',
          view: 'subscriptions',
          period: 'this_month',
          highlight_vendor: 'Netflix',
          anomaly_status: 'confirmed',
        },
      },
      {
        type: 'turn_diagnostics',
        turnIndex: 1,
        agentTransfers: [{ targetAgent: 'savings_agent' }],
      },
      {
        type: 'search_suggestions',
        htmls: ['<div>q</div>'],
        webSearchQueries: ['cancel netflix'],
        citations: [{ title: 'Netflix Help', uri: 'https://help.netflix.com/cancel' }],
      },
      { type: 'turn_complete', turnIndex: 2 },
      { type: 'go_away', sessionId: 's1' },
      { type: 'session_expired', message: 'idle' },
      { type: 'interrupt' },
      { type: 'end' },
      { type: 'error', message: 'bad field', field: 'demoDate' },
    ]

    for (const rawObj of serverPayloads) {
      expect(validateServer(rawObj), ajv.errorsText(validateServer.errors)).toBe(true)
      const parsed: ServerMsg = parseServerMsg(JSON.stringify(rawObj))
      expect(validateServer(parsed), ajv.errorsText(validateServer.errors)).toBe(true)
    }
  })

  it('parses per-vendor anomaly_by_vendor maps and enforces MAX_AUDIO_B64_LEN = 87,384 & MAX_CLIENT_TEXT_CHARS = 8,192', () => {
    expect(MAX_AUDIO_B64_LEN).toBe(87_384)
    expect(MAX_CLIENT_TEXT_CHARS).toBe(8_192)

    const parsed = parseUiViewStatePayload({
      seq: 3,
      page: 'spending',
      view: 'overview',
      highlight_vendor: 'Netflix',
      anomaly_by_vendor: {
        Netflix: 'unrecognised',
        PureGym: 'confirmed',
      },
    })
    expect(parsed.anomaly_by_vendor).toEqual({
      Netflix: 'unrecognised',
      PureGym: 'confirmed',
    })

    if ('anomaly_by_vendor' in (uiViewStateSchema as { properties?: Record<string, unknown> }).properties!) {
      const uiFrame = { type: 'ui_state', tier: 1, state: parsed }
      expect(validateServer(uiFrame), ajv.errorsText(validateServer.errors)).toBe(true)
    }

    expect(() =>
      parseUiViewStatePayload({
        seq: 4,
        page: 'spending',
        anomaly_by_vendor: { '<script>': 'confirmed' },
      }),
    ).toThrow(/anomaly_by_vendor/)

    expect(() =>
      parseUiViewStatePayload({
        seq: 4,
        page: 'spending',
        anomaly_by_vendor: { Netflix: 'bogus' },
      }),
    ).toThrow(/anomaly_by_vendor/)

    expect(() => serializeClientMsg({ type: 'audio', data: '' })).toThrow(/audio frame/)
    expect(() =>
      serializeClientMsg({ type: 'audio', data: 'A'.repeat(MAX_AUDIO_B64_LEN + 1) }),
    ).toThrow(/87384/)
    expect(
      JSON.parse(serializeClientMsg({ type: 'audio', data: 'A'.repeat(MAX_AUDIO_B64_LEN) })).type,
    ).toBe('audio')

    expect(() =>
      serializeClientMsg({ type: 'text', text: 'x'.repeat(MAX_CLIENT_TEXT_CHARS + 1) }),
    ).toThrow(/8192/)
  })

  it('rejects removed client_function, malformed frames, and hostile ui_state properties', () => {
    expect(() =>
      parseServerMsg(JSON.stringify({ type: 'client_function', id: '1', name: 'x', args: {} })),
    ).toThrow(/unknown server message/i)
    expect(() => parseServerMsg(JSON.stringify({ type: 'ready' }))).toThrow(/ready frame/)
    expect(() => parseServerMsg(JSON.stringify({ type: 'audio' }))).toThrow(/audio frame/)
    expect(() =>
      parseServerMsg(
        JSON.stringify({ type: 'ui_state', tier: 1, state: { seq: 1, page: 'bogus' } }),
      ),
    ).toThrow(/ui_state frame/)
    expect(() =>
      parseServerMsg(
        JSON.stringify({
          type: 'ui_state',
          tier: 1,
          state: { seq: 1, page: 'spending', vendor: '<script>x</script>' },
        }),
      ),
    ).toThrow(/ui_state frame/)
    expect(() =>
      parseServerMsg(
        JSON.stringify({
          type: 'ui_state',
          tier: 1,
          state: { seq: 1, page: 'home', injected: true },
        }),
      ),
    ).toThrow(/unexpected property/)
    expect(() => parseServerMsg(JSON.stringify({ type: 'go_away' }))).toThrow(/go_away frame/)
  })

  it('omits null/undefined sessionId and variables on start serialization, and includes sessionId + lastUiSeq on resume', () => {
    const fresh = JSON.parse(
      serializeClientMsg(
        buildClientStart('chloe', {
          demoDate: '2026-11-24',
          timeOfDay: 'morning',
          sessionId: null,
        }),
      ),
    )
    expect(fresh).toEqual({
      type: 'start',
      persona: 'chloe',
      timeOfDay: 'morning',
      demoDate: '2026-11-24',
    })
    expect(fresh).not.toHaveProperty('variables')
    expect(fresh).not.toHaveProperty('sessionId')
    expect(fresh).not.toHaveProperty('lastUiSeq')

    const resumed = JSON.parse(
      serializeClientMsg(
        buildClientStart('chloe', {
          demoDate: '2026-11-24',
          timeOfDay: 'morning',
          sessionId: 'sess-goaway',
          lastUiSeq: 5,
        }),
      ),
    )
    expect(resumed.sessionId).toBe('sess-goaway')
    expect(resumed.lastUiSeq).toBe(5)
  })
})
