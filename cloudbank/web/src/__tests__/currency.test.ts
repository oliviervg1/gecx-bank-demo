import { describe, it, expect } from 'vitest'
import { formatGBP } from '../util/currency'

describe('formatGBP', () => {
  it('formats whole pounds with two decimal places', () => {
    expect(formatGBP(0)).toBe('0.00')
    expect(formatGBP(5)).toBe('5.00')
    expect(formatGBP(45)).toBe('45.00')
  })

  it('adds thousand separators for >= 4 digits', () => {
    expect(formatGBP(1245.5)).toBe('1,245.50')
    expect(formatGBP(214500)).toBe('214,500.00')
    expect(formatGBP(4250.75)).toBe('4,250.75')
  })

  it('rounds to 2 decimal places', () => {
    expect(formatGBP(12.4)).toBe('12.40')
    expect(formatGBP(12.345)).toBe('12.35')
  })

  it('handles negative values for income rows', () => {
    expect(formatGBP(-3200)).toBe('-3,200.00')
  })
})
