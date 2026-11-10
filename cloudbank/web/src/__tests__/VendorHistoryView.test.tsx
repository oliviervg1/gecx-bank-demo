import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VendorHistoryView } from '../pages/spending/VendorHistoryView'
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

function renderWith(vendor: string) {
  return render(
    <PersonaProvider initialDemoDate="2026-11-24">
      <SpendingViewProvider>
        <VendorHistoryView vendor={vendor} />
      </SpendingViewProvider>
    </PersonaProvider>,
  )
}

describe('VendorHistoryView', () => {
  it('renders canonical vendor breadcrumb, chart, and matching transactions', () => {
    renderWith('tesco')
    expect(screen.getByText(/Spending › Tesco/)).toBeInTheDocument()
    expect(document.querySelector('.recharts-wrapper')).not.toBeNull()
    const rows = document.querySelectorAll('[data-component-id^="txn-"]')
    expect(rows.length).toBeGreaterThan(0)
    rows.forEach((r) => {
      expect(r.textContent?.toLowerCase()).toContain('tesco')
    })
  })

  it('renders empty state politely when vendor has no transactions', () => {
    renderWith('NonexistentCorp')
    expect(document.querySelectorAll('[data-component-id^="txn-"]').length).toBe(0)
    expect(screen.getByText(/No recent transactions/i)).toBeInTheDocument()
  })
})
