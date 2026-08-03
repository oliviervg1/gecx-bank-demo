import { describe, it, expect } from 'vitest'
import { buildSessionVariables, type HasFirstName } from '../agent/sessionVariables'

function fixture(over: Partial<HasFirstName> = {}): HasFirstName {
  return { user: { first_name: 'Chloe' }, ...over }
}

describe('buildSessionVariables', () => {
  it('returns only first_name', () => {
    const v = buildSessionVariables(fixture())
    expect(Object.keys(v)).toEqual(['first_name'])
    expect(v.first_name).toBe('Chloe')
  })

  it('does NOT include spending_summary anymore (the agent uses get_* tools)', () => {
    const v = buildSessionVariables(fixture())
    expect(v).not.toHaveProperty('spending_summary')
  })

  it('does NOT include any anomaly_* fields even when an anomaly is present', () => {
    const v = buildSessionVariables(fixture())
    expect(v).not.toHaveProperty('anomaly_vendor')
    expect(v).not.toHaveProperty('anomaly_amount')
    expect(v).not.toHaveProperty('anomaly_renewal_days_ago')
  })

  it('produces all-string values (CES session-variable contract)', () => {
    const v = buildSessionVariables(fixture())
    for (const [k, val] of Object.entries(v)) {
      expect(typeof val, `${k} should be string`).toBe('string')
    }
  })
})
