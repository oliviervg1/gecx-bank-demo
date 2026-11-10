import { describe, it, expect } from 'vitest'
import parityVectors from '../../../shared/parity_vectors.json'
import savingsMathSource from '../util/savingsMath.ts?raw'
import mortgageMathSource from '../util/mortgageMath.ts?raw'
import demoClockSource from '../util/demoClock.ts?raw'
import { getFixture } from '../data/fixture'
import type { Persona } from '../personas/personas'
import {
  annualInterestOnBalance,
  computeSavingsComparison,
  halfUp,
  projectSavingsGoal,
} from '../util/savingsMath'
import {
  compareRenewalOptions,
  computeRenterReadiness,
  formatMonthsDuration,
  projectOverpayment,
  renewalPaymentPence,
  simulateMortgage,
} from '../util/mortgageMath'
import { computeSpendingSummary } from '../util/spendingSummary'
import {
  categoryDrilldownView,
  matchVendorRows,
  subscriptionsView,
  vendorHistoryView,
} from '../util/spendingViews'

const DEMO_DATE = parityVectors.demo_date

describe('Cross-language integer math source hygiene', () => {
  const mathSources: Array<[string, string]> = [
    ['savingsMath.ts', savingsMathSource],
    ['mortgageMath.ts', mortgageMathSource],
    ['demoClock.ts', demoClockSource],
  ]

  it.each(mathSources)(
    'bans Math.round, Math.pow, **, toFixed, and toISOString in %s',
    (_fileName, raw) => {
      // Strip single-line and block comments before checking executable tokens.
      const stripped = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')

      expect(stripped).not.toMatch(/Math\.round\b/)
      expect(stripped).not.toMatch(/Math\.pow\b/)
      expect(stripped).not.toContain('**')
      expect(stripped).not.toMatch(/\.toFixed\s*\(/)
      expect(stripped).not.toMatch(/\.toISOString\s*\(/)
    },
  )
})

describe('parity_vectors.json — half_up_cases', () => {
  it.each(parityVectors.half_up_cases)('$id: halfUp($n, $d) === $expected', (c) => {
    expect(halfUp(c.n, c.d)).toBe(c.expected)
  })

  it('rounds strictly at the exact half boundary and not one unit below', () => {
    expect(halfUp(59_999, 120_000)).toBe(0)
    expect(halfUp(60_000, 120_000)).toBe(1)
    expect(halfUp(4, 2)).toBe(2)
    expect(halfUp(5, 2)).toBe(3)
  })
})

describe('parity_vectors.json — persona_spending', () => {
  const entries = Object.entries(parityVectors.persona_spending) as Array<
    [Persona, (typeof parityVectors.persona_spending)['chloe']]
  >

  it.each(entries)('matches exact spending totals, deltas, categories, and anomalies for %s', (persona, expected) => {
    const fixture = getFixture(persona)
    const summary = computeSpendingSummary(fixture.transactions, DEMO_DATE)

    expect(summary.monthly_history.map((m) => m.total_pence)).toEqual(
      expected.monthly_totals_pence,
    )
    expect(summary.this_month_total_pence).toBe(expected.monthly_totals_pence[0])
    expect(summary.last_month_total_pence).toBe(expected.monthly_totals_pence[1])
    expect(summary.delta_this_vs_last_pence).toBe(expected.delta_this_vs_last_pence)

    const subs0 = subscriptionsView(fixture.transactions, 'this_month', DEMO_DATE)
    const subs1 = subscriptionsView(fixture.transactions, 'last_month', DEMO_DATE)
    const subs2 = subscriptionsView(fixture.transactions, 'two_months_ago', DEMO_DATE)
    expect([subs0.total_pence, subs1.total_pence, subs2.total_pence]).toEqual(
      expected.recurring_totals_pence,
    )
    expect(summary.recurring_this_month_pence).toBe(expected.recurring_totals_pence[0])

    expect(summary.by_category_pence).toEqual(expected.by_category_this_month_pence)

    for (const [cat, catPence] of Object.entries(expected.by_category_this_month_pence)) {
      const drill = categoryDrilldownView(fixture.transactions, cat, 'this_month', DEMO_DATE)
      expect(drill.total_pence).toBe(catPence)
    }

    const anom = fixture.transactions.find((t) => t.month_offset === 0 && t.is_anomaly)
    expect(anom).toBeDefined()
    expect(anom!.id).toBe(expected.anomaly.id)
    expect(anom!.vendor).toBe(expected.anomaly.vendor)
    expect(anom!.day).toBe(expected.anomaly.day)
    expect(anom!.amount_pence).toBe(expected.anomaly.amount_pence)

    const vh = vendorHistoryView(
      fixture.transactions,
      expected.anomaly.vendor,
      'last_month',
      DEMO_DATE,
    )
    expect(vh.periodTotalPence).toBe(expected.anomaly.prior_month_amount_pence)
  })

  it('matches whole vendor tokens identically to Python _match_vendor_rows (S2-1)', () => {
    const chloeTxns = getFixture('chloe').transactions
    const davidTxns = getFixture('david').transactions
    // Short substring "co" must NOT match "Tesco" or "Costa Coffee".
    expect(matchVendorRows(chloeTxns, 'co').matched).toHaveLength(0)
    // Possessive stem "sainsbury" matches "Sainsbury's" (in David's fixture).
    const sainsbury = matchVendorRows(davidTxns, 'sainsbury')
    expect(sainsbury.canonical).toBe("Sainsbury's")
    expect(sainsbury.matched.length).toBeGreaterThan(0)
    // Single whole token "costa" matches "Costa Coffee".
    const costa = matchVendorRows(chloeTxns, 'costa')
    expect(costa.canonical).toBe('Costa Coffee')
    expect(costa.matched.length).toBeGreaterThan(0)
  })
})

describe('parity_vectors.json — savings_projections', () => {
  for (const row of parityVectors.savings_projections) {
    it(`matches savings vector ${row.id}`, () => {
      if ('persona' in row && row.persona) {
        const sav = getFixture(row.persona as Persona).accounts.savings
        const res = computeSavingsComparison(
          sav,
          DEMO_DATE,
          row.extra_monthly_pence,
          row.custom_target_pence,
        )
        expect(res.baseline_months).toBe(row.expected.baseline_months)
        expect(res.projected_months).toBe(row.expected.projected_months)
        expect(res.months_saved).toBe(row.expected.months_saved)
        expect(res.unreachable).toBe(row.expected.unreachable)
        expect(res.projected_balance_pence).toBe(row.expected.projected_balance_pence)
        expect(res.total_interest_earned_pence).toBe(row.expected.total_interest_earned_pence)
        expect(res.annual_interest_on_balance_pence).toBe(
          row.expected.annual_interest_on_balance_pence,
        )
        expect(res.target_year).toBe(row.expected.target_year)
        expect(res.target_month).toBe(row.expected.target_month)
        expect(annualInterestOnBalance(sav.balance_pence, sav.gross_rate_bps)).toBe(
          row.expected.annual_interest_on_balance_pence,
        )
      } else if ('synthetic' in row && row.synthetic) {
        const s = row.synthetic
        const res = projectSavingsGoal(
          s.balance_pence,
          s.gross_rate_bps,
          s.monthly_contribution_pence,
          s.extra_monthly_pence,
          s.goal_target_pence,
        )
        expect(res).toEqual(row.expected)
      }
    })
  }
})

describe('parity_vectors.json — mortgage_overpayments & simulation_edges', () => {
  it.each(parityVectors.mortgage_overpayments)('matches mortgage overpayment vector $id', (row) => {
    const mg = getFixture(row.persona as Persona).accounts.mortgage!
    const res = projectOverpayment(
      mg,
      row.monthly_overpayment_pence,
      row.lump_sum_overpayment_pence,
    )
    expect({
      baseline_months: res.baseline_months,
      projected_months: res.projected_months,
      months_saved: res.months_saved,
      baseline_interest_pence: res.baseline_interest_pence,
      projected_interest_pence: res.projected_interest_pence,
      interest_saved_pence: res.interest_saved_pence,
      remaining_allowance_pence: res.remaining_allowance_pence,
      first_year_overpayment_pence: res.first_year_overpayment_pence,
      exceeds_allowance: res.exceeds_allowance,
      excess_over_allowance_pence: res.excess_over_allowance_pence,
    }).toEqual(row.expected)
  })

  it.each(parityVectors.mortgage_simulation_edges)('matches simulation edge vector $id', (row) => {
    const res = simulateMortgage(
      row.balance_pence,
      row.interest_rate_bps,
      row.monthly_payment_pence,
      row.max_months,
    )
    expect(res).toEqual(row.expected)
  })

  it('handles zero or negative opening mortgage balance cleanly', () => {
    expect(simulateMortgage(0, 420, 100_000)).toEqual({
      months: 0,
      total_interest_pence: 0,
      ending_balance_pence: 0,
      paid_off: true,
    })
  })
})

describe('parity_vectors.json — mortgage_renewals (integer bisection)', () => {
  const renewalEntries = Object.entries(parityVectors.mortgage_renewals) as Array<
    [Persona, (typeof parityVectors.mortgage_renewals)['chloe']]
  >

  it.each(renewalEntries)('matches exact bisection renewal payments and deltas for %s', (persona, expected) => {
    const mg = getFixture(persona).accounts.mortgage!
    expect(mg.next_payment.amount_pence).toBe(expected.current_payment_pence)
    const items = compareRenewalOptions(mg)
    expect(
      items.map((i) => ({
        id: i.id,
        rate_bps: i.rate_bps,
        payment_pence: i.payment_pence,
        delta_pence: i.delta_pence,
      })),
    ).toEqual(expected.options)

    // Pin optimality: payment_pence pays off within term_remaining_months, payment_pence - 1 does NOT!
    for (const opt of expected.options) {
      const p = renewalPaymentPence(mg.balance_pence, opt.rate_bps, mg.term_remaining_months)
      expect(p).toBe(opt.payment_pence)
      expect(
        simulateMortgage(mg.balance_pence, opt.rate_bps, p, mg.term_remaining_months).paid_off,
      ).toBe(true)
      expect(
        simulateMortgage(mg.balance_pence, opt.rate_bps, p - 1, mg.term_remaining_months).paid_off,
      ).toBe(false)
    }
  })
})

describe('parity_vectors.json — renter_readiness & duration formatting', () => {
  it('matches Tom renter readiness vector verbatim', () => {
    const tom = getFixture('tom')
    const res = computeRenterReadiness(tom.user.annual_income_pence, tom.accounts.savings)
    expect(res).toEqual(parityVectors.renter_readiness.tom)
  })

  it('formats durations identically to Python _format_months_duration', () => {
    expect(formatMonthsDuration(220)).toBe('18 years and 4 months')
    expect(formatMonthsDuration(12)).toBe('1 year')
    expect(formatMonthsDuration(24)).toBe('2 years')
    expect(formatMonthsDuration(1)).toBe('1 month')
    expect(formatMonthsDuration(5)).toBe('5 months')
    expect(formatMonthsDuration(13)).toBe('1 year and 1 month')
  })
})
