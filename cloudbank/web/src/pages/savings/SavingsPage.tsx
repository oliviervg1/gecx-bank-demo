import { useMemo } from 'react'
import { useFixture } from '../../data/useFixture'
import { usePersona } from '../../personas/PersonaProvider'
import { useBankingViewState } from '../../agent/BankingViewStateProvider'
import { formatBps, formatGBPFromPence } from '../../util/currency'
import { computeSavingsComparison, halfUp } from '../../util/savingsMath'
import { formatMonthsDuration } from '../../util/mortgageMath'

const EXTRA_PRESETS_PENCE = [0, 4500, 10000, 20000] as const

function parsePoundsInputToPence(raw: string): number {
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return 0
  const clamped = Math.min(num, 10_000_000)
  return Math.floor(clamped * 100 + 0.5)
}

export function SavingsPage() {
  const fixture = useFixture()
  const { demoDate } = usePersona()
  const {
    extraMonthlyPence,
    customTargetPence,
    setExtraMonthlyPence,
    setCustomTargetPence,
  } = useBankingViewState()

  const savings = fixture.accounts.savings

  const comparison = useMemo(
    () =>
      computeSavingsComparison(savings, demoDate, extraMonthlyPence, customTargetPence),
    [savings, demoDate, extraMonthlyPence, customTargetPence],
  )

  const progressBps =
    comparison.target_pence > 0
      ? Math.min(10_000, halfUp(savings.balance_pence * 10_000, comparison.target_pence))
      : 10_000
  const progressPercent = Math.min(100, Math.trunc(progressBps / 100))

  const extraOptions = useMemo(() => {
    const base: number[] = [...EXTRA_PRESETS_PENCE]
    if (extraMonthlyPence > 0 && !base.includes(extraMonthlyPence)) {
      base.push(extraMonthlyPence)
      base.sort((a, b) => a - b)
    }
    return base
  }, [extraMonthlyPence])

  const targetPresets = useMemo(() => {
    const defaults = [0, 1500000, 2500000, 3500000]
    if (customTargetPence > 0 && !defaults.includes(customTargetPence)) {
      defaults.push(customTargetPence)
    }
    return defaults
  }, [customTargetPence])

  return (
    <div className="pb-6">
      <div className="pt-4 pb-4 border-b border-brand-divider">
        <div className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-medium">
          {savings.name}
        </div>
        <h1 className="text-[1.375rem] font-bold tracking-[-0.02em] text-brand-text mt-1 leading-tight">
          {savings.goal_name}
        </h1>
      </div>

      {/* Balance & Rate Summary */}
      <div className="py-4 border-b border-brand-divider">
        <div className="flex items-baseline justify-between gap-2">
          <div>
            <div className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-medium">
              Current Pot Balance
            </div>
            <div className="text-[1.875rem] font-bold tracking-[-0.02em] text-brand-text tabular-nums mt-1 leading-none">
              {formatGBPFromPence(savings.balance_pence)}
            </div>
          </div>
          <div className="text-right tabular-nums">
            <div className="text-[1rem] font-bold text-brand-green">
              {formatBps(savings.aer_bps)} AER
            </div>
            <div className="text-[0.75rem] text-brand-muted">
              {formatBps(savings.gross_rate_bps)} gross p.a. (variable)
            </div>
          </div>
        </div>

        {/* Accessible Goal Progress Bar */}
        <div className="mt-4">
          <div className="flex items-center justify-between text-[0.75rem] text-brand-muted tabular-nums mb-1.5">
            <span>Progress ({formatBps(progressBps)})</span>
            <span>
              Target:{' '}
              <strong className="font-semibold text-brand-text">
                {formatGBPFromPence(comparison.target_pence)}
              </strong>
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={`${savings.goal_name} savings progress`}
            aria-valuenow={progressPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-2 w-full rounded-full bg-[#eceae3] overflow-hidden"
          >
            <div
              className="h-full bg-brand-green transition-all motion-reduce:transition-none"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 pt-3 border-t border-brand-divider text-[0.8125rem] tabular-nums">
          <div>
            <div className="text-[0.6875rem] uppercase tracking-[0.06em] text-brand-muted">
              Regular monthly deposit
            </div>
            <div className="font-semibold text-brand-text mt-0.5">
              {formatGBPFromPence(savings.monthly_contribution_pence)}/mo
            </div>
          </div>
          <div>
            <div className="text-[0.6875rem] uppercase tracking-[0.06em] text-brand-muted">
              12-Month Balance Interest
            </div>
            <div className="font-semibold text-brand-text mt-0.5">
              +{formatGBPFromPence(comparison.annual_interest_on_balance_pence)}/yr
            </div>
          </div>
        </div>
      </div>

      {/* Interactive Goal Projection Calculator (synced with ui_view_state) */}
      <div className="py-4 border-b border-brand-divider" data-testid="savings-calculator">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-semibold">
            Extra Monthly Contribution
          </span>
          <span className="text-[0.8125rem] font-semibold text-brand-green tabular-nums">
            +{formatGBPFromPence(extraMonthlyPence)}/mo
          </span>
        </div>

        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label="Extra monthly contribution"
        >
          {extraOptions.map((pence) => {
            const active = extraMonthlyPence === pence
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
                onClick={() => setExtraMonthlyPence(pence)}
                className={
                  'min-h-9 px-3 py-1.5 rounded-lg text-[0.75rem] font-semibold border transition-colors tabular-nums ' +
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

        <div className="mt-3 flex items-center gap-2">
          <label
            htmlFor="savings-extra-input"
            className="text-[0.75rem] text-brand-muted shrink-0"
          >
            Custom extra (£/mo):
          </label>
          <input
            id="savings-extra-input"
            type="number"
            min="0"
            step="1"
            value={extraMonthlyPence > 0 ? extraMonthlyPence / 100 : ''}
            placeholder="0"
            onChange={(e) => setExtraMonthlyPence(parsePoundsInputToPence(e.target.value))}
            className="min-h-9 w-28 px-2.5 py-1 rounded-lg border border-brand-border-strong bg-white text-[0.8125rem] text-brand-text tabular-nums focus:border-brand-green"
          />
        </div>

        {/* Custom Goal Target Selector */}
        <div className="mt-4 pt-3 border-t border-brand-divider">
          <div className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-semibold mb-2">
            Try a different goal
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Try a different goal">
            {targetPresets.map((pence) => {
              const active = customTargetPence === pence
              const label =
                pence === 0
                  ? `Goal (${formatGBPFromPence(savings.goal_target_pence)})`
                  : formatGBPFromPence(pence)
              return (
                <button
                  key={pence}
                  type="button"
                  aria-pressed={active}
                  data-active={active}
                  onClick={() => setCustomTargetPence(pence)}
                  className={
                    'min-h-9 px-2.5 py-1 rounded-lg text-[0.75rem] font-semibold border transition-colors tabular-nums ' +
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
        </div>
      </div>

      {/* Exact Goal Timeline Results */}
      <div className="pt-4">
        <div className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-semibold mb-2">
          Projected Goal Timeline
        </div>

        {comparison.unreachable ? (
          <div className="p-3.5 rounded-xl border border-brand-gold-text/50 bg-[#fcf9f2] text-[0.8125rem] text-brand-text">
            At {formatGBPFromPence(savings.monthly_contribution_pence + extraMonthlyPence)}/mo, reaching{' '}
            {formatGBPFromPence(comparison.target_pence)} takes over 50 years. Increase your monthly contribution to reach this target sooner.
          </div>
        ) : comparison.projected_months === 0 ? (
          <div className="p-3.5 rounded-xl border border-brand-green/40 bg-[#f6faf8] text-[0.8125rem] text-brand-text">
            Your current balance of {formatGBPFromPence(savings.balance_pence)} already meets the{' '}
            {formatGBPFromPence(comparison.target_pence)} target.
          </div>
        ) : (
          <div className="divide-y divide-brand-divider border-t border-b border-brand-divider tabular-nums">
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[0.8125rem] text-brand-muted">Projected completion</span>
              <span className="text-[0.9375rem] font-bold text-brand-green">
                {comparison.target_label} ({comparison.projected_months}{' '}
                {comparison.projected_months === 1 ? 'month' : 'months'})
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[0.8125rem] text-brand-muted">Baseline timeline</span>
              <span className="text-[0.875rem] font-medium text-brand-text">
                {comparison.baseline_months !== null
                  ? `${comparison.baseline_months} months (${formatMonthsDuration(comparison.baseline_months)})`
                  : 'Over 50 years'}
              </span>
            </div>
            {extraMonthlyPence > 0 && (
              <div className="flex items-center justify-between py-2.5">
                <span className="text-[0.8125rem] text-brand-muted">Goal reached</span>
                <span className="text-[0.875rem] font-semibold text-brand-gold-text">
                  {comparison.months_saved}{' '}
                  {comparison.months_saved === 1 ? 'month' : 'months'} sooner
                </span>
              </div>
            )}
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[0.8125rem] text-brand-muted">Total monthly deposit</span>
              <span className="text-[0.875rem] font-semibold text-brand-text">
                {formatGBPFromPence(savings.monthly_contribution_pence + extraMonthlyPence)}/mo
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[0.8125rem] text-brand-muted">Interest earned to goal</span>
              <span className="text-[0.875rem] font-semibold text-brand-text">
                +{formatGBPFromPence(comparison.total_interest_earned_pence)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
