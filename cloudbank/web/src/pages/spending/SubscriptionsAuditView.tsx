import { useEffect, useMemo, useRef } from 'react'
import { useFixture } from '../../data/useFixture'
import { usePersona } from '../../personas/PersonaProvider'
import { useBankingViewState } from '../../agent/BankingViewStateProvider'
import { SpendingHeader } from './SpendingHeader'
import { ListRow } from '../../components/ListRow'
import { IconBadge } from '../../components/IconBadge'
import { iconForCategory, type SpendingCategory } from '../../components/iconForCategory'
import type { Transaction } from '../../data/fixture'
import { formatGBPFromPence } from '../../util/currency'
import { shortMonthForOffset } from '../../util/demoClock'
import { prefersReducedMotion } from '../../util/motion'
import { subscriptionsView, vendorsEqual } from '../../util/spendingViews'

const EMPTY: Transaction[] = []

function SubscriptionRow({
  transaction,
  highlighted,
  demoDate,
  statusLabel,
}: {
  transaction: Transaction
  highlighted: boolean
  demoDate: string
  statusLabel?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (highlighted && ref.current && typeof ref.current.scrollIntoView === 'function') {
      ref.current.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'center',
      })
    }
  }, [highlighted])

  const styled = iconForCategory(transaction.category as SpendingCategory)
  const tone = highlighted ? 'gold' : styled.tone
  const wrapperClass = highlighted
    ? 'px-3 -mx-3 rounded-lg bg-[#fcf9f2] border border-brand-gold-text/45 transition-colors'
    : 'transition-colors'

  const kind = transaction.category === 'bills' ? 'Direct Debit' : 'Subscription'
  const dateStr = `${transaction.day} ${shortMonthForOffset(demoDate, transaction.month_offset)}`
  const subtitle = statusLabel
    ? `${kind} · ${dateStr} · ${statusLabel}`
    : transaction.is_anomaly
      ? `${kind} · ${dateStr} · flagged`
      : `${kind} · ${dateStr}`

  return (
    <div
      ref={ref}
      data-component-id={transaction.id}
      data-highlighted={highlighted ? 'true' : 'false'}
      className={wrapperClass}
    >
      <ListRow
        icon={<IconBadge icon={styled.icon} tone={tone} />}
        title={transaction.vendor}
        subtitle={subtitle}
        right={
          <span className="text-[0.9375rem] font-semibold text-brand-text tabular-nums">
            {formatGBPFromPence(transaction.amount_pence)}
          </span>
        }
      />
    </div>
  )
}

export function SubscriptionsAuditView() {
  const fixture = useFixture()
  const { demoDate } = usePersona()
  const { period, highlightVendor, getVendorAnomalyStatus } = useBankingViewState()
  const transactions = fixture?.transactions ?? EMPTY

  const { items: subs, total_pence, monthName } = useMemo(
    () => subscriptionsView(transactions, period, demoDate),
    [transactions, period, demoDate],
  )

  return (
    <div className="pb-6">
      <SpendingHeader breadcrumb="Subscriptions" />

      <div className="py-4 border-b border-brand-divider">
        <h2 className="text-[0.6875rem] tracking-[0.08em] uppercase text-brand-muted font-medium">
          {monthName} Recurring Subscriptions & Bills
        </h2>
        <div className="text-[1.75rem] font-bold text-brand-text mt-1 leading-none tabular-nums">
          {formatGBPFromPence(total_pence)}
        </div>
        <div className="text-[0.8125rem] text-brand-muted mt-1">
          {subs.length} recurring {subs.length === 1 ? 'charge' : 'charges'}
        </div>
      </div>

      <ul className="list-none m-0 p-0 mt-4 divide-y divide-brand-divider border-t border-b border-brand-divider">
        {subs.map((t) => {
          const isHighlighted = highlightVendor
            ? vendorsEqual(t.vendor, highlightVendor)
            : Boolean(t.is_anomaly)
          const rowAnomalyStatus = t.is_anomaly ? getVendorAnomalyStatus(t.vendor) : ''
          const statusLabel =
            rowAnomalyStatus === 'confirmed'
              ? 'Confirmed'
              : rowAnomalyStatus === 'unrecognised'
                ? 'Marked as not recognised'
                : undefined
          return (
            <li key={t.id}>
              <SubscriptionRow
                transaction={t}
                highlighted={isHighlighted}
                demoDate={demoDate}
                statusLabel={statusLabel}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
