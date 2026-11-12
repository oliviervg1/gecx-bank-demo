import { ChevronLeft } from 'lucide-react'
import {
  useBankingViewState,
  type SpendingView,
} from '../../agent/BankingViewStateProvider'
import { SegmentedTabs } from '../../components/SegmentedTabs'
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

export type SpendingTopTabId = 'overview' | 'subscriptions' | 'trend'

export const SPENDING_TAB_ID_PREFIX = 'spending'

export const SPENDING_SUBVIEW_TABS: ReadonlyArray<{
  id: SpendingTopTabId
  label: string
}> = [
  { id: 'overview', label: 'Overview' },
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'trend', label: '3-Month Trend' },
]

export function isSpendingTopSubview(view: SpendingView): view is SpendingTopTabId {
  return view === 'overview' || view === 'subscriptions' || view === 'trend'
}

export function SpendingHeader({ breadcrumb, showPeriodSelector = true }: Props) {
  const { view, period, setView, setPeriod } = useBankingViewState()
  const { demoDate } = usePersona()

  const periodOptions: Array<{ id: SpendingPeriod; label: string }> = [
    { id: OFFSET_TO_PERIOD[0], label: shortMonthForOffset(demoDate, 0) },
    { id: OFFSET_TO_PERIOD[1], label: shortMonthForOffset(demoDate, 1) },
    { id: OFFSET_TO_PERIOD[2], label: shortMonthForOffset(demoDate, 2) },
  ]

  const isTopSubview = isSpendingTopSubview(view)

  return (
    <div className="pt-4 pb-3 border-b border-brand-divider">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          {breadcrumb && (
            <button
              type="button"
              aria-label="Back to Spending overview"
              onClick={() => setView({ view: 'overview' })}
              className="w-9 h-9 rounded-full bg-white border border-brand-border-strong flex items-center justify-center text-brand-text shrink-0 hover:bg-[#faf9f6]"
            >
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
          )}
          <h1
            tabIndex={-1}
            className="text-[1.375rem] font-bold tracking-[-0.02em] text-brand-text truncate leading-tight"
          >
            {breadcrumb ? `Spending › ${breadcrumb}` : 'Spending'}
          </h1>
        </div>

        {showPeriodSelector && view !== 'trend' && (
          <div
            role="group"
            aria-label="Statement month"
            className="inline-flex rounded-lg border border-brand-border-strong bg-[#faf9f6] p-0.5 shrink-0"
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
                    'min-h-8 px-2.5 py-1 rounded-md text-[0.75rem] font-semibold transition-colors ' +
                    (active
                      ? 'bg-white text-brand-green border border-brand-border-strong'
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
        <SegmentedTabs
          idPrefix={SPENDING_TAB_ID_PREFIX}
          ariaLabel="Spending views"
          tabs={SPENDING_SUBVIEW_TABS}
          activeId={view}
          onSelect={(nextId) => setView({ view: nextId })}
        />
      )}
    </div>
  )
}
