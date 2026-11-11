import { MONTH_NAMES } from './demoClock'

export function parseLocalDate(isoDate: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

export function ordinalSuffix(n: number): string {
  const teens = n % 100
  if (teens >= 11 && teens <= 13) return 'th'
  const last = n % 10
  return last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'
}

export function nextMonthlyOccurrence(dayOfMonth: number, today: Date = new Date()): Date {
  const clampToMonth = (year: number, monthIndex: number): Date => {
    const lastDay = new Date(year, monthIndex + 1, 0).getDate()
    return new Date(year, monthIndex, Math.min(dayOfMonth, lastDay))
  }
  const thisMonth = clampToMonth(today.getFullYear(), today.getMonth())
  if (thisMonth.getDate() >= today.getDate()) return thisMonth
  return clampToMonth(today.getFullYear(), today.getMonth() + 1)
}

export function formatDayOrdinal(day: number): string {
  return `${day}${ordinalSuffix(day)}`
}

export function formatDayAndMonth(d: Date): string {
  const day = d.getDate()
  return `${day}${ordinalSuffix(day)} ${MONTH_NAMES[d.getMonth()]}`
}
