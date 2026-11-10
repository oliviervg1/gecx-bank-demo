import { describe, it, expect } from 'vitest'
import { composeHomeInsight } from '../pages/home/composeHomeInsight'

const baseSummary = {
  this_month_total_pence: 84520,
  last_month_total_pence: 82000,
  delta_this_vs_last_pence: 2520,
  recurring_this_month_pence: 10000,
  by_category_pence: {},
  by_vendor_pence: {},
  monthly_history: [
    { offset: 0 as const, label: 'Nov', total_pence: 84520, by_category_pence: {} },
    { offset: 1 as const, label: 'Oct', total_pence: 82000, by_category_pence: {} },
    { offset: 2 as const, label: 'Sep', total_pence: 80000, by_category_pence: {} },
  ],
}

const mortgage = {
  next_payment: { amount_pence: 124550, day_of_month: 1 },
}

describe('composeHomeInsight', () => {
  it('renders resolved calendar month, exact GBP figures, and ordinal payment day', () => {
    const out = composeHomeInsight({
      spending_summary: baseSummary,
      mortgage,
      currentBalancePence: 425075,
      demoDate: '2026-11-24',
    })
    expect(out).toContain('November')
    expect(out).toContain('£845.20')
    expect(out).toContain('£1,245.50')
    expect(out).toContain('1st')
    expect(out).toContain('comfortable buffer')
  })

  it('distinguishes typical vs ahead-of-usual pace and tight balance margin', () => {
    const ahead = composeHomeInsight({
      spending_summary: { ...baseSummary, this_month_total_pence: 200000 },
      mortgage,
      currentBalancePence: 50000,
      demoDate: '2026-11-24',
    })
    expect(ahead).toContain('running ahead')
    expect(ahead).toContain('tight margin')
  })

  it('omits mortgage clause for renters without a mortgage', () => {
    const renter = composeHomeInsight({
      spending_summary: baseSummary,
      currentBalancePence: 300000,
      demoDate: '2026-11-24',
    })
    expect(renter).toContain('£845.20')
    expect(renter).not.toContain('mortgage payment')
  })
})
