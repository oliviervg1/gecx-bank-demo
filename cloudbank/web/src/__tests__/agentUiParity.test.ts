// Agent/UI parity.
//
// The handler suite builds tiny synthetic fixtures; the view suite renders the
// real chloe.json. Neither can see the other, so a divergence between the two
// would pass both suites — for example a subscriptions screen showing £917.19
// while the concierge says £56.99.
//
// These tests pin the invariant that actually matters on stage: for a REAL
// fixture, the number the get_* ClientFunction returns is the number the
// screen renders. They run for EVERY persona across several `today` values,
// including the 1st of a month, where monthly_history's positional index is
// most likely to disagree with transactionsForMonth's calendar arithmetic.
//
// Running every persona matters as much as running every date: a handler that
// reached for a fixture module directly instead of the active one would show up
// as David's screens narrated with Chloe's numbers.

import { describe, it, expect } from 'vitest'
import { spendingHandlers, type FixtureLike } from '../agent/handlers/spendingHandlers'
import {
  subscriptionsView,
  categoryDrilldownView,
  vendorHistoryView,
  bucketByMonth,
} from '../util/spendingViews'
import { computeSpendingSummary } from '../util/spendingSummary'
import { allFixtures } from '../data/fixture'
import type { Transaction } from '../data/fixture'

// Local-time dates (never `new Date('...')`, which parses as UTC and shifts
// the day west of Greenwich). The 1st and the last day of a month are the
// boundaries that break positional month indexing.
const DATES: Array<[string, Date]> = [
  ['1st of the month', new Date(2026, 7, 1)],
  ['2nd of the month', new Date(2026, 7, 2)],
  ['mid-month', new Date(2026, 7, 15)],
  ['last day of the month', new Date(2026, 7, 31)],
  ['1st of a different month', new Date(2026, 6, 1)],
]

const CATEGORIES = [
  'groceries', 'coffee_shops', 'eating_out', 'subscriptions',
  'transport', 'shopping', 'bills', 'entertainment',
] as const

// Cases are the cross-product of persona x date. Vendors are derived per
// persona (the three busiest, plus the income vendor and a miss) rather than
// hardcoded, so each fixture is probed with names that actually occur in it.
const CASES = allFixtures().flatMap(([persona, f]) =>
  DATES.map(([dateLabel, today]) => {
    const spendCounts = new Map<string, number>()
    let incomeVendor = ''
    for (const t of f.transactions) {
      if (t.amount < 0) { incomeVendor = t.vendor; continue }
      spendCounts.set(t.vendor, (spendCounts.get(t.vendor) ?? 0) + 1)
    }
    const busiest = [...spendCounts.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v]) => v)
    return {
      label: `${persona} @ ${dateLabel}`,
      today,
      fixture: f as unknown as FixtureLike,
      transactions: f.transactions as unknown as Transaction[],
      vendors: [...busiest, incomeVendor, 'nonexistent-vendor'].filter(Boolean),
    }
  }),
)

describe.each(CASES)('agent/UI parity — $label', ({ today, fixture, transactions, vendors }) => {
  const ctx = { fixture, today }

  it('get_subscriptions agrees with the subscriptions screen', () => {
    const view = subscriptionsView(transactions, today)
    const tool = spendingHandlers.get_subscriptions({ month: 0 }, ctx) as {
      monthly_total?: number
      items?: Array<{ vendor?: string; amount: number }>
      error?: string
    }

    expect(tool.error).toBeUndefined()
    expect(tool.monthly_total).toBeCloseTo(view.total, 2)
    expect((tool.items ?? []).map((i) => i.vendor).sort()).toEqual(
      view.items.map((t) => t.vendor).sort(),
    )
  })

  it.each(CATEGORIES)('get_category_breakdown agrees with the %s drilldown', (category) => {
    const view = categoryDrilldownView(transactions, category, today)
    const tool = spendingHandlers.get_category_breakdown({ category, month: 0 }, ctx) as {
      total?: number
      top_vendors?: Array<{ vendor: string; total: number; count: number }>
      error?: string
    }

    expect(tool.error).toBeUndefined()
    expect(tool.total).toBeCloseTo(view.total, 2)

    // The tool returns the top 3 vendors; every one must match the screen's
    // per-vendor totals exactly.
    for (const v of tool.top_vendors ?? []) {
      expect(view.byVendor[v.vendor]).toBeCloseTo(v.total, 2)
    }
  })

  it.each(vendors)('get_vendor_breakdown agrees with the %s vendor screen', (vendor) => {
    const view = vendorHistoryView(transactions, vendor, today)
    const tool = spendingHandlers.get_vendor_breakdown({ vendor, month: 0 }, ctx) as {
      total?: number
      count?: number
      matched_vendors?: string[]
      error?: string
    }

    expect(tool.error).toBeUndefined()
    expect(tool.total).toBeCloseTo(view.total, 2)
    expect(tool.count).toBe(view.thisMonth.length)
  })

  it('get_monthly_trend agrees with the trend chart (order-insensitive)', () => {
    const view = bucketByMonth(transactions, { excludeIncome: true }, today)
    const tool = spendingHandlers.get_monthly_trend({}, ctx) as {
      months?: Array<{ label: string; total: number }>
    }

    const byLabel = (xs: Array<{ label: string; total: number }>) =>
      Object.fromEntries(xs.map((m) => [m.label, m.total]))

    // The tool is newest-first, the chart oldest-first — compare as maps.
    expect(byLabel(tool.months ?? [])).toEqual(
      byLabel(view.map((b) => ({ label: b.label, total: b.total }))),
    )
  })

  it('get_overview total agrees with the shared spending kernel', () => {
    const summary = computeSpendingSummary(transactions, today)
    const tool = spendingHandlers.get_overview({ month: 0 }, ctx) as {
      total?: number
      error?: string
    }

    expect(tool.error).toBeUndefined()
    expect(tool.total).toBeCloseTo(summary.this_month_total, 2)
  })

  it('month offsets 0/1/2 return distinct, correctly-labelled calendar months', () => {
    const labels = [0, 1, 2].map((month) => {
      const r = spendingHandlers.get_overview({ month }, ctx) as { month_label?: string }
      return r.month_label
    })

    // offset 0 must be THIS calendar month, whatever the fixture contains.
    expect(labels[0]).toBe(today.toLocaleString('en-GB', { month: 'short' }))
    expect(new Set(labels).size).toBe(3)
  })

  it('reported anomaly, if any, actually falls in the reported month', () => {
    const tool = spendingHandlers.get_overview({ month: 0 }, ctx) as {
      anomaly?: { vendor: string }
    }
    if (!tool.anomaly) return

    const row = transactions.find((t) => t.vendor === tool.anomaly!.vendor && t.is_anomaly)
    expect(row).toBeDefined()
    const d = new Date(today)
    d.setDate(d.getDate() - row!.days_ago)
    expect(d.getMonth()).toBe(today.getMonth())
    expect(d.getFullYear()).toBe(today.getFullYear())
  })
})
