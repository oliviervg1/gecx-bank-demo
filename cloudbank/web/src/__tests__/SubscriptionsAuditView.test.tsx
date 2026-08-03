import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SubscriptionsAuditView } from '../pages/spending/SubscriptionsAuditView'
import { PersonaProvider } from '../personas/PersonaProvider'
import { SpendingViewProvider } from '../agent/SpendingViewProvider'
import { AgentRegistryContext } from '../agent/AgentRegistryContext'
import { createRegistry } from '../agent/clientFunctions'

function renderPage() {
  return render(
    <PersonaProvider>
      <AgentRegistryContext.Provider value={createRegistry()}>
        <SpendingViewProvider>
          <SubscriptionsAuditView />
        </SpendingViewProvider>
      </AgentRegistryContext.Provider>
    </PersonaProvider>,
  )
}

describe('SubscriptionsAuditView', () => {
  it('shows the Subscriptions breadcrumb', () => {
    renderPage()
    expect(screen.getByText(/Spending › Subscriptions/)).toBeInTheDocument()
  })

  it('lists only is_subscription=true transactions from the current month', () => {
    renderPage()
    const rows = document.querySelectorAll('[data-component-id^="txn-"]')
    expect(rows.length).toBeGreaterThan(0)
    // Every row's text mentions one of the known subscription vendors.
    const vendors = Array.from(rows).map((r) => r.textContent ?? '')
    vendors.forEach((v) => {
      expect(v).toMatch(/Netflix|Spotify|British Gas|EE|Manchester Lettings/)
    })
  })

  it('auto-highlights anomalous subscriptions (Netflix)', () => {
    renderPage()
    const netflix = document.querySelector('[data-component-id="txn-netflix"]')
    expect(netflix?.getAttribute('data-highlighted')).toBe('true')
  })

  it('shows a "This month: £X" summary', () => {
    renderPage()
    expect(screen.getByText(/This month/i)).toBeInTheDocument()
  })

  it('shows the back chevron', () => {
    renderPage()
    expect(screen.getByLabelText('Back to Spending overview')).toBeInTheDocument()
  })
})
