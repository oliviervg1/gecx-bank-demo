import type { ReactNode, ButtonHTMLAttributes, HTMLAttributes } from 'react'

type HeroCardProps = {
  children: ReactNode
  className?: string
} & (
  | ({ onClick: () => void } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className'>)
  | ({ onClick?: undefined } & Omit<HTMLAttributes<HTMLDivElement>, 'onClick' | 'className'>)
)

const BASE = 'rounded-xl border border-brand-green-deep p-4 text-white bg-brand-green'

export function HeroCard({ children, className = '', onClick, ...rest }: HeroCardProps) {
  if (onClick) {
    return (
      <button
        type="button"
        data-card
        onClick={onClick}
        className={`${BASE} text-left w-full hover:bg-brand-green-deep transition-colors ${className}`}
        {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
      >
        {children}
      </button>
    )
  }
  return (
    <div data-card className={`${BASE} ${className}`} {...(rest as HTMLAttributes<HTMLDivElement>)}>
      {children}
    </div>
  )
}
