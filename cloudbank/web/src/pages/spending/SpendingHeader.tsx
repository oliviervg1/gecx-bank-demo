import { ChevronLeft } from 'lucide-react'
import { useSpendingView, type SpendingView } from '../../agent/SpendingViewProvider'
import { usePersona } from '../../personas/PersonaProvider'
import {
  OFFSET_TO_PERIOD,
  shortMonthForOffset,
  type SpendingPeriod,
} from '../../util/demoClock'

interface Props {
  breadcrumb?: string
  showPeriodSelector?: boolean
}

const SUBVIEW_TABS: Array<{ id: SpendingView; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'trend', label: '3-Month Trend' },
]

export function SpendingHeader({ breadcrumb, showPeriodSelector = true }: Props) {
  const { view, period, setView, setPeriod } = useSpendingView()
  const { demoDate } = usePersona()

  const periodOptions: Array<{ id: SpendingPeriod; label: string }> = [
    { id: OFFSET_TO_PERIOD[0], label: shortMonthForOffset(demoDate, 0) },
    { id: OFFSET_TO_PERIOD[1], label: shortMonthForOffset(demoDate, 1) },
    { id: OFFSET_TO_PERIOD[2], label: shortMonthForOffset(demoDate, 2) },
  ]

  const isTopSubview = view === 'overview' || view === 'subscriptions' || view === 'trend'

  return (
    <div className="pt-4 pb-3 border-b border-brand-divider">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          {breadcrumb && (
            <button
              type="button"
              aria-label="Back to Spending overview"
              onClick={() => setView({ view: 'overview' })}
              className="w-8 h-8 rounded-full bg-white border border-brand-divider flex items-center justify-center text-brand-text shrink-0 hover:bg-[#faf9f6]"
            >
              <ChevronLeft size={18} />
            </button>
          )}
          <h1 className="text-[22px] font-bold tracking-[-0.02em] text-brand-text truncate leading-tight">
            {breadcrumb ? `Spending › ${breadcrumb}` : 'Spending'}
          </h1>
        </div>

        {showPeriodSelector && view !== 'trend' && (
          <div
            role="group"
            aria-label="Statement month"
            className="inline-flex rounded-lg border border-brand-divider bg-[#faf9f6] p-0.5 shrink-0"
          >
            {periodOptions.map((opt) => {
              const active = period === opt.id
              return (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={active}
                  data-active={active}
                  onClick={() => setPeriod(opt.id)}
                  className={
                    'px-2.5 py-1 rounded-md text-[12px] font-semibold transition-colors ' +
                    (active
                      ? 'bg-white text-brand-green border border-brand-divider'
                      : 'text-brand-muted hover:text-brand-text')
                  }
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {isTopSubview && (
        <div className="flex items-center gap-4 mt-3" role="tablist" aria-label="Spending views">
          {SUBVIEW_TABS.map((tab) => {
            const active = view === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-active={active}
                onClick={() => setView({ view: tab.id })}
                className={
                  'text-[13px] pb-1 border-b-2 transition-colors ' +
                  (active
                    ? 'border-brand-green text-brand-green font-semibold'
                    : 'border-transparent text-brand-muted hover:text-brand-text')
                }
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
