// Exact integer-pence and basis-point formatters without floating-point rounding drift.

function groupThousands(digits: string): string {
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits.charAt(i)
  }
  return out
}

/**
 * Format integer pence as a 2-decimal string without currency symbol (e.g. 124550 -> '1,245.50').
 */
export function formatPence(amountPence: number): string {
  const truncated = Math.trunc(amountPence)
  const sign = truncated < 0 ? '-' : ''
  const absPence = Math.abs(truncated)
  const pence = absPence % 100
  const pounds = (absPence - pence) / 100
  const penceStr = pence < 10 ? `0${pence}` : `${pence}`
  return `${sign}${groupThousands(String(pounds))}.${penceStr}`
}

/**
 * Format integer pence with leading sign before £ (e.g. 425075 -> '£4,250.75', -320000 -> '-£3,200.00').
 */
export function formatGBPFromPence(amountPence: number): string {
  const truncated = Math.trunc(amountPence)
  const sign = truncated < 0 ? '-' : ''
  return `${sign}£${formatPence(Math.abs(truncated))}`
}

/**
 * Format integer basis points as X.XX% (e.g. 450 -> '4.50%', 389 -> '3.89%').
 */
export function formatBps(rateBps: number): string {
  const absBps = Math.abs(Math.trunc(rateBps))
  const frac = absBps % 100
  const whole = (absBps - frac) / 100
  const fracStr = frac < 10 ? `0${frac}` : `${frac}`
  return `${rateBps < 0 ? '-' : ''}${whole}.${fracStr}%`
}
