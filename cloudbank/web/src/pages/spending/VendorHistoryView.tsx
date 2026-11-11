import { useMemo } from 'react'
import { useFixture } from '../../data/useFixture'
import { usePersona } from '../../personas/PersonaProvider'
import { useBankingViewState } from '../../agent/BankingViewStateProvider'
import { TransactionRow } from './TransactionRow'
import { SpendingHeader } from './SpendingHeader'
import type { Transaction } from '../../data/fixture'
import { formatGBPFromPence } from '../../util/currency'
import { vendorHistoryView } from '../../util/spendingViews'

const EMPTY: Transaction[] = []

interface Props {
  vendor: string
}

export function VendorHistoryView({ vendor }: Props) {
  const fixture = useFixture()
  const { demoDate } = usePersona()
  const { period } = useBankingViewState()
  const transactions = fixture?.transactions ?? EMPTY

  const {
    canonicalVendor,
    periodRows,
    periodTotalPence,
    monthName,
  } = useMemo(
    () => vendorHistoryView(transactions, vendor, period, demoDate),
    [transactions, vendor, period, demoDate],
  )

  return (
    <div className="pb-6">
      <SpendingHeader breadcrumb={canonicalVendor} />

      <div className="py-4 border-b border-brand-divider">
        <div className="text-[0.6875rem] tracking-[0.08em] uppercase text-brand-muted font-medium">
          {monthName} · {canonicalVendor}
        </div>
        <div className="flex items-baseline justify-between mt-1">
          <div className="text-[1.75rem] font-bold text-brand-text leading-none tabular-nums">
            {formatGBPFromPence(periodTotalPence)}
          </div>
          <div className="text-[0.8125rem] text-brand-muted tabular-nums">
            {periodRows.length} {periodRows.length === 1 ? 'visit' : 'visits'} in {monthName}
          </div>
        </div>
      </div>

      <div className="mt-4 divide-y divide-brand-divider border-t border-b border-brand-divider">
        {periodRows.length === 0 ? (
          <div className="py-6 text-center text-[0.8125rem] text-brand-muted">
            No transactions at this merchant in {monthName}.
          </div>
        ) : (
          periodRows.map((t) => (
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
