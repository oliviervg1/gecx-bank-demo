import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MortgagePage } from '../pages/mortgage/MortgagePage'
import { PersonaProvider } from '../personas/PersonaProvider'
import { PageProvider } from '../pages/PageProvider'
import { BankingViewStateProvider } from '../agent/BankingViewStateProvider'

function renderMortgage(persona: 'chloe' | 'sarah' | 'tom' = 'chloe') {
  return render(
    <PersonaProvider initialPersona={persona} initialDemoDate="2026-11-24">
      <PageProvider>
        <BankingViewStateProvider>
          <MortgagePage />
        </BankingViewStateProvider>
      </PageProvider>
    </PersonaProvider>,
  )
}

describe('MortgagePage', () => {
  it('renders homeowner overview with exact balance, rate, remaining term, progressbar, and 10% allowance', () => {
    renderMortgage('chloe')
    expect(screen.getByRole('heading', { level: 1, name: 'Your Mortgage' })).toBeInTheDocument()
    expect(screen.getByText('123 Forest Avenue, Manchester')).toBeInTheDocument()
    expect(screen.getByText('£214,500.00')).toBeInTheDocument()
    expect(screen.getByText('4.20% Fixed')).toBeInTheDocument()
    expect(screen.getByText('18 years and 4 months')).toBeInTheDocument()
    expect(screen.getByText('£21,450.00 left')).toBeInTheDocument()
    expect(
      screen.getByRole('progressbar', { name: '10% fee-free annual overpayment allowance used' }),
    ).toBeInTheDocument()
  })

  it('implements WAI-ARIA tablist keyboard navigation (ArrowRight, ArrowLeft, Home, End) and tabpanel pairing', () => {
    renderMortgage('chloe')
    const overviewTab = screen.getByRole('tab', { name: 'Overview' })
    const overpayTab = screen.getByRole('tab', { name: 'Overpay' })
    const ratesTab = screen.getByRole('tab', { name: 'Fixed Rates' })

    expect(overviewTab).toHaveAttribute('aria-selected', 'true')
    expect(overviewTab).toHaveAttribute('tabindex', '0')
    expect(overpayTab).toHaveAttribute('tabindex', '-1')
    expect(ratesTab).toHaveAttribute('tabindex', '-1')

    const panel = screen.getByRole('tabpanel')
    expect(panel.id).toBe(overviewTab.getAttribute('aria-controls'))
    expect(panel).toHaveAttribute('aria-labelledby', overviewTab.id)

    fireEvent.keyDown(overviewTab, { key: 'ArrowRight' })
    expect(overpayTab).toHaveAttribute('aria-selected', 'true')
    expect(overpayTab).toHaveFocus()

    fireEvent.keyDown(overpayTab, { key: 'End' })
    expect(ratesTab).toHaveAttribute('aria-selected', 'true')
    expect(ratesTab).toHaveFocus()

    fireEvent.keyDown(ratesTab, { key: 'Home' })
    expect(overviewTab).toHaveAttribute('aria-selected', 'true')
    expect(overviewTab).toHaveFocus()

    fireEvent.keyDown(overviewTab, { key: 'ArrowLeft' })
    expect(ratesTab).toHaveAttribute('aria-selected', 'true')
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

  it('renders exact integer-bisection fixed-rate renewal options and custom lump-sum input', () => {
    renderMortgage('chloe')
    fireEvent.click(screen.getByRole('tab', { name: 'Overpay' }))
    const lumpInput = screen.getByLabelText('Custom lump sum (£):')
    fireEvent.change(lumpInput, { target: { value: '5000' } })
    expect(screen.getAllByText('£5,000.00').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('tab', { name: 'Fixed Rates' }))
    expect(screen.getByText('£1,365.17/mo')).toBeInTheDocument()
    expect(screen.getByText('£1,348.63/mo')).toBeInTheDocument()
    expect(screen.getByText('−£34.54/mo less than today')).toBeInTheDocument()
    expect(screen.getByText(/exclude product arrangement fees/i)).toBeInTheDocument()
  })

  it('renders First-Home Borrowing Readiness (£189,000 max borrowing) for renter Tom', () => {
    renderMortgage('tom')
    expect(screen.getByTestId('renter-readiness-view')).toBeInTheDocument()
    expect(screen.getByText('£189,000.00')).toBeInTheDocument()
    expect(screen.getByText('£224,000.00')).toBeInTheDocument()
    expect(
      screen.getByRole('progressbar', { name: 'First Home Deposit deposit progress' }),
    ).toBeInTheDocument()
  })
})
