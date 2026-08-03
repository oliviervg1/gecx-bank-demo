import type { ReactNode } from 'react'
import { Search, SlidersHorizontal } from 'lucide-react'
import { Card } from '../../components/Card'
import { SectionHeader } from '../../components/SectionHeader'
import { ListRow } from '../../components/ListRow'
import { IconBadge } from '../../components/IconBadge'
import { iconForCategory, type SpendingCategory } from '../../components/iconForCategory'
import { useToast } from '../../components/ToastProvider'
import { formatGBP } from '../../util/currency'
import { useFixture } from '../../data/useFixture'

const FILTER_HINT = 'Ask the concierge to filter by category or vendor.'

function relativeDate(daysAgo: number): string {
  if (daysAgo === 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  const d = new Date(); d.setDate(d.getDate() - daysAgo)
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short' })
}

function prettyCategory(c: string): string {
  const s = c.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function OverviewView() {
  const { show } = useToast()
  const txns = useFixture().transactions
  const sorted = [...txns].sort((a, b) => a.days_ago - b.days_ago).slice(0, 8)
  return (
    <div className="pb-4">
      <SectionHeader
        title="Spending"
        right={
          <>
            <IconButton onClick={() => show(FILTER_HINT)} label="search"><Search size={18} /></IconButton>
            <IconButton onClick={() => show(FILTER_HINT)} label="filter"><SlidersHorizontal size={18} /></IconButton>
          </>
        }
      />
      <div className="text-[11px] tracking-[0.08em] uppercase text-brand-muted font-medium mb-2">RECENT</div>
      <Card className="p-0">
        {sorted.map((t, i) => {
          const isIncome = t.amount < 0
          const category = (isIncome ? 'income' : t.category) as SpendingCategory
          const styled = iconForCategory(category)
          const amountText = isIncome
            ? <span className="text-brand-green font-semibold">+£{formatGBP(Math.abs(t.amount))}</span>
            : <span className="text-brand-text">£{formatGBP(t.amount)}</span>
          return (
            <div key={t.id}>
              {i > 0 && <div className="h-px bg-brand-divider mx-4" />}
              <div className="px-4">
                <ListRow
                  icon={<IconBadge icon={styled.icon} tone={styled.tone} />}
                  title={t.vendor ?? prettyCategory(t.category)}
                  subtitle={`${prettyCategory(t.category)} · ${relativeDate(t.days_ago)}`}
                  right={amountText}
                />
              </div>
            </div>
          )
        })}
      </Card>
    </div>
  )
}

function IconButton({ children, onClick, label }: { children: ReactNode; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="w-9 h-9 rounded-full bg-white shadow-card flex items-center justify-center text-brand-text"
    >
      {children}
    </button>
  )
}
