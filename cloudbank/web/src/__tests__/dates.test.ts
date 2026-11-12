import { describe, it, expect } from 'vitest'
import { formatDayOrdinal, ordinalSuffix } from '../util/dates'
import {
  defaultDemoDateForNow,
  formatIsoDate,
  formatIsoDayMonthYear,
  isValidIsoCalendarDate,
  monthNameForOffset,
  nextPaymentDateLabel,
  readDemoDateFromSearch,
  targetYearMonth,
} from '../util/demoClock'

describe('demoClock: timezone-safe integer-component dates', () => {
  it('formats local calendar dates without UTC shift and anchors default day to 24 across all months', () => {
    expect(formatIsoDate(new Date(2026, 1, 24))).toBe('2026-02-24')
    expect(defaultDemoDateForNow(new Date(2026, 1, 28))).toBe('2026-02-24')
    expect(defaultDemoDateForNow(new Date(2026, 10, 10))).toBe('2026-11-24')
  })

  it('validates real calendar dates and rejects impossible dates', () => {
    expect(isValidIsoCalendarDate('2026-11-24')).toBe(true)
    expect(isValidIsoCalendarDate('2028-02-29')).toBe(true)
    expect(isValidIsoCalendarDate('2026-02-29')).toBe(false)
    expect(isValidIsoCalendarDate('2026-02-30')).toBe(false)
    expect(isValidIsoCalendarDate('2026-11-24\n')).toBe(false)
    expect(readDemoDateFromSearch('?demo_date=2026-12-24')).toBe('2026-12-24')
    expect(readDemoDateFromSearch('?demo_date=2026-02-30')).toBe('2026-11-24')
  })

  it('resolves month offsets, targetYearMonth, and nextPaymentDateLabel across year boundaries', () => {
    expect(monthNameForOffset('2026-01-24', 0)).toBe('January')
    expect(monthNameForOffset('2026-01-24', 1)).toBe('December')
    expect(monthNameForOffset('2026-01-24', 2)).toBe('November')
    expect(targetYearMonth('2026-11-24', 19)).toEqual({
      targetYear: 2028,
      targetMonth: 6,
      label: 'June 2028',
    })
    expect(nextPaymentDateLabel(1, '2026-11-24')).toBe('1 December 2026')
    expect(nextPaymentDateLabel(25, '2026-11-24')).toBe('25 November 2026')
    expect(nextPaymentDateLabel(1, '2026-12-24')).toBe('1 January 2027')
    expect(formatIsoDayMonthYear('2027-09-30')).toBe('30 September 2027')
  })
})

describe('dates.ts: ordinal helpers', () => {
  it('formats ordinal day suffixes accurately', () => {
    expect(formatDayOrdinal(1)).toBe('1st')
    expect(formatDayOrdinal(2)).toBe('2nd')
    expect(formatDayOrdinal(3)).toBe('3rd')
    expect(formatDayOrdinal(12)).toBe('12th')
    expect(formatDayOrdinal(21)).toBe('21st')
    expect(ordinalSuffix(11)).toBe('th')
  })
})
