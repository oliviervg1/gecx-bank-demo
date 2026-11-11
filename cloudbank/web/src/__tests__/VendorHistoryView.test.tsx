import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VendorHistoryView } from '../pages/spending/VendorHistoryView'
import { PersonaProvider } from '../personas/PersonaProvider'
import { SpendingViewProvider } from '../agent/SpendingViewProvider'

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
  it('renders canonical vendor breadcrumb, selected month spend, and strictly selected-month visits', () => {
    renderWith('tesco')
    expect(screen.getByText(/Spending › Tesco/)).toBeInTheDocument()
    expect(screen.getByText('£80.75')).toBeInTheDocument()
    expect(screen.getByText('3 visits in November')).toBeInTheDocument()
    const rows = document.querySelectorAll('[data-component-id^="txn-"]')
    expect(rows.length).toBe(3)
    rows.forEach((r) => {
      expect(r.textContent?.toLowerCase()).toContain('tesco')
    })
  })

  it('renders empty state politely when vendor has no transactions', () => {
    renderWith('NonexistentCorp')
    expect(document.querySelectorAll('[data-component-id^="txn-"]').length).toBe(0)
    expect(screen.getByText(/No transactions at this merchant/i)).toBeInTheDocument()
  })
})
