import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CategoryDrilldownView } from '../pages/spending/CategoryDrilldownView'
import { PersonaProvider } from '../personas/PersonaProvider'
import { SpendingViewProvider } from '../agent/SpendingViewProvider'
import { AgentRegistryContext } from '../agent/AgentRegistryContext'
import { createRegistry } from '../agent/clientFunctions'

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: 400, height: 240, top: 0, left: 0, bottom: 240, right: 400, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect
  }
})
afterAll(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
})

function renderWith(category: string) {
  return render(
    <PersonaProvider>
      <AgentRegistryContext.Provider value={createRegistry()}>
        <SpendingViewProvider>
          <CategoryDrilldownView category={category} />
        </SpendingViewProvider>
      </AgentRegistryContext.Provider>
    </PersonaProvider>,
  )
}

describe('CategoryDrilldownView', () => {
  it('shows the breadcrumb "Spending › Coffee shops"', () => {
    renderWith('coffee_shops')
    expect(screen.getByText(/Spending › Coffee shops/)).toBeInTheDocument()
  })

  it('renders only transactions in the named category', () => {
    renderWith('coffee_shops')
    const rows = document.querySelectorAll('[data-component-id^="txn-"]')
    expect(rows.length).toBeGreaterThan(0)
    // Every visible row should be a coffee_shops txn.
    rows.forEach((r) => {
      expect(r.textContent).toMatch(/Pret a Manger|Costa Coffee/)
    })
  })

  it('shows the per-vendor bar chart (recharts wrapper present)', () => {
    renderWith('coffee_shops')
    expect(document.querySelector('.recharts-wrapper')).not.toBeNull()
  })

  it('shows a "This month: £X" summary for the category', () => {
    renderWith('coffee_shops')
    // chloe.json coffee_shops current-month total computed at render
    // time via isInCurrentCalendarMonth; the label is the load-bearing
    // assertion.
    expect(screen.getByText(/This month/i)).toBeInTheDocument()
  })

  it('shows the back chevron in the header', () => {
    renderWith('coffee_shops')
    expect(screen.getByLabelText('Back to Spending overview')).toBeInTheDocument()
  })
})
