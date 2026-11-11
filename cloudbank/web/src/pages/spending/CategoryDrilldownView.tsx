import { useMemo } from 'react'
import { useFixture } from '../../data/useFixture'
import { usePersona } from '../../personas/PersonaProvider'
import { useBankingViewState } from '../../agent/BankingViewStateProvider'
import { HorizontalMerchantBarChart } from '../../components/SemanticBarCharts'
import { TransactionRow } from './TransactionRow'
import { SpendingHeader } from './SpendingHeader'
import type { Transaction } from '../../data/fixture'
import { formatGBPFromPence } from '../../util/currency'
import { categoryDrilldownView, vendorsEqual } from '../../util/spendingViews'

const EMPTY: Transaction[] = []

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
  const { period, highlightVendor } = useBankingViewState()
  const transactions = fixture?.transactions ?? EMPTY

  const { rows: filtered, total_pence, byVendorPence, monthName } = useMemo(
    () => categoryDrilldownView(transactions, category, period, demoDate),
    [transactions, category, period, demoDate],
  )
  const barData = useMemo(
    () =>
      byVendorPence.map(({ vendor, total_pence: val }) => ({
        name: vendor,
        valuePence: val,
      })),
    [byVendorPence],
  )

  return (
    <div className="pb-6">
      <SpendingHeader breadcrumb={prettyCategory(category)} />

      <div className="py-4 border-b border-brand-divider">
        <div className="text-[0.6875rem] tracking-[0.08em] uppercase text-brand-muted font-medium">
          {monthName} · {prettyCategory(category)}
        </div>
        <div className="text-[1.75rem] font-bold text-brand-text mt-1 leading-none tabular-nums">
          {formatGBPFromPence(total_pence)}
        </div>
        <div className="text-[0.8125rem] text-brand-muted mt-1">
          {filtered.length} {filtered.length === 1 ? 'transaction' : 'transactions'}
        </div>
      </div>

      {barData.length > 0 && (
        <div
          data-chart-slot="category_vendors"
          className="py-4 border-b border-brand-divider"
        >
          <div className="text-[0.6875rem] tracking-[0.08em] uppercase text-brand-muted font-medium mb-2">
            By Merchant
          </div>
          <HorizontalMerchantBarChart
            data={barData}
            ariaLabel={`${monthName} ${prettyCategory(category)} spending by merchant`}
          />
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
