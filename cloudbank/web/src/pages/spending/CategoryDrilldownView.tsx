import { useMemo } from 'react'
import { useFixture } from '../../data/useFixture'
import { usePersona } from '../../personas/PersonaProvider'
import { useBankingViewState } from '../../agent/BankingViewStateProvider'
import { HorizontalMerchantBarChart } from '../../components/SemanticBarCharts'
import { TransactionRow } from './TransactionRow'
import { SpendingHeader } from './SpendingHeader'
import type { Transaction } from '../../data/fixture'
import { formatGBPFromPence } from '../../util/currency'
import { categoryDrilldownView, formatCategoryLabel, vendorsEqual } from '../../util/spendingViews'

const EMPTY: Transaction[] = []

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
  const categoryLabel = formatCategoryLabel(category)

  return (
    <div className="pb-6">
      <SpendingHeader breadcrumb={categoryLabel} />

      <div className="py-4 border-b border-brand-divider">
        <div className="text-[0.6875rem] tracking-[0.08em] uppercase text-brand-muted font-medium">
          {monthName} · {categoryLabel}
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
          <h2 className="text-[0.6875rem] tracking-[0.08em] uppercase text-brand-muted font-medium mb-2">
            By Merchant
          </h2>
          <HorizontalMerchantBarChart
            data={barData}
            ariaLabel={`${monthName} ${categoryLabel} spending by merchant`}
          />
        </div>
      )}

      <ul className="list-none m-0 p-0 mt-4 divide-y divide-brand-divider border-t border-b border-brand-divider">
        {filtered.map((t) => (
          <li key={t.id}>
            <TransactionRow
              transaction={t}
              highlighted={
                highlightVendor
                  ? vendorsEqual(t.vendor, highlightVendor)
                  : Boolean(t.is_anomaly)
              }
            />
          </li>
        ))}
      </ul>
    </div>
  )
}
