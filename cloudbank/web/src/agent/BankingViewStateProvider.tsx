import {
  createContext,
  startTransition,
  use,
  useCallback,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react'
import type { UiViewStatePayload, WireAnomalyStatus } from './protocol'
import type { SpendingPeriod } from '../util/demoClock'
import { formatCategoryLabel, vendorsEqual } from '../util/spendingViews'
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
  anomalyByVendor?: Record<string, WireAnomalyStatus>
}

interface BankingViewReducerState {
  view: SpendingView
  period: SpendingPeriod
  category: string | undefined
  vendor: string | undefined
  highlightVendor: string
  anomalyStatus: AnomalyStatus
  anomalyByVendor: Record<string, WireAnomalyStatus>
  direction: 'forward' | 'back'
  extraMonthlyPence: number
  customTargetPence: number
  mortgageSubview: MortgageSubview
  monthlyOverpaymentPence: number
  lumpSumOverpaymentPence: number
  navigationAnnouncement: string
}

const INITIAL_BANKING_VIEW_STATE: BankingViewReducerState = {
  view: 'overview',
  period: 'this_month',
  category: undefined,
  vendor: undefined,
  highlightVendor: '',
  anomalyStatus: '',
  anomalyByVendor: {},
  direction: 'forward',
  extraMonthlyPence: 0,
  customTargetPence: 0,
  mortgageSubview: 'overview',
  monthlyOverpaymentPence: 0,
  lumpSumOverpaymentPence: 0,
  navigationAnnouncement: '',
}

type BankingViewAction =
  | { type: 'SET_VIEW'; next: SpendingViewState }
  | { type: 'SET_PERIOD'; period: SpendingPeriod }
  | { type: 'SET_HIGHLIGHT_VENDOR'; vendor: string }
  | { type: 'SET_ANOMALY_STATUS'; status: AnomalyStatus; vendor?: string }
  | { type: 'SET_EXTRA_MONTHLY_PENCE'; pence: number }
  | { type: 'SET_CUSTOM_TARGET_PENCE'; pence: number }
  | { type: 'SET_MORTGAGE_SUBVIEW'; subview: MortgageSubview }
  | { type: 'SET_MONTHLY_OVERPAYMENT_PENCE'; pence: number }
  | { type: 'SET_LUMP_SUM_OVERPAYMENT_PENCE'; pence: number }
  | { type: 'APPLY_SERVER_UI_STATE'; payload: UiViewStatePayload }
  | { type: 'RESET_UI_STATE' }

function upsertVendorAnomalyStatus(
  current: Record<string, WireAnomalyStatus>,
  vendor: string,
  status: AnomalyStatus,
): Record<string, WireAnomalyStatus> {
  if (!vendor) return current
  const next: Record<string, WireAnomalyStatus> = {}
  for (const [k, v] of Object.entries(current)) {
    if (!vendorsEqual(k, vendor)) {
      next[k] = v
    }
  }
  if (status === 'confirmed' || status === 'unrecognised') {
    next[vendor] = status
  }
  return next
}

function mergeAnomalyByVendorMap(
  current: Record<string, WireAnomalyStatus>,
  incoming?: Record<string, WireAnomalyStatus>,
  highlightVendor?: string,
  scalarStatus?: AnomalyStatus,
): Record<string, WireAnomalyStatus> {
  let next = current
  if (incoming) {
    for (const [vendor, status] of Object.entries(incoming)) {
      next = upsertVendorAnomalyStatus(next, vendor, status)
    }
  }
  if (highlightVendor && (scalarStatus === 'confirmed' || scalarStatus === 'unrecognised')) {
    next = upsertVendorAnomalyStatus(next, highlightVendor, scalarStatus)
  }
  return next
}

export function resolveAnomalyStatusForVendor(
  vendor: string,
  anomalyByVendor: Record<string, WireAnomalyStatus>,
  highlightVendor: string,
  fallbackStatus: AnomalyStatus,
): AnomalyStatus {
  for (const [k, v] of Object.entries(anomalyByVendor)) {
    if (vendorsEqual(k, vendor)) {
      return v
    }
  }
  if (highlightVendor) {
    return vendorsEqual(highlightVendor, vendor) ? fallbackStatus : ''
  }
  if (Object.keys(anomalyByVendor).length === 0) {
    return fallbackStatus
  }
  return ''
}

export function describeUiNavigation(payload: UiViewStatePayload): string {
  switch (payload.page) {
    case 'home':
      return 'Showing Home: Accounts Overview'
    case 'profile':
      return 'Showing Profile'
    case 'savings':
      return 'Showing Savings'
    case 'mortgage':
      if (payload.subview === 'overpay') return 'Showing Mortgage: Overpay'
      if (payload.subview === 'rates') return 'Showing Mortgage: Fixed Rates'
      return 'Showing Mortgage: Overview'
    case 'spending': {
      const nextView = payload.view ?? 'overview'
      if (nextView === 'subscriptions') return 'Showing Spending: Subscriptions'
      if (nextView === 'trend') return 'Showing Spending: 3-Month Trend'
      if (nextView === 'category' && payload.category) {
        return `Showing Spending: ${formatCategoryLabel(payload.category) || 'Category'}`
      }
      if (nextView === 'vendor' && payload.vendor) {
        return `Showing Spending: ${payload.vendor}`
      }
      return 'Showing Spending: Overview'
    }
  }
}

function bankingViewReducer(
  state: BankingViewReducerState,
  action: BankingViewAction,
): BankingViewReducerState {
  switch (action.type) {
    case 'SET_VIEW': {
      const { next } = action
      const incomingIsOverview = next.view === 'overview'
      const prevWasOverview = state.view === 'overview'
      const nextHighlight =
        next.highlightVendor !== undefined ? next.highlightVendor : state.highlightVendor
      const nextScalar =
        next.anomalyStatus !== undefined ? next.anomalyStatus : state.anomalyStatus
      return {
        ...state,
        direction: incomingIsOverview && !prevWasOverview ? 'back' : 'forward',
        view: next.view,
        category: next.category,
        vendor: next.vendor,
        period: next.period !== undefined ? next.period : state.period,
        highlightVendor: nextHighlight,
        anomalyStatus: nextScalar,
        anomalyByVendor: mergeAnomalyByVendorMap(
          state.anomalyByVendor,
          next.anomalyByVendor,
          next.highlightVendor ?? state.highlightVendor,
          next.anomalyStatus,
        ),
      }
    }
    case 'SET_PERIOD':
      return { ...state, period: action.period }
    case 'SET_HIGHLIGHT_VENDOR':
      return { ...state, highlightVendor: action.vendor }
    case 'SET_ANOMALY_STATUS': {
      const targetVendor = action.vendor ?? state.highlightVendor
      return {
        ...state,
        anomalyStatus: action.status,
        anomalyByVendor: targetVendor
          ? upsertVendorAnomalyStatus(state.anomalyByVendor, targetVendor, action.status)
          : state.anomalyByVendor,
      }
    }
    case 'SET_EXTRA_MONTHLY_PENCE':
      return { ...state, extraMonthlyPence: Math.max(0, Math.trunc(action.pence)) }
    case 'SET_CUSTOM_TARGET_PENCE':
      return { ...state, customTargetPence: Math.max(0, Math.trunc(action.pence)) }
    case 'SET_MORTGAGE_SUBVIEW':
      return { ...state, mortgageSubview: action.subview }
    case 'SET_MONTHLY_OVERPAYMENT_PENCE':
      return { ...state, monthlyOverpaymentPence: Math.max(0, Math.trunc(action.pence)) }
    case 'SET_LUMP_SUM_OVERPAYMENT_PENCE':
      return { ...state, lumpSumOverpaymentPence: Math.max(0, Math.trunc(action.pence)) }
    case 'APPLY_SERVER_UI_STATE': {
      const { payload } = action
      const announcement = describeUiNavigation(payload)
      const mergedAnomalies = mergeAnomalyByVendorMap(
        state.anomalyByVendor,
        payload.anomaly_by_vendor,
        payload.highlight_vendor,
        payload.anomaly_status,
      )
      let next: BankingViewReducerState = {
        ...state,
        navigationAnnouncement: announcement,
        anomalyByVendor: mergedAnomalies,
      }

      if (payload.page === 'spending') {
        const nextView: SpendingView = payload.view ?? 'overview'
        const incomingIsOverview = nextView === 'overview'
        const prevWasOverview = state.view === 'overview'
        const nextHighlight = payload.highlight_vendor ?? ''
        const resolvedScalar =
          payload.anomaly_status ??
          (nextHighlight
            ? resolveAnomalyStatusForVendor(nextHighlight, mergedAnomalies, '', '')
            : nextView === 'overview'
              ? ''
              : state.anomalyStatus)
        next = {
          ...next,
          direction: incomingIsOverview && !prevWasOverview ? 'back' : 'forward',
          view: nextView,
          period: payload.period ?? state.period,
          category: payload.category,
          vendor: payload.vendor,
          highlightVendor: nextHighlight,
          anomalyStatus: resolvedScalar,
        }
      }

      if (payload.page === 'savings') {
        next = {
          ...next,
          extraMonthlyPence:
            typeof payload.extra_monthly_pence === 'number'
              ? Math.max(0, Math.trunc(payload.extra_monthly_pence))
              : state.extraMonthlyPence,
          customTargetPence:
            typeof payload.custom_target_pence === 'number'
              ? Math.max(0, Math.trunc(payload.custom_target_pence))
              : 0,
        }
      }

      if (payload.page === 'mortgage') {
        next = {
          ...next,
          mortgageSubview: payload.subview ?? state.mortgageSubview,
          monthlyOverpaymentPence:
            typeof payload.monthly_overpayment_pence === 'number'
              ? Math.max(0, Math.trunc(payload.monthly_overpayment_pence))
              : state.monthlyOverpaymentPence,
          lumpSumOverpaymentPence:
            typeof payload.lump_sum_overpayment_pence === 'number'
              ? Math.max(0, Math.trunc(payload.lump_sum_overpayment_pence))
              : state.lumpSumOverpaymentPence,
        }
      }

      return next
    }
    case 'RESET_UI_STATE':
      return {
        ...INITIAL_BANKING_VIEW_STATE,
        direction: 'back',
      }
  }
}

export interface BankingViewStateContextValue {
  view: SpendingView
  period: SpendingPeriod
  category?: string
  vendor?: string
  highlightVendor: string
  anomalyStatus: AnomalyStatus
  anomalyByVendor: Record<string, WireAnomalyStatus>
  getVendorAnomalyStatus: (vendor: string) => AnomalyStatus
  direction: 'forward' | 'back'
  extraMonthlyPence: number
  customTargetPence: number
  mortgageSubview: MortgageSubview
  monthlyOverpaymentPence: number
  lumpSumOverpaymentPence: number
  navigationAnnouncement: string
  setView: (next: SpendingViewState) => void
  setPeriod: (period: SpendingPeriod) => void
  setHighlightVendor: (vendor: string) => void
  setAnomalyStatus: (status: AnomalyStatus, vendor?: string) => void
  setExtraMonthlyPence: (pence: number) => void
  setCustomTargetPence: (pence: number) => void
  setMortgageSubview: (subview: MortgageSubview) => void
  setMonthlyOverpaymentPence: (pence: number) => void
  setLumpSumOverpaymentPence: (pence: number) => void
  applyServerUiState: (payload: UiViewStatePayload) => void
  resetUiState: () => void
}

const BankingViewStateContext = createContext<BankingViewStateContextValue | null>(null)

export function BankingViewStateProvider({ children }: { children: ReactNode }) {
  const pageCtx = usePageOptional()
  const navigateTo = pageCtx?.navigateTo
  const [state, dispatch] = useReducer(bankingViewReducer, INITIAL_BANKING_VIEW_STATE)

  const setView = useCallback((next: SpendingViewState) => {
    dispatch({ type: 'SET_VIEW', next })
  }, [])

  const setPeriod = useCallback((period: SpendingPeriod) => {
    dispatch({ type: 'SET_PERIOD', period })
  }, [])

  const setHighlightVendor = useCallback((vendor: string) => {
    dispatch({ type: 'SET_HIGHLIGHT_VENDOR', vendor })
  }, [])

  const setAnomalyStatus = useCallback((status: AnomalyStatus, vendor?: string) => {
    dispatch({ type: 'SET_ANOMALY_STATUS', status, vendor })
  }, [])

  const setExtraMonthlyPence = useCallback((pence: number) => {
    dispatch({ type: 'SET_EXTRA_MONTHLY_PENCE', pence })
  }, [])

  const setCustomTargetPence = useCallback((pence: number) => {
    dispatch({ type: 'SET_CUSTOM_TARGET_PENCE', pence })
  }, [])

  const setMortgageSubview = useCallback((subview: MortgageSubview) => {
    dispatch({ type: 'SET_MORTGAGE_SUBVIEW', subview })
  }, [])

  const setMonthlyOverpaymentPence = useCallback((pence: number) => {
    dispatch({ type: 'SET_MONTHLY_OVERPAYMENT_PENCE', pence })
  }, [])

  const setLumpSumOverpaymentPence = useCallback((pence: number) => {
    dispatch({ type: 'SET_LUMP_SUM_OVERPAYMENT_PENCE', pence })
  }, [])

  const getVendorAnomalyStatus = useCallback(
    (vendor: string): AnomalyStatus =>
      resolveAnomalyStatusForVendor(
        vendor,
        state.anomalyByVendor,
        state.highlightVendor,
        state.anomalyStatus,
      ),
    [state.anomalyByVendor, state.highlightVendor, state.anomalyStatus],
  )

  const applyServerUiState = useCallback(
    (payload: UiViewStatePayload) => {
      startTransition(() => {
        if (navigateTo && (ALL_PAGES as readonly string[]).includes(payload.page)) {
          navigateTo(payload.page as PageId)
        }
        dispatch({ type: 'APPLY_SERVER_UI_STATE', payload })
      })
    },
    [navigateTo],
  )

  const resetUiState = useCallback(() => {
    startTransition(() => {
      if (navigateTo) navigateTo('home')
      dispatch({ type: 'RESET_UI_STATE' })
    })
  }, [navigateTo])

  const value = useMemo<BankingViewStateContextValue>(
    () => ({
      view: state.view,
      period: state.period,
      category: state.category,
      vendor: state.vendor,
      highlightVendor: state.highlightVendor,
      anomalyStatus: state.anomalyStatus,
      anomalyByVendor: state.anomalyByVendor,
      getVendorAnomalyStatus,
      direction: state.direction,
      extraMonthlyPence: state.extraMonthlyPence,
      customTargetPence: state.customTargetPence,
      mortgageSubview: state.mortgageSubview,
      monthlyOverpaymentPence: state.monthlyOverpaymentPence,
      lumpSumOverpaymentPence: state.lumpSumOverpaymentPence,
      navigationAnnouncement: state.navigationAnnouncement,
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
      state,
      getVendorAnomalyStatus,
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
    ],
  )

  return <BankingViewStateContext value={value}>{children}</BankingViewStateContext>
}

export function useBankingViewState(): BankingViewStateContextValue {
  const ctx = use(BankingViewStateContext)
  if (!ctx) {
    throw new Error('useBankingViewState must be used within <BankingViewStateProvider>')
  }
  return ctx
}
