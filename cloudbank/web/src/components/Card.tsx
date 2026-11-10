import type { ReactNode, HTMLAttributes, ButtonHTMLAttributes } from 'react'

type CardProps = {
  children: ReactNode
  className?: string
} & (
  | ({ onClick: () => void } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className'>)
  | ({ onClick?: undefined } & Omit<HTMLAttributes<HTMLDivElement>, 'onClick' | 'className'>)
)

const BASE = 'bg-brand-card border border-brand-divider rounded-xl p-4'

export function Card({ children, className = '', onClick, ...rest }: CardProps) {
  if (onClick) {
    return (
      <button
        type="button"
        data-card
        onClick={onClick}
        className={`${BASE} text-left w-full hover:bg-[#faf9f6] transition-colors ${className}`}
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
