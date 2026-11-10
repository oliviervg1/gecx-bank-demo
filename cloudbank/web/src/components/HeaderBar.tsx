import { Landmark } from 'lucide-react'
import { ConciergePill } from './ConciergePill'

export function HeaderBar() {
  return (
    <header className="flex items-center justify-between px-4 py-3 border-b border-brand-divider bg-white shrink-0">
      <div className="flex items-center gap-2 text-brand-text">
        <Landmark size={18} aria-hidden="true" className="text-brand-green" />
        <span className="text-[15px] font-semibold tracking-[-0.01em]">Cloudbank</span>
      </div>
      <ConciergePill />
    </header>
  )
}
