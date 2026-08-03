// Pure aggregations behind the Spending drill-in views.
//
// They live here rather than as useMemo bodies inside each view component so
// tests can call them without rendering. That is what lets
// `agentUiParity.test.ts` assert that what the screen shows and what the get_*
// ClientFunctions return are the same numbers.
//
// Every function takes `today` so tests can pin the date. The views pass
// nothing and get `new Date()`.

import type { Transaction } from '../data/fixture'
import { isInCurrentCalendarMonth } from './spendingSummary'

const round2 = (n: number): number => Math.round(n * 100) / 100

export interface MonthBucket {
  label: string
  year: number
  month: number
  total: number
}

// The trailing 3 CALENDAR months, oldest-first — the order the bar charts read
// left-to-right. This is the reverse of what get_monthly_trend returns
// (newest-first); see spending_agent/instruction.txt on never narrating a
// chart bar positionally.
//
// Months with no transactions are included as zero bars rather than dropped.
// Collecting only non-empty months meant that on the 1st — when the current
// month is empty — the chart quietly plotted a window ending LAST month, with
// nothing on the axis to say so, while get_monthly_trend correctly reported
// the current month at £0.
export function bucketByMonth(
  txns: Transaction[],
  opts: { category?: string; vendor?: string; excludeIncome?: boolean } = {},
  today: Date = new Date(),
): MonthBucket[] {
  const vendorLc = opts.vendor?.toLowerCase()
  const totals = new Map<string, number>()
  for (const t of txns) {
    if (opts.category && t.category !== opts.category) continue
    if (vendorLc && !t.vendor.toLowerCase().includes(vendorLc)) continue
    if (opts.excludeIncome && t.amount < 0) continue
    const d = new Date(today)
    d.setDate(d.getDate() - t.days_ago)
    const key = `${d.getFullYear()}-${d.getMonth()}`
    totals.set(key, (totals.get(key) ?? 0) + t.amount)
  }
  // offset 2, 1, 0 => oldest-first.
  return [2, 1, 0].map((offset) => {
    const d = new Date(today.getFullYear(), today.getMonth() - offset, 1)
    return {
      label: d.toLocaleString('en-GB', { month: 'short' }),
      year: d.getFullYear(),
      month: d.getMonth(),
      total: round2(totals.get(`${d.getFullYear()}-${d.getMonth()}`) ?? 0),
    }
  })
}

export interface SubscriptionsView {
  items: Transaction[]
  total: number
}

// "Subscription" is defined by the is_subscription flag, not by the
// `subscriptions` category — British Gas, EE and the rent are flagged
// recurring but categorised as `bills`. get_subscriptions must agree.
export function subscriptionsView(
  txns: Transaction[],
  today: Date = new Date(),
): SubscriptionsView {
  const items = txns
    .filter((t) => t.is_subscription === true && isInCurrentCalendarMonth(t.days_ago, today))
    .sort((a, b) => b.amount - a.amount)
  return { items, total: round2(items.reduce((sum, t) => sum + t.amount, 0)) }
}

export interface CategoryDrilldownData {
  rows: Transaction[]
  total: number
  byVendor: Record<string, number>
}

export function categoryDrilldownView(
  txns: Transaction[],
  category: string,
  today: Date = new Date(),
): CategoryDrilldownData {
  const rows = txns
    .filter(
      (t) =>
        t.category === category &&
        t.amount >= 0 &&
        isInCurrentCalendarMonth(t.days_ago, today),
    )
    .sort((a, b) => a.days_ago - b.days_ago)

  const byVendorRaw: Record<string, number> = {}
  for (const t of rows) {
    byVendorRaw[t.vendor] = (byVendorRaw[t.vendor] ?? 0) + t.amount
  }

  return {
    rows,
    total: round2(rows.reduce((sum, t) => sum + t.amount, 0)),
    byVendor: Object.fromEntries(
      Object.entries(byVendorRaw).map(([v, total]) => [v, round2(total)]),
    ),
  }
}

export interface VendorHistoryData {
  rows: Transaction[]
  thisMonth: Transaction[]
  total: number
  buckets: MonthBucket[]
}

export function vendorHistoryView(
  txns: Transaction[],
  vendor: string,
  today: Date = new Date(),
): VendorHistoryData {
  const needle = vendor.trim().toLowerCase()
  // Income is excluded here as it is in every other code path — otherwise a
  // search for "sal" surfaces the Salary row as a negative bar and a
  // "-£3,200.00" headline, while get_vendor_breakdown reports no matches.
  const rows = txns.filter((t) => t.amount >= 0 && t.vendor.toLowerCase().includes(needle))
  const thisMonth = rows.filter((t) => isInCurrentCalendarMonth(t.days_ago, today))
  return {
    rows,
    thisMonth,
    total: round2(thisMonth.reduce((sum, t) => sum + t.amount, 0)),
    buckets: bucketByMonth(txns, { vendor: needle, excludeIncome: true }, today),
  }
}
