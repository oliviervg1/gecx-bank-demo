import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VendorHistoryView } from '../pages/spending/VendorHistoryView'
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

function renderWith(vendor: string) {
  return render(
    <PersonaProvider>
      <AgentRegistryContext.Provider value={createRegistry()}>
        <SpendingViewProvider>
          <VendorHistoryView vendor={vendor} />
        </SpendingViewProvider>
      </AgentRegistryContext.Provider>
    </PersonaProvider>,
  )
}

describe('VendorHistoryView', () => {
  it('shows the vendor in the breadcrumb', () => {
    renderWith('Tesco')
    expect(screen.getByText(/Spending › Tesco/)).toBeInTheDocument()
  })

  it('renders only transactions for the named vendor (case-insensitive)', () => {
    renderWith('tesco')
    const rows = document.querySelectorAll('[data-component-id^="txn-"]')
    expect(rows.length).toBeGreaterThan(0)
    rows.forEach((r) => {
      expect(r.textContent?.toLowerCase()).toContain('tesco')
    })
  })

  it('shows the back chevron', () => {
    renderWith('Tesco')
    expect(screen.getByLabelText('Back to Spending overview')).toBeInTheDocument()
  })

  it('shows the mini trend chart (recharts wrapper present)', () => {
    renderWith('Tesco')
    expect(document.querySelector('.recharts-wrapper')).not.toBeNull()
  })

  it('renders empty list politely when vendor has no transactions', () => {
    renderWith('NonexistentCorp')
    const rows = document.querySelectorAll('[data-component-id^="txn-"]')
    expect(rows.length).toBe(0)
    expect(screen.getByText(/No recent transactions/i)).toBeInTheDocument()
  })
})
