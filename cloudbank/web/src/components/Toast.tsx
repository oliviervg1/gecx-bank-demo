interface Props {
  message: string
  variant: 'info' | 'error'
}

export function Toast({ message, variant }: Props) {
  const border = variant === 'error' ? 'border-brand-danger' : 'border-brand-divider'
  return (
    <div
      data-toast
      role="status"
      aria-live="polite"
      className={
        'mx-3 mt-2 px-3 py-2 rounded-xl bg-white shadow-card border ' +
        'text-[13px] text-brand-text ' +
        border
      }
    >
      {message}
    </div>
  )
}
