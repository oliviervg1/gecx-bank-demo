import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MonthlyTrendView } from '../pages/spending/MonthlyTrendView'
import { PersonaProvider } from '../personas/PersonaProvider'
import { BankingViewStateProvider } from '../agent/BankingViewStateProvider'

function renderWith({ category, vendor }: { category?: string; vendor?: string } = {}) {
  return render(
    <PersonaProvider initialDemoDate="2026-11-24">
      <BankingViewStateProvider>
        <MonthlyTrendView category={category} vendor={vendor} />
      </BankingViewStateProvider>
    </PersonaProvider>,
  )
}

describe('MonthlyTrendView', () => {
  it('renders overall 3-month semantic SVG chart and exact November/October/September ledger', () => {
    renderWith()
    const slot = document.querySelector('[data-chart-slot="monthly_trend"]')
    expect(slot).not.toBeNull()
    expect(slot?.querySelector('svg[role="img"]')).not.toBeNull()
    expect(screen.getByText('November')).toBeInTheDocument()
    expect(screen.getAllByText('£2,018.64').length).toBeGreaterThan(0)
    expect(screen.getAllByText('£1,941.49').length).toBeGreaterThan(0)
    expect(screen.getAllByText('£1,903.34').length).toBeGreaterThan(0)
  })

  it('renders category and vendor scoped breadcrumbs', () => {
    const { unmount } = renderWith({ category: 'coffee_shops' })
    expect(screen.getByText(/Spending › Trend › Coffee shops/)).toBeInTheDocument()
    unmount()

    renderWith({ vendor: 'Tesco' })
    expect(screen.getByText(/Spending › Trend › Tesco/)).toBeInTheDocument()
    expect(screen.getByText('£179.65')).toBeInTheDocument()
    expect(screen.getAllByText('£80.75').length).toBeGreaterThan(0)
    expect(screen.getAllByText('£52.50').length).toBeGreaterThan(0)
    expect(screen.getAllByText('£46.40').length).toBeGreaterThan(0)
  })
})
