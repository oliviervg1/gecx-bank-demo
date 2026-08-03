import type { ReactNode, HTMLAttributes, ButtonHTMLAttributes } from 'react'

type CardProps = {
  children: ReactNode
  className?: string
} & (
  | { onClick: () => void } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className'>
  | { onClick?: undefined } & Omit<HTMLAttributes<HTMLDivElement>, 'onClick' | 'className'>
)

const BASE = 'bg-brand-card rounded-2xl shadow-card p-4'

export function Card({ children, className = '', onClick, ...rest }: CardProps) {
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
