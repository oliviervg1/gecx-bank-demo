import { useMemo } from 'react'
import { BarChart, Bar, Cell, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts'
import { useFixture } from '../../data/useFixture'
import { TransactionRow } from './TransactionRow'
import { SpendingHeader } from './SpendingHeader'
import { Card } from '../../components/Card'
import type { Transaction } from '../../data/fixture'
import { formatGBP } from '../../util/currency'
import { categoryDrilldownView } from '../../util/spendingViews'

const EMPTY: Transaction[] = []

// New palette (Plan Task 20): forest green primary + gold secondary tint.
// Index 0 is forest green; every other bar uses the gold tint so the chart
// reads as "primary vs supporting" rather than a rainbow.
const BAR_PRIMARY = '#0a4d35'
const BAR_SECONDARY = '#c89b3c'

function prettyCategory(category: string): string {
  // Sentence case: "coffee_shops" -> "Coffee shops" (only the first word is
  // capitalised). The plan's prose pins this: prettyCategory("coffee_shops")
  // === "Coffee shops".
  const spaced = category.replace(/_/g, ' ')
  if (spaced.length === 0) return spaced
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

interface Props {
  category: string
}

export function CategoryDrilldownView({ category }: Props) {
  const fixture = useFixture()
  const transactions = fixture?.transactions ?? EMPTY

  // rows, total and byVendor all describe the same population — this month's
  // transactions in this category. Scoping them together is what keeps the
  // card from printing a this-month total above an all-time row count.
  const { rows: filtered, total, byVendor } = useMemo(
    () => categoryDrilldownView(transactions, category),
    [transactions, category],
  )
  const barData = Object.entries(byVendor).map(([name, value]) => ({ name, value }))

  return (
    <div className="pb-4">
      <SpendingHeader breadcrumb={prettyCategory(category)} />

      <Card className="mt-2">
        <div className="text-[11px] tracking-[0.08em] uppercase text-brand-muted font-medium">This month</div>
        <div className="text-[28px] font-bold text-brand-text mt-1 leading-none">£{formatGBP(total)}</div>
        <div className="text-[13px] text-brand-muted mt-1">{filtered.length} transactions</div>
      </Card>

      {barData.length > 0 && (
        <Card data-chart-slot="category_vendors" className="mt-3">
          <div className="text-[11px] tracking-[0.08em] uppercase text-brand-muted font-medium mb-2">By vendor</div>
          <div style={{ width: '100%', height: 160 }}>
            <ResponsiveContainer>
              <BarChart data={barData} layout="vertical" margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => `£${formatGBP(v)}`} />
                <Bar dataKey="value" isAnimationActive={false}>
                  {barData.map((_, i) => (
                    <Cell key={i} fill={i === 0 ? BAR_PRIMARY : BAR_SECONDARY} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      <Card className="mt-3 p-0 overflow-hidden">
        {filtered.map((t) => (
          <TransactionRow key={t.id} transaction={t} highlighted={t.is_anomaly === true} />
        ))}
      </Card>
    </div>
  )
}
