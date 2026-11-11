import { describe, it, expect } from 'vitest'
import wsProtocolSchema from '../../../shared/ws_protocol.schema.json'
import {
  parseServerMsg,
  serializeClientMsg,
  type ClientMsg,
  type ServerMsg,
} from '../agent/protocol'
import { buildClientStart } from '../agent/sessionVariables'

type JsonSchemaNode = Record<string, unknown>

function validateDraft7(
  value: unknown,
  node: JsonSchemaNode,
  root: JsonSchemaNode,
  path: string = '$',
): string[] {
  if (typeof node.$ref === 'string') {
    const segs = node.$ref.replace(/^#\//, '').split('/')
    let target: unknown = root
    for (const s of segs) {
      target = (target as Record<string, unknown>)?.[s]
    }
    if (!target || typeof target !== 'object') {
      return [`${path}: unresolved $ref ${node.$ref}`]
    }
    return validateDraft7(value, target as JsonSchemaNode, root, path)
  }

  if (Array.isArray(node.oneOf)) {
    const matches = (node.oneOf as JsonSchemaNode[]).filter(
      (sub) => validateDraft7(value, sub, root, path).length === 0,
    )
    return matches.length === 1
      ? []
      : [`${path}: expected exactly 1 oneOf match, got ${matches.length}`]
  }

  if (Array.isArray(node.anyOf)) {
    const ok = (node.anyOf as JsonSchemaNode[]).some(
      (sub) => validateDraft7(value, sub, root, path).length === 0,
    )
    return ok ? [] : [`${path}: matched zero anyOf branches`]
  }

  if ('const' in node && value !== node.const) {
    return [`${path}: expected const ${String(node.const)}, got ${String(value)}`]
  }

  const rawType = node.type
  if (Array.isArray(rawType)) {
    if (value === null && rawType.includes('null')) {
      return []
    }
    const nonNullTypes = rawType.filter((t): t is string => t !== 'null')
    if (nonNullTypes.length === 1) {
      return validateDraft7(value, { ...node, type: nonNullTypes[0] }, root, path)
    }
  }

  const errors: string[] = []
  if (rawType === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return [`${path}: expected object`]
    }
    const obj = value as Record<string, unknown>
    const required = (node.required as string[] | undefined) ?? []
    for (const req of required) {
      if (!(req in obj) || obj[req] === undefined) {
        errors.push(`${path}: missing required '${req}'`)
      }
    }
    const props = (node.properties as Record<string, JsonSchemaNode> | undefined) ?? {}
    if (node.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) {
          errors.push(`${path}: unexpected property '${k}'`)
        }
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj && obj[k] !== undefined) {
        errors.push(...validateDraft7(obj[k], sub, root, `${path}.${k}`))
      }
    }
    return errors
  }

  if (rawType === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected array`]
    const itemNode = node.items as JsonSchemaNode | undefined
    if (itemNode) {
      value.forEach((item, idx) => {
        errors.push(...validateDraft7(item, itemNode, root, `${path}[${idx}]`))
      })
    }
    return errors
  }

  if (rawType === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return [`${path}: expected integer`]
    }
    if (typeof node.minimum === 'number' && value < node.minimum) {
      errors.push(`${path}: ${value} < ${node.minimum}`)
    }
    if (typeof node.maximum === 'number' && value > node.maximum) {
      errors.push(`${path}: ${value} > ${node.maximum}`)
    }
    return errors
  }

  if (rawType === 'boolean') {
    return typeof value === 'boolean' ? [] : [`${path}: expected boolean`]
  }

  if (rawType === 'string') {
    if (typeof value !== 'string') return [`${path}: expected string`]
    if (typeof node.minLength === 'number' && value.length < node.minLength) {
      errors.push(`${path}: shorter than ${node.minLength}`)
    }
    if (typeof node.maxLength === 'number' && value.length > node.maxLength) {
      errors.push(`${path}: longer than ${node.maxLength}`)
    }
    if (Array.isArray(node.enum) && !node.enum.includes(value)) {
      errors.push(`${path}: '${value}' not in enum`)
    }
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern, 'u').test(value)) {
      errors.push(`${path}: fails pattern ${node.pattern}`)
    }
    const notNode = node.not as JsonSchemaNode | undefined
    if (notNode && typeof notNode.pattern === 'string') {
      if (new RegExp(notNode.pattern, 'u').test(value)) {
        errors.push(`${path}: matched forbidden pattern`)
      }
    }
  }

  return errors
}

const rootSchema = wsProtocolSchema as unknown as JsonSchemaNode
const clientMsgDef = (wsProtocolSchema.definitions as Record<string, JsonSchemaNode>).ClientMsg!
const serverMsgDef = (wsProtocolSchema.definitions as Record<string, JsonSchemaNode>).ServerMsg!

describe('protocol.ts: validated against shared/ws_protocol.schema.json', () => {
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
      expect(validateDraft7(wireObj, clientMsgDef, rootSchema)).toEqual([])
      expect(validateDraft7(wireObj, rootSchema, rootSchema)).toEqual([])
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
      expect(validateDraft7(rawObj, serverMsgDef, rootSchema)).toEqual([])
      const parsed: ServerMsg = parseServerMsg(JSON.stringify(rawObj))
      expect(validateDraft7(parsed, serverMsgDef, rootSchema)).toEqual([])
    }
  })

  it('rejects removed client_function, malformed frames, and hostile ui_state properties', () => {
    expect(() =>
      parseServerMsg(JSON.stringify({ type: 'client_function', id: '1', name: 'x', args: {} })),
    ).toThrow(/unknown server message/i)
    expect(() => parseServerMsg(JSON.stringify({ type: 'ready' }))).toThrow(/ready frame/)
    expect(() => parseServerMsg(JSON.stringify({ type: 'audio' }))).toThrow(/audio frame/)
    expect(() =>
      parseServerMsg(JSON.stringify({ type: 'ui_state', tier: 1, state: { seq: 1, page: 'bogus' } })),
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
