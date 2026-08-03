import { useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell } from 'recharts'
import { useFixture } from '../../data/useFixture'
import { SpendingHeader } from './SpendingHeader'
import { Card } from '../../components/Card'
import type { Transaction } from '../../data/fixture'
import { formatGBP } from '../../util/currency'
import { bucketByMonth } from '../../util/spendingViews'

const EMPTY: Transaction[] = []

// New palette (Plan Task 20): all three months in forest green, with the most
// recent month highlighted in gold to draw the eye to "now". This replaces
// the old grey/blue/green rotation.
const BAR_PRIMARY = '#0a4d35'
const BAR_HIGHLIGHT = '#c89b3c'

function prettyCategory(category: string): string {
  // Sentence-case (matches CategoryDrilldownView's prettyCategory):
  // "coffee_shops" -> "Coffee shops".
  const spaced = category.replace(/_/g, ' ')
  if (spaced.length === 0) return spaced
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

interface Props {
  category?: string
  vendor?: string   // case-insensitive substring match across transaction.vendor;
                    // mutually exclusive with `category`. Set via SpendingDataBinder
                    // when the agent calls get_monthly_trend with show=true.
}

export function MonthlyTrendView({ category, vendor }: Props) {
  const fixture = useFixture()
  const transactions = fixture?.transactions ?? EMPTY

  const buckets = useMemo(
    () => bucketByMonth(transactions, { category, vendor, excludeIncome: true }),
    [transactions, category, vendor],
  )
  const breadcrumb = vendor
    ? `Trend › ${vendor}`
    : category
      ? `Trend › ${prettyCategory(category)}`
      : 'Trend'
  const data = buckets.map((b) => ({ name: b.label, value: b.total }))

  return (
    <div className="pb-4">
      <SpendingHeader breadcrumb={breadcrumb} />

      <Card className="mt-2">
        <div className="text-[11px] tracking-[0.08em] uppercase text-brand-muted font-medium mb-2">
          Monthly totals
        </div>
        <div style={{ width: '100%', height: 220 }}>
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 16, right: 8, left: -16, bottom: 0 }}>
              <XAxis
                dataKey="name"
                tick={{ fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                interval={0}
              />
              <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip formatter={(v: number) => `£${formatGBP(v)}`} />
              <Bar dataKey="value" isAnimationActive={false} radius={[6, 6, 0, 0]}>
                {data.map((_, i) => (
                  // Highlight the most recent month (last bar) in gold.
                  <Cell key={i} fill={i === data.length - 1 ? BAR_HIGHLIGHT : BAR_PRIMARY} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  )
}
