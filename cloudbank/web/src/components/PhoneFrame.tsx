import type { ReactNode } from 'react'

export interface PhoneFrameProps {
  header?: ReactNode
  footer?: ReactNode
  children: ReactNode
}

export function PhoneFrame({ header, footer, children }: PhoneFrameProps) {
  return (
    <div className="flex-1 flex items-center justify-center bg-brand-bg p-0 sm:p-4">
      <div className="w-full max-w-[24.375rem] h-dvh sm:h-[52.75rem] bg-white sm:border border-brand-divider sm:rounded-2xl overflow-hidden flex flex-col">
        {header}
        <main id="main-content" tabIndex={-1} className="flex-1 min-h-0 bg-white overflow-hidden">
          {children}
        </main>
        {footer}
      </div>
    </div>
  )
}
