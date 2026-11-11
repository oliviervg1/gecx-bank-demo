import type { Transaction } from '../../data/fixture'
import type { SpendingSummary } from '../../hooks/useSpendingSummary'
import { formatGBPFromPence } from '../../util/currency'
import { formatDayOrdinal } from '../../util/dates'
import { DEFAULT_PINNED_DEMO_DATE, monthNameForOffset } from '../../util/demoClock'
import { vendorsEqual } from '../../util/spendingViews'

interface MortgageNextPayment {
  next_payment: { amount_pence: number; day_of_month: number }
}

interface Args {
  spending_summary: SpendingSummary
  mortgage?: MortgageNextPayment
  currentBalancePence: number
  demoDate?: string
  transactions?: Transaction[]
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function buildAnomalyLead(
  transactions: Transaction[] | undefined,
  monthName: string,
): string | null {
  if (!transactions || transactions.length === 0) return null
  const anom = transactions.find(
    (t) => t.month_offset === 0 && t.amount_pence > 0 && t.is_anomaly === true,
  )
  if (!anom) return null
  const prior = transactions.find(
    (t) =>
      t.month_offset === 1 &&
      t.amount_pence > 0 &&
      vendorsEqual(t.vendor, anom.vendor),
  )
  if (prior && prior.amount_pence !== anom.amount_pence) {
    return `${anom.vendor} charged ${formatGBPFromPence(anom.amount_pence)} on ${anom.day} ${monthName}, up from ${formatGBPFromPence(prior.amount_pence)} last month; ask your concierge to check or cancel it.`
  }
  return `${anom.vendor} charged ${formatGBPFromPence(anom.amount_pence)} on ${anom.day} ${monthName} and is flagged for review; ask your concierge to check it.`
}

export function composeHomeInsight({
  spending_summary,
  mortgage,
  currentBalancePence,
  demoDate = DEFAULT_PINNED_DEMO_DATE,
  transactions,
}: Args): string {
  const spendPence = spending_summary.this_month_total_pence
  const monthName = monthNameForOffset(demoDate, 0)
  const anomalyLead = buildAnomalyLead(transactions, monthName)

  const histAvg = average(
    spending_summary.monthly_history.slice(1).map((m) => m.total_pence),
  )
  const pace =
    histAvg === 0 || spendPence < histAvg * 1.1
      ? 'within your typical monthly pace'
      : spendPence > histAvg * 1.3
        ? 'running ahead of your usual pace'
        : 'in line with recent months'
  const opening = anomalyLead
    ? `${anomalyLead} You've spent ${formatGBPFromPence(spendPence)} in ${monthName}.`
    : `In ${monthName} you've spent ${formatGBPFromPence(spendPence)} so far, ${pace}.`

  if (!mortgage) {
    if (anomalyLead) return opening
    const cushion =
      currentBalancePence > spendPence
        ? 'Your current account balance sits comfortably ahead of this month’s spend.'
        : 'Keep an eye on your current account buffer against this month’s spend.'
    return `${opening} ${cushion}`
  }

  const nextAmt = mortgage.next_payment.amount_pence
  const buffer = currentBalancePence - nextAmt
  const bufferPhrase =
    currentBalancePence > nextAmt * 2
      ? 'a comfortable buffer remaining'
      : buffer > 0
        ? 'enough headroom to cover it with a buffer'
        : 'a tight margin against that payment'
  return (
    `${opening} ` +
    `With your ${formatGBPFromPence(nextAmt)} mortgage payment due on the ${formatDayOrdinal(mortgage.next_payment.day_of_month)}, ` +
    `you have ${bufferPhrase}.`
  )
}
