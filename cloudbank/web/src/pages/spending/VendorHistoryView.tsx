import { useMemo } from 'react'
import { BarChart, Bar, XAxis, ResponsiveContainer, Tooltip, Cell } from 'recharts'
import { useFixture } from '../../data/useFixture'
import { TransactionRow } from './TransactionRow'
import { SpendingHeader } from './SpendingHeader'
import { Card } from '../../components/Card'
import type { Transaction } from '../../data/fixture'
import { formatGBP } from '../../util/currency'
import { vendorHistoryView } from '../../util/spendingViews'

const EMPTY: Transaction[] = []

// New palette (Plan Task 20): forest green primary + gold highlight on the
// most recent month. Replaces the old grey/blue/green rotation.
const BAR_PRIMARY = '#0a4d35'
const BAR_HIGHLIGHT = '#c89b3c'

interface Props {
  vendor: string
}

export function VendorHistoryView({ vendor }: Props) {
  const fixture = useFixture()
  const transactions = fixture?.transactions ?? EMPTY

  // Shared with get_vendor_breakdown via spendingViews — and, unlike the
  // previous inline version, it excludes income so a search for "sal" no
  // longer renders the Salary row as "-£3,200.00".
  const { rows: filtered, thisMonth, total, buckets } = useMemo(
    () => vendorHistoryView(transactions, vendor),
    [transactions, vendor],
  )
  const barData = buckets.map((b) => ({ name: b.label, value: b.total }))

  return (
    <div className="pb-4">
      <SpendingHeader breadcrumb={vendor} />

      <Card className="mt-2">
        <div className="text-[11px] tracking-[0.08em] uppercase text-brand-muted font-medium">This month</div>
        <div className="text-[28px] font-bold text-brand-text mt-1 leading-none">£{formatGBP(total)}</div>
        <div className="text-[13px] text-brand-muted mt-1">
          {thisMonth.length} {thisMonth.length === 1 ? 'visit' : 'visits'}
        </div>
      </Card>

      {barData.length > 0 && (
        <Card className="mt-3">
          <div className="text-[11px] tracking-[0.08em] uppercase text-brand-muted font-medium mb-2">Monthly</div>
          <div style={{ width: '100%', height: 100 }}>
            <ResponsiveContainer>
              <BarChart data={barData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} interval={0} />
                <Tooltip formatter={(v: number) => `£${formatGBP(v)}`} />
                <Bar dataKey="value" isAnimationActive={false} radius={[6, 6, 0, 0]}>
                  {barData.map((_, i) => (
                    <Cell key={i} fill={i === barData.length - 1 ? BAR_HIGHLIGHT : BAR_PRIMARY} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      <Card className="mt-3 p-0 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="px-4 py-6 text-center text-[13px] text-brand-muted">
            No recent transactions at this vendor.
          </div>
        ) : (
          filtered
            .slice()
            .sort((a, b) => a.days_ago - b.days_ago)
            .map((t) => (
              <TransactionRow key={t.id} transaction={t} highlighted={t.is_anomaly === true} />
            ))
        )}
      </Card>
    </div>
  )
}
