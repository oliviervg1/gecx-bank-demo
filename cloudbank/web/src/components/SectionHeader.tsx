import type { ReactNode } from 'react'

interface Props {
  title: string
  subtitle?: string
  right?: ReactNode
  variant?: 'page' | 'section'
}

export function SectionHeader({ title, subtitle, right, variant = 'page' }: Props) {
  if (variant === 'section') {
    return (
      <div className="flex items-center justify-between mt-5 mb-2">
        <h2 className="text-[18px] font-semibold tracking-[-0.01em] text-brand-text">{title}</h2>
        {right}
      </div>
    )
  }
  return (
    <div className="flex items-center justify-between mt-2 mb-3">
      <div>
        <h1 className="text-[28px] font-bold tracking-[-0.02em] text-brand-text leading-none">{title}</h1>
        {subtitle && <div className="text-[14px] text-brand-muted mt-1">{subtitle}</div>}
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  )
}
