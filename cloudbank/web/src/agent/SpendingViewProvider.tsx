import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type SpendingView =
  | 'overview'
  | 'category_drilldown'
  | 'monthly_trend'
  | 'subscriptions_audit'
  | 'vendor_history'

export interface SpendingViewState {
  view: SpendingView
  category?: string
  vendor?: string
}

export interface SpendingViewContextValue extends SpendingViewState {
  setView: (next: SpendingViewState) => void
  direction: 'forward' | 'back'
}

const SpendingViewContext = createContext<SpendingViewContextValue>({
  view: 'overview',
  setView: () => {},
  direction: 'forward',
})

export function SpendingViewProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SpendingViewState>({ view: 'overview' })
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const prevViewRef = useRef<string>('overview')

  // Wrapped setState that tracks navigation direction.
  // 'overview' is the only top-level view; everything else is a sub-view.
  // Going overview -> sub-view (or sub-view -> sub-view) is forward;
  // sub-view -> overview is back.
  // Consumers: SpendingDataBinder (via the get_* tools' `show` flag side
  // effect, see App.tsx) and the SpendingHeader back chevron.
  const setView = useCallback((next: SpendingViewState) => {
    const incomingIsOverview = next.view === 'overview'
    const prevWasOverview = prevViewRef.current === 'overview'
    if (incomingIsOverview && !prevWasOverview) setDirection('back')
    else setDirection('forward')
    prevViewRef.current = next.view
    setState(next)
  }, [])

  const value = useMemo<SpendingViewContextValue>(
    () => ({ ...state, setView, direction }),
    [state, setView, direction],
  )

  return (
    <SpendingViewContext.Provider value={value}>
      {children}
    </SpendingViewContext.Provider>
  )
}

export function useSpendingView(): SpendingViewContextValue {
  return useContext(SpendingViewContext)
}
