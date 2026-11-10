import { Landmark, MessageSquare } from 'lucide-react'
import { ConciergePill } from './ConciergePill'

interface Props {
  onToggleConcierge?: () => void
  conciergeOpen?: boolean
}

export function HeaderBar({ onToggleConcierge, conciergeOpen = false }: Props = {}) {
  return (
    <header className="flex items-center justify-between px-4 py-3 border-b border-brand-divider bg-white shrink-0">
      <div className="flex items-center gap-2 text-brand-text">
        <Landmark size={18} aria-hidden="true" className="text-brand-green" />
        <span className="text-[15px] font-semibold tracking-[-0.01em]">Cloudbank</span>
      </div>
      <div className="flex items-center gap-1.5">
        {onToggleConcierge && (
          <button
            type="button"
            data-testid="mobile-concierge-toggle"
            aria-label={conciergeOpen ? 'Close concierge chat' : 'Open concierge chat'}
            aria-pressed={conciergeOpen}
            onClick={onToggleConcierge}
            className={
              'p-1.5 rounded-full border transition-colors ' +
              (conciergeOpen
                ? 'border-brand-green bg-[#faf9f6] text-brand-green'
                : 'border-brand-divider bg-white text-brand-muted hover:text-brand-text')
            }
          >
            <MessageSquare size={15} aria-hidden="true" />
          </button>
        )}
        <ConciergePill />
      </div>
    </header>
  )
}
