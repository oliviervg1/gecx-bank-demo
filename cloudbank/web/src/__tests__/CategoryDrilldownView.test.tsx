import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CategoryDrilldownView } from '../pages/spending/CategoryDrilldownView'
import { PersonaProvider } from '../personas/PersonaProvider'
import { BankingViewStateProvider } from '../agent/BankingViewStateProvider'

function renderWith(category: string) {
  return render(
    <PersonaProvider initialDemoDate="2026-11-24">
      <BankingViewStateProvider>
        <CategoryDrilldownView category={category} />
      </BankingViewStateProvider>
    </PersonaProvider>,
  )
}

describe('CategoryDrilldownView', () => {
  it('shows breadcrumb, exact £18.70 November coffee shops total, semantic SVG chart, and back chevron', () => {
    renderWith('coffee_shops')
    expect(screen.getByText(/Spending › Coffee shops/)).toBeInTheDocument()
    expect(screen.getByText('£18.70')).toBeInTheDocument()
    const slot = document.querySelector('[data-chart-slot="category_vendors"]')
    expect(slot).not.toBeNull()
    expect(slot?.querySelector('svg[role="img"]')).not.toBeNull()
    expect(slot?.querySelectorAll('[data-bar-merchant]').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Back to Spending overview')).toBeInTheDocument()

    const rows = document.querySelectorAll('[data-component-id^="txn-"]')
    expect(rows.length).toBeGreaterThan(0)
    rows.forEach((r) => {
      expect(r.textContent).toMatch(/Pret a Manger|Costa Coffee/)
    })
  })
})
