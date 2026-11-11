import { useMemo } from 'react'
import { useFixture } from '../data/useFixture'
import { usePersona } from '../personas/PersonaProvider'
import { computeSpendingSummary, type SpendingSummary } from '../util/spendingSummary'

export type { SpendingSummary }

export function useSpendingSummary(): SpendingSummary {
  const fixture = useFixture()
  const { demoDate } = usePersona()
  return useMemo(
    () => computeSpendingSummary(fixture.transactions, demoDate),
    [fixture, demoDate],
  )
}
