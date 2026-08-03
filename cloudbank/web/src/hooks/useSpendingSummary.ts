import { useMemo } from 'react'
import { useFixture } from '../data/useFixture'
import { computeSpendingSummary, type SpendingSummary, type RawTransaction } from '../util/spendingSummary'

export type { SpendingSummary }

// Reads the ACTIVE persona's fixture, never a fixture module directly — that is
// what stops ?persona=david rendering David's name against Chloe's numbers.
export function useSpendingSummary(): SpendingSummary {
  const fixture = useFixture()
  return useMemo(
    () => computeSpendingSummary(fixture.transactions as RawTransaction[]),
    [fixture],
  )
}
