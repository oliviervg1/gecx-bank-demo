import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MortgagePage } from '../pages/mortgage/MortgagePage'
import { ToastProvider } from '../components/ToastProvider'
import { PersonaProvider } from '../personas/PersonaProvider'

function renderMortgage() {
  return render(<PersonaProvider><ToastProvider><MortgagePage /></ToastProvider></PersonaProvider>)
}

describe('MortgagePage', () => {
  it('renders the page title and address sub-line', () => {
    renderMortgage()
    expect(screen.getByText('Your Mortgage')).toBeInTheDocument()
    expect(screen.getByText('123 Forest Avenue')).toBeInTheDocument()
  })

  it('renders the Remaining Balance hero with interest rate + term', () => {
    renderMortgage()
    expect(screen.getByText('Remaining Balance')).toBeInTheDocument()
    expect(screen.getByText('Interest Rate')).toBeInTheDocument()
    expect(screen.getByText('Term')).toBeInTheDocument()
    expect(screen.getByText(/Fixed/)).toBeInTheDocument()
  })

  it('renders Next Payment card with an Overpay action', () => {
    renderMortgage()
    expect(screen.getByText('NEXT PAYMENT')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /overpay/i })).toBeInTheDocument()
  })

  it('renders all four Manage list rows', () => {
    renderMortgage()
    expect(screen.getByText('Change Rate')).toBeInTheDocument()
    expect(screen.getByText('Documents')).toBeInTheDocument()
    expect(screen.getByText('Statements')).toBeInTheDocument()
    expect(screen.getByText('Insurance')).toBeInTheDocument()
  })

  it('Overpay tap fires a "Coming soon" toast', () => {
    renderMortgage()
    fireEvent.click(screen.getByRole('button', { name: /overpay/i }))
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument()
  })
})
