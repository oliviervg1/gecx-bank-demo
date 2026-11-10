import { useEffect, useRef } from 'react'
import type { Transaction } from '../../data/fixture'
import { ListRow } from '../../components/ListRow'
import { IconBadge } from '../../components/IconBadge'
import { iconForCategory, type SpendingCategory } from '../../components/iconForCategory'
import { formatGBPFromPence } from '../../util/currency'
import { shortMonthForOffset } from '../../util/demoClock'
import { usePersona } from '../../personas/PersonaProvider'

function formatSignedAmount(amountPence: number): string {
  if (amountPence < 0) {
    return `+${formatGBPFromPence(Math.abs(amountPence))}`
  }
  return formatGBPFromPence(amountPence)
}

interface Props {
  transaction: Transaction
  highlighted?: boolean
  autoScroll?: boolean
  statusBadge?: string
  onClick?: () => void
}

export function TransactionRow({
  transaction,
  highlighted = false,
  autoScroll = true,
  statusBadge,
  onClick,
}: Props) {
  const { id, vendor, category, amount_pence, is_subscription, is_anomaly, month_offset, day } =
    transaction
  const { demoDate } = usePersona()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoScroll && highlighted && ref.current && typeof ref.current.scrollIntoView === 'function') {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [autoScroll, highlighted])

  const isIncome = amount_pence < 0
  const styled = iconForCategory((isIncome ? 'income' : category) as SpendingCategory)
  const tone = highlighted ? 'gold' : styled.tone
  const wrapperClass = highlighted
    ? 'px-3 -mx-3 rounded-lg bg-[#fcf9f2] border border-brand-gold/50 transition-colors'
    : 'transition-colors'

  const dateLabel = `${day} ${shortMonthForOffset(demoDate, month_offset)}`
  const subtitleParts = [category.replace(/_/g, ' '), dateLabel]
  if (is_subscription) subtitleParts.push('recurring')
  if (is_anomaly) subtitleParts.push('flagged')

  const right = (
    <div className="text-right tabular-nums">
      <div
        className={
          'text-[15px] font-semibold ' +
          (isIncome ? 'text-brand-green' : 'text-brand-text')
        }
      >
        {formatSignedAmount(amount_pence)}
      </div>
      {statusBadge && (
        <div className="text-[11px] font-medium text-brand-gold">{statusBadge}</div>
      )}
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
        subtitle={subtitleParts.join(' · ')}
        right={right}
        onClick={onClick}
      />
    </div>
  )
}
