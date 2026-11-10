import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MortgagePage } from '../pages/mortgage/MortgagePage'
import { PersonaProvider } from '../personas/PersonaProvider'
import { PageProvider } from '../pages/PageProvider'
import { SpendingViewProvider } from '../agent/SpendingViewProvider'

function renderMortgage(persona: 'chloe' | 'sarah' | 'tom' = 'chloe') {
  return render(
    <PersonaProvider initialPersona={persona} initialDemoDate="2026-11-24">
      <PageProvider>
        <SpendingViewProvider>
          <MortgagePage />
        </SpendingViewProvider>
      </PageProvider>
    </PersonaProvider>,
  )
}

describe('MortgagePage', () => {
  it('renders homeowner overview with exact balance, rate, remaining term, and 10% allowance', () => {
    renderMortgage('chloe')
    expect(screen.getByText('Your Mortgage')).toBeInTheDocument()
    expect(screen.getByText('123 Forest Avenue, Manchester')).toBeInTheDocument()
    expect(screen.getByText('£214,500.00')).toBeInTheDocument()
    expect(screen.getByText('4.20% Fixed')).toBeInTheDocument()
    expect(screen.getByText('18 years and 4 months')).toBeInTheDocument()
    expect(screen.getByText('£21,450.00 left')).toBeInTheDocument()
  })

  it('calculates exact overpayment interest saved (£17,849.18) and ERC cap status', () => {
    const { unmount } = renderMortgage('chloe')
    fireEvent.click(screen.getByRole('tab', { name: 'Overpay' }))
    fireEvent.click(screen.getByRole('button', { name: '+£200/mo' }))
    expect(screen.getByText('£17,849.18')).toBeInTheDocument()
    expect(screen.getByText('3 years and 2 months')).toBeInTheDocument()
    expect(screen.getByText(/indicative illustration only/i)).toBeInTheDocument()
    unmount()

    // Sarah £400/mo exceeds remaining £3,650.00 ERC-free cap by £1,150.00.
    renderMortgage('sarah')
    fireEvent.click(screen.getByRole('tab', { name: 'Overpay' }))
    fireEvent.click(screen.getByRole('button', { name: '+£400/mo' }))
    expect(screen.getByTestId('overpay-allowance-status')).toHaveTextContent('£1,150.00')
  })

  it('renders exact integer-bisection fixed-rate renewal options', () => {
    renderMortgage('chloe')
    fireEvent.click(screen.getByRole('tab', { name: 'Fixed Rates' }))
    expect(screen.getByText('£1,365.17/mo')).toBeInTheDocument()
    expect(screen.getByText('£1,348.63/mo')).toBeInTheDocument()
    expect(screen.getByText('-£34.54/mo vs current')).toBeInTheDocument()
  })

  it('renders First-Home Borrowing Readiness (£189,000 max borrowing) for renter Tom', () => {
    renderMortgage('tom')
    expect(screen.getByTestId('renter-readiness-view')).toBeInTheDocument()
    expect(screen.getByText('£189,000.00')).toBeInTheDocument()
    expect(screen.getByText('£224,000.00')).toBeInTheDocument()
  })
})
