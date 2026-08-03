import { PieChart, Building2, Sparkles, ChevronRight } from 'lucide-react'
import { Card } from '../../components/Card'
import { HeroCard } from '../../components/HeroCard'
import { SectionHeader } from '../../components/SectionHeader'
import { IconBadge } from '../../components/IconBadge'
import { usePage } from '../PageProvider'
import { useSpendingSummary } from '../../hooks/useSpendingSummary'
import { composeHomeInsight } from './composeHomeInsight'
import { formatGBP } from '../../util/currency'
import { formatDayAndMonth, nextMonthlyOccurrence } from '../../util/dates'
import { useFixture } from '../../data/useFixture'

function CurrencyAmount({ value, large = false, gold = false }: { value: number; large?: boolean; gold?: boolean }) {
  const sizeNumber = large ? 'text-[32px] leading-none' : 'text-[20px]'
  const sizeSymbol = large ? 'text-[24px]' : 'text-[16px]'
  return (
    <span className="inline-flex items-baseline">
      <span className={`${sizeSymbol} ${gold ? 'text-brand-gold' : ''} mr-0.5`}>£</span>
      <span className={`${sizeNumber} font-bold tabular-nums`}>{formatGBP(value)}</span>
    </span>
  )
}

export function HomePage() {
  const { navigateTo } = usePage()
  const summary = useSpendingSummary()
  const account = useFixture().accounts
  // Tom rents, so mortgage is genuinely absent for some personas.
  const mortgage = account.mortgage
  const insight = composeHomeInsight({
    spending_summary: summary,
    mortgage: mortgage ? { next_payment: mortgage.next_payment } : undefined,
    currentBalance: account.current.balance,
  })

  return (
    <div className="pb-4">
      <SectionHeader title="Overview" />

      <HeroCard onClick={() => navigateTo('spending')} className="mb-3">
        <div className="flex items-start justify-between mb-3">
          <span className="text-[14px] font-medium opacity-90">Current Account</span>
          <PieChart size={20} className="text-brand-gold" />
        </div>
        <CurrencyAmount value={account.current.balance} large gold />
        <div className="mt-4 pt-3 border-t border-white/20 flex items-end justify-between">
          <div>
            <div className="text-[12px] opacity-80">This Month's Spending</div>
            <div className="text-[16px] font-semibold tabular-nums">£{formatGBP(summary.this_month_total)}</div>
          </div>
          <span className="text-brand-gold text-[14px] font-semibold inline-flex items-center gap-0.5">
            Analyze <ChevronRight size={16} />
          </span>
        </div>
      </HeroCard>

      {mortgage && (
        <Card onClick={() => navigateTo('mortgage')} className="mb-5">
          <div className="flex items-start justify-between mb-3">
            <span className="text-[14px] font-medium text-brand-text">Mortgage</span>
            <Building2 size={20} className="text-brand-green" />
          </div>
          <CurrencyAmount value={mortgage.balance} large gold />
          <div className="mt-4 pt-3 border-t border-brand-divider flex items-end justify-between">
            <div>
              <div className="text-[12px] text-brand-muted">
                Next Payment ({formatDayAndMonth(nextMonthlyOccurrence(mortgage.next_payment.day_of_month))})
              </div>
              <div className="text-[16px] font-semibold tabular-nums text-brand-text">
                £{formatGBP(mortgage.next_payment.amount)}
              </div>
            </div>
            <span className="text-brand-gold text-[14px] font-semibold inline-flex items-center gap-0.5">
              Manage <ChevronRight size={16} />
            </span>
          </div>
        </Card>
      )}

      <SectionHeader title="AI Concierge Insights" variant="section" />
      <Card className="border-l-[3px] border-brand-gold">
        <div className="flex items-start gap-3">
          <IconBadge icon={Sparkles} tone="gold" size={36} iconSize={18} />
          <p className="text-[14px] leading-relaxed text-brand-text">{insight}</p>
        </div>
      </Card>
    </div>
  )
}
