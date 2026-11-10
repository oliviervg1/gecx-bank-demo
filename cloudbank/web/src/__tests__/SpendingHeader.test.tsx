import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { SpendingHeader } from '../pages/spending/SpendingHeader'
import {
  SpendingViewProvider,
  useSpendingView,
  type SpendingViewState,
} from '../agent/SpendingViewProvider'
import { PersonaProvider } from '../personas/PersonaProvider'

function Harness({
  breadcrumb,
  startView,
}: {
  breadcrumb?: string
  startView?: SpendingViewState
}) {
  const { view, setView } = useSpendingView()
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

function renderWith(breadcrumb?: string, startView?: SpendingViewState) {
  return render(
    <PersonaProvider initialDemoDate="2026-11-24">
      <SpendingViewProvider>
        <Harness breadcrumb={breadcrumb} startView={startView} />
      </SpendingViewProvider>
    </PersonaProvider>,
  )
}

describe('SpendingHeader', () => {
  it('shows "Spending" without a back chevron when no breadcrumb is given', () => {
    renderWith()
    expect(screen.getByText('Spending')).toBeInTheDocument()
    expect(screen.queryByLabelText('Back to Spending overview')).toBeNull()
  })

  it('shows breadcrumb and back chevron when breadcrumb is provided', () => {
    renderWith('Coffee shops', { view: 'category', category: 'coffee_shops' })
    expect(screen.getByText(/Spending › Coffee shops/)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Back to Spending overview'))
    expect(screen.getByTestId('current-view').textContent).toBe('overview')
  })
})
