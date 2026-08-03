import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

export const ALL_PAGES = ['home', 'spending', 'mortgage', 'profile'] as const
export type PageId = (typeof ALL_PAGES)[number]

export type Direction = 'forward' | 'back'

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

  const navigateTo = useCallback((id: PageId) => {
    const next = ALL_PAGES.indexOf(id)
    const prev = previousIndexRef.current
    setDirection(next >= prev ? 'forward' : 'back')
    previousIndexRef.current = next
    setPage(id)
  }, [])

  const value = useMemo<PageContextValue>(
    () => ({ page, navigateTo, direction }),
    [page, navigateTo, direction],
  )

  return <PageContext.Provider value={value}>{children}</PageContext.Provider>
}

export function usePage(): PageContextValue {
  const ctx = useContext(PageContext)
  if (!ctx) throw new Error('usePage must be used within <PageProvider>')
  return ctx
}
