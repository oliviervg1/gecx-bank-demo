import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ProfilePage } from '../pages/ProfilePage'
import { MortgagePage } from '../pages/mortgage/MortgagePage'
import { PersonaProvider } from '../personas/PersonaProvider'
import { ToastProvider } from '../components/ToastProvider'
import { AgentContext, type AgentContextValue } from '../agent/AgentProvider'
import { PageProvider } from '../pages/PageProvider'
import { SpendingViewProvider } from '../agent/SpendingViewProvider'
import { HomePage } from '../pages/home/HomePage'
import { allFixtures, getFixture, type Fixture } from '../data/fixture'
import { buildSessionVariables } from '../agent/sessionVariables'
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
  diagnostics: [],
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
        <AgentContext.Provider value={stubAgent}>
          <ToastProvider>
            <ProfilePage />
          </ToastProvider>
        </AgentContext.Provider>
      </PersonaProvider>,
    )
    expect(screen.getByText(`${f.user.first_name} ${f.user.last_name}`)).toBeInTheDocument()
  })

  it('HomePage shows this persona’s exact November total', () => {
    setPersonaUrl(persona)
    render(
      <PersonaProvider initialDemoDate="2026-11-24">
        <PageProvider>
          <HomePage />
        </PageProvider>
      </PersonaProvider>,
    )
    const expected = formatGBPFromPence(
      computeSpendingSummary(f.transactions, '2026-11-24').this_month_total_pence,
    )
    expect(screen.getAllByText(expected).length).toBeGreaterThan(0)
  })

  it('start frame variables carry this persona’s verbatim fixture', () => {
    const vars = buildSessionVariables(persona, getFixture(persona), {
      demoDate: '2026-11-24',
      timeOfDay: 'morning',
    })
    expect(vars.persona_id).toBe(persona)
    expect(vars.first_name).toBe(f.user.first_name)
    expect(vars.customer_snapshot).toBe(f)
  })

  it('renders MortgagePage appropriately for homeowners vs renter', () => {
    setPersonaUrl(persona)
    render(
      <PersonaProvider initialDemoDate="2026-11-24">
        <PageProvider>
          <SpendingViewProvider>
            <MortgagePage />
          </SpendingViewProvider>
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
        <AgentContext.Provider value={stubAgent}>
          <ToastProvider>
            <ProfilePage />
          </ToastProvider>
        </AgentContext.Provider>
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
