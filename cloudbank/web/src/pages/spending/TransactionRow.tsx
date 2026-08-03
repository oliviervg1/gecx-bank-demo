import { useEffect, useRef } from 'react'
import type { Transaction } from '../../data/fixture'
import { ListRow } from '../../components/ListRow'
import { IconBadge } from '../../components/IconBadge'
import { iconForCategory, type SpendingCategory } from '../../components/iconForCategory'
import { formatGBP } from '../../util/currency'

// Income is rendered "+£3,200.00", matching OverviewView, rather than letting
// the minus land inside the £ prefix ("£-3,200.00"). The spending views now
// filter income out upstream, so this is defence-in-depth for any future
// caller that doesn't.
function formatAmount(n: number): string {
  return n < 0 ? `+£${formatGBP(Math.abs(n))}` : `£${formatGBP(n)}`
}

function formatDaysAgo(d: number): string {
  return `${d}d`
}

interface Props {
  transaction: Transaction
  highlighted?: boolean
}

export function TransactionRow({ transaction, highlighted = false }: Props) {
  const { id, vendor, category, amount, is_subscription, is_anomaly, days_ago, renewal_days_ago } = transaction
  const ref = useRef<HTMLDivElement>(null)

  // Scroll into view whenever this row transitions to highlighted. Doing
  // it here (rather than at dispatch time in the handler) decouples the
  // highlight from the page-mount timing — when navigate_to(spending) and
  // highlight_component(componentId=...) arrive in the same agent turn,
  // SpendingPage isn't in the DOM yet at handler time. By the time the
  // matching row mounts with highlighted=true, this effect fires.
  useEffect(() => {
    if (highlighted && ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [highlighted])

  // Anomalies get a gold IconBadge tone + gold ring/tint on the wrapper,
  // matching the SubscriptionsAuditView treatment so flagged rows read
  // consistently across spending views.
  const styled = iconForCategory(category as SpendingCategory)
  const tone = highlighted ? 'gold' : styled.tone
  const wrapperClass = highlighted
    ? 'px-4 ring-2 ring-brand-gold bg-brand-gold/5 transition-colors'
    : 'px-4 transition-colors'

  const subtitleParts = [category.replace(/_/g, ' ')]
  if (is_subscription) subtitleParts.push('subscription')
  if (is_anomaly) subtitleParts.push('flagged')
  const subtitle = subtitleParts.join(' · ')

  const right = (
    <div className="text-right">
      <div className="text-[15px] font-semibold text-brand-text">{formatAmount(amount)}</div>
      <div className="text-[11px] text-brand-muted">{formatDaysAgo(days_ago)}</div>
    </div>
  )

  return (
    <div
      ref={ref}
      data-component-id={id}
      data-highlighted={highlighted ? 'true' : 'false'}
      className={wrapperClass}
    >
      <ListRow
        icon={<IconBadge icon={styled.icon} tone={tone} />}
        title={vendor}
        subtitle={subtitle}
        right={right}
      />
      {highlighted && is_subscription && renewal_days_ago !== undefined && (
        <div className="text-[11px] text-brand-muted pb-2 pl-[56px]">
          Auto-renewed {renewal_days_ago} day{renewal_days_ago === 1 ? '' : 's'} ago.
        </div>
      )}
    </div>
  )
}
