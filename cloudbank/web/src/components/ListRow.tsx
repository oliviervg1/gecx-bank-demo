import type { ReactNode } from 'react'

interface BaseProps {
  icon: ReactNode
  title: string
  subtitle?: string
  right?: ReactNode
  className?: string
}

type ListRowProps =
  | (BaseProps & { onClick: () => void })
  | (BaseProps & { onClick?: undefined })

export function ListRow({ icon, title, subtitle, right, className = '', onClick }: ListRowProps) {
  const inner = (
    <>
      {icon}
      <div className="flex-1 min-w-0">
        <div className="text-[0.9375rem] font-semibold text-brand-text truncate">{title}</div>
        {subtitle && (
          <div className="text-[0.8125rem] text-brand-muted truncate">{subtitle}</div>
        )}
      </div>
      {right !== undefined && (
        <div className="text-[0.9375rem] text-brand-text shrink-0 flex items-center">{right}</div>
      )}
    </>
  )
  const layout = `flex items-center gap-3 py-3 min-h-11 ${className}`
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${layout} w-full text-left`}>
        {inner}
      </button>
    )
  }
  return <div className={layout}>{inner}</div>
}
