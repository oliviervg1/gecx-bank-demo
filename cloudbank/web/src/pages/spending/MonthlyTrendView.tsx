import { useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell } from 'recharts'
import { useFixture } from '../../data/useFixture'
import { usePersona } from '../../personas/PersonaProvider'
import { SpendingHeader } from './SpendingHeader'
import type { Transaction } from '../../data/fixture'
import { formatGBPFromPence } from '../../util/currency'
import { bucketByMonth, matchVendorRows } from '../../util/spendingViews'

const EMPTY: Transaction[] = []
const BAR_PRIMARY = '#0a4d35'
const BAR_HIGHLIGHT = '#b8892e'

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
    () => bucketByMonth(transactions, { category, vendor: canonicalVendor, excludeIncome: true }, demoDate),
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

  const data = buckets.map((b) => ({
    name: b.label,
    monthName: b.monthName,
    value: b.total_pence,
  }))

  return (
    <div className="pb-6">
      <SpendingHeader breadcrumb={breadcrumb} showPeriodSelector={false} />

      {scopeLabel && (
        <div className="py-4 border-b border-brand-divider">
          <div className="text-[11px] tracking-[0.08em] uppercase text-brand-muted font-medium">
            Three-Month Total · {scopeLabel}
          </div>
          <div className="flex items-baseline justify-between mt-1">
            <div className="text-[28px] font-bold text-brand-text leading-none tabular-nums">
              {formatGBPFromPence(threeMonthTotalPence)}
            </div>
            <div className="text-[13px] text-brand-muted tabular-nums">{deltaLabel}</div>
          </div>
        </div>
      )}

      <div className="py-4 border-b border-brand-divider">
        <div className="text-[11px] tracking-[0.08em] uppercase text-brand-muted font-medium mb-2">
          Three-Month Statement Comparison
        </div>
        <div style={{ width: '100%', height: 196 }}>
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 12, right: 8, left: -12, bottom: 0 }}>
              <XAxis
                dataKey="name"
                tick={{ fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                interval={0}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => `£${Math.trunc(v / 100)}`}
              />
              <Tooltip formatter={(v: number) => formatGBPFromPence(v)} />
              <Bar dataKey="value" isAnimationActive={false} radius={[4, 4, 0, 0]}>
                {data.map((_, i) => (
                  <Cell key={i} fill={i === data.length - 1 ? BAR_HIGHLIGHT : BAR_PRIMARY} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Exact Monthly Figures Ledger */}
      <div className="mt-4 divide-y divide-brand-divider border-t border-b border-brand-divider">
        {buckets
          .slice()
          .reverse()
          .map((b) => (
            <div key={b.offset} className="flex items-center justify-between py-2.5 tabular-nums">
              <span className="text-[14px] font-medium text-brand-text">{b.monthName}</span>
              <span className="text-[15px] font-semibold text-brand-text">
                {formatGBPFromPence(b.total_pence)}
              </span>
            </div>
          ))}
      </div>
    </div>
  )
}
