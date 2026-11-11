import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Toast } from './Toast'

interface ToastState {
  message: string
  variant: 'info' | 'error'
  key: number
}

interface ToastContextValue {
  show: (message: string, variant?: 'info' | 'error') => void
  dismiss: () => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const AUTO_DISMISS_MS = 4000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null)
  const timerRef = useRef<number | null>(null)

  const dismiss = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setToast(null)
  }, [])

  const show = useCallback((message: string, variant: 'info' | 'error' = 'info') => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
    }
    setToast({ message, variant, key: Date.now() })
    timerRef.current = window.setTimeout(() => {
      setToast(null)
      timerRef.current = null
    }, AUTO_DISMISS_MS)
  }, [])

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    },
    [],
  )

  const value = useMemo<ToastContextValue>(() => ({ show, dismiss }), [show, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-6 inset-x-0 z-50 pointer-events-none flex justify-center px-4">
        <div
          role={toast?.variant === 'error' ? 'alert' : 'status'}
          aria-live={toast?.variant === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
        >
          {toast && (
            <Toast
              key={toast.key}
              message={toast.message}
              variant={toast.variant}
              onDismiss={dismiss}
            />
          )}
        </div>
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}
