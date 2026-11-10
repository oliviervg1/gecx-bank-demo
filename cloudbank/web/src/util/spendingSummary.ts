// Pure integer-pence spending summary over month-anchored transactions (month_offset: 0 | 1 | 2).

import type { Transaction } from '../data/fixture'
import { DEFAULT_PINNED_DEMO_DATE, shortMonthForOffset } from './demoClock'

export interface SpendingSummary {
  this_month_total_pence: number
  last_month_total_pence: number
  delta_this_vs_last_pence: number
  recurring_this_month_pence: number
  by_category_pence: Record<string, number>
  by_vendor_pence: Record<string, { total_pence: number; count: number }>
  monthly_history: Array<{
    offset: 0 | 1 | 2
    label: string
    total_pence: number
    by_category_pence: Record<string, number>
  }>
}

export function computeSpendingSummary(
  transactions: Transaction[],
  demoDate: string = DEFAULT_PINNED_DEMO_DATE,
): SpendingSummary {
  const totalsByOffset: [number, number, number] = [0, 0, 0]
  const recurringByOffset: [number, number, number] = [0, 0, 0]
  const catByOffset: [Record<string, number>, Record<string, number>, Record<string, number>] = [
    {},
    {},
    {},
  ]
  const byVendorThisMonth: Record<string, { total_pence: number; count: number }> = {}

  for (const tx of transactions) {
    if (tx.amount_pence <= 0) continue
    const off = tx.month_offset
    if (off !== 0 && off !== 1 && off !== 2) continue

    totalsByOffset[off] += tx.amount_pence
    if (tx.is_subscription) {
      recurringByOffset[off] += tx.amount_pence
    }
    catByOffset[off][tx.category] = (catByOffset[off][tx.category] ?? 0) + tx.amount_pence

    if (off === 0) {
      const existing = byVendorThisMonth[tx.vendor] ?? { total_pence: 0, count: 0 }
      existing.total_pence += tx.amount_pence
      existing.count += 1
      byVendorThisMonth[tx.vendor] = existing
    }
  }

  const offsets: Array<0 | 1 | 2> = [0, 1, 2]
  const monthly_history = offsets.map((offset) => ({
    offset,
    label: shortMonthForOffset(demoDate, offset),
    total_pence: totalsByOffset[offset],
    by_category_pence: catByOffset[offset],
  }))

  return {
    this_month_total_pence: totalsByOffset[0],
    last_month_total_pence: totalsByOffset[1],
    delta_this_vs_last_pence: totalsByOffset[0] - totalsByOffset[1],
    recurring_this_month_pence: recurringByOffset[0],
    by_category_pence: catByOffset[0],
    by_vendor_pence: byVendorThisMonth,
    monthly_history,
  }
}
