// The mortgage "next payment" is a recurring day-of-month resolved against
// today, not an absolute date in the fixture, so it cannot go stale and start
// announcing a payment that has already happened. These tests pin the edges of
// that resolution.

import { describe, it, expect } from 'vitest'
import {
  nextMonthlyOccurrence,
  formatDayOrdinal,
  formatDayAndMonth,
  parseLocalDate,
  ordinalSuffix,
} from '../util/dates'

describe('nextMonthlyOccurrence', () => {
  it('returns this month when the day is still ahead', () => {
    const d = nextMonthlyOccurrence(15, new Date(2026, 7, 3)) // 3 Aug
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 7, 15])
  })

  it('returns today when the payment falls today', () => {
    const d = nextMonthlyOccurrence(3, new Date(2026, 7, 3))
    expect(d.getDate()).toBe(3)
    expect(d.getMonth()).toBe(7)
  })

  it('rolls into next month once the day has passed', () => {
    const d = nextMonthlyOccurrence(1, new Date(2026, 7, 3)) // 1st already gone
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 8, 1])
  })

  it('rolls across a year boundary', () => {
    const d = nextMonthlyOccurrence(1, new Date(2026, 11, 15)) // 15 Dec
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2027, 0, 1])
  })

  // A 31st payment must not skip a short month by overflowing into the next.
  it('clamps to the last day of a 30-day month', () => {
    const d = nextMonthlyOccurrence(31, new Date(2026, 10, 5)) // 5 Nov
    expect([d.getMonth(), d.getDate()]).toEqual([10, 30])
  })

  it('clamps to the last day of February', () => {
    const d = nextMonthlyOccurrence(30, new Date(2026, 1, 5)) // 5 Feb 2026
    expect([d.getMonth(), d.getDate()]).toEqual([1, 28])
  })

  it('clamps to 29 February in a leap year', () => {
    const d = nextMonthlyOccurrence(31, new Date(2028, 1, 5)) // 2028 is a leap year
    expect([d.getMonth(), d.getDate()]).toEqual([1, 29])
  })

  it('never returns a date in the past, for any day-of-month across a year', () => {
    for (let month = 0; month < 12; month++) {
      for (const dom of [1, 15, 28, 31]) {
        const today = new Date(2026, month, 20)
        const next = nextMonthlyOccurrence(dom, today)
        // Compare by calendar day, not by time-of-day.
        const asDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
        expect(asDay(next)).toBeGreaterThanOrEqual(asDay(today))
      }
    }
  })
})

describe('ordinal formatting', () => {
  it.each([
    [1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'],
    [11, '11th'], [12, '12th'], [13, '13th'],
    [21, '21st'], [22, '22nd'], [23, '23rd'], [31, '31st'],
  ])('formatDayOrdinal(%i) === %s', (day, expected) => {
    expect(formatDayOrdinal(day)).toBe(expected)
  })

  it('formatDayAndMonth renders day and full month name', () => {
    expect(formatDayAndMonth(new Date(2026, 6, 1))).toBe('1st July')
    expect(formatDayAndMonth(new Date(2026, 11, 23))).toBe('23rd December')
  })

  it('ordinalSuffix handles the 11-13 exception', () => {
    expect(ordinalSuffix(11)).toBe('th')
    expect(ordinalSuffix(111)).toBe('th')
  })
})

describe('parseLocalDate', () => {
  // new Date('2026-07-01') is UTC midnight, which reads as 30 June in any
  // timezone west of Greenwich. parseLocalDate must give the written day.
  it('keeps the calendar day written in the string', () => {
    const d = parseLocalDate('2026-07-01')
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 6, 1])
  })
})
