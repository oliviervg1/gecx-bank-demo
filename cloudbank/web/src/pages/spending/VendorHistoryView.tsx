import { useMemo } from 'react'
import { BarChart, Bar, XAxis, ResponsiveContainer, Tooltip, Cell } from 'recharts'
import { useFixture } from '../../data/useFixture'
import { usePersona } from '../../personas/PersonaProvider'
import { useSpendingView } from '../../agent/SpendingViewProvider'
import { TransactionRow } from './TransactionRow'
import { SpendingHeader } from './SpendingHeader'
import type { Transaction } from '../../data/fixture'
import { formatGBPFromPence } from '../../util/currency'
import { vendorHistoryView } from '../../util/spendingViews'

const EMPTY: Transaction[] = []
const BAR_PRIMARY = '#0a4d35'
const BAR_HIGHLIGHT = '#b8892e'

interface Props {
  vendor: string
}

export function VendorHistoryView({ vendor }: Props) {
  const fixture = useFixture()
  const { demoDate } = usePersona()
  const { period } = useSpendingView()
  const transactions = fixture?.transactions ?? EMPTY

  const {
    canonicalVendor,
    rows: allRows,
    periodRows,
    periodTotalPence,
    threeMonthTotalPence,
    buckets,
    monthName,
  } = useMemo(
    () => vendorHistoryView(transactions, vendor, period, demoDate),
    [transactions, vendor, period, demoDate],
  )
  const barData = buckets.map((b) => ({ name: b.label, value: b.total_pence }))

  return (
    <div className="pb-6">
      <SpendingHeader breadcrumb={canonicalVendor} />

      <div className="py-4 border-b border-brand-divider">
        <div className="text-[11px] tracking-[0.08em] uppercase text-brand-muted font-medium">
          {monthName} · {canonicalVendor}
        </div>
        <div className="flex items-baseline justify-between mt-1">
          <div className="text-[28px] font-bold text-brand-text leading-none tabular-nums">
            {formatGBPFromPence(periodTotalPence)}
          </div>
          <div className="text-[13px] text-brand-muted tabular-nums">
            3-month total: {formatGBPFromPence(threeMonthTotalPence)}
          </div>
        </div>
        <div className="text-[13px] text-brand-muted mt-1">
          {periodRows.length} {periodRows.length === 1 ? 'visit' : 'visits'} in {monthName}
        </div>
      </div>

      {barData.length > 0 && (
        <div className="py-4 border-b border-brand-divider">
          <div className="text-[11px] tracking-[0.08em] uppercase text-brand-muted font-medium mb-2">
            3-Month Trend
          </div>
          <div style={{ width: '100%', height: 108 }}>
            <ResponsiveContainer>
              <BarChart data={barData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} interval={0} />
                <Tooltip formatter={(v: number) => formatGBPFromPence(v)} />
                <Bar dataKey="value" isAnimationActive={false} radius={[4, 4, 0, 0]}>
                  {barData.map((_, i) => (
                    <Cell key={i} fill={i === barData.length - 1 ? BAR_HIGHLIGHT : BAR_PRIMARY} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="mt-4 divide-y divide-brand-divider border-t border-b border-brand-divider">
        {allRows.length === 0 ? (
          <div className="py-6 text-center text-[13px] text-brand-muted">
            No recent transactions at this vendor.
          </div>
        ) : (
          allRows.map((t) => (
            <TransactionRow
              key={t.id}
              transaction={t}
              highlighted={t.is_anomaly === true}
            />
          ))
        )}
      </div>
    </div>
  )
}
