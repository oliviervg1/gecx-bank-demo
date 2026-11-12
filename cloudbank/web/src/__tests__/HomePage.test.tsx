import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HomePage } from '../pages/home/HomePage'
import { PersonaProvider } from '../personas/PersonaProvider'
import { PageProvider } from '../pages/PageProvider'

function renderHome(persona: 'chloe' | 'tom' = 'chloe') {
  return render(
    <PersonaProvider initialPersona={persona} initialDemoDate="2026-11-24">
      <PageProvider>
        <HomePage />
      </PageProvider>
    </PersonaProvider>,
  )
}

describe('HomePage', () => {
  it('renders Chloe’s Current, Savings, and Mortgage rows with exact figures', () => {
    renderHome('chloe')
    expect(screen.getByText('Accounts Overview')).toBeInTheDocument()
    expect(screen.getByText('£4,250.75')).toBeInTheDocument()
    expect(screen.getByText('£4,850.00')).toBeInTheDocument()
    expect(screen.getByText('£214,500.00')).toBeInTheDocument()
    expect(screen.getByText('Concierge Summary')).toBeInTheDocument()
  })

  it('renders First-Home Readiness instead of a mortgage balance for renter Tom', () => {
    renderHome('tom')
    expect(screen.getByText('First-Home Readiness')).toBeInTheDocument()
    expect(screen.getByText('£189,000.00')).toBeInTheDocument()
  })
})
