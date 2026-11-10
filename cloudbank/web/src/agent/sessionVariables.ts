// Builds the exact 5-key CLIENT_SEEDABLE_VARIABLES payload for ClientStart.
// customer_snapshot is passed verbatim from the active persona fixture.

import type { CustomerSnapshot } from '../data/fixture'
import { DEFAULT_PINNED_DEMO_DATE, resolveTimeOfDay } from '../util/demoClock'
import type { PersonaId, SeedVariables } from './protocol'

export function buildSessionVariables(
  personaId: PersonaId,
  fixture: CustomerSnapshot,
  opts: {
    demoDate?: string
    timeOfDay?: 'morning' | 'afternoon' | 'evening'
    now?: Date
  } = {},
): SeedVariables {
  const demoDate = opts.demoDate ?? DEFAULT_PINNED_DEMO_DATE
  const timeOfDay = opts.timeOfDay ?? resolveTimeOfDay(opts.now)
  return {
    persona_id: personaId,
    first_name: fixture.user.first_name,
    demo_date: demoDate,
    time_of_day: timeOfDay,
    customer_snapshot: fixture,
  }
}
