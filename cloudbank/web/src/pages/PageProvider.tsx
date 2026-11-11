import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export const ALL_PAGES = ['home', 'spending', 'savings', 'mortgage', 'profile'] as const
export type PageId = (typeof ALL_PAGES)[number]

export type Direction = 'forward' | 'back'

export const PAGE_TITLES: Record<PageId, string> = {
  home: 'Cloudbank — Home',
  spending: 'Cloudbank — Spending',
  savings: 'Cloudbank — Savings',
  mortgage: 'Cloudbank — Mortgage',
  profile: 'Cloudbank — Profile',
}

interface PageContextValue {
  page: PageId
  navigateTo: (id: PageId) => void
  direction: Direction
}

export const PageContext = createContext<PageContextValue | null>(null)

export function PageProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<PageId>('home')
  const [direction, setDirection] = useState<Direction>('forward')
  const previousIndexRef = useRef<number>(ALL_PAGES.indexOf('home'))

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = PAGE_TITLES[page]
    }
  }, [page])

  const navigateTo = useCallback((id: PageId) => {
    const next = ALL_PAGES.indexOf(id)
    if (next < 0) return
    const prev = previousIndexRef.current
    setDirection(next >= prev ? 'forward' : 'back')
    previousIndexRef.current = next
    setPage(id)
  }, [])

  const value = useMemo<PageContextValue>(
    () => ({ page, navigateTo, direction }),
    [page, navigateTo, direction],
  )

  return <PageContext value={value}>{children}</PageContext>
}

export function usePage(): PageContextValue {
  const ctx = use(PageContext)
  if (!ctx) throw new Error('usePage must be used within <PageProvider>')
  return ctx
}

export function usePageOptional(): PageContextValue | null {
  return use(PageContext)
}
