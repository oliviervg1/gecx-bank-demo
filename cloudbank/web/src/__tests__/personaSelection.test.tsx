import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ProfilePage } from '../pages/ProfilePage'
import { MortgagePage } from '../pages/mortgage/MortgagePage'
import { PersonaProvider } from '../personas/PersonaProvider'
import { ToastProvider } from '../components/ToastProvider'
import { AgentContext, type AgentContextValue } from '../agent/AgentProvider'
import { PageProvider } from '../pages/PageProvider'
import { BankingViewStateProvider } from '../agent/BankingViewStateProvider'
import { AuthSessionProvider } from '../auth/AuthProvider'
import { HomePage } from '../pages/home/HomePage'
import { allFixtures, type Fixture } from '../data/fixture'
import { buildClientStart } from '../agent/sessionVariables'
import { computeSpendingSummary } from '../util/spendingSummary'
import { formatGBPFromPence } from '../util/currency'
import type { Persona } from '../personas/personas'

function setPersonaUrl(persona: string | null) {
  window.history.replaceState({}, '', persona ? `/?persona=${persona}` : '/')
}

const stubAgent: AgentContextValue = {
  phase: 'ready',
  connState: 'ready',
  micState: 'idle',
  sessionId: 'sess-1',
  turns: [],
  activeAgentName: 'root_agent',
  latestUiState: null,
  latestUiTier: null,
  transcript: null,
  agentText: null,
  errorMessage: null,
  micDenied: false,
  pushToTalk: true,
  beginTalking: async () => {},
  endTalking: () => {},
  startMic: async () => {},
  stopMic: () => {},
  submitText: () => {},
  reconnect: () => {},
  disconnect: () => {},
}

beforeEach(() => setPersonaUrl(null))
afterEach(() => {
  cleanup()
  setPersonaUrl(null)
})

describe.each(allFixtures())('persona selection: %s', (persona: Persona, f: Fixture) => {
  it('ProfilePage shows this persona’s identity', () => {
    setPersonaUrl(persona)
    render(
      <PersonaProvider>
        <BankingViewStateProvider>
          <AgentContext.Provider value={stubAgent}>
            <AuthSessionProvider>
              <ToastProvider>
                <ProfilePage />
              </ToastProvider>
            </AuthSessionProvider>
          </AgentContext.Provider>
        </BankingViewStateProvider>
      </PersonaProvider>,
    )
    expect(screen.getByText(`${f.user.first_name} ${f.user.last_name}`)).toBeInTheDocument()
  })

  it('HomePage shows this persona’s exact November total', () => {
    setPersonaUrl(persona)
    render(
      <PersonaProvider initialDemoDate="2026-11-24">
        <PageProvider>
          <BankingViewStateProvider>
            <HomePage />
          </BankingViewStateProvider>
        </PageProvider>
      </PersonaProvider>,
    )
    const expected = formatGBPFromPence(
      computeSpendingSummary(f.transactions, '2026-11-24').this_month_total_pence,
    )
    expect(screen.getAllByText(expected).length).toBeGreaterThan(0)
  })

  it('start frame carries lean persona and clock metadata without raw customer_snapshot', () => {
    const start = buildClientStart(persona, {
      demoDate: '2026-11-24',
      timeOfDay: 'morning',
    })
    expect(start).toEqual({
      type: 'start',
      persona,
      demoDate: '2026-11-24',
      timeOfDay: 'morning',
    })
    expect('variables' in start).toBe(false)
  })

  it('renders MortgagePage appropriately for homeowners vs renter', () => {
    setPersonaUrl(persona)
    render(
      <PersonaProvider initialDemoDate="2026-11-24">
        <PageProvider>
          <BankingViewStateProvider>
            <MortgagePage />
          </BankingViewStateProvider>
        </PageProvider>
      </PersonaProvider>,
    )
    if (f.accounts.mortgage) {
      expect(screen.getByText(f.accounts.mortgage.address)).toBeInTheDocument()
      expect(screen.getByText('Remaining Balance')).toBeInTheDocument()
    } else {
      expect(screen.getByTestId('renter-readiness-view')).toBeInTheDocument()
      expect(screen.queryByText('Remaining Balance')).not.toBeInTheDocument()
    }
  })
})

describe('persona selection: distinctness & fallbacks', () => {
  it('falls back to chloe for an unknown persona query param', () => {
    setPersonaUrl('mallory')
    render(
      <PersonaProvider>
        <BankingViewStateProvider>
          <AgentContext.Provider value={stubAgent}>
            <AuthSessionProvider>
              <ToastProvider>
                <ProfilePage />
              </ToastProvider>
            </AuthSessionProvider>
          </AgentContext.Provider>
        </BankingViewStateProvider>
      </PersonaProvider>,
    )
    expect(screen.getByText('Chloe Williams')).toBeInTheDocument()
  })

  it('gives each persona a distinct November spending total', () => {
    const totals = allFixtures().map(
      ([, f]) => computeSpendingSummary(f.transactions, '2026-11-24').this_month_total_pence,
    )
    expect(new Set(totals).size).toBe(totals.length)
  })
})
