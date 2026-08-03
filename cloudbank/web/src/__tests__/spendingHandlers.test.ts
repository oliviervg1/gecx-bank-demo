import { describe, it, expect } from 'vitest'
import { spendingHandlers } from '../agent/handlers/spendingHandlers'

function txn(over: Partial<{
  id: string; days_ago: number; vendor: string; category: string;
  amount: number; is_subscription?: boolean; is_anomaly?: boolean;
  renewal_days_ago?: number
}> = {}) {
  return {
    id: 'x', days_ago: 1, vendor: 'V', category: 'groceries', amount: 10,
    ...over,
  }
}

const today = new Date('2026-05-28T12:00:00Z')

describe('spendingHandlers.get_overview', () => {
  it('returns this-month total, label, top_category, and anomaly when month=0', () => {
    const fixture = {
      user: { first_name: 'Chloe' },
      transactions: [
        txn({ id: 'a', days_ago: 1, vendor: 'Tesco', category: 'groceries', amount: 40 }),
        txn({ id: 'b', days_ago: 2, vendor: 'Pret', category: 'coffee_shops', amount: 5 }),
        txn({ id: 'c', days_ago: 1, vendor: 'Netflix', category: 'subscriptions', amount: 45, is_anomaly: true, renewal_days_ago: 1 }),
      ],
    }
    const out = spendingHandlers.get_overview({}, { fixture, today })
    expect(out).toEqual({
      month_label: 'May',
      total: 90,
      top_category: { name: 'subscriptions', total: 45 },
      anomaly: { vendor: 'Netflix', amount: 45, renewal_days_ago: 1 },
    })
  })

  it('omits anomaly when month > 0', () => {
    const fixture = {
      user: { first_name: 'Chloe' },
      transactions: [
        // Anomaly in current month
        txn({ id: 'n', days_ago: 1, vendor: 'Netflix', category: 'subscriptions', amount: 45, is_anomaly: true, renewal_days_ago: 1 }),
        // April spending so monthly_history[1] is non-empty
        txn({ id: 'a', days_ago: 35, vendor: 'Tesco', category: 'groceries', amount: 50 }),
      ],
    }
    const out = spendingHandlers.get_overview({ month: 1 }, { fixture, today })
    expect(out).not.toHaveProperty('anomaly')
    expect(out.month_label).toBe('Apr')
    expect(out.total).toBe(50)
  })

  it('returns no_data_for_month error when offset is out of range', () => {
    const fixture = {
      user: { first_name: 'Chloe' },
      transactions: [txn({ id: 'a', days_ago: 1, vendor: 'V', category: 'groceries', amount: 10 })],
    }
    const out = spendingHandlers.get_overview({ month: 5 }, { fixture, today })
    expect(out).toEqual({ error: 'no_data_for_month' })
  })

  it('returns no_data_for_month when month is negative', () => {
    const fixture = {
      user: { first_name: 'Chloe' },
      transactions: [txn({ id: 'a', days_ago: 1, vendor: 'V', category: 'groceries', amount: 10 })],
    }
    const out = spendingHandlers.get_overview({ month: -1 }, { fixture, today })
    expect(out).toEqual({ error: 'no_data_for_month' })
  })
})

describe('spendingHandlers.get_category_breakdown', () => {
  it('returns this month total + top 3 vendors for the requested category', () => {
    const fixture = {
      user: { first_name: 'Chloe' },
      transactions: [
        txn({ id: 'p1', days_ago: 1, vendor: 'Pret a Manger', category: 'coffee_shops', amount: 5 }),
        txn({ id: 'p2', days_ago: 2, vendor: 'Pret a Manger', category: 'coffee_shops', amount: 5 }),
        txn({ id: 'c1', days_ago: 3, vendor: 'Costa Coffee', category: 'coffee_shops', amount: 4 }),
        txn({ id: 's1', days_ago: 4, vendor: 'Starbucks',    category: 'coffee_shops', amount: 3 }),
        txn({ id: 'tk', days_ago: 5, vendor: 'Tim Hortons',  category: 'coffee_shops', amount: 2 }),
        txn({ id: 't',  days_ago: 5, vendor: 'Tesco',        category: 'groceries',    amount: 40 }),  // other cat ignored
      ],
    }
    const out = spendingHandlers.get_category_breakdown(
      { category: 'coffee_shops' },
      { fixture, today },
    )
    expect(out).toEqual({
      category: 'coffee_shops',
      month_label: 'May',
      total: 19,
      top_vendors: [
        { vendor: 'Pret a Manger', total: 10, count: 2 },
        { vendor: 'Costa Coffee',  total: 4,  count: 1 },
        { vendor: 'Starbucks',     total: 3,  count: 1 },
      ],
    })
  })

  it('honours month=1 (last month) and recomputes top_vendors for that month', () => {
    const fixture = {
      user: { first_name: 'Chloe' },
      transactions: [
        // April (days_ago ≈ 35)
        txn({ id: 'p_apr',  days_ago: 35, vendor: 'Pret', category: 'coffee_shops', amount: 8 }),
        txn({ id: 'c_apr',  days_ago: 37, vendor: 'Costa', category: 'coffee_shops', amount: 6 }),
        // May (days_ago = 1) — should NOT appear when month=1
        txn({ id: 's_may',  days_ago: 1,  vendor: 'Starbucks', category: 'coffee_shops', amount: 99 }),
      ],
    }
    const out = spendingHandlers.get_category_breakdown(
      { category: 'coffee_shops', month: 1 },
      { fixture, today },
    )
    expect(out).toMatchObject({
      category: 'coffee_shops',
      month_label: 'Apr',
      total: 14,
    })
    expect((out as { top_vendors: Array<{ vendor: string }> }).top_vendors.map((v) => v.vendor))
      .toEqual(['Pret', 'Costa'])
  })

  it('returns unknown_category when the category is not in the enum', () => {
    const fixture = {
      user: { first_name: 'Chloe' },
      transactions: [],
    }
    const out = spendingHandlers.get_category_breakdown(
      { category: 'fancy_dining' },
      { fixture, today },
    )
    expect(out).toEqual({ error: 'unknown_category' })
  })

  it('returns no_data_for_month when month offset is out of range', () => {
    const fixture = { user: { first_name: 'Chloe' }, transactions: [] }
    const out = spendingHandlers.get_category_breakdown(
      { category: 'groceries', month: 9 },
      { fixture, today },
    )
    expect(out).toEqual({ error: 'no_data_for_month' })
  })
})

describe('spendingHandlers.get_vendor_breakdown', () => {
  it('matches case-insensitive substring across vendor keys and sums', () => {
    const fixture = {
      user: { first_name: 'Chloe' },
      transactions: [
        txn({ id: 't1', days_ago: 1, vendor: 'Tesco',         category: 'groceries', amount: 20 }),
        txn({ id: 't2', days_ago: 3, vendor: 'Tesco Express', category: 'groceries', amount: 12 }),
        txn({ id: 'a',  days_ago: 2, vendor: 'Asda',          category: 'groceries', amount: 40 }),  // not matched
      ],
    }
    const out = spendingHandlers.get_vendor_breakdown({ vendor: 'tesco' }, { fixture, today })
    expect(out).toMatchObject({
      matched_vendors: expect.arrayContaining(['Tesco', 'Tesco Express']),
      month_label: 'May',
      total: 32,
      count: 2,
    })
  })

  it('returns last 3 individual charges across matched vendors', () => {
    const fixture = {
      user: { first_name: 'Chloe' },
      transactions: [
        txn({ id: 'a', days_ago: 1, vendor: 'Tesco', category: 'groceries', amount: 10 }),
        txn({ id: 'b', days_ago: 3, vendor: 'Tesco Express', category: 'groceries', amount: 20 }),
        txn({ id: 'c', days_ago: 5, vendor: 'Tesco', category: 'groceries', amount: 30 }),
        txn({ id: 'd', days_ago: 7, vendor: 'Tesco', category: 'groceries', amount: 40 }),  // 4th — should be dropped
      ],
    }
    const out = spendingHandlers.get_vendor_breakdown({ vendor: 'tesco' }, { fixture, today }) as
      { recent: Array<{ days_ago: number; amount: number }> }
    expect(out.recent).toEqual([
      { days_ago: 1, amount: 10 },
      { days_ago: 3, amount: 20 },
      { days_ago: 5, amount: 30 },
    ])
  })

  it('returns empty-match shape (NOT an error) when no vendor matches', () => {
    const fixture = {
      user: { first_name: 'Chloe' },
      transactions: [txn({ id: 'a', days_ago: 1, vendor: 'Tesco', category: 'groceries', amount: 10 })],
    }
    const out = spendingHandlers.get_vendor_breakdown({ vendor: 'mystery' }, { fixture, today })
    expect(out).toEqual({
      matched_vendors: [],
      month_label: 'May',
      total: 0,
      count: 0,
      recent: [],
    })
  })

  it('returns missing_vendor error when vendor is empty', () => {
    const fixture = { user: { first_name: 'Chloe' }, transactions: [] }
    const out = spendingHandlers.get_vendor_breakdown({ vendor: '' }, { fixture, today })
    expect(out).toEqual({ error: 'missing_vendor' })
  })

  it('returns no_data_for_month error when month is out of range', () => {
    const fixture = { user: { first_name: 'Chloe' }, transactions: [] }
    const out = spendingHandlers.get_vendor_breakdown({ vendor: 'Tesco', month: 99 }, { fixture, today })
    expect(out).toEqual({ error: 'no_data_for_month' })
  })
})

describe('spendingHandlers.get_monthly_trend', () => {
  it('returns overall 3-month trend with precomputed delta when no filter', () => {
    const fixture = {
      user: { first_name: 'Chloe' },
      transactions: [
        txn({ id: 'm1', days_ago: 1,  vendor: 'V', category: 'groceries', amount: 100 }),  // May
        txn({ id: 'm2', days_ago: 35, vendor: 'V', category: 'groceries', amount: 80 }),   // Apr
        txn({ id: 'm3', days_ago: 65, vendor: 'V', category: 'groceries', amount: 60 }),   // Mar
      ],
    }
    const out = spendingHandlers.get_monthly_trend({}, { fixture, today })
    expect(out).toEqual({
      scope: 'overall',
      months: [
        { label: 'May', total: 100 },
        { label: 'Apr', total: 80 },
        { label: 'Mar', total: 60 },
      ],
      delta_vs_last_month: 20,
    })
  })

  it('returns category-scoped trend when category arg is set', () => {
    const fixture = {
      user: { first_name: 'Chloe' },
      transactions: [
        txn({ id: 'c1', days_ago: 1,  vendor: 'Pret', category: 'coffee_shops', amount: 30 }),
        txn({ id: 'c2', days_ago: 35, vendor: 'Pret', category: 'coffee_shops', amount: 25 }),
        txn({ id: 'g1', days_ago: 1,  vendor: 'Tesco', category: 'groceries',  amount: 99 }),  // not in this scope
      ],
    }
    const out = spendingHandlers.get_monthly_trend({ category: 'coffee_shops' }, { fixture, today })
    expect(out).toEqual({
      scope: 'category',
      months: [
        { label: 'May', total: 30 },
        { label: 'Apr', total: 25 },
        { label: 'Mar', total: 0 },
      ],
      delta_vs_last_month: 5,
    })
  })

  it('returns vendor-scoped trend with matched_vendors and substring matching', () => {
    const fixture = {
      user: { first_name: 'Chloe' },
      transactions: [
        txn({ id: 'a', days_ago: 1,  vendor: 'Tesco',         category: 'groceries', amount: 20 }),
        txn({ id: 'b', days_ago: 5,  vendor: 'Tesco Express', category: 'groceries', amount: 10 }),
        txn({ id: 'c', days_ago: 35, vendor: 'Tesco',         category: 'groceries', amount: 25 }),
        txn({ id: 'd', days_ago: 4,  vendor: 'Asda',          category: 'groceries', amount: 99 }),  // ignored
      ],
    }
    const out = spendingHandlers.get_monthly_trend({ vendor: 'tesco' }, { fixture, today }) as {
      scope: string; matched_vendors: string[]; months: Array<{ label: string; total: number }>; delta_vs_last_month: number
    }
    expect(out.scope).toBe('vendor')
    expect(out.matched_vendors.sort()).toEqual(['Tesco', 'Tesco Express'])
    expect(out.months).toEqual([
      { label: 'May', total: 30 },
      { label: 'Apr', total: 25 },
      { label: 'Mar', total: 0 },
    ])
    expect(out.delta_vs_last_month).toBe(5)
  })

  it('returns mutually_exclusive_filters when both category and vendor are set', () => {
    const fixture = { user: { first_name: 'Chloe' }, transactions: [] }
    const out = spendingHandlers.get_monthly_trend(
      { category: 'groceries', vendor: 'Tesco' },
      { fixture, today },
    )
    expect(out).toEqual({ error: 'mutually_exclusive_filters' })
  })

  it('returns missing_vendor when vendor arg is empty string', () => {
    const fixture = { user: { first_name: 'Chloe' }, transactions: [] }
    const out = spendingHandlers.get_monthly_trend({ vendor: '' }, { fixture, today })
    expect(out).toEqual({ error: 'missing_vendor' })
  })

  it('returns unknown_category when category is not in the enum', () => {
    const fixture = { user: { first_name: 'Chloe' }, transactions: [] }
    const out = spendingHandlers.get_monthly_trend({ category: 'fancy_dining' }, { fixture, today })
    expect(out).toEqual({ error: 'unknown_category' })
  })

  it('overall scope always returns 3 months even when fixture is sparse', () => {
    const fixture = {
      user: { first_name: 'Chloe' },
      // Only May data — no April or March transactions
      transactions: [
        txn({ id: 'a', days_ago: 1, vendor: 'V', category: 'groceries', amount: 50 }),
      ],
    }
    const out = spendingHandlers.get_monthly_trend({}, { fixture, today }) as {
      months: Array<{ label: string; total: number }>
    }
    expect(out.months).toEqual([
      { label: 'May', total: 50 },
      { label: 'Apr', total: 0 },
      { label: 'Mar', total: 0 },
    ])
  })
})

describe('spendingHandlers.get_subscriptions', () => {
  it('returns this-month subscription total + items from the subscriptions category', () => {
    const fixture = {
      user: { first_name: 'Chloe' },
      transactions: [
        txn({ id: 'n', days_ago: 1, vendor: 'Netflix', category: 'subscriptions', amount: 45, is_subscription: true }),
        txn({ id: 's', days_ago: 4, vendor: 'Spotify', category: 'subscriptions', amount: 12, is_subscription: true }),
        txn({ id: 't', days_ago: 5, vendor: 'Tesco',   category: 'groceries',     amount: 99 }),  // not a subscription
      ],
    }
    const out = spendingHandlers.get_subscriptions({}, { fixture, today })
    expect(out).toEqual({
      month_label: 'May',
      monthly_total: 57,
      items: [
        { vendor: 'Netflix', amount: 45 },
        { vendor: 'Spotify', amount: 12 },
      ],
    })
  })

  it('honours month=1 (last month) and excludes current-month subscriptions', () => {
    const fixture = {
      user: { first_name: 'Chloe' },
      transactions: [
        txn({ id: 'n_may', days_ago: 1,  vendor: 'Netflix', category: 'subscriptions', amount: 45, is_subscription: true }),
        txn({ id: 'n_apr', days_ago: 35, vendor: 'Netflix', category: 'subscriptions', amount: 45, is_subscription: true }),
      ],
    }
    const out = spendingHandlers.get_subscriptions({ month: 1 }, { fixture, today }) as
      { monthly_total: number; items: Array<{ vendor: string }> }
    expect(out.monthly_total).toBe(45)
    expect(out.items).toEqual([{ vendor: 'Netflix', amount: 45 }])
  })

  it('returns no_data_for_month when offset out of range', () => {
    const fixture = { user: { first_name: 'Chloe' }, transactions: [] }
    const out = spendingHandlers.get_subscriptions({ month: 99 }, { fixture, today })
    expect(out).toEqual({ error: 'no_data_for_month' })
  })
})
