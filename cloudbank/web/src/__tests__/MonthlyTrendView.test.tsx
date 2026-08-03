import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MonthlyTrendView } from '../pages/spending/MonthlyTrendView'
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

function renderWith({ category, vendor }: { category?: string; vendor?: string } = {}) {
  return render(
    <PersonaProvider>
      <AgentRegistryContext.Provider value={createRegistry()}>
        <SpendingViewProvider>
          <MonthlyTrendView category={category} vendor={vendor} />
        </SpendingViewProvider>
      </AgentRegistryContext.Provider>
    </PersonaProvider>,
  )
}

describe('MonthlyTrendView', () => {
  it('renders the overall-trend breadcrumb when no category is given', () => {
    renderWith()
    expect(screen.getByText(/Spending › Trend$/)).toBeInTheDocument()
  })

  it('renders a category-scoped breadcrumb when category is given', () => {
    renderWith({ category: 'coffee_shops' })
    expect(screen.getByText(/Spending › Trend › Coffee shops/)).toBeInTheDocument()
  })

  it('renders a vendor-scoped breadcrumb with case-insensitive substring matching', () => {
    renderWith({ vendor: 'tesco' })
    expect(screen.getByText(/Spending › Trend › tesco/i)).toBeInTheDocument()
  })

  it('renders the recharts bar chart', () => {
    renderWith()
    expect(document.querySelector('.recharts-wrapper')).not.toBeNull()
  })

  it('shows three monthly labels in the chart', () => {
    renderWith()
    // The chart axis ticks will be rendered as SVG <text> elements with the
    // month label. With the recharts stub in place, count tick text nodes.
    const ticks = document.querySelectorAll('.recharts-cartesian-axis-tick-value')
    expect(ticks.length).toBeGreaterThanOrEqual(3)
  })

  it('shows the back chevron in the header', () => {
    renderWith()
    expect(screen.getByLabelText('Back to Spending overview')).toBeInTheDocument()
  })
})
