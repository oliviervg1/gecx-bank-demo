import { describe, it, expect } from 'vitest'
import { ALL_PERSONAS, DEFAULT_PERSONA, parsePersona } from '../personas/personas'

describe('personas', () => {
  it('exposes the canonical persona list', () => {
    expect(ALL_PERSONAS).toEqual(['chloe', 'david', 'tom', 'sarah'])
  })

  it('defaults to chloe', () => {
    expect(DEFAULT_PERSONA).toBe('chloe')
  })

  it('parses a valid persona id', () => {
    expect(parsePersona('chloe')).toBe('chloe')
    expect(parsePersona('sarah')).toBe('sarah')
  })

  it('falls back to the default when input is null', () => {
    expect(parsePersona(null)).toBe('chloe')
  })

  it('falls back to the default when input is unknown', () => {
    expect(parsePersona('mystery')).toBe('chloe')
  })

  it('is case-insensitive on input', () => {
    expect(parsePersona('Chloe')).toBe('chloe')
    expect(parsePersona('DAVID')).toBe('david')
  })
})
