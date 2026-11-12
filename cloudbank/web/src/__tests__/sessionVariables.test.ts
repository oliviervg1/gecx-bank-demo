import { describe, it, expect } from 'vitest'
import { buildClientStart } from '../agent/sessionVariables'
import { ALL_PERSONAS } from '../personas/personas'

describe('buildClientStart: lean server-owned persona handshake contract', () => {
  it.each(ALL_PERSONAS)(
    'builds lean ClientStart for %s without client-seeded customer_snapshot or first_name',
    (personaId) => {
      const start = buildClientStart(personaId, {
        demoDate: '2026-11-24',
        timeOfDay: 'afternoon',
      })
      expect(start).toEqual({
        type: 'start',
        persona: personaId,
        timeOfDay: 'afternoon',
        demoDate: '2026-11-24',
      })
      expect(start).not.toHaveProperty('variables')
      expect(start).not.toHaveProperty('customer_snapshot')
    },
  )

  it('falls back to pinned demoDate when invalid date string is passed and attaches lastUiSeq only when resuming', () => {
    const invalidDate = buildClientStart('david', {
      demoDate: '2026-02-30',
      timeOfDay: 'morning',
      lastUiSeq: 9,
    })
    expect(invalidDate.demoDate).toBe('2026-11-24')
    expect(invalidDate).not.toHaveProperty('lastUiSeq')

    const resumed = buildClientStart('david', {
      demoDate: '2026-11-24',
      timeOfDay: 'morning',
      sessionId: 'sess-42',
      lastUiSeq: 9,
    })
    expect(resumed.sessionId).toBe('sess-42')
    expect(resumed.lastUiSeq).toBe(9)
  })
})
