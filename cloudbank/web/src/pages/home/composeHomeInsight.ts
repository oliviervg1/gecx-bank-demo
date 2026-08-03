import type { SpendingSummary } from '../../hooks/useSpendingSummary'
import { formatGBP } from '../../util/currency'
import { formatDayOrdinal } from '../../util/dates'

interface Mortgage {
  next_payment: { amount: number; day_of_month: number }
}

interface Args {
  spending_summary: SpendingSummary
  // Absent for personas who rent (Tom). The insight drops the mortgage clause
  // rather than inventing a payment.
  mortgage?: Mortgage
  currentBalance: number
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}


export function composeHomeInsight({ spending_summary, mortgage, currentBalance }: Args): string {
  const spend = spending_summary.this_month_total
  // Baseline is the PRIOR months only. monthly_history[0] is the current
  // month, so including it compared a partial month against a baseline
  // containing itself — which dragged the average down early in the month and
  // reported "well within your typical range" almost unconditionally.
  const histAvg = average(spending_summary.monthly_history.slice(1).map((m) => m.total))
  const pace =
    histAvg === 0 || spend < histAvg * 1.1 ? 'well within your typical range' :
    spend > histAvg * 1.3 ? 'running ahead of your usual' :
    'in line with your usual'
  const opening = `You've spent £${formatGBP(spend)} so far this month, which is ${pace}.`

  if (!mortgage) {
    const cushion =
      currentBalance > spend ? 'Your balance is comfortably ahead of that.' :
      'Keep an eye on the balance against that pace.'
    return `${opening} ${cushion}`
  }

  const buffer = currentBalance - mortgage.next_payment.amount
  const bufferPhrase =
    currentBalance > mortgage.next_payment.amount * 2 ? 'a comfortable buffer remaining' :
    buffer > 0 ? 'enough to cover it with a little to spare' :
    'tight against that payment'
  return (
    `${opening} ` +
    `With your £${formatGBP(mortgage.next_payment.amount)} mortgage payment on the ${formatDayOrdinal(mortgage.next_payment.day_of_month)}, ` +
    `you have ${bufferPhrase}.`
  )
}
