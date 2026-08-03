// End-to-end persona selection.
//
// The parity suite proves each fixture is internally consistent (handler
// output == screen output). This proves the other half: that `?persona=david`
// actually reaches every consumer. Before multi-persona landed, eight files
// imported chloe.json directly, so the persona was honoured by the greeting
// and ignored by everything else — David's name over Chloe's money.
//
// Each assertion below targets one of those former bypass paths.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import App from '../App'
import { ProfilePage } from '../pages/ProfilePage'
import { MortgagePage } from '../pages/mortgage/MortgagePage'
import { PersonaProvider } from '../personas/PersonaProvider'
import { ToastProvider } from '../components/ToastProvider'
import { AgentContext } from '../agent/AgentProvider'
import { PageProvider } from '../pages/PageProvider'
import { HomePage } from '../pages/home/HomePage'
import { allFixtures, getFixture, type Fixture } from '../data/fixture'
import { buildSessionVariables } from '../agent/sessionVariables'
import { computeSpendingSummary } from '../util/spendingSummary'
import { formatGBP } from '../util/currency'
import type { Registry } from '../agent/clientFunctions'
import type { Persona } from '../personas/personas'

function setPersonaUrl(persona: string | null) {
  window.history.replaceState({}, '', persona ? `/?persona=${persona}` : '/')
}

const stubAgent = {
  connState: 'ready' as const,
  micState: 'idle' as const,
  transcript: null,
  agentText: null,
  errorMessage: null,
  registry: {
    register: () => {}, unregister: () => {},
    dispatch: async () => ({ id: '', response: {} }),
  } as unknown as Registry,
  startMic: async () => {}, stopMic: () => {},
  reconnect: () => {}, disconnect: () => {},
}

beforeEach(() => setPersonaUrl(null))
afterEach(() => { cleanup(); setPersonaUrl(null) })

describe.each(allFixtures())('persona selection: %s', (persona: Persona, f: Fixture) => {
  it('ProfilePage shows this persona’s identity, not Chloe’s', () => {
    setPersonaUrl(persona)
    render(
      <PersonaProvider>
        <AgentContext.Provider value={stubAgent as never}>
          <ToastProvider><ProfilePage /></ToastProvider>
        </AgentContext.Provider>
      </PersonaProvider>,
    )
    expect(
      screen.getByText(`${f.user.first_name} ${f.user.last_name}`),
    ).toBeInTheDocument()
  })

  it('HomePage shows this persona’s month-to-date total', () => {
    setPersonaUrl(persona)
    render(
      <PersonaProvider><PageProvider><HomePage /></PageProvider></PersonaProvider>,
    )
    const expected = formatGBP(computeSpendingSummary(f.transactions).this_month_total)
    // The card renders "£" and the number as separate text nodes, so match on
    // the element's combined textContent rather than an exact node value.
    const matches = screen.getAllByText(
      (_content, el) => el?.textContent?.replace(/\s/g, '') === `£${expected}`,
    )
    expect(matches.length).toBeGreaterThan(0)
  })

  it('the agent start frame carries this persona’s first name', () => {
    expect(buildSessionVariables(getFixture(persona))).toEqual({
      first_name: f.user.first_name,
    })
  })

  it('the get_* handlers return this persona’s numbers', () => {
    setPersonaUrl(persona)
    render(<App />)
    // App's SpendingDataBinder exposes the live registry in DEV so the wiring
    // can be inspected without a WebSocket.
    const registry = (window as unknown as { __agentRegistry?: Registry }).__agentRegistry
    expect(registry, 'registry should be exposed in DEV').toBeTruthy()
    return registry!
      .dispatch({ id: 't1', name: 'get_overview', args: {} })
      .then((envelope) => {
        const out = (envelope.response as { output?: { total?: number } }).output
        expect(out).toBeTruthy()
        expect(out!.total).toBeCloseTo(
          computeSpendingSummary(f.transactions).this_month_total,
          2,
        )
      })
  })

  it('renders the mortgage page appropriately for whether this persona owns a home', () => {
    setPersonaUrl(persona)
    render(
      <PersonaProvider><ToastProvider><MortgagePage /></ToastProvider></PersonaProvider>,
    )
    if (f.accounts.mortgage) {
      expect(screen.getByText(f.accounts.mortgage.address)).toBeInTheDocument()
      expect(screen.getByText('Remaining Balance')).toBeInTheDocument()
    } else {
      // Tom rents. A page of zeroes would read as a data-loading bug.
      expect(screen.getByText(/don't have a mortgage/i)).toBeInTheDocument()
      expect(screen.queryByText('Remaining Balance')).not.toBeInTheDocument()
    }
  })
})

describe('persona selection: fallbacks', () => {
  it('defaults to chloe with no query param', () => {
    render(
      <PersonaProvider>
        <AgentContext.Provider value={stubAgent as never}>
          <ToastProvider><ProfilePage /></ToastProvider>
        </AgentContext.Provider>
      </PersonaProvider>,
    )
    expect(screen.getByText('Chloe Williams')).toBeInTheDocument()
  })

  it('falls back to chloe for an unknown persona rather than rendering empty', () => {
    setPersonaUrl('mallory')
    render(
      <PersonaProvider>
        <AgentContext.Provider value={stubAgent as never}>
          <ToastProvider><ProfilePage /></ToastProvider>
        </AgentContext.Provider>
      </PersonaProvider>,
    )
    expect(screen.getByText('Chloe Williams')).toBeInTheDocument()
  })

  it('gives each persona a distinct month-to-date total, so a mix-up is visible', () => {
    const totals = allFixtures().map(
      ([, f]) => computeSpendingSummary(f.transactions).this_month_total,
    )
    expect(new Set(totals).size).toBe(totals.length)
  })
})
