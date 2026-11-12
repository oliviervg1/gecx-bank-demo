import { describe, it, expect } from 'vitest'
import { formatBps, formatGBPFromPence, formatPence } from '../util/currency'

describe('currency & basis-point formatters', () => {
  it('formats integer pence without floating-point drift', () => {
    expect(formatPence(0)).toBe('0.00')
    expect(formatPence(500)).toBe('5.00')
    expect(formatPence(4500)).toBe('45.00')
    expect(formatPence(201864)).toBe('2,018.64')
    expect(formatPence(21450000)).toBe('214,500.00')
    expect(formatGBPFromPence(425075)).toBe('£4,250.75')
    expect(formatGBPFromPence(-3454)).toBe('-£34.54')
  })

  it('formats integer basis points as X.XX%', () => {
    expect(formatBps(450)).toBe('4.50%')
    expect(formatBps(441)).toBe('4.41%')
    expect(formatBps(389)).toBe('3.89%')
    expect(formatBps(4057)).toBe('40.57%')
  })
})
