import { Home, BarChart3, Building2, User } from 'lucide-react'
import type { ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import { usePage } from '../pages/PageProvider'

interface Tab {
  id: 'home' | 'spending' | 'mortgage' | 'profile'
  label: string
  icon: ComponentType<LucideProps>
}

const TABS: Tab[] = [
  { id: 'home',     label: 'Home',     icon: Home },
  { id: 'spending', label: 'Spending', icon: BarChart3 },
  { id: 'mortgage', label: 'Mortgage', icon: Building2 },
  { id: 'profile',  label: 'Profile',  icon: User },
]

export function TabBar() {
  const { page, navigateTo } = usePage()
  return (
    <nav className="flex items-stretch border-t border-brand-divider bg-white">
      {TABS.map(({ id, label, icon: Icon }) => {
        const active = page === id
        return (
          <button
            key={id}
            type="button"
            data-active={active}
            onClick={() => navigateTo(id as never)}
            className="flex-1 flex flex-col items-center gap-1 pt-2 pb-3 relative"
          >
            {active && (
              <span className="absolute top-0 left-1/2 -translate-x-1/2 w-7 h-[2px] bg-brand-green rounded-full" />
            )}
            <Icon
              size={22}
              strokeWidth={active ? 2 : 1.75}
              className={active ? 'text-brand-green' : 'text-brand-muted'}
            />
            <span
              className={
                'text-[11px] ' +
                (active ? 'text-brand-green font-semibold' : 'text-brand-muted')
              }
            >
              {label}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
