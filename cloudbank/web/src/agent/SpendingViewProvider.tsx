import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { UiViewStatePayload } from './protocol'
import type { SpendingPeriod } from '../util/demoClock'
import { usePageOptional, ALL_PAGES, type PageId } from '../pages/PageProvider'

export type SpendingView =
  | 'overview'
  | 'category'
  | 'vendor'
  | 'trend'
  | 'subscriptions'

export type AnomalyStatus = '' | 'confirmed' | 'unrecognised'
export type MortgageSubview = 'overview' | 'overpay' | 'rates'

export interface SpendingViewState {
  view: SpendingView
  period?: SpendingPeriod
  category?: string
  vendor?: string
  highlightVendor?: string
  anomalyStatus?: AnomalyStatus
}

export interface SpendingViewContextValue {
  view: SpendingView
  period: SpendingPeriod
  category?: string
  vendor?: string
  highlightVendor: string
  anomalyStatus: AnomalyStatus
  direction: 'forward' | 'back'
  extraMonthlyPence: number
  customTargetPence: number
  mortgageSubview: MortgageSubview
  monthlyOverpaymentPence: number
  lumpSumOverpaymentPence: number
  setView: (next: SpendingViewState) => void
  setPeriod: (period: SpendingPeriod) => void
  setHighlightVendor: (vendor: string) => void
  setAnomalyStatus: (status: AnomalyStatus) => void
  setExtraMonthlyPence: (pence: number) => void
  setCustomTargetPence: (pence: number) => void
  setMortgageSubview: (subview: MortgageSubview) => void
  setMonthlyOverpaymentPence: (pence: number) => void
  setLumpSumOverpaymentPence: (pence: number) => void
  applyServerUiState: (payload: UiViewStatePayload) => void
  resetUiState: () => void
}

const DEFAULT_CONTEXT: SpendingViewContextValue = {
  view: 'overview',
  period: 'this_month',
  highlightVendor: '',
  anomalyStatus: '',
  direction: 'forward',
  extraMonthlyPence: 0,
  customTargetPence: 0,
  mortgageSubview: 'overview',
  monthlyOverpaymentPence: 0,
  lumpSumOverpaymentPence: 0,
  setView: () => {},
  setPeriod: () => {},
  setHighlightVendor: () => {},
  setAnomalyStatus: () => {},
  setExtraMonthlyPence: () => {},
  setCustomTargetPence: () => {},
  setMortgageSubview: () => {},
  setMonthlyOverpaymentPence: () => {},
  setLumpSumOverpaymentPence: () => {},
  applyServerUiState: () => {},
  resetUiState: () => {},
}

const SpendingViewContext = createContext<SpendingViewContextValue>(DEFAULT_CONTEXT)

export function SpendingViewProvider({ children }: { children: ReactNode }) {
  const pageCtx = usePageOptional()
  const navigateTo = pageCtx?.navigateTo

  const [view, setViewState] = useState<SpendingView>('overview')
  const [period, setPeriod] = useState<SpendingPeriod>('this_month')
  const [category, setCategory] = useState<string | undefined>(undefined)
  const [vendor, setVendor] = useState<string | undefined>(undefined)
  const [highlightVendor, setHighlightVendor] = useState<string>('')
  const [anomalyStatus, setAnomalyStatus] = useState<AnomalyStatus>('')
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')

  const [extraMonthlyPence, setExtraMonthlyPence] = useState<number>(0)
  const [customTargetPence, setCustomTargetPence] = useState<number>(0)

  const [mortgageSubview, setMortgageSubview] = useState<MortgageSubview>('overview')
  const [monthlyOverpaymentPence, setMonthlyOverpaymentPence] = useState<number>(0)
  const [lumpSumOverpaymentPence, setLumpSumOverpaymentPence] = useState<number>(0)

  const prevViewRef = useRef<SpendingView>('overview')

  const setView = useCallback((next: SpendingViewState) => {
    const incomingIsOverview = next.view === 'overview'
    const prevWasOverview = prevViewRef.current === 'overview'
    setDirection(incomingIsOverview && !prevWasOverview ? 'back' : 'forward')
    prevViewRef.current = next.view
    setViewState(next.view)
    setCategory(next.category)
    setVendor(next.vendor)
    if (next.period !== undefined) setPeriod(next.period)
    if (next.highlightVendor !== undefined) setHighlightVendor(next.highlightVendor)
    if (next.anomalyStatus !== undefined) setAnomalyStatus(next.anomalyStatus)
  }, [])

  const applyServerUiState = useCallback(
    (payload: UiViewStatePayload) => {
      if (navigateTo && (ALL_PAGES as readonly string[]).includes(payload.page)) {
        navigateTo(payload.page as PageId)
      }

      if (payload.page === 'spending') {
        const nextView: SpendingView = payload.view ?? 'overview'
        const incomingIsOverview = nextView === 'overview'
        const prevWasOverview = prevViewRef.current === 'overview'
        setDirection(incomingIsOverview && !prevWasOverview ? 'back' : 'forward')
        prevViewRef.current = nextView
        setViewState(nextView)
        if (payload.period) setPeriod(payload.period)
        setCategory(payload.category)
        setVendor(payload.vendor)
        setHighlightVendor(payload.highlight_vendor ?? '')
        if (payload.anomaly_status) {
          setAnomalyStatus(payload.anomaly_status)
        } else if (nextView === 'overview') {
          setAnomalyStatus('')
        }
      }

      if (payload.page === 'savings') {
        if (typeof payload.extra_monthly_pence === 'number') {
          setExtraMonthlyPence(Math.max(0, Math.trunc(payload.extra_monthly_pence)))
        }
        if (typeof payload.custom_target_pence === 'number') {
          setCustomTargetPence(Math.max(0, Math.trunc(payload.custom_target_pence)))
        } else {
          setCustomTargetPence(0)
        }
      }

      if (payload.page === 'mortgage') {
        if (payload.subview) {
          setMortgageSubview(payload.subview)
        }
        if (typeof payload.monthly_overpayment_pence === 'number') {
          setMonthlyOverpaymentPence(Math.max(0, Math.trunc(payload.monthly_overpayment_pence)))
        }
        if (typeof payload.lump_sum_overpayment_pence === 'number') {
          setLumpSumOverpaymentPence(Math.max(0, Math.trunc(payload.lump_sum_overpayment_pence)))
        }
      }
    },
    [navigateTo],
  )

  const resetUiState = useCallback(() => {
    if (navigateTo) navigateTo('home')
    prevViewRef.current = 'overview'
    setDirection('back')
    setViewState('overview')
    setPeriod('this_month')
    setCategory(undefined)
    setVendor(undefined)
    setHighlightVendor('')
    setAnomalyStatus('')
    setExtraMonthlyPence(0)
    setCustomTargetPence(0)
    setMortgageSubview('overview')
    setMonthlyOverpaymentPence(0)
    setLumpSumOverpaymentPence(0)
  }, [navigateTo])

  const value = useMemo<SpendingViewContextValue>(
    () => ({
      view,
      period,
      category,
      vendor,
      highlightVendor,
      anomalyStatus,
      direction,
      extraMonthlyPence,
      customTargetPence,
      mortgageSubview,
      monthlyOverpaymentPence,
      lumpSumOverpaymentPence,
      setView,
      setPeriod,
      setHighlightVendor,
      setAnomalyStatus,
      setExtraMonthlyPence,
      setCustomTargetPence,
      setMortgageSubview,
      setMonthlyOverpaymentPence,
      setLumpSumOverpaymentPence,
      applyServerUiState,
      resetUiState,
    }),
    [
      view,
      period,
      category,
      vendor,
      highlightVendor,
      anomalyStatus,
      direction,
      extraMonthlyPence,
      customTargetPence,
      mortgageSubview,
      monthlyOverpaymentPence,
      lumpSumOverpaymentPence,
      setView,
      applyServerUiState,
      resetUiState,
    ],
  )

  return <SpendingViewContext.Provider value={value}>{children}</SpendingViewContext.Provider>
}

export function useSpendingView(): SpendingViewContextValue {
  return useContext(SpendingViewContext)
}

export const useUiViewState = useSpendingView
