import { ChevronLeft } from 'lucide-react'
import { useSpendingView } from '../../agent/SpendingViewProvider'

interface Props {
  // When set, header shows "Spending › <breadcrumb>" and a back chevron.
  // When unset, header shows just "Spending" (overview view).
  breadcrumb?: string
}

export function SpendingHeader({ breadcrumb }: Props) {
  const { setView } = useSpendingView()
  return (
    <div className="flex items-center gap-2 mt-2 mb-3 min-w-0">
      {breadcrumb && (
        <button
          type="button"
          aria-label="Back to Spending overview"
          onClick={() => setView({ view: 'overview' })}
          className="w-9 h-9 rounded-full bg-white shadow-card flex items-center justify-center text-brand-text shrink-0"
        >
          <ChevronLeft size={20} />
        </button>
      )}
      <h1 className="text-[20px] font-bold tracking-[-0.01em] text-brand-text truncate">
        {breadcrumb ? `Spending › ${breadcrumb}` : 'Spending'}
      </h1>
    </div>
  )
}
