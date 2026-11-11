import { ArrowUpRight, Sparkles } from 'lucide-react'
import { usePage } from '../PageProvider'
import { useSpendingSummary } from '../../hooks/useSpendingSummary'
import { composeHomeInsight } from './composeHomeInsight'
import { formatBps, formatGBPFromPence } from '../../util/currency'
import {
  formatIsoDayMonthYear,
  monthNameForOffset,
  nextPaymentDateLabel,
} from '../../util/demoClock'
import { computeRenterReadiness } from '../../util/mortgageMath'
import { computeSavingsComparison } from '../../util/savingsMath'
import { useFixture } from '../../data/useFixture'
import { usePersona } from '../../personas/PersonaProvider'

export function HomePage() {
  const { navigateTo } = usePage()
  const { demoDate } = usePersona()
  const fixture = useFixture()
  const summary = useSpendingSummary()
  const { current, savings, mortgage } = fixture.accounts

  const thisMonthName = monthNameForOffset(demoDate, 0)
  const savingsProjection = computeSavingsComparison(savings, demoDate, 0, 0)
  const renterReadiness = !mortgage
    ? computeRenterReadiness(fixture.user.annual_income_pence, savings)
    : null

  const insight = composeHomeInsight({
    spending_summary: summary,
    mortgage: mortgage ? { next_payment: mortgage.next_payment } : undefined,
    currentBalancePence: current.balance_pence,
    demoDate,
    transactions: fixture.transactions,
  })

  return (
    <div className="pb-6">
      <div className="pt-4 pb-4 border-b border-brand-divider">
        <div className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-medium">
          Statement as of {formatIsoDayMonthYear(demoDate)}
        </div>
        <h1
          tabIndex={-1}
          className="text-[1.5rem] font-bold tracking-[-0.02em] text-brand-text mt-1 leading-tight"
        >
          Accounts Overview
        </h1>
      </div>

      {/* Unified Editorial Account Ledger */}
      <ul
        aria-label="Accounts"
        className="list-none m-0 p-0 divide-y divide-brand-divider border-b border-brand-divider"
      >
        {/* 1. Current Account & Spending */}
        <li>
          <button
            type="button"
            data-card
            onClick={() => navigateTo('spending')}
            className="w-full text-left py-4 hover:bg-[#faf9f6] transition-colors group"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
                <span className="text-[0.75rem] font-semibold uppercase tracking-[0.06em] text-brand-green">
                  {current.name}
                </span>
                <span className="text-[0.75rem] text-brand-muted tabular-nums whitespace-nowrap">
                  {current.sort_code} · ••{current.account_number_last4}
                </span>
              </div>
              <span className="inline-flex items-center gap-1 text-[0.75rem] font-semibold text-brand-green shrink-0">
                Spending <ArrowUpRight size={14} aria-hidden="true" />
              </span>
            </div>
            <div className="text-[1.875rem] font-bold tracking-[-0.02em] text-brand-text tabular-nums mt-1 leading-none">
              {formatGBPFromPence(current.balance_pence)}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem] text-brand-muted tabular-nums">
              <span>
                {thisMonthName} spend:{' '}
                <strong className="font-semibold text-brand-text">
                  {formatGBPFromPence(summary.this_month_total_pence)}
                </strong>
              </span>
              <span>
                Recurring:{' '}
                <strong className="font-semibold text-brand-text">
                  {formatGBPFromPence(summary.recurring_this_month_pence)}
                </strong>
              </span>
            </div>
          </button>
        </li>

        {/* 2. Savings Pot */}
        <li>
          <button
            type="button"
            data-card
            onClick={() => navigateTo('savings')}
            className="w-full text-left py-4 hover:bg-[#faf9f6] transition-colors group"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
                <span className="text-[0.75rem] font-semibold uppercase tracking-[0.06em] text-brand-text">
                  {savings.name}
                </span>
                <span className="text-[0.75rem] text-brand-muted whitespace-nowrap">
                  {savings.goal_name}
                </span>
              </div>
              <span className="inline-flex items-center gap-1 text-[0.75rem] font-semibold text-brand-green shrink-0">
                Projections <ArrowUpRight size={14} aria-hidden="true" />
              </span>
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <span className="text-[1.5rem] font-bold tracking-[-0.02em] text-brand-text tabular-nums leading-none">
                {formatGBPFromPence(savings.balance_pence)}
              </span>
              <span className="text-[0.8125rem] font-semibold text-brand-gold-text tabular-nums">
                {formatBps(savings.aer_bps)} AER
              </span>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[0.8125rem] text-brand-muted tabular-nums">
              <span>
                Goal:{' '}
                <strong className="font-semibold text-brand-text">
                  {formatGBPFromPence(savings.goal_target_pence)}
                </strong>{' '}
                (+{formatGBPFromPence(savings.monthly_contribution_pence)}/mo)
              </span>
              {savingsProjection.target_label && savingsProjection.projected_months !== null && (
                <span>
                  On track:{' '}
                  <strong className="font-semibold text-brand-text">
                    {savingsProjection.target_label}
                  </strong>
                </span>
              )}
            </div>
          </button>
        </li>

        {/* 3. Mortgage (Homeowner) or First-Home Readiness (Renter) */}
        {mortgage ? (
          <li>
            <button
              type="button"
              data-card
              onClick={() => navigateTo('mortgage')}
              className="w-full text-left py-4 hover:bg-[#faf9f6] transition-colors group"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
                  <span className="text-[0.75rem] font-semibold uppercase tracking-[0.06em] text-brand-text">
                    Mortgage
                  </span>
                  <span className="text-[0.75rem] text-brand-muted">{mortgage.address}</span>
                </div>
                <span className="inline-flex items-center gap-1 text-[0.75rem] font-semibold text-brand-green shrink-0">
                  Manage <ArrowUpRight size={14} aria-hidden="true" />
                </span>
              </div>
              <div className="flex items-baseline justify-between mt-1">
                <span className="text-[1.5rem] font-bold tracking-[-0.02em] text-brand-text tabular-nums leading-none">
                  {formatGBPFromPence(mortgage.balance_pence)}
                </span>
                <span className="text-[0.8125rem] font-semibold text-brand-muted tabular-nums">
                  {formatBps(mortgage.interest_rate_bps)} {mortgage.rate_type}
                </span>
              </div>
              <div className="mt-2.5 text-[0.8125rem] text-brand-muted tabular-nums">
                Next payment:{' '}
                <strong className="font-semibold text-brand-text">
                  {formatGBPFromPence(mortgage.next_payment.amount_pence)}
                </strong>{' '}
                on {nextPaymentDateLabel(mortgage.next_payment.day_of_month, demoDate)}
              </div>
            </button>
          </li>
        ) : (
          renterReadiness && (
            <li>
              <button
                type="button"
                data-card
                onClick={() => navigateTo('mortgage')}
                className="w-full text-left py-4 hover:bg-[#faf9f6] transition-colors group"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[0.75rem] font-semibold uppercase tracking-[0.06em] text-brand-text">
                    First-Home Readiness
                  </span>
                  <span className="inline-flex items-center gap-1 text-[0.75rem] font-semibold text-brand-green">
                    Readiness <ArrowUpRight size={14} aria-hidden="true" />
                  </span>
                </div>
                <div className="flex items-baseline justify-between mt-1">
                  <span className="text-[1.5rem] font-bold tracking-[-0.02em] text-brand-text tabular-nums leading-none">
                    {formatGBPFromPence(renterReadiness.max_borrowing_pence)}
                  </span>
                  <span className="text-[0.8125rem] font-semibold text-brand-gold-text tabular-nums">
                    {formatBps(renterReadiness.deposit_progress_bps)} deposit saved
                  </span>
                </div>
                <div className="mt-2 text-[0.8125rem] text-brand-muted tabular-nums">
                  Indicative 4.5× borrowing + {formatGBPFromPence(renterReadiness.goal_deposit_pence)} target deposit ={' '}
                  <strong className="font-semibold text-brand-text">
                    {formatGBPFromPence(renterReadiness.indicative_budget_with_goal_pence)}
                  </strong>
                </div>
              </button>
            </li>
          )
        )}
      </ul>

      {/* Editorial Concierge Insight */}
      <div className="pt-4">
        <div className="flex items-center gap-1.5 mb-2">
          <Sparkles size={13} aria-hidden="true" className="text-brand-gold-text" />
          <h2 className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-semibold">
            Concierge Summary
          </h2>
        </div>
        <p className="text-[0.875rem] leading-relaxed text-brand-text border-l-2 border-brand-gold pl-3 py-0.5">
          {insight}
        </p>
      </div>
    </div>
  )
}
