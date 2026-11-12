import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { SpendingHeader } from '../pages/spending/SpendingHeader'
import {
  BankingViewStateProvider,
  useBankingViewState,
  type SpendingViewState,
} from '../agent/BankingViewStateProvider'
import { PersonaProvider } from '../personas/PersonaProvider'

function Harness({
  breadcrumb,
  startView,
}: {
  breadcrumb?: string
  startView?: SpendingViewState
}) {
  const { view, period, setView } = useBankingViewState()
  useEffect(() => {
    if (startView) setView(startView)
  }, [setView, startView])
  return (
    <>
      <SpendingHeader breadcrumb={breadcrumb} />
      <div data-testid="current-view">{view}</div>
      <div data-testid="current-period">{period}</div>
    </>
  )
}

function renderWith(breadcrumb?: string, startView?: SpendingViewState) {
  return render(
    <PersonaProvider initialDemoDate="2026-11-24">
      <BankingViewStateProvider>
        <Harness breadcrumb={breadcrumb} startView={startView} />
      </BankingViewStateProvider>
    </PersonaProvider>,
  )
}

describe('SpendingHeader', () => {
  it('shows "Spending" heading without a back chevron when no breadcrumb is given and supports arrow-key view tabs and month toggles', () => {
    renderWith()
    expect(screen.getByRole('heading', { level: 1, name: 'Spending' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Back to Spending overview')).toBeNull()

    const overviewTab = screen.getByRole('tab', { name: 'Overview' })
    const subscriptionsTab = screen.getByRole('tab', { name: 'Subscriptions' })
    expect(overviewTab).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(overviewTab, { key: 'ArrowRight' })
    expect(subscriptionsTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('current-view').textContent).toBe('subscriptions')

    const octBtn = screen.getByRole('button', { name: 'Oct' })
    fireEvent.click(octBtn)
    expect(octBtn).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('current-period').textContent).toBe('last_month')
  })

  it('shows breadcrumb and back chevron when breadcrumb is provided', () => {
    renderWith('Coffee shops', { view: 'category', category: 'coffee_shops' })
    expect(screen.getByText(/Spending › Coffee shops/)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Back to Spending overview'))
    expect(screen.getByTestId('current-view').textContent).toBe('overview')
  })
})
