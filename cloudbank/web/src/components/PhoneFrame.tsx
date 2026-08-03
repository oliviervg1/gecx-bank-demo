import type { ReactNode } from 'react'

export interface PhoneFrameProps {
  header?: ReactNode
  footer?: ReactNode
  children: ReactNode
}

export function PhoneFrame({ header, footer, children }: PhoneFrameProps) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-100 p-6">
      <div className="w-[390px] h-[844px] bg-white border-[10px] border-slate-900 rounded-[44px] overflow-hidden shadow-2xl flex flex-col">
        {/* notch */}
        <div className="h-6 bg-slate-900 w-32 mx-auto rounded-b-2xl" />
        {/* status bar */}
        <div className="flex justify-between items-center px-4 py-1 text-xs font-semibold bg-white">
          <span>9:41</span>
          <span>●●● ⌃ ▮</span>
        </div>
        {header}
        <div className="flex-1 min-h-0 bg-brand-bg">{children}</div>
        {footer}
      </div>
    </div>
  )
}
