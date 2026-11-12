import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SubscriptionsAuditView } from '../pages/spending/SubscriptionsAuditView'
import { PersonaProvider } from '../personas/PersonaProvider'
import { BankingViewStateProvider } from '../agent/BankingViewStateProvider'

function renderPage() {
  return render(
    <PersonaProvider initialDemoDate="2026-11-24">
      <BankingViewStateProvider>
        <SubscriptionsAuditView />
      </BankingViewStateProvider>
    </PersonaProvider>,
  )
}

describe('SubscriptionsAuditView', () => {
  it('shows Subscriptions breadcrumb, £1,731.90 recurring total, and highlights Netflix anomaly', () => {
    renderPage()
    expect(screen.getByText(/Spending › Subscriptions/)).toBeInTheDocument()
    expect(screen.getByText('£1,731.90')).toBeInTheDocument()
    const netflix = document.querySelector('[data-component-id="txn-netflix"]')
    expect(netflix?.getAttribute('data-highlighted')).toBe('true')
    expect(screen.getByLabelText('Back to Spending overview')).toBeInTheDocument()
  })
})
