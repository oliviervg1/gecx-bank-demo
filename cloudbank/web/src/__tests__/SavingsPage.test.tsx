import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SavingsPage } from '../pages/savings/SavingsPage'
import { PersonaProvider } from '../personas/PersonaProvider'
import { SpendingViewProvider } from '../agent/SpendingViewProvider'

function renderSavings(persona: 'chloe' | 'tom' = 'chloe') {
  return render(
    <PersonaProvider initialPersona={persona} initialDemoDate="2026-11-24">
      <SpendingViewProvider>
        <SavingsPage />
      </SpendingViewProvider>
    </PersonaProvider>,
  )
}

describe('SavingsPage', () => {
  it('renders Chloe’s Home Emergency Pot balance, AER, and baseline October 2028 target', () => {
    renderSavings('chloe')
    expect(screen.getByText('Home Emergency Pot')).toBeInTheDocument()
    expect(screen.getByText('£4,850.00')).toBeInTheDocument()
    expect(screen.getByText('4.50% AER')).toBeInTheDocument()
    expect(screen.getByText(/October 2028 \(23 months\)/)).toBeInTheDocument()
  })

  it('updates projected completion to June 2028 (4 months sooner) when +£45/mo is selected', () => {
    renderSavings('chloe')
    fireEvent.click(screen.getByRole('button', { name: '+£45/mo' }))
    expect(screen.getByText(/June 2028 \(19 months\)/)).toBeInTheDocument()
    expect(screen.getByText(/4 months sooner/)).toBeInTheDocument()
  })

  it('supports custom goal target scenarios (£15,000.00)', () => {
    renderSavings('chloe')
    fireEvent.click(screen.getByRole('button', { name: '+£100/mo' }))
    fireEvent.click(screen.getByRole('button', { name: '£15,000.00' }))
    expect(screen.getByText(/June 2029 \(31 months\)/)).toBeInTheDocument()
    expect(screen.getByText(/13 months sooner/)).toBeInTheDocument()
  })
})
