import { Cloud } from 'lucide-react'
import { ConciergePill } from './ConciergePill'

export function HeaderBar() {
  return (
    <header className="flex items-center justify-between px-4 pt-4 pb-3">
      <div className="flex items-center gap-2 text-brand-text">
        <Cloud size={26} aria-hidden="true" className="text-brand-green fill-brand-green/15" />
        <span className="text-[15px] font-semibold">Cloudbank</span>
      </div>
      <ConciergePill />
    </header>
  )
}
