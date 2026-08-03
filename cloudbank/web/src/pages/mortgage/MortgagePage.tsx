import { Percent, Calendar, Settings, FileText, Receipt, Shield, ChevronRight } from 'lucide-react'
import { Card } from '../../components/Card'
import { HeroCard } from '../../components/HeroCard'
import { SectionHeader } from '../../components/SectionHeader'
import { ListRow } from '../../components/ListRow'
import { IconBadge } from '../../components/IconBadge'
import { useToast } from '../../components/ToastProvider'
import { formatGBP } from '../../util/currency'
import { formatDayAndMonth, nextMonthlyOccurrence } from '../../util/dates'
import { useFixture } from '../../data/useFixture'

const COMING_SOON = 'Coming soon.'

function nextPaymentDue(dayOfMonth: number): string {
  return `Due ${formatDayAndMonth(nextMonthlyOccurrence(dayOfMonth))}`
}

export function MortgagePage() {
  const { show } = useToast()
  const mortgage = useFixture().accounts.mortgage

  // Not every persona is a homeowner — Tom rents. The tab still exists (it is
  // one of the four in the bottom bar), so it needs a real empty state rather
  // than a page of zeroes that reads like a data-loading bug.
  if (!mortgage) {
    return (
      <div className="pb-4">
        <SectionHeader title="Your Mortgage" />
        <Card className="mt-2">
          <div className="text-[15px] font-semibold text-brand-text mb-1">
            You don't have a mortgage with us
          </div>
          <p className="text-[13px] text-brand-muted">
            When you're ready to buy, we can talk through what you could borrow
            and what the repayments would look like.
          </p>
          <button
            type="button"
            onClick={() => show(COMING_SOON)}
            className="mt-3 text-brand-gold text-[14px] font-semibold"
          >
            Explore mortgages
          </button>
        </Card>
      </div>
    )
  }

  return (
    <div className="pb-4">
      <SectionHeader title="Your Mortgage" subtitle={mortgage.address} />

      <HeroCard className="mb-5">
        <div className="text-[14px] opacity-90 mb-2">Remaining Balance</div>
        <div className="inline-flex items-baseline">
          <span className="text-[24px] text-brand-gold mr-0.5">£</span>
          <span className="text-[32px] font-bold tabular-nums leading-none">{formatGBP(mortgage.balance)}</span>
        </div>
        <div className="mt-4 pt-3 border-t border-white/20 grid grid-cols-2 gap-3">
          <div className="flex items-start gap-2">
            <Percent size={16} className="opacity-80 mt-0.5" />
            <div>
              <div className="text-[12px] opacity-80">Interest Rate</div>
              <div className="text-[15px] font-semibold">{mortgage.interest_rate}% {mortgage.rate_type}</div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Calendar size={16} className="opacity-80 mt-0.5" />
            <div>
              <div className="text-[12px] opacity-80">Term</div>
              <div className="text-[15px] font-semibold">{mortgage.term_remaining}</div>
            </div>
          </div>
        </div>
      </HeroCard>

      <SectionHeader title="Payments" variant="section" />
      <Card className="mb-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] tracking-[0.08em] text-brand-muted font-medium">NEXT PAYMENT</div>
            <div className="text-[20px] font-bold tabular-nums">£{formatGBP(mortgage.next_payment.amount)}</div>
            <div className="text-[13px] text-brand-muted">{nextPaymentDue(mortgage.next_payment.day_of_month)}</div>
          </div>
          <button
            type="button"
            onClick={() => show(COMING_SOON)}
            className="text-brand-gold text-[14px] font-semibold"
          >
            Overpay
          </button>
        </div>
      </Card>

      <SectionHeader title="Manage" variant="section" />
      <Card className="p-0">
        <ManageRow icon={Settings}  title="Change Rate" subtitle="Explore new fixed deals" onClick={() => show(COMING_SOON)} />
        <Divider />
        <ManageRow icon={FileText}  title="Documents" onClick={() => show(COMING_SOON)} />
        <Divider />
        <ManageRow icon={Receipt}   title="Statements" onClick={() => show(COMING_SOON)} />
        <Divider />
        <ManageRow icon={Shield}    title="Insurance"  onClick={() => show(COMING_SOON)} />
      </Card>
    </div>
  )
}

function ManageRow({ icon: Icon, title, subtitle, onClick }: { icon: typeof Settings; title: string; subtitle?: string; onClick: () => void }) {
  return (
    <div className="px-4">
      <ListRow
        icon={<IconBadge icon={Icon} tone="green" />}
        title={title}
        subtitle={subtitle}
        right={<ChevronRight size={18} className="text-brand-muted" />}
        onClick={onClick}
      />
    </div>
  )
}

function Divider() {
  return <div className="h-px bg-brand-divider mx-4" />
}
