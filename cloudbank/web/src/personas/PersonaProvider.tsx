import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { parsePersona, type Persona } from './personas'

interface PersonaContextValue {
  persona: Persona
}

const PersonaContext = createContext<PersonaContextValue | null>(null)

export function PersonaProvider({ children }: { children: ReactNode }) {
  // The persona is locked in at mount time and read from the URL. Switching it
  // in-session would need a state-teardown path through AgentProvider so the
  // new persona's greeting round-trips, so there is no setter here.
  const value = useMemo<PersonaContextValue>(() => {
    const search = typeof window === 'undefined' ? '' : window.location.search
    const raw = new URLSearchParams(search).get('persona')
    return { persona: parsePersona(raw) }
  }, [])

  return <PersonaContext.Provider value={value}>{children}</PersonaContext.Provider>
}

export function usePersona(): PersonaContextValue {
  const ctx = useContext(PersonaContext)
  if (!ctx) throw new Error('usePersona must be used within <PersonaProvider>')
  return ctx
}
