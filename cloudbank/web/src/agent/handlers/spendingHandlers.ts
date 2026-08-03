// Pure-function handlers for the agent's get_* ClientFunctions. Each
// handler slices into the persona fixture (via computeSpendingSummary or
// directly over transactions). The handlers are pure — they take the
// fixture and "today" as inputs and never read globals — so they're
// trivially unit-testable.
//
// Registered into the ClientFunction Registry by App.tsx's
// SpendingDataBinder. The Registry wraps a normal return value in
// { output: … }; a thrown exception, or a bare { error: '…' } return from one
// of these handlers, becomes { error: … } per the CES ToolResponse contract.

import chloeFixture from '../../fixtures/chloe.json'
import { computeSpendingSummary, type RawTransaction } from '../../util/spendingSummary'

export interface FixtureLike {
  user: { first_name: string }
  transactions: Array<RawTransaction & {
    id: string
    is_anomaly?: boolean
    renewal_days_ago?: number
    is_subscription?: boolean
  }>
}

export interface HandlerCtx {
  fixture: FixtureLike
  today?: Date            // injectable for deterministic tests
}

// Shared currency rounding for every handler. Mirrors the (non-exported)
// round2 inside computeSpendingSummary so the numbers handlers return
// match the numbers the UI computes.
const round2 = (n: number): number => Math.round(n * 100) / 100

const CATEGORIES = new Set([
  'groceries', 'coffee_shops', 'eating_out', 'subscriptions',
  'transport', 'shopping', 'bills', 'entertainment',
])

// Helper: walk transactions filtered to a given calendar-month offset.
function transactionsForMonth(
  transactions: FixtureLike['transactions'],
  today: Date,
  monthOffset: number,
): FixtureLike['transactions'] {
  const targetYear = new Date(today.getFullYear(), today.getMonth() - monthOffset, 1).getFullYear()
  const targetMonth = new Date(today.getFullYear(), today.getMonth() - monthOffset, 1).getMonth()
  return transactions.filter((t) => {
    if (t.amount < 0) return false  // income excluded — matches computeSpendingSummary
    const d = new Date(today)
    d.setDate(d.getDate() - t.days_ago)
    return d.getFullYear() === targetYear && d.getMonth() === targetMonth
  })
}

export const spendingHandlers = {
  get_overview(args: Record<string, unknown>, ctx?: HandlerCtx) {
    const fixture = ctx?.fixture ?? (chloeFixture as FixtureLike)
    const today = ctx?.today ?? new Date()
    const monthOffset = Number(args.month ?? 0)
    if (!Number.isInteger(monthOffset) || monthOffset < 0 || monthOffset > 2) {
      return { error: 'no_data_for_month' }
    }
    const summary = computeSpendingSummary(fixture.transactions, today)
    const bucket = summary.monthly_history[monthOffset]
    if (!bucket) return { error: 'no_data_for_month' }
    const entries = Object.entries(bucket.by_category)
    const result: Record<string, unknown> = {
      month_label: bucket.label,
      total: round2(bucket.total),
    }
    // A month with no spending yet is a legitimate £0 answer, not an error —
    // on the 1st of the month this is the normal case. top_category is simply
    // omitted, and the agent narrates "nothing yet this month".
    if (entries.length > 0) {
      const top = entries.sort(([, a], [, b]) => b - a)[0]
      result.top_category = { name: top[0], total: round2(top[1]) }
    }
    if (monthOffset === 0) {
      // Scoped to the current month: an unscoped `find` over the whole fixture
      // reports a stale charge as this month's whenever the anomaly ages out.
      const anomalyRow = transactionsForMonth(fixture.transactions, today, 0)
        .find((t) => t.is_anomaly === true)
      if (anomalyRow) {
        result.anomaly = {
          vendor: anomalyRow.vendor ?? '',
          amount: round2(anomalyRow.amount),
          renewal_days_ago: anomalyRow.renewal_days_ago ?? 0,
        }
      }
    }
    return result
  },

  get_category_breakdown(args: Record<string, unknown>, ctx?: HandlerCtx) {
    const category = String(args.category ?? '')
    if (!CATEGORIES.has(category)) return { error: 'unknown_category' }
    const monthOffset = Number(args.month ?? 0)
    if (!Number.isInteger(monthOffset) || monthOffset < 0 || monthOffset > 2) {
      return { error: 'no_data_for_month' }
    }
    const fixture = ctx?.fixture ?? (chloeFixture as FixtureLike)
    const today = ctx?.today ?? new Date()
    const summary = computeSpendingSummary(fixture.transactions, today)
    const bucket = summary.monthly_history[monthOffset]
    if (!bucket) return { error: 'no_data_for_month' }

    const monthTxns = transactionsForMonth(fixture.transactions, today, monthOffset)
      .filter((t) => t.category === category)
    const vendorTotals = new Map<string, { total: number; count: number }>()
    for (const t of monthTxns) {
      if (!t.vendor) continue
      const v = vendorTotals.get(t.vendor) ?? { total: 0, count: 0 }
      v.total += t.amount
      v.count += 1
      vendorTotals.set(t.vendor, v)
    }
    const top_vendors = Array.from(vendorTotals.entries())
      .map(([vendor, { total, count }]) => ({ vendor, total: round2(total), count }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 3)

    return {
      category,
      month_label: bucket.label,
      total: round2(bucket.by_category[category] ?? 0),
      top_vendors,
    }
  },

  get_vendor_breakdown(args: Record<string, unknown>, ctx?: HandlerCtx) {
    const needle = String(args.vendor ?? '').trim()
    if (!needle) return { error: 'missing_vendor' }
    const monthOffset = Number(args.month ?? 0)
    if (!Number.isInteger(monthOffset) || monthOffset < 0 || monthOffset > 2) {
      return { error: 'no_data_for_month' }
    }
    const fixture = ctx?.fixture ?? (chloeFixture as FixtureLike)
    const today = ctx?.today ?? new Date()
    const summary = computeSpendingSummary(fixture.transactions, today)
    const bucket = summary.monthly_history[monthOffset]
    if (!bucket) return { error: 'no_data_for_month' }

    const needleLc = needle.toLowerCase()
    const monthTxns = transactionsForMonth(fixture.transactions, today, monthOffset)
    const matching = monthTxns.filter(
      (t): t is typeof t & { vendor: string } =>
        t.vendor !== undefined && t.vendor.toLowerCase().includes(needleLc),
    )
    const matched_vendors = Array.from(new Set(matching.map((t) => t.vendor)))
    const total = round2(matching.reduce((s, t) => s + t.amount, 0))
    const recent = matching
      .slice()
      .sort((a, b) => a.days_ago - b.days_ago)
      .slice(0, 3)
      .map((t) => ({ days_ago: t.days_ago, amount: round2(t.amount) }))

    return {
      matched_vendors,
      month_label: bucket.label,
      total,
      count: matching.length,
      recent,
    }
  },

  get_monthly_trend(args: Record<string, unknown>, ctx?: HandlerCtx) {
    const category = args.category !== undefined ? String(args.category) : undefined
    const vendor = args.vendor !== undefined ? String(args.vendor) : undefined
    if (category !== undefined && vendor !== undefined) {
      return { error: 'mutually_exclusive_filters' }
    }
    if (vendor !== undefined && vendor.trim() === '') {
      return { error: 'missing_vendor' }
    }
    if (category !== undefined && !CATEGORIES.has(category)) {
      return { error: 'unknown_category' }
    }
    const fixture = ctx?.fixture ?? (chloeFixture as FixtureLike)
    const today = ctx?.today ?? new Date()
    const summary = computeSpendingSummary(fixture.transactions, today)
    const monthLabel = (offset: number): string =>
      summary.monthly_history[offset]?.label
      ?? new Date(today.getFullYear(), today.getMonth() - offset, 1)
            .toLocaleString('en-GB', { month: 'short' })

    let scope: 'overall' | 'category' | 'vendor' = 'overall'
    let months: Array<{ label: string; total: number }>
    let matched_vendors: string[] | undefined

    if (category !== undefined) {
      scope = 'category'
      months = [0, 1, 2].map((offset) => ({
        label: monthLabel(offset),
        total: round2(summary.monthly_history[offset]?.by_category[category] ?? 0),
      }))
    } else if (vendor !== undefined) {
      scope = 'vendor'
      const needleLc = vendor.toLowerCase()
      const matchSet = new Set<string>()
      months = [0, 1, 2].map((offset) => {
        const monthTxns = transactionsForMonth(fixture.transactions, today, offset)
          .filter(
            (t): t is typeof t & { vendor: string } =>
              t.vendor !== undefined && t.vendor.toLowerCase().includes(needleLc),
          )
        for (const t of monthTxns) matchSet.add(t.vendor)
        return {
          label: monthLabel(offset),
          total: round2(monthTxns.reduce((s, t) => s + t.amount, 0)),
        }
      })
      matched_vendors = Array.from(matchSet)
    } else {
      months = [0, 1, 2].map((offset) => ({
        label: monthLabel(offset),
        total: round2(summary.monthly_history[offset]?.total ?? 0),
      }))
    }

    const delta_vs_last_month = round2((months[0]?.total ?? 0) - (months[1]?.total ?? 0))
    const result: Record<string, unknown> = { scope, months, delta_vs_last_month }
    if (matched_vendors) result.matched_vendors = matched_vendors
    return result
  },

  get_subscriptions(args: Record<string, unknown>, ctx?: HandlerCtx) {
    const monthOffset = Number(args.month ?? 0)
    if (!Number.isInteger(monthOffset) || monthOffset < 0 || monthOffset > 2) {
      return { error: 'no_data_for_month' }
    }
    const fixture = ctx?.fixture ?? (chloeFixture as FixtureLike)
    const today = ctx?.today ?? new Date()
    const summary = computeSpendingSummary(fixture.transactions, today)
    const bucket = summary.monthly_history[monthOffset]
    if (!bucket) return { error: 'no_data_for_month' }
    // "Subscription" is the is_subscription FLAG, not the `subscriptions`
    // category. British Gas, EE and the rent are flagged recurring but
    // categorised as `bills`; filtering on category made this tool report
    // £56.99 while SubscriptionsAuditView rendered £917.19 for the same month.
    // The flag matches the screen and this tool's own description.
    const monthTxns = transactionsForMonth(fixture.transactions, today, monthOffset)
      .filter((t) => t.is_subscription === true)
      .sort((a, b) => b.amount - a.amount)
    const items = monthTxns.map((t) => ({ vendor: t.vendor, amount: round2(t.amount) }))
    const monthly_total = round2(items.reduce((s, i) => s + i.amount, 0))
    return { month_label: bucket.label, monthly_total, items }
  },
}
