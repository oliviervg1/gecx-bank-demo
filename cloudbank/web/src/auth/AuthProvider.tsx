import {
  createContext,
  use,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useAgent } from '../agent/AgentProvider'
import { useBankingViewState } from '../agent/BankingViewStateProvider'
import { usePersona } from '../personas/PersonaProvider'
import type { Persona } from '../personas/personas'

export interface AuthSessionContextValue {
  signedOut: boolean
  signOut: () => void
  signBackIn: () => void
}

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null)

export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const { persona } = usePersona()
  const { disconnect, reconnect } = useAgent()
  const { resetUiState } = useBankingViewState()
  // Scoped by persona so switching customer personas automatically signs into the newly selected profile.
  const [signedOutPersona, setSignedOutPersona] = useState<Persona | null>(null)
  const signedOut = signedOutPersona === persona

  const signOut = useCallback(() => {
    disconnect({ clearTurns: true })
    resetUiState()
    setSignedOutPersona(persona)
  }, [disconnect, resetUiState, persona])

  const signBackIn = useCallback(() => {
    setSignedOutPersona(null)
    reconnect()
  }, [reconnect])

  const value = useMemo<AuthSessionContextValue>(
    () => ({ signedOut, signOut, signBackIn }),
    [signedOut, signOut, signBackIn],
  )

  return <AuthSessionContext value={value}>{children}</AuthSessionContext>
}

export function useAuthSessionOptional(): AuthSessionContextValue | null {
  return use(AuthSessionContext)
}
