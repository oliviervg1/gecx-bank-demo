import { useMemo } from 'react'
import { AlertTriangle, ArrowUpRight, CheckCircle2 } from 'lucide-react'
import { useFixture } from '../../data/useFixture'
import { usePersona } from '../../personas/PersonaProvider'
import { usePage } from '../PageProvider'
import {
  useBankingViewState,
  type MortgageSubview,
} from '../../agent/BankingViewStateProvider'
import { SegmentedTabPanels, SegmentedTabs } from '../../components/SegmentedTabs'
import { formatBps, formatGBPFromPence } from '../../util/currency'
import { formatIsoDayMonthYear, nextPaymentDateLabel } from '../../util/demoClock'
import {
  compareRenewalOptions,
  computeRenterReadiness,
  formatMonthsDuration,
  projectOverpayment,
} from '../../util/mortgageMath'

const ILLUSTRATION_NOTE =
  'These figures are an indicative illustration only and not personalised mortgage advice.'

const MONTHLY_OVERPAY_PRESETS = [0, 4500, 10000, 20000, 40000] as const
const LUMP_OVERPAY_PRESETS = [0, 500000, 1000000] as const

const SUBVIEW_TABS: ReadonlyArray<{ id: MortgageSubview; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'overpay', label: 'Overpay' },
  { id: 'rates', label: 'Fixed Rates' },
]

function parsePoundsInput(raw: string): number {
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return 0
  const clamped = Math.min(num, 10_000_000)
  return Math.floor(clamped * 100 + 0.5)
}

export function MortgagePage() {
  const fixture = useFixture()
  const { demoDate } = usePersona()
  const { navigateTo } = usePage()
  const {
    mortgageSubview,
    monthlyOverpaymentPence,
    lumpSumOverpaymentPence,
    setMortgageSubview,
    setMonthlyOverpaymentPence,
    setLumpSumOverpaymentPence,
  } = useBankingViewState()

  const mortgage = fixture.accounts.mortgage
  const savings = fixture.accounts.savings

  const overpayResult = useMemo(
    () =>
      mortgage
        ? projectOverpayment(mortgage, monthlyOverpaymentPence, lumpSumOverpaymentPence)
        : null,
    [mortgage, monthlyOverpaymentPence, lumpSumOverpaymentPence],
  )

  const renewalItems = useMemo(
    () => (mortgage ? compareRenewalOptions(mortgage) : []),
    [mortgage],
  )

  // Renter view (Tom: First-Time Buyer Borrowing & Deposit Readiness)
  if (!mortgage) {
    const readiness = computeRenterReadiness(fixture.user.annual_income_pence, savings)
    const progressPct = Math.min(100, Math.trunc(readiness.deposit_progress_bps / 100))

    return (
      <div className="pb-6" data-testid="renter-readiness-view">
        <div className="pt-4 pb-4 border-b border-brand-divider">
          <div className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-medium">
            First-Time Buyer Guide
          </div>
          <h1 className="text-[1.375rem] font-bold tracking-[-0.02em] text-brand-text mt-1 leading-tight">
            First-Home Borrowing Readiness
          </h1>
        </div>

        <div className="py-4 border-b border-brand-divider tabular-nums">
          <div className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-medium">
            Indicative Maximum Borrowing (4.5× Income)
          </div>
          <div className="text-[1.875rem] font-bold tracking-[-0.02em] text-brand-text mt-1 leading-none">
            {formatGBPFromPence(readiness.max_borrowing_pence)}
          </div>
          <div className="text-[0.8125rem] text-brand-muted mt-1.5">
            Based on {formatGBPFromPence(readiness.annual_income_pence)} annual gross income
            {fixture.user.monthly_rent_pence
              ? ` · Current rent ${formatGBPFromPence(fixture.user.monthly_rent_pence)}/mo`
              : ''}
          </div>
        </div>

        <div className="py-4 border-b border-brand-divider tabular-nums">
          <div className="flex items-center justify-between text-[0.8125rem]">
            <span className="font-semibold text-brand-text">{savings.goal_name}</span>
            <span className="font-semibold text-brand-gold-text">
              {formatBps(readiness.deposit_progress_bps)}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={`${savings.goal_name} deposit progress`}
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-2 w-full rounded-full bg-[#eceae3] overflow-hidden mt-2"
          >
            <div
              className="h-full bg-brand-green transition-all motion-reduce:transition-none"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-[0.75rem] text-brand-muted">
            <span>Saved: {formatGBPFromPence(readiness.current_deposit_pence)}</span>
            <span>Goal: {formatGBPFromPence(readiness.goal_deposit_pence)}</span>
          </div>

          <div className="mt-4 divide-y divide-brand-divider border-t border-brand-divider">
            <div className="flex items-center justify-between py-2.5 text-[0.8125rem]">
              <span className="text-brand-muted">Remaining to deposit goal</span>
              <span className="font-semibold text-brand-text">
                {formatGBPFromPence(readiness.remaining_to_goal_pence)}
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5 text-[0.8125rem]">
              <span className="text-brand-muted">Indicative property budget at goal</span>
              <span className="font-bold text-brand-green text-[0.9375rem]">
                {formatGBPFromPence(readiness.indicative_budget_with_goal_pence)}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => navigateTo('savings')}
            className="mt-3 min-h-9 inline-flex items-center gap-1 text-[0.8125rem] font-semibold text-brand-green hover:underline"
          >
            Project deposit timeline in Savings <ArrowUpRight size={15} aria-hidden="true" />
          </button>
        </div>

        <p className="mt-4 text-[0.75rem] text-brand-muted leading-relaxed">
          {ILLUSTRATION_NOTE}
        </p>
      </div>
    )
  }

  const remainingAllowancePence = Math.max(
    0,
    mortgage.annual_overpayment_allowance_pence - mortgage.overpaid_this_year_pence,
  )
  const allowanceUsedPct =
    mortgage.annual_overpayment_allowance_pence > 0
      ? Math.min(
          100,
          Math.trunc(
            (mortgage.overpaid_this_year_pence * 100) /
              mortgage.annual_overpayment_allowance_pence,
          ),
        )
      : 0

  const monthlyOptions = (() => {
    const list: number[] = [...MONTHLY_OVERPAY_PRESETS]
    if (monthlyOverpaymentPence > 0 && !list.includes(monthlyOverpaymentPence)) {
      list.push(monthlyOverpaymentPence)
      list.sort((a, b) => a - b)
    }
    return list
  })()

  const lumpOptions = (() => {
    const list: number[] = [...LUMP_OVERPAY_PRESETS]
    if (lumpSumOverpaymentPence > 0 && !list.includes(lumpSumOverpaymentPence)) {
      list.push(lumpSumOverpaymentPence)
      list.sort((a, b) => a - b)
    }
    return list
  })()

  return (
    <div className="pb-6">
      {/* Header & Accessible WAI-ARIA Subview Tabs */}
      <div className="pt-4 pb-3 border-b border-brand-divider">
        <div className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-medium">
          {mortgage.address}
        </div>
        <h1 className="text-[1.375rem] font-bold tracking-[-0.02em] text-brand-text mt-1 leading-tight">
          Your Mortgage
        </h1>

        <SegmentedTabs
          idPrefix="mortgage"
          ariaLabel="Mortgage views"
          tabs={SUBVIEW_TABS}
          activeId={mortgageSubview}
          onSelect={setMortgageSubview}
        />
      </div>

      <SegmentedTabPanels
        idPrefix="mortgage"
        tabs={SUBVIEW_TABS}
        activeId={mortgageSubview}
        renderPanel={(subview) => {
          if (subview === 'overview') {
            return (
              <div>
                <div className="py-4 border-b border-brand-divider tabular-nums">
                  <div className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-medium">
                    Remaining Balance
                  </div>
                  <div className="text-[1.875rem] font-bold tracking-[-0.02em] text-brand-text mt-1 leading-none">
                    {formatGBPFromPence(mortgage.balance_pence)}
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-3 pt-3 border-t border-brand-divider text-[0.8125rem]">
                    <div>
                      <div className="text-[0.6875rem] uppercase tracking-[0.06em] text-brand-muted">
                        Current Rate
                      </div>
                      <div className="font-semibold text-brand-text mt-0.5">
                        {formatBps(mortgage.interest_rate_bps)} {mortgage.rate_type}
                      </div>
                      <div className="text-[0.75rem] text-brand-muted">
                        Until {formatIsoDayMonthYear(mortgage.fixed_until)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[0.6875rem] uppercase tracking-[0.06em] text-brand-muted">
                        Remaining Term
                      </div>
                      <div className="font-semibold text-brand-text mt-0.5">
                        {formatMonthsDuration(mortgage.term_remaining_months)}
                      </div>
                      <div className="text-[0.75rem] text-brand-muted">
                        ({mortgage.term_remaining_months} months)
                      </div>
                    </div>
                  </div>
                </div>

                {/* Next Scheduled Payment */}
                <div className="py-4 border-b border-brand-divider flex items-center justify-between gap-2 tabular-nums">
                  <div>
                    <div className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-medium">
                      Next Payment
                    </div>
                    <div className="text-[1.25rem] font-bold text-brand-text mt-0.5">
                      {formatGBPFromPence(mortgage.next_payment.amount_pence)}
                    </div>
                    <div className="text-[0.75rem] text-brand-muted">
                      Due {nextPaymentDateLabel(mortgage.next_payment.day_of_month, demoDate)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMortgageSubview('overpay')}
                    className="min-h-9 px-3 py-1.5 rounded-lg border border-brand-border-strong text-[0.8125rem] font-semibold text-brand-green hover:bg-[#faf9f6]"
                  >
                    Overpay calculator
                  </button>
                </div>

                {/* Annual 10% ERC-Free Overpayment Allowance */}
                <div className="py-4 border-b border-brand-divider tabular-nums">
                  <div className="flex items-center justify-between text-[0.8125rem]">
                    <span className="font-semibold text-brand-text">
                      10% Fee-Free Overpayment Allowance
                    </span>
                    <span className="font-semibold text-brand-green">
                      {formatGBPFromPence(remainingAllowancePence)} left
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label="10% fee-free annual overpayment allowance used"
                    aria-valuenow={allowanceUsedPct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="h-2 w-full rounded-full bg-[#eceae3] overflow-hidden mt-2"
                  >
                    <div
                      className="h-full bg-brand-gold-text transition-all motion-reduce:transition-none"
                      style={{ width: `${allowanceUsedPct}%` }}
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[0.75rem] text-brand-muted">
                    <span>
                      Overpaid this year: {formatGBPFromPence(mortgage.overpaid_this_year_pence)}
                    </span>
                    <span>
                      Annual cap: {formatGBPFromPence(mortgage.annual_overpayment_allowance_pence)}
                    </span>
                  </div>
                </div>

                {/* Quick Link to Renewal Deals */}
                <div className="pt-4 flex items-center justify-between gap-2">
                  <span className="text-[0.8125rem] text-brand-muted">
                    Compare 2-year and 5-year fixed renewal deals
                  </span>
                  <button
                    type="button"
                    onClick={() => setMortgageSubview('rates')}
                    className="min-h-9 px-2 text-[0.8125rem] font-semibold text-brand-green hover:underline shrink-0"
                  >
                    Compare rates
                  </button>
                </div>
              </div>
            )
          }

          if (subview === 'overpay' && overpayResult) {
            return (
              <div data-testid="mortgage-overpay-view">
                <div className="py-4 border-b border-brand-divider">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-semibold">
                      Monthly Overpayment
                    </span>
                    <span className="text-[0.8125rem] font-semibold text-brand-green tabular-nums">
                      +{formatGBPFromPence(monthlyOverpaymentPence)}/mo
                    </span>
                  </div>

                  <div
                    className="flex flex-wrap gap-1.5"
                    role="group"
                    aria-label="Monthly overpayment"
                  >
                    {monthlyOptions.map((pence) => {
                      const active = monthlyOverpaymentPence === pence
                      const label =
                        pence === 0
                          ? '+£0'
                          : pence % 100 === 0
                            ? `+£${pence / 100}/mo`
                            : `+${formatGBPFromPence(pence)}/mo`
                      return (
                        <button
                          key={pence}
                          type="button"
                          aria-pressed={active}
                          data-active={active}
                          onClick={() => setMonthlyOverpaymentPence(pence)}
                          className={
                            'min-h-9 px-2.5 py-1.5 rounded-lg text-[0.75rem] font-semibold border transition-colors tabular-nums ' +
                            (active
                              ? 'bg-brand-green text-white border-brand-green'
                              : 'bg-white text-brand-text border-brand-border-strong hover:bg-[#faf9f6]')
                          }
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>

                  <div className="mt-2.5 flex items-center gap-2">
                    <label
                      htmlFor="mortgage-monthly-input"
                      className="text-[0.75rem] text-brand-muted"
                    >
                      Custom monthly (£):
                    </label>
                    <input
                      id="mortgage-monthly-input"
                      type="number"
                      min="0"
                      step="10"
                      value={monthlyOverpaymentPence > 0 ? monthlyOverpaymentPence / 100 : ''}
                      placeholder="0"
                      onChange={(e) =>
                        setMonthlyOverpaymentPence(parsePoundsInput(e.target.value))
                      }
                      className="min-h-9 w-28 px-2.5 py-1 rounded-lg border border-brand-border-strong bg-white text-[0.8125rem] text-brand-text tabular-nums focus:border-brand-green"
                    />
                  </div>

                  {/* Lump-Sum Overpayment */}
                  <div className="mt-4 pt-3 border-t border-brand-divider">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-semibold">
                        Single Lump-Sum Overpayment
                      </span>
                      <span className="text-[0.8125rem] font-semibold text-brand-green tabular-nums">
                        {formatGBPFromPence(lumpSumOverpaymentPence)}
                      </span>
                    </div>

                    <div
                      className="flex flex-wrap gap-1.5"
                      role="group"
                      aria-label="Lump-sum overpayment"
                    >
                      {lumpOptions.map((pence) => {
                        const active = lumpSumOverpaymentPence === pence
                        const label = pence === 0 ? '£0' : formatGBPFromPence(pence)
                        return (
                          <button
                            key={pence}
                            type="button"
                            aria-pressed={active}
                            data-active={active}
                            onClick={() => setLumpSumOverpaymentPence(pence)}
                            className={
                              'min-h-9 px-2.5 py-1.5 rounded-lg text-[0.75rem] font-semibold border transition-colors tabular-nums ' +
                              (active
                                ? 'bg-brand-green text-white border-brand-green'
                                : 'bg-white text-brand-text border-brand-border-strong hover:bg-[#faf9f6]')
                            }
                          >
                            {label}
                          </button>
                        )
                      })}
                    </div>

                    <div className="mt-2.5 flex items-center gap-2">
                      <label
                        htmlFor="mortgage-lump-input"
                        className="text-[0.75rem] text-brand-muted"
                      >
                        Custom lump sum (£):
                      </label>
                      <input
                        id="mortgage-lump-input"
                        type="number"
                        min="0"
                        step="100"
                        value={lumpSumOverpaymentPence > 0 ? lumpSumOverpaymentPence / 100 : ''}
                        placeholder="0"
                        onChange={(e) =>
                          setLumpSumOverpaymentPence(parsePoundsInput(e.target.value))
                        }
                        className="min-h-9 w-28 px-2.5 py-1 rounded-lg border border-brand-border-strong bg-white text-[0.8125rem] text-brand-text tabular-nums focus:border-brand-green"
                      />
                    </div>
                  </div>
                </div>

                {/* Allowance Status Banner */}
                <div
                  data-testid="overpay-allowance-status"
                  className={
                    'mt-4 p-3 rounded-xl border text-[0.75rem] flex items-start gap-2 tabular-nums ' +
                    (overpayResult.exceeds_allowance
                      ? 'border-brand-danger/40 bg-[#fdf6f6] text-brand-danger'
                      : 'border-brand-green/30 bg-[#f6faf8] text-brand-green')
                  }
                >
                  {overpayResult.exceeds_allowance ? (
                    <AlertTriangle size={16} aria-hidden="true" className="shrink-0 mt-0.5" />
                  ) : (
                    <CheckCircle2 size={16} aria-hidden="true" className="shrink-0 mt-0.5" />
                  )}
                  <span>
                    {overpayResult.exceeds_allowance
                      ? `Year-one overpayment of ${formatGBPFromPence(overpayResult.first_year_overpayment_pence)} exceeds your remaining ${formatGBPFromPence(overpayResult.remaining_allowance_pence)} 10% fee-free allowance by ${formatGBPFromPence(overpayResult.excess_over_allowance_pence)} (an early repayment charge may apply on the excess).`
                      : `Year-one overpayment of ${formatGBPFromPence(overpayResult.first_year_overpayment_pence)} stays within your ${formatGBPFromPence(overpayResult.remaining_allowance_pence)} remaining 10% fee-free allowance.`}
                  </span>
                </div>

                {/* Amortisation Comparison Ledger */}
                <div className="mt-4 divide-y divide-brand-divider border-t border-b border-brand-divider tabular-nums">
                  <div className="flex items-center justify-between py-2.5">
                    <span className="text-[0.8125rem] text-brand-muted">
                      Total interest saved
                    </span>
                    <span className="text-[1rem] font-bold text-brand-green">
                      {formatGBPFromPence(overpayResult.interest_saved_pence)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-2.5">
                    <span className="text-[0.8125rem] text-brand-muted">
                      Time shaved off term
                    </span>
                    <span className="text-[0.875rem] font-semibold text-brand-gold-text">
                      {formatMonthsDuration(overpayResult.months_saved)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-2.5">
                    <span className="text-[0.8125rem] text-brand-muted">
                      Projected payoff term
                    </span>
                    <span className="text-[0.875rem] font-medium text-brand-text">
                      {overpayResult.paid_off
                        ? formatMonthsDuration(overpayResult.projected_months)
                        : 'Over 50 years'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-2.5">
                    <span className="text-[0.8125rem] text-brand-muted">
                      New monthly payment
                    </span>
                    <span className="text-[0.875rem] font-semibold text-brand-text">
                      {formatGBPFromPence(
                        mortgage.next_payment.amount_pence + monthlyOverpaymentPence,
                      )}
                      /mo
                    </span>
                  </div>
                </div>

                <p className="mt-4 text-[0.75rem] text-brand-muted leading-relaxed">
                  {ILLUSTRATION_NOTE}
                </p>
              </div>
            )
          }

          return (
            <div data-testid="mortgage-rates-view">
              <div className="py-4 border-b border-brand-divider tabular-nums">
                <div className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-medium">
                  Current Deal (Ends {formatIsoDayMonthYear(mortgage.fixed_until)})
                </div>
                <div className="flex items-baseline justify-between mt-1">
                  <span className="text-[1.25rem] font-bold text-brand-text">
                    {formatBps(mortgage.interest_rate_bps)} {mortgage.rate_type}
                  </span>
                  <span className="text-[1rem] font-semibold text-brand-text">
                    {formatGBPFromPence(mortgage.next_payment.amount_pence)}/mo
                  </span>
                </div>
              </div>

              <div className="mt-3 divide-y divide-brand-divider border-b border-brand-divider tabular-nums">
                {renewalItems.map((item) => {
                  const deltaSummary =
                    item.delta_pence < 0
                      ? `−${formatGBPFromPence(Math.abs(item.delta_pence))}/mo less than today`
                      : item.delta_pence > 0
                        ? `+${formatGBPFromPence(item.delta_pence)}/mo vs today`
                        : '£0.00/mo vs today'
                  return (
                    <div key={item.id} className="py-3.5 flex items-center justify-between">
                      <div>
                        <div className="text-[0.9375rem] font-semibold text-brand-text">
                          {item.label}
                        </div>
                        <div className="text-[0.8125rem] text-brand-muted mt-0.5">
                          {formatBps(item.rate_bps)} fixed ·{' '}
                          {formatMonthsDuration(mortgage.term_remaining_months)} term
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[1rem] font-bold text-brand-text">
                          {formatGBPFromPence(item.payment_pence)}/mo
                        </div>
                        <div
                          className={
                            'text-[0.75rem] font-semibold ' +
                            (item.delta_pence <= 0
                              ? 'text-brand-green'
                              : 'text-brand-gold-text')
                          }
                        >
                          {deltaSummary}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              <p className="mt-4 text-[0.75rem] text-brand-muted leading-relaxed">
                {ILLUSTRATION_NOTE} Illustrative rates exclude product arrangement fees.
              </p>
            </div>
          )
        }}
      />
    </div>
  )
}
