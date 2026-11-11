import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MonthlyTrendView } from '../pages/spending/MonthlyTrendView'
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

function renderWith({ category, vendor }: { category?: string; vendor?: string } = {}) {
  return render(
    <PersonaProvider initialDemoDate="2026-11-24">
      <SpendingViewProvider>
        <MonthlyTrendView category={category} vendor={vendor} />
      </SpendingViewProvider>
    </PersonaProvider>,
  )
}

describe('MonthlyTrendView', () => {
  it('renders overall 3-month chart and exact November/October/September ledger', () => {
    renderWith()
    expect(document.querySelector('.recharts-wrapper')).not.toBeNull()
    expect(screen.getByText('November')).toBeInTheDocument()
    expect(screen.getByText('£2,018.64')).toBeInTheDocument()
    expect(screen.getByText('£1,941.49')).toBeInTheDocument()
    expect(screen.getByText('£1,903.34')).toBeInTheDocument()
  })

  it('renders category and vendor scoped breadcrumbs', () => {
    const { unmount } = renderWith({ category: 'coffee_shops' })
    expect(screen.getByText(/Spending › Trend › Coffee shops/)).toBeInTheDocument()
    unmount()

    renderWith({ vendor: 'Tesco' })
    expect(screen.getByText(/Spending › Trend › Tesco/)).toBeInTheDocument()
    expect(screen.getByText('£179.65')).toBeInTheDocument()
    expect(screen.getByText('£80.75')).toBeInTheDocument()
    expect(screen.getByText('£52.50')).toBeInTheDocument()
    expect(screen.getByText('£46.40')).toBeInTheDocument()
  })
})
