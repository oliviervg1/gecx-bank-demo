import { describe, it, expect } from 'vitest'
import { computeSpendingSummary } from '../util/spendingSummary'
import type { Transaction } from '../data/fixture'

function tx(
  month_offset: 0 | 1 | 2,
  day: number,
  amount_pence: number,
  category: Transaction['category'],
  vendor: string = 'Merchant',
  is_subscription = false,
): Transaction {
  return {
    id: `txn-${month_offset}-${day}-${vendor}`,
    month_offset,
    day,
    vendor,
    category,
    amount_pence,
    is_subscription,
  }
}

describe('computeSpendingSummary (integer pence + month_offset)', () => {
  it('returns three zero-padded calendar months for an empty list', () => {
    const s = computeSpendingSummary([], '2026-11-24')
    expect(s.this_month_total_pence).toBe(0)
    expect(s.last_month_total_pence).toBe(0)
    expect(s.delta_this_vs_last_pence).toBe(0)
    expect(s.by_category_pence).toEqual({})
    expect(s.by_vendor_pence).toEqual({})
    expect(s.monthly_history.map((m) => m.label)).toEqual(['Nov', 'Oct', 'Sep'])
    expect(s.monthly_history.every((m) => m.total_pence === 0)).toBe(true)
  })

  it('aggregates current-month spend, recurring total, and delta vs last month', () => {
    const s = computeSpendingSummary(
      [
        tx(0, 21, 4500, 'subscriptions', 'Netflix', true),
        tx(0, 18, 1240, 'groceries', 'Tesco'),
        tx(0, 10, 2500, 'groceries', 'Tesco'),
        tx(1, 21, 1799, 'subscriptions', 'Netflix', true),
      ],
      '2026-11-24',
    )
    expect(s.this_month_total_pence).toBe(8240)
    expect(s.last_month_total_pence).toBe(1799)
    expect(s.delta_this_vs_last_pence).toBe(6441)
    expect(s.recurring_this_month_pence).toBe(4500)
    expect(s.by_category_pence).toEqual({ subscriptions: 4500, groceries: 3740 })
    expect(s.by_vendor_pence).toEqual({
      Netflix: { total_pence: 4500, count: 1 },
      Tesco: { total_pence: 3740, count: 2 },
    })
  })

  it('excludes negative income rows from all spending sums', () => {
    const s = computeSpendingSummary(
      [
        tx(0, 1, -350000, 'income', 'Salary'),
        tx(0, 5, 1240, 'groceries', 'Tesco'),
      ],
      '2026-11-24',
    )
    expect(s.this_month_total_pence).toBe(1240)
    expect(s.by_category_pence).toEqual({ groceries: 1240 })
  })
})
