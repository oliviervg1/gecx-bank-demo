export function ordinalSuffix(n: number): string {
  const abs = Math.abs(Math.trunc(n))
  const teens = abs % 100
  if (teens >= 11 && teens <= 13) return 'th'
  const last = abs % 10
  return last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'
}

export function formatDayOrdinal(day: number): string {
  return `${day}${ordinalSuffix(day)}`
}
