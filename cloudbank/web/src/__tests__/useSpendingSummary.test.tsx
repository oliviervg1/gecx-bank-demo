import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useSpendingSummary } from '../hooks/useSpendingSummary'
import { computeSpendingSummary } from '../util/spendingSummary'
import { getFixture } from '../data/fixture'
import { PersonaProvider } from '../personas/PersonaProvider'

function Probe() {
  const s = useSpendingSummary()
  return <span data-testid="this-month">{s.this_month_total_pence}</span>
}

describe('useSpendingSummary', () => {
  it('computes this month’s integer-pence total from the active persona fixture', () => {
    render(
      <PersonaProvider initialDemoDate="2026-11-24">
        <Probe />
      </PersonaProvider>,
    )
    const value = Number(screen.getByTestId('this-month').textContent ?? '')
    expect(value).toBe(
      computeSpendingSummary(getFixture('chloe').transactions, '2026-11-24')
        .this_month_total_pence,
    )
    expect(value).toBe(201864)
  })
})
