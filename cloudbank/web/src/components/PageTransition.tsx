import { useEffect, useRef, type FocusEvent, type ReactNode } from 'react'

interface Props {
  pageKey: string
  direction?: 'forward' | 'back'
  children: ReactNode
}

export function PageTransition({ pageKey, direction = 'forward', children }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const prevPageKeyRef = useRef(pageKey)
  const hadFocusInsideRef = useRef(false)
  const lastFocusedRoleRef = useRef<string | null>(null)

  function handleFocusCapture(e: FocusEvent<HTMLDivElement>) {
    hadFocusInsideRef.current = true
    if (e.target instanceof HTMLElement) {
      lastFocusedRoleRef.current = e.target.getAttribute('role')
    } else {
      lastFocusedRoleRef.current = null
    }
  }

  function handleBlurCapture(e: FocusEvent<HTMLDivElement>) {
    const nextTarget = e.relatedTarget
    if (
      nextTarget instanceof Node &&
      containerRef.current &&
      !containerRef.current.contains(nextTarget)
    ) {
      hadFocusInsideRef.current = false
      lastFocusedRoleRef.current = null
    }
  }

  useEffect(() => {
    if (prevPageKeyRef.current === pageKey) return
    prevPageKeyRef.current = pageKey

    const container = containerRef.current
    if (!container || !hadFocusInsideRef.current) return

    const active = document.activeElement
    const focusDroppedOrInside =
      active === null || active === document.body || container.contains(active)
    if (!focusDroppedOrInside) {
      hadFocusInsideRef.current = false
      lastFocusedRoleRef.current = null
      return
    }

    if (lastFocusedRoleRef.current === 'tab') {
      const selectedTab = container.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"]',
      )
      if (selectedTab) {
        selectedTab.focus({ preventScroll: true })
        return
      }
    }

    const heading = container.querySelector<HTMLElement>('h1')
    if (heading) {
      if (!heading.hasAttribute('tabindex')) {
        heading.setAttribute('tabindex', '-1')
      }
      heading.focus({ preventScroll: true })
    }
  }, [pageKey])

  return (
    <div
      ref={containerRef}
      data-direction={direction}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
      className="h-full"
    >
      <div key={pageKey} className="cb-page-transition motion-safe:transition-opacity">
        {children}
      </div>
    </div>
  )
}
