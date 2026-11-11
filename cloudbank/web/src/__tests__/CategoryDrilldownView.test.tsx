import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CategoryDrilldownView } from '../pages/spending/CategoryDrilldownView'
import { PersonaProvider } from '../personas/PersonaProvider'
import { SpendingViewProvider } from '../agent/SpendingViewProvider'

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: 400,
      height: 240,
      top: 0,
      left: 0,
      bottom: 240,
      right: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
  }
})
afterAll(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
})

function renderWith(category: string) {
  return render(
    <PersonaProvider initialDemoDate="2026-11-24">
      <SpendingViewProvider>
        <CategoryDrilldownView category={category} />
      </SpendingViewProvider>
    </PersonaProvider>,
  )
}

describe('CategoryDrilldownView', () => {
  it('shows breadcrumb, exact £18.70 November coffee shops total, chart, and back chevron', () => {
    renderWith('coffee_shops')
    expect(screen.getByText(/Spending › Coffee shops/)).toBeInTheDocument()
    expect(screen.getByText('£18.70')).toBeInTheDocument()
    expect(document.querySelector('.recharts-wrapper')).not.toBeNull()
    expect(screen.getByLabelText('Back to Spending overview')).toBeInTheDocument()

    const rows = document.querySelectorAll('[data-component-id^="txn-"]')
    expect(rows.length).toBeGreaterThan(0)
    rows.forEach((r) => {
      expect(r.textContent).toMatch(/Pret a Manger|Costa Coffee/)
    })
  })
})
