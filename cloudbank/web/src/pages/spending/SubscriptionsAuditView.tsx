import { useEffect, useMemo, useRef } from 'react'
import { Tv } from 'lucide-react'
import { useFixture } from '../../data/useFixture'
import { SpendingHeader } from './SpendingHeader'
import { Card } from '../../components/Card'
import { ListRow } from '../../components/ListRow'
import { IconBadge } from '../../components/IconBadge'
import type { Transaction } from '../../data/fixture'
import { formatGBP } from '../../util/currency'
import { subscriptionsView } from '../../util/spendingViews'

const EMPTY: Transaction[] = []

// SubscriptionRow keeps the data attributes the SubscriptionsAuditView tests
// rely on (data-component-id, data-highlighted) on the row wrapper, so the
// "auto-highlights anomalous subscriptions" selector still finds the Netflix
// row. The scroll-into-view-on-highlight behaviour mirrors TransactionRow so
// the agent's highlight_component(componentId) flow still works.
function SubscriptionRow({ transaction, anomalous }: { transaction: Transaction; anomalous: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (anomalous && ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [anomalous])

  const tone = anomalous ? 'gold' : 'green'
  const wrapperClass = anomalous
    ? 'px-4 ring-2 ring-brand-gold bg-brand-gold/5 transition-colors'
    : 'px-4 transition-colors'

  return (
    <div
      ref={ref}
      data-component-id={transaction.id}
      data-highlighted={anomalous ? 'true' : 'false'}
      className={wrapperClass}
    >
      <ListRow
        icon={<IconBadge icon={Tv} tone={tone} />}
        title={transaction.vendor}
        subtitle={
          anomalous && transaction.renewal_days_ago !== undefined
            ? `Subscription · auto-renewed ${transaction.renewal_days_ago} day${transaction.renewal_days_ago === 1 ? '' : 's'} ago`
            : 'Subscription'
        }
        right={<span className="text-[15px] font-semibold text-brand-text">£{formatGBP(transaction.amount)}</span>}
      />
    </div>
  )
}

export function SubscriptionsAuditView() {
  const fixture = useFixture()
  const transactions = fixture?.transactions ?? EMPTY

  // Shared with the get_subscriptions ClientFunction via spendingViews, so the
  // number on screen and the number the concierge speaks cannot diverge.
  const { items: subs, total } = useMemo(() => subscriptionsView(transactions), [transactions])

  return (
    <div className="pb-4">
      <SpendingHeader breadcrumb="Subscriptions" />

      <Card className="mt-2">
        <div className="text-[11px] tracking-[0.08em] uppercase text-brand-muted font-medium">This month</div>
        <div className="text-[28px] font-bold text-brand-text mt-1 leading-none">£{formatGBP(total)}</div>
        <div className="text-[13px] text-brand-muted mt-1">{subs.length} recurring charges</div>
      </Card>

      <Card className="mt-3 p-0 overflow-hidden">
        {subs.map((t, i) => (
          <div key={t.id}>
            {i > 0 && <div className="h-px bg-brand-divider mx-4" />}
            <SubscriptionRow transaction={t} anomalous={t.is_anomaly === true} />
          </div>
        ))}
      </Card>
    </div>
  )
}
