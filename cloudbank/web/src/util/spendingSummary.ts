// Pure aggregation of a transaction list into the shape the agent
// receives as the `spending_summary` session variable. Used by both the
// React hook (useSpendingSummary) and the agent's session-variables
// builder (buildSessionVariables). ONE source of truth for the math.

export interface SpendingSummary {
  this_month_total: number
  by_category: Record<string, number>
  by_vendor: Record<string, { total: number; count: number }>
  monthly_history: Array<{ label: string; total: number; by_category: Record<string, number> }>
}

export interface RawTransaction {
  days_ago: number
  amount: number
  category: string
  vendor?: string
}

function bucketCalendarMonth(daysAgo: number, today: Date): [number, number] {
  const d = new Date(today)
  d.setDate(d.getDate() - daysAgo)
  return [d.getFullYear(), d.getMonth()]
}

// True if a transaction with the given days_ago falls in `today`'s
// calendar month. The single source of truth used by the spending
// drill-in views' "This month" filters AND by computeSpendingSummary's
// own this_month_total computation, so app + agent never disagree on
// what "this month" means.
export function isInCurrentCalendarMonth(daysAgo: number, today: Date = new Date()): boolean {
  const [yr, mo] = bucketCalendarMonth(daysAgo, today)
  return yr === today.getFullYear() && mo === today.getMonth()
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function computeSpendingSummary(
  transactions: RawTransaction[],
  today: Date = new Date(),
): SpendingSummary {
  const [tyr, tmo] = [today.getFullYear(), today.getMonth()]

  let this_month_total = 0
  const by_category: Record<string, number> = {}
  const by_vendor: Record<string, { total: number; count: number }> = {}
  const monthly = new Map<
    string,
    { label: string; total: number; by_category: Record<string, number>; year: number; month: number }
  >()

  for (const t of transactions) {
    const amount = Number(t.amount)
    if (amount < 0) continue // income — excluded from spending sums

    const [yr, mo] = bucketCalendarMonth(t.days_ago, today)
    const inThisMonth = yr === tyr && mo === tmo
    if (inThisMonth) {
      this_month_total += amount
      by_category[t.category] = (by_category[t.category] ?? 0) + amount
      if (t.vendor) {
        const v = by_vendor[t.vendor] ?? { total: 0, count: 0 }
        v.total += amount
        v.count += 1
        by_vendor[t.vendor] = v
      }
    }
    const key = `${yr}-${mo}`
    const entry = monthly.get(key) ?? {
      label: new Date(yr, mo, 1).toLocaleString('en-GB', { month: 'short' }),
      total: 0,
      by_category: {},
      year: yr,
      month: mo,
    }
    entry.total += amount
    entry.by_category[t.category] = (entry.by_category[t.category] ?? 0) + amount
    monthly.set(key, entry)
  }

  // Built from the CALENDAR months [this, last, two-ago] and padded with zeros
  // when a month has no transactions, so `monthly_history[n]` is always
  // "n months ago". The previous version collected only months that contained
  // transactions and sorted them newest-first, which meant that on the 1st of
  // any month (chloe.json's earliest transaction is days_ago: 1) index 0 was
  // LAST month, silently shifting every offset the get_* handlers pass while
  // their vendor lists — sourced from transactionsForMonth's real calendar
  // arithmetic — stayed correct. Index and calendar now agree by construction.
  const monthly_history = [0, 1, 2].map((offset) => {
    const d = new Date(tyr, tmo - offset, 1)
    const entry = monthly.get(`${d.getFullYear()}-${d.getMonth()}`)
    return {
      label: d.toLocaleString('en-GB', { month: 'short' }),
      total: round2(entry?.total ?? 0),
      by_category: Object.fromEntries(
        Object.entries(entry?.by_category ?? {}).map(([k, v]) => [k, round2(v)]),
      ),
    }
  })

  return {
    this_month_total: round2(this_month_total),
    by_category: Object.fromEntries(Object.entries(by_category).map(([k, v]) => [k, round2(v)])),
    by_vendor: Object.fromEntries(
      Object.entries(by_vendor).map(([k, v]) => [k, { total: round2(v.total), count: v.count }]),
    ),
    monthly_history,
  }
}
