import { describe, it, expect } from 'vitest'
import { composeHomeInsight } from '../pages/home/composeHomeInsight'

const baseSummary = {
  this_month_total: 845.20,
  monthly_history: [
    { label: 'May', total: 845.20, by_category: {} },
    { label: 'Apr', total: 820.00, by_category: {} },
    { label: 'Mar', total: 800.00, by_category: {} },
  ],
}

const mortgage = {
  next_payment: { amount: 1245.50, day_of_month: 1 },
}

describe('composeHomeInsight', () => {
  it('produces a sentence containing both money values and an ordinal date', () => {
    const out = composeHomeInsight({
      spending_summary: baseSummary as never,
      mortgage,
      currentBalance: 4250.75,
    })
    expect(out).toContain('£845.20')
    expect(out).toContain('£1,245.50')
    expect(out).toContain('1st')
  })

  it('says "well within your typical range" when spend is within 110% of avg', () => {
    const out = composeHomeInsight({
      spending_summary: { ...baseSummary, this_month_total: 800 } as never,
      mortgage,
      currentBalance: 4250.75,
    })
    expect(out).toContain('well within your typical range')
  })

  it('says "running ahead of your usual" when spend > 130% of avg', () => {
    const out = composeHomeInsight({
      spending_summary: { ...baseSummary, this_month_total: 2000 } as never,
      mortgage,
      currentBalance: 4250.75,
    })
    expect(out).toContain('running ahead of your usual')
  })

  it('says "comfortable buffer" when balance is more than 2x the next payment', () => {
    const out = composeHomeInsight({
      spending_summary: baseSummary as never,
      mortgage,
      currentBalance: 4250.75,
    })
    expect(out).toContain('comfortable buffer')
  })

  it('says "tight against" when balance is below the next payment amount', () => {
    const out = composeHomeInsight({
      spending_summary: baseSummary as never,
      mortgage,
      currentBalance: 500,
    })
    expect(out).toContain('tight against')
  })
})
