import { useMemo } from 'react'
import { useFixture } from '../../data/useFixture'
import { usePersona } from '../../personas/PersonaProvider'
import { MonthlyComparisonBarChart } from '../../components/SemanticBarCharts'
import { SpendingHeader } from './SpendingHeader'
import type { Transaction } from '../../data/fixture'
import { formatGBPFromPence } from '../../util/currency'
import { bucketByMonth, matchVendorRows } from '../../util/spendingViews'

const EMPTY: Transaction[] = []

function prettyCategory(category: string): string {
  const spaced = category.replace(/_/g, ' ')
  if (spaced.length === 0) return spaced
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

interface Props {
  category?: string
  vendor?: string
}

export function MonthlyTrendView({ category, vendor }: Props) {
  const fixture = useFixture()
  const { demoDate } = usePersona()
  const transactions = fixture?.transactions ?? EMPTY

  const canonicalVendor = useMemo(() => {
    if (!vendor) return undefined
    const matched = matchVendorRows(transactions, vendor)
    return matched.canonical || vendor
  }, [transactions, vendor])

  const buckets = useMemo(
    () =>
      bucketByMonth(
        transactions,
        { category, vendor: canonicalVendor, excludeIncome: true },
        demoDate,
      ),
    [transactions, category, canonicalVendor, demoDate],
  )

  const scopeLabel = canonicalVendor ?? (category ? prettyCategory(category) : undefined)
  const breadcrumb = scopeLabel ? `Trend › ${scopeLabel}` : undefined
  const threeMonthTotalPence = buckets.reduce((sum, b) => sum + b.total_pence, 0)
  const prevMonthName = buckets[1]?.monthName ?? 'last month'
  const deltaPence = (buckets[2]?.total_pence ?? 0) - (buckets[1]?.total_pence ?? 0)
  const deltaLabel =
    deltaPence > 0
      ? `+${formatGBPFromPence(deltaPence)} vs ${prevMonthName}`
      : deltaPence < 0
        ? `${formatGBPFromPence(deltaPence)} vs ${prevMonthName}`
        : `Unchanged vs ${prevMonthName}`

  const chartData = useMemo(
    () =>
      buckets.map((b) => ({
        shortLabel: b.label,
        monthName: b.monthName,
        valuePence: b.total_pence,
      })),
    [buckets],
  )

  return (
    <div className="pb-6">
      <SpendingHeader breadcrumb={breadcrumb} showPeriodSelector={false} />

      {scopeLabel && (
        <div className="py-4 border-b border-brand-divider">
          <div className="text-[0.6875rem] tracking-[0.08em] uppercase text-brand-muted font-medium">
            Three-Month Total · {scopeLabel}
          </div>
          <div className="flex items-baseline justify-between mt-1">
            <div className="text-[1.75rem] font-bold text-brand-text leading-none tabular-nums">
              {formatGBPFromPence(threeMonthTotalPence)}
            </div>
            <div className="text-[0.8125rem] text-brand-muted tabular-nums">{deltaLabel}</div>
          </div>
        </div>
      )}

      <div data-chart-slot="monthly_trend" className="py-4 border-b border-brand-divider">
        <div className="text-[0.6875rem] tracking-[0.08em] uppercase text-brand-muted font-medium mb-2">
          Three-Month Statement Comparison
        </div>
        <MonthlyComparisonBarChart
          data={chartData}
          ariaLabel={
            scopeLabel
              ? `Three-month ${scopeLabel} spending comparison`
              : 'Three-month statement comparison'
          }
        />
      </div>

      {/* Semantic Monthly Figures Ledger */}
      <dl
        aria-label="Monthly statement totals"
        className="mt-4 divide-y divide-brand-divider border-t border-b border-brand-divider"
      >
        {buckets
          .slice()
          .reverse()
          .map((b) => (
            <div key={b.offset} className="flex items-center justify-between py-2.5 tabular-nums">
              <dt className="text-[0.875rem] font-medium text-brand-text">{b.monthName}</dt>
              <dd className="text-[0.9375rem] font-semibold text-brand-text">
                {formatGBPFromPence(b.total_pence)}
              </dd>
            </div>
          ))}
      </dl>
    </div>
  )
}
