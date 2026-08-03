import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useSpendingSummary } from '../hooks/useSpendingSummary'
import { computeSpendingSummary, type RawTransaction } from '../util/spendingSummary'
import chloe from '../fixtures/chloe.json'
import { PersonaProvider } from '../personas/PersonaProvider'

function Probe() {
  const s = useSpendingSummary()
  return <span data-testid="this-month">{s.this_month_total}</span>
}

describe('useSpendingSummary', () => {
  // The hook computes the summary from the active persona's fixture directly;
  // there is no spending_summary session variable to parse.
  it('computes this month\'s total from the fixture', () => {
    render(<PersonaProvider><Probe /></PersonaProvider>)
    const text = screen.getByTestId('this-month').textContent ?? ''
    const value = Number(text)
    expect(Number.isFinite(value)).toBe(true)
    expect(value).toBeGreaterThanOrEqual(0)
    // Must agree with the shared kernel — the hook is a memoised wrapper, not
    // a second implementation.
    expect(value).toBe(computeSpendingSummary(
      (chloe as unknown as { transactions: RawTransaction[] }).transactions,
    ).this_month_total)
  })
})
