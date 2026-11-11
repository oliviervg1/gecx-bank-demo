import type { ReactNode } from 'react'

export interface PhoneFrameProps {
  header?: ReactNode
  footer?: ReactNode
  children: ReactNode
}

export function PhoneFrame({ header, footer, children }: PhoneFrameProps) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-brand-bg p-0 sm:p-4">
      <div className="w-full max-w-[390px] h-screen sm:h-[844px] bg-white sm:border border-brand-divider sm:rounded-2xl overflow-hidden flex flex-col">
        {header}
        <div className="flex-1 min-h-0 bg-white overflow-hidden">{children}</div>
        {footer}
      </div>
    </div>
  )
}
