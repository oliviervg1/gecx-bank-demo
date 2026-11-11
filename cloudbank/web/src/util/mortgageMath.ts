// Exact integer mortgage amortisation, overpayment, renewal bisection, and renter readiness math.
// Mirrors assist_mortgages/python_code.py with zero Math.round, Math.pow, **, or toFixed.

import type { MortgageAccount, SavingsAccount } from '../data/fixture'
import { halfUp } from './savingsMath'

export { halfUp }

export const MAX_MORTGAGE_MONTHS = 600

export interface MortgageSimulationResult {
  months: number
  total_interest_pence: number
  ending_balance_pence: number
  paid_off: boolean
}

export interface MortgageOverpaymentResult {
  baseline_months: number
  projected_months: number
  months_saved: number
  baseline_interest_pence: number
  projected_interest_pence: number
  interest_saved_pence: number
  remaining_allowance_pence: number
  first_year_overpayment_pence: number
  exceeds_allowance: boolean
  excess_over_allowance_pence: number
  paid_off: boolean
}

export interface RenewalComparisonItem {
  id: string
  label: string
  term_years: number
  rate_bps: number
  payment_pence: number
  delta_pence: number
}

export interface RenterReadinessResult {
  annual_income_pence: number
  max_borrowing_pence: number
  current_deposit_pence: number
  goal_deposit_pence: number
  remaining_to_goal_pence: number
  deposit_progress_bps: number
  indicative_budget_with_goal_pence: number
}

export function simulateMortgage(
  openingBalancePence: number,
  interestRateBps: number,
  monthlyPaymentPence: number,
  maxMonths: number = MAX_MORTGAGE_MONTHS,
): MortgageSimulationResult {
  if (openingBalancePence <= 0) {
    return {
      months: 0,
      total_interest_pence: 0,
      ending_balance_pence: 0,
      paid_off: true,
    }
  }

  let bal = openingBalancePence
  let totalInterest = 0
  for (let monthIdx = 1; monthIdx <= maxMonths; monthIdx++) {
    const interest = halfUp(bal * interestRateBps, 120_000)
    if (bal + interest <= monthlyPaymentPence) {
      return {
        months: monthIdx,
        total_interest_pence: totalInterest + interest,
        ending_balance_pence: 0,
        paid_off: true,
      }
    }
    bal = bal + interest - monthlyPaymentPence
    totalInterest = totalInterest + interest
  }

  return {
    months: maxMonths,
    total_interest_pence: totalInterest,
    ending_balance_pence: bal,
    paid_off: false,
  }
}

export function renewalPaymentPence(
  balancePence: number,
  rateBps: number,
  termRemainingMonths: number,
): number {
  if (balancePence <= 0) {
    return 0
  }
  let low = halfUp(balancePence * rateBps, 120_000) + 1
  let high = balancePence + low
  while (low < high) {
    const sum = low + high
    const mid = (sum - (sum % 2)) / 2
    if (simulateMortgage(balancePence, rateBps, mid, termRemainingMonths).paid_off) {
      high = mid
    } else {
      low = mid + 1
    }
  }
  return low
}

export function projectOverpayment(
  mortgage: MortgageAccount,
  monthlyOverpaymentPence: number,
  lumpSumOverpaymentPence: number,
): MortgageOverpaymentResult {
  const balancePence = mortgage.balance_pence
  const rateBps = mortgage.interest_rate_bps
  const scheduledPence = mortgage.next_payment.amount_pence
  const effectiveLump = Math.min(Math.max(0, lumpSumOverpaymentPence), balancePence)

  const base = simulateMortgage(balancePence, rateBps, scheduledPence)
  const proj = simulateMortgage(
    balancePence - effectiveLump,
    rateBps,
    scheduledPence + monthlyOverpaymentPence,
  )

  const remainingAllowance = Math.max(
    0,
    mortgage.annual_overpayment_allowance_pence - mortgage.overpaid_this_year_pence,
  )
  const firstYearOverpay = Math.min(
    balancePence,
    effectiveLump + Math.min(12, proj.months) * monthlyOverpaymentPence,
  )
  const exceeds = firstYearOverpay > remainingAllowance
  const excess = Math.max(0, firstYearOverpay - remainingAllowance)

  return {
    baseline_months: base.months,
    projected_months: proj.months,
    months_saved: Math.max(0, base.months - proj.months),
    baseline_interest_pence: base.total_interest_pence,
    projected_interest_pence: proj.total_interest_pence,
    interest_saved_pence: Math.max(0, base.total_interest_pence - proj.total_interest_pence),
    remaining_allowance_pence: remainingAllowance,
    first_year_overpayment_pence: firstYearOverpay,
    exceeds_allowance: exceeds,
    excess_over_allowance_pence: excess,
    paid_off: proj.paid_off,
  }
}

export function compareRenewalOptions(mortgage: MortgageAccount): RenewalComparisonItem[] {
  const currentPayment = mortgage.next_payment.amount_pence
  return mortgage.renewal_options.map((opt) => {
    const paymentPence = renewalPaymentPence(
      mortgage.balance_pence,
      opt.rate_bps,
      mortgage.term_remaining_months,
    )
    return {
      id: opt.id,
      label: opt.label,
      term_years: opt.term_years,
      rate_bps: opt.rate_bps,
      payment_pence: paymentPence,
      delta_pence: paymentPence - currentPayment,
    }
  })
}

export function computeRenterReadiness(
  annualIncomePence: number,
  savings: SavingsAccount,
): RenterReadinessResult {
  const maxBorrowingPence = halfUp(annualIncomePence * 45, 10)
  const currentDepositPence = savings.balance_pence
  const goalDepositPence = savings.goal_target_pence
  const remainingToGoalPence = Math.max(0, goalDepositPence - currentDepositPence)
  const depositProgressBps =
    goalDepositPence > 0
      ? Math.min(10_000, halfUp(currentDepositPence * 10_000, goalDepositPence))
      : 10_000
  return {
    annual_income_pence: annualIncomePence,
    max_borrowing_pence: maxBorrowingPence,
    current_deposit_pence: currentDepositPence,
    goal_deposit_pence: goalDepositPence,
    remaining_to_goal_pence: remainingToGoalPence,
    deposit_progress_bps: depositProgressBps,
    indicative_budget_with_goal_pence: maxBorrowingPence + goalDepositPence,
  }
}

export function formatMonthsDuration(totalMonths: number): string {
  const safe = Math.max(0, Math.trunc(totalMonths))
  const months = safe % 12
  const years = (safe - months) / 12
  if (years > 0 && months > 0) {
    return `${years} ${years === 1 ? 'year' : 'years'} and ${months} ${months === 1 ? 'month' : 'months'}`
  }
  if (years > 0) {
    return `${years} ${years === 1 ? 'year' : 'years'}`
  }
  return `${months} ${months === 1 ? 'month' : 'months'}`
}
