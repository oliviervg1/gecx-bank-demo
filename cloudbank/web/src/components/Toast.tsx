import { X } from 'lucide-react'

interface Props {
  message: string
  variant: 'info' | 'error'
  onDismiss?: () => void
}

export function Toast({ message, variant, onDismiss }: Props) {
  const border =
    variant === 'error' ? 'border-brand-danger' : 'border-brand-border-strong'
  return (
    <div
      data-toast
      className={
        'pointer-events-auto max-w-md px-3.5 py-2.5 rounded-lg bg-white border ' +
        'text-[0.8125rem] text-brand-text flex items-center gap-2.5 ' +
        border
      }
    >
      <span className="flex-1">{message}</span>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={onDismiss}
          className="min-w-7 min-h-7 rounded-md inline-flex items-center justify-center text-brand-muted hover:text-brand-text hover:bg-[#faf9f6] transition-colors shrink-0"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
