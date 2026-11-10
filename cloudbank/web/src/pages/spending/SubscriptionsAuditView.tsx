import { useEffect, useMemo, useRef } from 'react'
import { Tv } from 'lucide-react'
import { useFixture } from '../../data/useFixture'
import { usePersona } from '../../personas/PersonaProvider'
import { useSpendingView } from '../../agent/SpendingViewProvider'
import { SpendingHeader } from './SpendingHeader'
import { ListRow } from '../../components/ListRow'
import { IconBadge } from '../../components/IconBadge'
import type { Transaction } from '../../data/fixture'
import { formatGBPFromPence } from '../../util/currency'
import { shortMonthForOffset } from '../../util/demoClock'
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
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [highlighted])

  const tone = highlighted ? 'gold' : 'green'
  const wrapperClass = highlighted
    ? 'px-3 -mx-3 rounded-lg bg-[#fcf9f2] border border-brand-gold/50 transition-colors'
    : 'transition-colors'

  const dateStr = `${transaction.day} ${shortMonthForOffset(demoDate, transaction.month_offset)}`
  const subtitle = statusLabel
    ? `Subscription · ${dateStr} · ${statusLabel}`
    : transaction.is_anomaly
      ? `Subscription · ${dateStr} · flagged`
      : `Subscription · ${dateStr}`

  return (
    <div
      ref={ref}
      data-component-id={transaction.id}
      data-highlighted={highlighted ? 'true' : 'false'}
      className={wrapperClass}
    >
      <ListRow
        icon={<IconBadge icon={Tv} tone={tone} />}
        title={transaction.vendor}
        subtitle={subtitle}
        right={
          <span className="text-[15px] font-semibold text-brand-text tabular-nums">
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
  const { period, highlightVendor, anomalyStatus } = useSpendingView()
  const transactions = fixture?.transactions ?? EMPTY

  const { items: subs, total_pence, monthName } = useMemo(
    () => subscriptionsView(transactions, period, demoDate),
    [transactions, period, demoDate],
  )

  return (
    <div className="pb-6">
      <SpendingHeader breadcrumb="Subscriptions" />

      <div className="py-4 border-b border-brand-divider">
        <div className="text-[11px] tracking-[0.08em] uppercase text-brand-muted font-medium">
          {monthName} Recurring Subscriptions & Bills
        </div>
        <div className="text-[28px] font-bold text-brand-text mt-1 leading-none tabular-nums">
          {formatGBPFromPence(total_pence)}
        </div>
        <div className="text-[13px] text-brand-muted mt-1">
          {subs.length} recurring {subs.length === 1 ? 'charge' : 'charges'}
        </div>
      </div>

      <div className="mt-4 divide-y divide-brand-divider border-t border-b border-brand-divider">
        {subs.map((t) => {
          const isHighlighted = highlightVendor
            ? vendorsEqual(t.vendor, highlightVendor)
            : Boolean(t.is_anomaly)
          const statusLabel =
            t.is_anomaly && anomalyStatus === 'confirmed'
              ? 'Confirmed'
              : t.is_anomaly && anomalyStatus === 'unrecognised'
                ? 'Marked as not recognised'
                : undefined
          return (
            <SubscriptionRow
              key={t.id}
              transaction={t}
              highlighted={isHighlighted}
              demoDate={demoDate}
              statusLabel={statusLabel}
            />
          )
        })}
      </div>
    </div>
  )
}
