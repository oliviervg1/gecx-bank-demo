import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SpendingHeader } from '../pages/spending/SpendingHeader'
import { SpendingViewProvider, useSpendingView } from '../agent/SpendingViewProvider'
import { AgentRegistryContext } from '../agent/AgentRegistryContext'
import { createRegistry } from '../agent/clientFunctions'
import { useEffect } from 'react'

function Harness({
  breadcrumb,
  startView,
}: {
  breadcrumb?: string
  startView?: { view: 'subscriptions_audit' | 'category_drilldown'; category?: string }
}) {
  const { view, setView } = useSpendingView()
  // Seed the state once at mount so the back-chevron has something to revert from.
  useEffect(() => {
    if (startView) setView(startView)
  }, [setView, startView])
  return (
    <>
      <SpendingHeader breadcrumb={breadcrumb} />
      <div data-testid="current-view">{view}</div>
    </>
  )
}

function renderWith(breadcrumb?: string, startView?: { view: 'subscriptions_audit'; category?: string }) {
  return render(
    <AgentRegistryContext.Provider value={createRegistry()}>
      <SpendingViewProvider>
        <Harness breadcrumb={breadcrumb} startView={startView} />
      </SpendingViewProvider>
    </AgentRegistryContext.Provider>,
  )
}

describe('SpendingHeader', () => {
  it('shows "Spending" without a back chevron when no breadcrumb is given', () => {
    renderWith()
    expect(screen.getByText('Spending')).toBeInTheDocument()
    expect(screen.queryByLabelText('Back to Spending overview')).toBeNull()
  })

  it('shows "Spending › <breadcrumb>" and a back chevron when breadcrumb is given', () => {
    renderWith('Coffee shops')
    expect(screen.getByText(/Spending › Coffee shops/)).toBeInTheDocument()
    expect(screen.getByLabelText('Back to Spending overview')).toBeInTheDocument()
  })

  it('clicking the back chevron returns view to overview', async () => {
    renderWith('Subscriptions', { view: 'subscriptions_audit' })
    expect(screen.getByTestId('current-view').textContent).toBe('subscriptions_audit')
    fireEvent.click(screen.getByLabelText('Back to Spending overview'))
    expect(screen.getByTestId('current-view').textContent).toBe('overview')
  })
})
