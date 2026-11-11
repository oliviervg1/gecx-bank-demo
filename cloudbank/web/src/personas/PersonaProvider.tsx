import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { parsePersona, type Persona } from './personas'
import {
  DEFAULT_PINNED_DEMO_DATE,
  isValidIsoCalendarDate,
  readDemoDateFromSearch,
} from '../util/demoClock'

interface PersonaContextValue {
  persona: Persona
  setPersona: (next: Persona) => void
  demoDate: string
  setDemoDate: (isoDate: string) => void
}

const PersonaContext = createContext<PersonaContextValue | null>(null)

interface PersonaProviderProps {
  children: ReactNode
  initialPersona?: Persona
  initialDemoDate?: string
}

export function PersonaProvider({
  children,
  initialPersona,
  initialDemoDate,
}: PersonaProviderProps) {
  const [persona, setPersonaState] = useState<Persona>(() => {
    if (initialPersona) return initialPersona
    const search = typeof window === 'undefined' ? '' : window.location.search
    return parsePersona(new URLSearchParams(search).get('persona'))
  })

  const [demoDate, setDemoDateState] = useState<string>(() => {
    if (initialDemoDate && isValidIsoCalendarDate(initialDemoDate)) return initialDemoDate
    const search = typeof window === 'undefined' ? '' : window.location.search
    return readDemoDateFromSearch(search, DEFAULT_PINNED_DEMO_DATE)
  })

  const setPersona = useCallback((next: Persona) => {
    setPersonaState(next)
    if (typeof window !== 'undefined' && window.history?.replaceState) {
      const url = new URL(window.location.href)
      url.searchParams.set('persona', next)
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    }
  }, [])

  const setDemoDate = useCallback((isoDate: string) => {
    if (!isValidIsoCalendarDate(isoDate)) return
    setDemoDateState(isoDate)
    if (typeof window !== 'undefined' && window.history?.replaceState) {
      const url = new URL(window.location.href)
      url.searchParams.set('demo_date', isoDate)
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    }
  }, [])

  const value = useMemo<PersonaContextValue>(
    () => ({ persona, setPersona, demoDate, setDemoDate }),
    [persona, setPersona, demoDate, setDemoDate],
  )

  return <PersonaContext.Provider value={value}>{children}</PersonaContext.Provider>
}

export function usePersona(): PersonaContextValue {
  const ctx = useContext(PersonaContext)
  if (!ctx) throw new Error('usePersona must be used within <PersonaProvider>')
  return ctx
}
