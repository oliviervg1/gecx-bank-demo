// Exact integer savings projection math mirroring assist_savings/python_code.py.
// Zero Math.round, Math.pow, **, or toFixed.

import type { SavingsAccount } from '../data/fixture'
import { targetYearMonth } from './demoClock'

export const MAX_SAVINGS_PROJECTION_MONTHS = 600

export interface SavingsGoalResult {
  months_to_goal: number | null
  unreachable: boolean
  projected_balance_pence: number
  total_interest_earned_pence: number
}

export interface SavingsComparisonResult {
  baseline_months: number | null
  projected_months: number | null
  months_saved: number
  unreachable: boolean
  projected_balance_pence: number
  total_interest_earned_pence: number
  annual_interest_on_balance_pence: number
  target_pence: number
  target_year: number | null
  target_month: number | null
  target_label: string | null
}

/**
 * Exact integer half-up division for non-negative integers n >= 0 and d > 0.
 */
export function halfUp(n: number, d: number): number {
  const num = n * 2 + d
  const den = 2 * d
  return (num - (num % den)) / den
}

export function projectSavingsGoal(
  balancePence: number,
  grossRateBps: number,
  monthlyContributionPence: number,
  extraMonthlyPence: number,
  goalTargetPence: number,
): SavingsGoalResult {
  if (balancePence >= goalTargetPence) {
    return {
      months_to_goal: 0,
      unreachable: false,
      projected_balance_pence: balancePence,
      total_interest_earned_pence: 0,
    }
  }

  let pot = balancePence
  let totalInterest = 0
  const monthlyAdd = monthlyContributionPence + extraMonthlyPence

  for (let monthIdx = 1; monthIdx <= MAX_SAVINGS_PROJECTION_MONTHS; monthIdx++) {
    const interest = halfUp(pot * grossRateBps, 120_000)
    pot = pot + interest + monthlyAdd
    totalInterest = totalInterest + interest
    if (pot >= goalTargetPence) {
      return {
        months_to_goal: monthIdx,
        unreachable: false,
        projected_balance_pence: pot,
        total_interest_earned_pence: totalInterest,
      }
    }
  }

  return {
    months_to_goal: null,
    unreachable: true,
    projected_balance_pence: pot,
    total_interest_earned_pence: totalInterest,
  }
}

export function annualInterestOnBalance(
  balancePence: number,
  grossRateBps: number,
): number {
  let pot = balancePence
  let earned = 0
  for (let m = 0; m < 12; m++) {
    const interest = halfUp(pot * grossRateBps, 120_000)
    pot = pot + interest
    earned = earned + interest
  }
  return earned
}

export function computeSavingsComparison(
  savings: SavingsAccount,
  demoDate: string,
  extraMonthlyPence: number = 0,
  customTargetPence: number = 0,
): SavingsComparisonResult {
  const targetPence = customTargetPence > 0 ? customTargetPence : savings.goal_target_pence
  const base = projectSavingsGoal(
    savings.balance_pence,
    savings.gross_rate_bps,
    savings.monthly_contribution_pence,
    0,
    targetPence,
  )
  const proj = projectSavingsGoal(
    savings.balance_pence,
    savings.gross_rate_bps,
    savings.monthly_contribution_pence,
    extraMonthlyPence,
    targetPence,
  )

  const monthsSaved =
    base.months_to_goal !== null && proj.months_to_goal !== null
      ? Math.max(0, base.months_to_goal - proj.months_to_goal)
      : 0

  const ym =
    proj.months_to_goal !== null ? targetYearMonth(demoDate, proj.months_to_goal) : null

  return {
    baseline_months: base.months_to_goal,
    projected_months: proj.months_to_goal,
    months_saved: monthsSaved,
    unreachable: proj.unreachable,
    projected_balance_pence: proj.projected_balance_pence,
    total_interest_earned_pence: proj.total_interest_earned_pence,
    annual_interest_on_balance_pence: annualInterestOnBalance(
      savings.balance_pence,
      savings.gross_rate_bps,
    ),
    target_pence: targetPence,
    target_year: ym ? ym.targetYear : null,
    target_month: ym ? ym.targetMonth : null,
    target_label: ym ? ym.label : null,
  }
}
