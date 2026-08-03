// Every persona fixture must satisfy the same invariants, because every screen
// and all five get_* ClientFunctions read them without branching on persona.
// A malformed fixture would otherwise surface as an empty chart or a silently
// wrong total on stage rather than as a failing test.
//
// These invariants are not arbitrary — each one is depended on by real code:
//   - the closed category vocabulary is what get_category_breakdown validates
//     against, so an unknown category is simply unreachable via the agent
//   - negative amounts mean income and are excluded everywhere; more than one
//     would make "income" ambiguous
//   - three months of days_ago coverage is what makes monthly_history and the
//     trend chart honest
//   - recurring vendors across months are what give the vendor/trend views
//     something to plot

import { describe, it, expect } from 'vitest'
import { allFixtures, type Fixture } from '../data/fixture'
import { ALL_PERSONAS } from '../personas/personas'
import { computeSpendingSummary } from '../util/spendingSummary'

// Mirrors CATEGORIES in agent/handlers/spendingHandlers.ts, plus `income`,
// which is a fixture-only marker for the negative row.
const SPEND_CATEGORIES = new Set([
  'groceries', 'coffee_shops', 'eating_out', 'subscriptions',
  'transport', 'shopping', 'bills', 'entertainment',
])
const ALL_CATEGORIES = new Set([...SPEND_CATEGORIES, 'income'])

const fixtures = allFixtures()

it('every persona has a fixture registered', () => {
  expect(fixtures.map(([p]) => p).sort()).toEqual([...ALL_PERSONAS].sort())
  for (const [, f] of fixtures) expect(f).toBeTruthy()
})

describe.each(fixtures)('fixture: %s', (_persona, f: Fixture) => {
  it('has a complete user block', () => {
    const u = f.user
    expect(u.first_name).toBeTruthy()
    expect(u.last_name).toBeTruthy()
    expect(u.age).toBeGreaterThan(0)
    expect(u.location).toBeTruthy()
    expect(u.employment).toBeTruthy()
    expect(Array.isArray(u.goals)).toBe(true)
    expect(u.goals.length).toBeGreaterThan(0)
  })

  it('uses only reserved example.com email addresses', () => {
    // RFC 2606 — a fixture must never contain a routable address.
    if (f.user.email) expect(f.user.email).toMatch(/@example\.com$/)
  })

  it('has a current account in GBP', () => {
    expect(f.accounts.current.name).toBeTruthy()
    expect(f.accounts.current.currency).toBe('GBP')
    expect(Number.isFinite(f.accounts.current.balance)).toBe(true)
  })

  it('has a well-formed mortgage when present', () => {
    const m = f.accounts.mortgage
    if (!m) return // Tom rents.
    expect(m.balance).toBeGreaterThan(0)
    expect(m.interest_rate).toBeGreaterThan(0)
    expect(m.next_payment.amount).toBeGreaterThan(0)
    expect(m.next_payment.day_of_month).toBeGreaterThanOrEqual(1)
    expect(m.next_payment.day_of_month).toBeLessThanOrEqual(28) // safe in every month
  })

  it('has unique txn- prefixed transaction ids', () => {
    const ids = f.transactions.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^txn-/)
  })

  it('uses only the closed category vocabulary', () => {
    for (const t of f.transactions) {
      expect(ALL_CATEGORIES.has(t.category), `unknown category ${t.category} on ${t.id}`).toBe(true)
    }
  })

  it('has exactly one income row, and it is the only negative amount', () => {
    const negative = f.transactions.filter((t) => t.amount < 0)
    expect(negative).toHaveLength(1)
    expect(negative[0].category).toBe('income')
    // And nothing else is miscategorised as income.
    expect(f.transactions.filter((t) => t.category === 'income')).toHaveLength(1)
  })

  it('spans three calendar months of history', () => {
    const days = f.transactions.map((t) => t.days_ago)
    expect(Math.min(...days)).toBeGreaterThanOrEqual(0)
    // Enough history for monthly_history's three buckets to be real.
    expect(Math.max(...days)).toBeGreaterThanOrEqual(62)
    for (const d of days) expect(Number.isInteger(d)).toBe(true)
  })

  it('has exactly one anomaly, carrying its supporting flags', () => {
    const anomalies = f.transactions.filter((t) => t.is_anomaly)
    expect(anomalies).toHaveLength(1)
    const a = anomalies[0]
    // The narrative beat is "this recurring charge renewed and you didn't
    // notice", so the anomaly must be a subscription with a renewal age.
    expect(a.is_subscription).toBe(true)
    expect(a.renewal_days_ago).toBeGreaterThanOrEqual(0)
    expect(a.amount).toBeGreaterThan(0)
  })

  it('has at least one vendor recurring across all three months', () => {
    // Without this, the vendor-history and monthly-trend views plot a single
    // bar and the "how is X trending?" question has no answer.
    const byVendorMonth = new Map<string, Set<number>>()
    for (const t of f.transactions) {
      if (t.amount < 0) continue
      const bucket = Math.floor(t.days_ago / 30)
      if (!byVendorMonth.has(t.vendor)) byVendorMonth.set(t.vendor, new Set())
      byVendorMonth.get(t.vendor)!.add(bucket)
    }
    const spanning = [...byVendorMonth.values()].filter((s) => s.size >= 3)
    expect(spanning.length).toBeGreaterThan(0)
  })

  it('produces non-zero spend in each of the three monthly_history buckets', () => {
    // Uses a mid-month "today" so no bucket is empty merely because the month
    // has only just started.
    const summary = computeSpendingSummary(f.transactions, new Date(2026, 7, 15))
    expect(summary.monthly_history).toHaveLength(3)
    for (const m of summary.monthly_history) {
      expect(m.total, `${m.label} is empty`).toBeGreaterThan(0)
    }
  })

  it('has subscriptions the audit view can show', () => {
    expect(f.transactions.filter((t) => t.is_subscription).length).toBeGreaterThan(0)
  })
})
