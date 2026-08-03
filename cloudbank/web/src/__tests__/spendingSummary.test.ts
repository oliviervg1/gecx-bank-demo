import { describe, it, expect } from 'vitest'
import { computeSpendingSummary, isInCurrentCalendarMonth, type RawTransaction } from '../util/spendingSummary'

// Fixed "today" so tests are deterministic across runs and timezones.
// Anchor on the 15th of a month so any days_ago up to 14 stays in-month.
const TODAY = new Date(2026, 4, 15) // 2026-05-15

function tx(days_ago: number, amount: number, category: string, vendor?: string): RawTransaction {
  return { days_ago, amount, category, vendor }
}

describe('computeSpendingSummary', () => {
  it('returns zeros for an empty transaction list', () => {
    const s = computeSpendingSummary([], TODAY)
    expect(s.this_month_total).toBe(0)
    expect(s.by_category).toEqual({})
    expect(s.by_vendor).toEqual({})
    // monthly_history is always exactly 3 calendar months (this, last,
    // two-ago), zero-padded — that invariant is what lets the get_* handlers
    // treat the index as a month offset. An empty window must still be three
    // zeroed months, not [], and no empty month may be dropped mid-window.
    expect(s.monthly_history).toHaveLength(3)
    expect(s.monthly_history.every((m) => m.total === 0)).toBe(true)
    expect(s.monthly_history.map((m) => m.label)).toEqual(['May', 'Apr', 'Mar'])
  })

  it('keeps monthly_history[n] aligned to "n calendar months ago" when a month is empty', () => {
    // Only last month has spend. The current month must still occupy index 0
    // at £0 rather than shifting last month into it.
    const s = computeSpendingSummary([tx(20, 50, 'groceries', 'Tesco')], TODAY)
    expect(s.monthly_history.map((m) => m.label)).toEqual(['May', 'Apr', 'Mar'])
    expect(s.monthly_history[0].total).toBe(0)
    expect(s.monthly_history[1].total).toBe(50)
  })

  it('aggregates current-month spend into this_month_total + by_category + by_vendor', () => {
    const s = computeSpendingSummary([
      tx(1, 12.40, 'groceries', 'Tesco'),
      tx(2, 4.95, 'coffee_shops', 'Pret'),
      tx(5, 25.00, 'groceries', 'Tesco'),
    ], TODAY)
    expect(s.this_month_total).toBe(42.35)
    expect(s.by_category).toEqual({ groceries: 37.40, coffee_shops: 4.95 })
    expect(s.by_vendor).toEqual({
      Tesco: { total: 37.40, count: 2 },
      Pret: { total: 4.95, count: 1 },
    })
  })

  it('excludes income (amount < 0) from all spending sums', () => {
    const s = computeSpendingSummary([
      tx(1, -3200, 'income', 'Salary'),
      tx(1, 12.40, 'groceries', 'Tesco'),
    ], TODAY)
    expect(s.this_month_total).toBe(12.40)
    expect(s.by_category).toEqual({ groceries: 12.40 })
    expect(s.by_vendor).toEqual({ Tesco: { total: 12.40, count: 1 } })
  })

  it('returns monthly_history newest-first, max 3 entries', () => {
    const s = computeSpendingSummary([
      tx(1, 10, 'groceries'),    // May
      tx(35, 20, 'groceries'),   // April (15 - 35d ≈ April 10)
      tx(70, 30, 'groceries'),   // March
      tx(100, 40, 'groceries'),  // February — should be sliced off
    ], TODAY)
    expect(s.monthly_history).toHaveLength(3)
    expect(s.monthly_history.map((m) => m.label)).toEqual(['May', 'Apr', 'Mar'])
    expect(s.monthly_history[0].total).toBe(10)
    expect(s.monthly_history[1].total).toBe(20)
    expect(s.monthly_history[2].total).toBe(30)
  })

  it('rounds every numeric output to 2 decimals', () => {
    const s = computeSpendingSummary([
      tx(1, 1.005, 'groceries', 'A'),
      tx(2, 1.005, 'groceries', 'A'),
    ], TODAY)
    // Cumulative-rounding-safe: rounding at output boundary, not per-add.
    expect(s.this_month_total).toBe(2.01)
    expect(s.by_category.groceries).toBe(2.01)
    expect(s.by_vendor.A.total).toBe(2.01)
  })
})

describe('isInCurrentCalendarMonth', () => {
  it('is true for today (days_ago=0)', () => {
    expect(isInCurrentCalendarMonth(0, TODAY)).toBe(true)
  })

  it('is true for days_ago that keep the date within the current calendar month', () => {
    // TODAY is May 15 — days_ago up to 14 lands on May 1 or later, still May.
    expect(isInCurrentCalendarMonth(14, TODAY)).toBe(true)
  })

  it('is false for days_ago that crosses into the previous calendar month', () => {
    // days_ago=15 from May 15 → April 30. Different calendar month.
    expect(isInCurrentCalendarMonth(15, TODAY)).toBe(false)
  })

  it('is false for days_ago > 30 even when "last 30 days" would catch it', () => {
    // days_ago=30 from May 15 → April 15. NOT in May — proving the calendar-
    // month semantic differs from the old "<=30 sliding window".
    expect(isInCurrentCalendarMonth(30, TODAY)).toBe(false)
  })
})
