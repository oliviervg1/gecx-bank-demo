import { useMemo } from 'react'
import { usePersona } from '../personas/PersonaProvider'
import { getFixture, type Fixture } from './fixture'

// Always resolves: every persona in ALL_PERSONAS has a registered fixture, and
// fixtureConformance.test.ts fails the build if one is missing. The return type
// is non-nullable so callers don't write `?? EMPTY` fallbacks for a case that
// cannot happen.
export function useFixture(): Fixture {
  const { persona } = usePersona()
  return useMemo(() => getFixture(persona), [persona])
}
