import { describe, it, expect } from 'vitest'
import customerSnapshotSchema from '../../../shared/customer_snapshot.schema.json'
import { allFixtures, type Fixture } from '../data/fixture'
import { ALL_PERSONAS } from '../personas/personas'
import { computeSpendingSummary } from '../util/spendingSummary'

type JsonSchemaNode = Record<string, unknown>

/**
 * Recursive Draft-07 JSON Schema validator covering all keywords used in
 * shared/customer_snapshot.schema.json (type, required, additionalProperties,
 * properties, items, enum, minimum, maximum, minLength, maxLength, minItems,
 * maxItems, pattern, not.pattern).
 */
function validateAgainstSchema(
  value: unknown,
  node: JsonSchemaNode,
  rootSchema: JsonSchemaNode,
  path: string = '$',
): string[] {
  if (typeof node.$ref === 'string') {
    const refPath = node.$ref.replace(/^#\//, '').split('/')
    let resolved: unknown = rootSchema
    for (const seg of refPath) {
      resolved = (resolved as Record<string, unknown>)?.[seg]
    }
    if (!resolved || typeof resolved !== 'object') {
      return [`${path}: unresolved $ref ${node.$ref}`]
    }
    return validateAgainstSchema(value, resolved as JsonSchemaNode, rootSchema, path)
  }

  const errors: string[] = []
  const expectedType = node.type

  if (expectedType === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return [`${path}: expected object`]
    }
    const obj = value as Record<string, unknown>
    const required = (node.required as string[] | undefined) ?? []
    for (const reqKey of required) {
      if (!(reqKey in obj) || obj[reqKey] === undefined) {
        errors.push(`${path}: missing required property '${reqKey}'`)
      }
    }
    const props = (node.properties as Record<string, JsonSchemaNode> | undefined) ?? {}
    if (node.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) {
          errors.push(`${path}: unexpected additional property '${k}'`)
        }
      }
    }
    for (const [k, propSchema] of Object.entries(props)) {
      if (k in obj && obj[k] !== undefined) {
        errors.push(...validateAgainstSchema(obj[k], propSchema, rootSchema, `${path}.${k}`))
      }
    }
    return errors
  }

  if (expectedType === 'array') {
    if (!Array.isArray(value)) {
      return [`${path}: expected array`]
    }
    if (typeof node.minItems === 'number' && value.length < node.minItems) {
      errors.push(`${path}: array length ${value.length} < minItems ${node.minItems}`)
    }
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) {
      errors.push(`${path}: array length ${value.length} > maxItems ${node.maxItems}`)
    }
    const itemSchema = node.items as JsonSchemaNode | undefined
    if (itemSchema) {
      value.forEach((item, idx) => {
        errors.push(...validateAgainstSchema(item, itemSchema, rootSchema, `${path}[${idx}]`))
      })
    }
    return errors
  }

  if (expectedType === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return [`${path}: expected integer, got ${String(value)}`]
    }
    if (typeof node.minimum === 'number' && value < node.minimum) {
      errors.push(`${path}: ${value} < minimum ${node.minimum}`)
    }
    if (typeof node.maximum === 'number' && value > node.maximum) {
      errors.push(`${path}: ${value} > maximum ${node.maximum}`)
    }
    return errors
  }

  if (expectedType === 'boolean') {
    if (typeof value !== 'boolean') {
      return [`${path}: expected boolean`]
    }
    return errors
  }

  if (expectedType === 'string') {
    if (typeof value !== 'string') {
      return [`${path}: expected string`]
    }
    if (typeof node.minLength === 'number' && value.length < node.minLength) {
      errors.push(`${path}: string shorter than ${node.minLength}`)
    }
    if (typeof node.maxLength === 'number' && value.length > node.maxLength) {
      errors.push(`${path}: string longer than ${node.maxLength}`)
    }
    if (Array.isArray(node.enum) && !node.enum.includes(value)) {
      errors.push(`${path}: '${value}' not in enum`)
    }
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern, 'u').test(value)) {
      errors.push(`${path}: '${value}' fails pattern ${node.pattern}`)
    }
    const notNode = node.not as JsonSchemaNode | undefined
    if (notNode && typeof notNode.pattern === 'string') {
      if (new RegExp(notNode.pattern, 'u').test(value)) {
        errors.push(`${path}: '${value}' matched forbidden pattern ${notNode.pattern}`)
      }
    }
    return errors
  }

  return errors
}

const fixtures = allFixtures()

describe('Shared JSON Schema validation (customer_snapshot.schema.json)', () => {
  it('registers every persona fixture', () => {
    expect(fixtures.map(([p]) => p).sort()).toEqual([...ALL_PERSONAS].sort())
  })

  it.each(fixtures)('validates %s.json cleanly against customer_snapshot.schema.json', (_persona, f) => {
    const errs = validateAgainstSchema(
      f,
      customerSnapshotSchema as unknown as JsonSchemaNode,
      customerSnapshotSchema as unknown as JsonSchemaNode,
    )
    expect(errs).toEqual([])
  })

  it('rejects hostile or non-conforming mutations against customer_snapshot.schema.json', () => {
    const validClone = structuredClone(fixtures[0][1]) as Record<string, any>

    const withExtraKey = structuredClone(validClone)
    withExtraKey.injected = true
    expect(
      validateAgainstSchema(
        withExtraKey,
        customerSnapshotSchema as unknown as JsonSchemaNode,
        customerSnapshotSchema as unknown as JsonSchemaNode,
      ).length,
    ).toBeGreaterThan(0)

    const withFloatPence = structuredClone(validClone)
    withFloatPence.accounts.current.balance_pence = 4250.75
    expect(
      validateAgainstSchema(
        withFloatPence,
        customerSnapshotSchema as unknown as JsonSchemaNode,
        customerSnapshotSchema as unknown as JsonSchemaNode,
      ).length,
    ).toBeGreaterThan(0)

    const withAngleBracket = structuredClone(validClone)
    withAngleBracket.transactions[0].vendor = '<script>alert(1)</script>'
    expect(
      validateAgainstSchema(
        withAngleBracket,
        customerSnapshotSchema as unknown as JsonSchemaNode,
        customerSnapshotSchema as unknown as JsonSchemaNode,
      ).length,
    ).toBeGreaterThan(0)
  })
})

describe.each(fixtures)('Domain invariants for fixture: %s', (_persona, f: Fixture) => {
  it('uses reserved example.com email addresses and valid savings rates', () => {
    if (f.user.email) {
      expect(f.user.email).toMatch(/@example\.com$/)
    }
    expect(f.accounts.savings.aer_bps).toBeGreaterThanOrEqual(f.accounts.savings.gross_rate_bps)
    expect(f.accounts.savings.goal_target_pence).toBeGreaterThan(f.accounts.savings.balance_pence)
  })

  it('has unique txn- IDs, exactly one income row, and one current-month anomaly', () => {
    const ids = f.transactions.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^txn-/)

    const negative = f.transactions.filter((t) => t.amount_pence < 0)
    expect(negative).toHaveLength(1)
    expect(negative[0].category).toBe('income')
    expect(f.transactions.filter((t) => t.category === 'income')).toHaveLength(1)

    const anomalies = f.transactions.filter((t) => t.is_anomaly)
    expect(anomalies).toHaveLength(1)
    expect(anomalies[0].month_offset).toBe(0)
    expect(anomalies[0].is_subscription).toBe(true)
    expect(anomalies[0].amount_pence).toBeGreaterThan(0)
  })

  it('populates all three calendar month offsets (0, 1, 2) with non-zero spend', () => {
    const summary = computeSpendingSummary(f.transactions, '2026-11-24')
    expect(summary.monthly_history).toHaveLength(3)
    for (const m of summary.monthly_history) {
      expect(m.total_pence).toBeGreaterThan(0)
    }
  })
})
