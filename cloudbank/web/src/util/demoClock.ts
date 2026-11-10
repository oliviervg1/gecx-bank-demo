// Timezone-safe integer-component demo clock and statement-month helpers.
// Never uses Date.prototype.toISOString() or new Date('YYYY-MM-DD') UTC parsing.

export const DEFAULT_PINNED_DEMO_DATE = '2026-11-24'

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

export const SHORT_MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

export type SpendingPeriod = 'this_month' | 'last_month' | 'two_months_ago'

export const PERIOD_TO_OFFSET: Record<SpendingPeriod, 0 | 1 | 2> = {
  this_month: 0,
  last_month: 1,
  two_months_ago: 2,
}

export const OFFSET_TO_PERIOD: Record<0 | 1 | 2, SpendingPeriod> = {
  0: 'this_month',
  1: 'last_month',
  2: 'two_months_ago',
}

const ISO_DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

export function formatIsoDate(date: Date): string {
  const y = date.getFullYear()
  const m = date.getMonth() + 1
  const d = date.getDate()
  return `${y}-${pad2(m)}-${pad2(d)}`
}

export function isValidIsoCalendarDate(raw: string): boolean {
  if (!ISO_DATE_RE.test(raw)) return false
  const year = Number(raw.slice(0, 4))
  const month = Number(raw.slice(5, 7))
  const day = Number(raw.slice(8, 10))
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false
  }
  const constructed = new Date(year, month - 1, day)
  return (
    constructed.getFullYear() === year &&
    constructed.getMonth() === month - 1 &&
    constructed.getDate() === day
  )
}

export function parseDemoDateComponents(demoDate: string): {
  year: number
  month: number
  day: number
} {
  const clean = demoDate.trim()
  if (isValidIsoCalendarDate(clean)) {
    return {
      year: Number(clean.slice(0, 4)),
      month: Number(clean.slice(5, 7)),
      day: Number(clean.slice(8, 10)),
    }
  }
  return { year: 2026, month: 11, day: 24 }
}

/**
 * Default anchored demo date: the 24th of `now`'s local calendar month (valid in all 12 months).
 */
export function defaultDemoDateForNow(now: Date = new Date()): string {
  return formatIsoDate(new Date(now.getFullYear(), now.getMonth(), 24))
}

export function readDemoDateFromSearch(
  search: string,
  fallbackDate: string = DEFAULT_PINNED_DEMO_DATE,
): string {
  const raw = new URLSearchParams(search).get('demo_date')
  if (raw && isValidIsoCalendarDate(raw)) {
    return raw
  }
  return fallbackDate
}

export function monthNameForOffset(demoDate: string, offset: 0 | 1 | 2): string {
  const { year, month } = parseDemoDateComponents(demoDate)
  const totalMonths = year * 12 + (month - 1) - offset
  const idx = ((totalMonths % 12) + 12) % 12
  return MONTH_NAMES[idx]
}

export function shortMonthForOffset(demoDate: string, offset: 0 | 1 | 2): string {
  const { year, month } = parseDemoDateComponents(demoDate)
  const totalMonths = year * 12 + (month - 1) - offset
  const idx = ((totalMonths % 12) + 12) % 12
  return SHORT_MONTH_NAMES[idx]
}

export function targetYearMonth(
  demoDate: string,
  monthsAhead: number,
): { targetYear: number; targetMonth: number; label: string } {
  const { year, month } = parseDemoDateComponents(demoDate)
  const totalMonths = year * 12 + (month - 1) + Math.trunc(monthsAhead)
  const rem = ((totalMonths % 12) + 12) % 12
  const targetYear = (totalMonths - rem) / 12
  const targetMonth = rem + 1
  return {
    targetYear,
    targetMonth,
    label: `${MONTH_NAMES[targetMonth - 1]} ${targetYear}`,
  }
}

export function nextPaymentDateLabel(dayOfMonth: number, demoDate: string): string {
  const { year, month, day } = parseDemoDateComponents(demoDate)
  let targetYear = year
  let targetMonth = month
  if (dayOfMonth < day) {
    const totalMonths = year * 12 + month
    const rem = totalMonths % 12
    targetYear = (totalMonths - rem) / 12
    targetMonth = rem + 1
  }
  const lastDay = new Date(targetYear, targetMonth, 0).getDate()
  const clampedDay = Math.min(dayOfMonth, lastDay)
  return `${clampedDay} ${MONTH_NAMES[targetMonth - 1]} ${targetYear}`
}

export function formatIsoDayMonthYear(isoDate: string): string {
  if (!isValidIsoCalendarDate(isoDate)) return isoDate
  const year = Number(isoDate.slice(0, 4))
  const month = Number(isoDate.slice(5, 7))
  const day = Number(isoDate.slice(8, 10))
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`
}

export function resolveTimeOfDay(
  now: Date = new Date(),
): 'morning' | 'afternoon' | 'evening' {
  const hour = now.getHours()
  if (hour < 12) return 'morning'
  if (hour < 18) return 'afternoon'
  return 'evening'
}
