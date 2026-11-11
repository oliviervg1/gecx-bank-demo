import { describe, it, expect } from 'vitest'
import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020'
import customerSnapshotSchema from '../../../shared/customer_snapshot.schema.json'
import { allFixtures, type Fixture } from '../data/fixture'
import { ALL_PERSONAS } from '../personas/personas'
import { computeSpendingSummary } from '../util/spendingSummary'

const schemaDialect = String((customerSnapshotSchema as { $schema?: string }).$schema ?? '')
const ajv = schemaDialect.includes('2020-12')
  ? new Ajv2020({ allErrors: true, strict: false })
  : new Ajv({ allErrors: true, strict: false })
const validateSnapshot = ajv.compile(customerSnapshotSchema)

const fixtures = allFixtures()

describe('Shared JSON Schema validation with Ajv (customer_snapshot.schema.json)', () => {
  it('registers every persona fixture', () => {
    expect(fixtures.map(([p]) => p).sort()).toEqual([...ALL_PERSONAS].sort())
  })

  it.each(fixtures)('validates %s.json cleanly against customer_snapshot.schema.json', (_persona, f) => {
    const valid = validateSnapshot(f)
    expect(valid, ajv.errorsText(validateSnapshot.errors)).toBe(true)
  })

  it('rejects hostile or non-conforming mutations against customer_snapshot.schema.json (including if/then/else income sign)', () => {
    const firstEntry = fixtures[0]
    expect(firstEntry).toBeDefined()
    const validClone = structuredClone(firstEntry![1]) as unknown as Record<string, unknown>

    const withExtraKey = structuredClone(validClone)
    withExtraKey.injected = true
    expect(validateSnapshot(withExtraKey)).toBe(false)

    const withFloatPence = structuredClone(validClone) as {
      accounts: { current: { balance_pence: number } }
    }
    withFloatPence.accounts.current.balance_pence = 4250.75
    expect(validateSnapshot(withFloatPence)).toBe(false)

    const withAngleBracket = structuredClone(validClone) as {
      transactions: Array<{ vendor: string }>
    }
    withAngleBracket.transactions[0]!.vendor = '<script>alert(1)</script>'
    expect(validateSnapshot(withAngleBracket)).toBe(false)

    const withPositiveIncome = structuredClone(validClone) as {
      transactions: Array<{ category: string; amount_pence: number }>
    }
    const incomeRow = withPositiveIncome.transactions.find((t) => t.category === 'income')!
    incomeRow.amount_pence = 1000
    expect(validateSnapshot(withPositiveIncome)).toBe(false)
  })
})

describe.each(fixtures)('Domain invariants for fixture: %s', (_persona, f: Fixture) => {
  it('uses reserved example.com email addresses, unallocated test sort code, and valid savings rates', () => {
    if (f.user.email) {
      expect(f.user.email).toMatch(/@example\.com$/)
    }
    expect(f.accounts.current.sort_code).toBe('00-00-99')
    expect(f.accounts.savings.aer_bps).toBeGreaterThanOrEqual(f.accounts.savings.gross_rate_bps)
    expect(f.accounts.savings.goal_target_pence).toBeGreaterThan(f.accounts.savings.balance_pence)
  })

  it('has unique txn- IDs, one income row per statement month (0, 1, 2), and one current-month anomaly', () => {
    const ids = f.transactions.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^txn-/)

    const negative = f.transactions.filter((t) => t.amount_pence < 0)
    expect(negative).toHaveLength(3)
    for (const row of negative) {
      expect(row.category).toBe('income')
    }
    expect(new Set(negative.map((t) => t.month_offset))).toEqual(new Set([0, 1, 2]))
    expect(f.transactions.filter((t) => t.category === 'income')).toHaveLength(3)

    const anomalies = f.transactions.filter((t) => t.is_anomaly)
    expect(anomalies).toHaveLength(1)
    const anomaly = anomalies[0]!
    expect(anomaly.month_offset).toBe(0)
    expect(anomaly.is_subscription).toBe(true)
    expect(anomaly.amount_pence).toBeGreaterThan(0)
  })

  it('populates all three calendar month offsets (0, 1, 2) with non-zero spend', () => {
    const summary = computeSpendingSummary(f.transactions, '2026-11-24')
    expect(summary.monthly_history).toHaveLength(3)
    for (const m of summary.monthly_history) {
      expect(m.total_pence).toBeGreaterThan(0)
    }
  })
})
