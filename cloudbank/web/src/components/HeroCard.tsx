import type { ReactNode, ButtonHTMLAttributes, HTMLAttributes } from 'react'

type HeroCardProps = {
  children: ReactNode
  className?: string
} & (
  | { onClick: () => void } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className'>
  | { onClick?: undefined } & Omit<HTMLAttributes<HTMLDivElement>, 'onClick' | 'className'>
)

// Subtle vertical gradient brandGreen → brandGreenDeep.
const BASE =
  'rounded-2xl shadow-card p-4 text-white ' +
  'bg-brand-green bg-gradient-to-b from-brand-green to-brand-green-deep'

export function HeroCard({ children, className = '', onClick, ...rest }: HeroCardProps) {
  if (onClick) {
    return (
      <button
        type="button"
        data-card
        onClick={onClick}
        className={`${BASE} text-left w-full ${className}`}
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
