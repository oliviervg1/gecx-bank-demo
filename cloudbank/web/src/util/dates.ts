// Date helpers for the fixture's date fields.
//
// Two problems these solve.
//
// 1. `new Date('2026-07-01')` is parsed by ECMA-262 as UTC midnight, but
//    .getDate() / .toLocaleString() then read LOCAL fields — so anywhere west
//    of Greenwich the mortgage card rendered "Due 30th June" for a 1st-July
//    payment. parseLocalDate builds the Date from explicit components so the
//    calendar day is the one written in the fixture, in any timezone.
//
// 2. An absolute `next_payment.date` goes stale. It shipped as "2026-07-01"
//    and by August the app was cheerfully announcing a payment that had
//    already happened. A mortgage payment recurs on a fixed day of the month,
//    so that is what the fixture now stores, and the next occurrence is
//    computed from today — the same relative-data approach `days_ago` already
//    uses for transactions.
//
// These also replace three near-identical copies of the ordinal-suffix logic
// that lived in HomePage, MortgagePage and composeHomeInsight.

export function parseLocalDate(isoDate: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

export function ordinalSuffix(n: number): string {
  // The teens exception is on the last TWO digits, so 111 is "111th", not
  // "111st". Unreachable for a day-of-month, but this is an exported helper.
  const teens = n % 100
  if (teens >= 11 && teens <= 13) return 'th'
  const last = n % 10
  return last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'
}

// The next occurrence of `dayOfMonth`, today included. Clamps to the final day
// of a short month, so a 31st payment falls on the 30th in November and on the
// 28th/29th in February rather than rolling into the next month.
export function nextMonthlyOccurrence(dayOfMonth: number, today: Date = new Date()): Date {
  const clampToMonth = (year: number, monthIndex: number): Date => {
    const lastDay = new Date(year, monthIndex + 1, 0).getDate()
    return new Date(year, monthIndex, Math.min(dayOfMonth, lastDay))
  }
  const thisMonth = clampToMonth(today.getFullYear(), today.getMonth())
  if (thisMonth.getDate() >= today.getDate()) return thisMonth
  return clampToMonth(today.getFullYear(), today.getMonth() + 1)
}

// 1 -> "1st"
export function formatDayOrdinal(day: number): string {
  return `${day}${ordinalSuffix(day)}`
}

// Date(2026, 6, 1) -> "1st July"
export function formatDayAndMonth(d: Date): string {
  const day = d.getDate()
  return `${day}${ordinalSuffix(day)} ${d.toLocaleString('en-GB', { month: 'long' })}`
}
