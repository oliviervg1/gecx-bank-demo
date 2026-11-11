import { useMemo } from 'react'
import { BarChart, Bar, Cell, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts'
import { useFixture } from '../../data/useFixture'
import { usePersona } from '../../personas/PersonaProvider'
import { useSpendingView } from '../../agent/SpendingViewProvider'
import { TransactionRow } from './TransactionRow'
import { SpendingHeader } from './SpendingHeader'
import type { Transaction } from '../../data/fixture'
import { formatGBPFromPence } from '../../util/currency'
import { categoryDrilldownView, vendorsEqual } from '../../util/spendingViews'

const EMPTY: Transaction[] = []
const BAR_PRIMARY = '#0a4d35'
const BAR_SECONDARY = '#b8892e'

function prettyCategory(category: string): string {
  const spaced = category.replace(/_/g, ' ')
  if (spaced.length === 0) return spaced
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

interface Props {
  category: string
}

export function CategoryDrilldownView({ category }: Props) {
  const fixture = useFixture()
  const { demoDate } = usePersona()
  const { period, highlightVendor } = useSpendingView()
  const transactions = fixture?.transactions ?? EMPTY

  const { rows: filtered, total_pence, byVendorPence, monthName } = useMemo(
    () => categoryDrilldownView(transactions, category, period, demoDate),
    [transactions, category, period, demoDate],
  )
  const barData = byVendorPence.map(({ vendor, total_pence: val }) => ({
    name: vendor,
    value: val,
  }))

  return (
    <div className="pb-6">
      <SpendingHeader breadcrumb={prettyCategory(category)} />

      <div className="py-4 border-b border-brand-divider">
        <div className="text-[11px] tracking-[0.08em] uppercase text-brand-muted font-medium">
          {monthName} · {prettyCategory(category)}
        </div>
        <div className="text-[28px] font-bold text-brand-text mt-1 leading-none tabular-nums">
          {formatGBPFromPence(total_pence)}
        </div>
        <div className="text-[13px] text-brand-muted mt-1">
          {filtered.length} {filtered.length === 1 ? 'transaction' : 'transactions'}
        </div>
      </div>

      {barData.length > 0 && (
        <div
          data-chart-slot="category_vendors"
          className="py-4 border-b border-brand-divider"
        >
          <div className="text-[11px] tracking-[0.08em] uppercase text-brand-muted font-medium mb-2">
            By Merchant
          </div>
          <div style={{ width: '100%', height: 148 }}>
            <ResponsiveContainer>
              <BarChart
                data={barData}
                layout="vertical"
                margin={{ top: 4, right: 16, left: 0, bottom: 4 }}
              >
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" width={116} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => formatGBPFromPence(v)} />
                <Bar dataKey="value" isAnimationActive={false} radius={[0, 4, 4, 0]}>
                  {barData.map((_, i) => (
                    <Cell key={i} fill={i === 0 ? BAR_PRIMARY : BAR_SECONDARY} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="mt-4 divide-y divide-brand-divider border-t border-b border-brand-divider">
        {filtered.map((t) => (
          <TransactionRow
            key={t.id}
            transaction={t}
            highlighted={
              highlightVendor
                ? vendorsEqual(t.vendor, highlightVendor)
                : Boolean(t.is_anomaly)
            }
          />
        ))}
      </div>
    </div>
  )
}
