import { describe, it, expect } from 'vitest'
import { buildSessionVariables } from '../agent/sessionVariables'
import { allFixtures } from '../data/fixture'

describe('buildSessionVariables — 5-key CLIENT_SEEDABLE_VARIABLES contract', () => {
  it.each(allFixtures())(
    'builds exact 5 keys for %s with customer_snapshot identical verbatim to fixture',
    (personaId, fixture) => {
      const vars = buildSessionVariables(personaId, fixture, {
        demoDate: '2026-11-24',
        timeOfDay: 'afternoon',
      })
      expect(Object.keys(vars).sort()).toEqual([
        'customer_snapshot',
        'demo_date',
        'first_name',
        'persona_id',
        'time_of_day',
      ])
      expect(vars.persona_id).toBe(personaId)
      expect(vars.first_name).toBe(fixture.user.first_name)
      expect(vars.demo_date).toBe('2026-11-24')
      expect(vars.time_of_day).toBe('afternoon')
      // customer_snapshot must be the exact verbatim fixture object!
      expect(vars.customer_snapshot).toBe(fixture)
      expect(vars.customer_snapshot).toEqual(fixture)
    },
  )
})
