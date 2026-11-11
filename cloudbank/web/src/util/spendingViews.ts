// Pure integer-pence Spending sub-view selectors matching assist_everyday_banking/python_code.py.

import type { Transaction } from '../data/fixture'
import {
  DEFAULT_PINNED_DEMO_DATE,
  PERIOD_TO_OFFSET,
  monthNameForOffset,
  shortMonthForOffset,
  type SpendingPeriod,
} from './demoClock'

export interface MonthBucket {
  offset: 0 | 1 | 2
  label: string
  monthName: string
  total_pence: number
}

const UNICODE_ALNUM_OR_SPACE_RE = /[\p{L}\p{N} ]/u

export function normalizeVendorForms(name: string): { raw: string; stem: string } {
  const lowered = name.trim().toLowerCase()
  const rawClean = Array.from(lowered)
    .filter((ch) => UNICODE_ALNUM_OR_SPACE_RE.test(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()

  let stemSrc = lowered
  if (stemSrc.endsWith("'s") || stemSrc.endsWith('\u2019s')) {
    stemSrc = stemSrc.slice(0, -2)
  }
  const stemClean = Array.from(stemSrc)
    .filter((ch) => UNICODE_ALNUM_OR_SPACE_RE.test(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()

  return { raw: rawClean, stem: stemClean }
}

function containsTokenSequence(txTokens: string[], needleTokens: string[]): boolean {
  if (needleTokens.length === 0 || needleTokens.length > txTokens.length) return false
  const firstToken = needleTokens[0]
  if (needleTokens.length === 1 && firstToken !== undefined && firstToken.length < 2 && txTokens.length > 1) {
    return false
  }
  const span = needleTokens.length
  for (let idx = 0; idx <= txTokens.length - span; idx++) {
    let allMatch = true
    for (let j = 0; j < span; j++) {
      if (txTokens[idx + j] !== needleTokens[j]) {
        allMatch = false
        break
      }
    }
    if (allMatch) return true
  }
  return false
}

export function vendorsEqual(left: string, right: string): boolean {
  const l = normalizeVendorForms(left)
  const r = normalizeVendorForms(right)
  if (!l.raw || !r.raw) return false
  return l.raw === r.raw || (Boolean(l.stem) && l.stem === r.stem)
}

/**
 * Match non-income transactions using exact normalised match + contiguous whole-token containment.
 * Identical to Python `_match_vendor_rows`.
 */
export function matchVendorRows(
  txns: Transaction[],
  queryVendor: string,
): { canonical: string; matched: Transaction[] } {
  const needle = normalizeVendorForms(queryVendor)
  if (!needle.raw) return { canonical: '', matched: [] }

  const rawTokens = needle.raw.split(' ')
  const stemTokens = needle.stem ? needle.stem.split(' ') : rawTokens

  const matched: Transaction[] = []
  let canonical = ''
  let hasExact = false

  for (const tx of txns) {
    if (tx.amount_pence <= 0) continue
    const txForms = normalizeVendorForms(tx.vendor)
    const isExact =
      txForms.raw === needle.raw || (Boolean(needle.stem) && txForms.stem === needle.stem)
    const isTokenMatch =
      containsTokenSequence(txForms.raw.split(' '), rawTokens) ||
      containsTokenSequence(txForms.stem.split(' '), stemTokens)

    if (isExact || isTokenMatch) {
      matched.push(tx)
      if (isExact && !hasExact) {
        canonical = tx.vendor
        hasExact = true
      } else if (!canonical) {
        canonical = tx.vendor
      }
    }
  }

  return { canonical, matched }
}

export function bucketByMonth(
  txns: Transaction[],
  opts: { category?: string; vendor?: string; excludeIncome?: boolean } = {},
  demoDate: string = DEFAULT_PINNED_DEMO_DATE,
): MonthBucket[] {
  const vendorMatchedIds = opts.vendor
    ? new Set(matchVendorRows(txns, opts.vendor).matched.map((t) => t.id))
    : null

  const totals: [number, number, number] = [0, 0, 0]
  for (const tx of txns) {
    if (opts.excludeIncome !== false && tx.amount_pence <= 0) continue
    if (opts.category && tx.category !== opts.category) continue
    if (vendorMatchedIds && !vendorMatchedIds.has(tx.id)) continue
    const off = tx.month_offset
    if (off === 0 || off === 1 || off === 2) {
      totals[off] += tx.amount_pence
    }
  }

  // Oldest-first [2, 1, 0] left-to-right for trend bars.
  const order: Array<0 | 1 | 2> = [2, 1, 0]
  return order.map((offset) => ({
    offset,
    label: shortMonthForOffset(demoDate, offset),
    monthName: monthNameForOffset(demoDate, offset),
    total_pence: totals[offset],
  }))
}

export interface SubscriptionsViewData {
  items: Transaction[]
  total_pence: number
  monthName: string
}

export function subscriptionsView(
  txns: Transaction[],
  period: SpendingPeriod = 'this_month',
  demoDate: string = DEFAULT_PINNED_DEMO_DATE,
): SubscriptionsViewData {
  const offset = PERIOD_TO_OFFSET[period]
  const items = txns
    .filter(
      (t) => t.month_offset === offset && t.is_subscription === true && t.amount_pence > 0,
    )
    .sort((a, b) => b.amount_pence - a.amount_pence)
  const total_pence = items.reduce((sum, t) => sum + t.amount_pence, 0)
  return {
    items,
    total_pence,
    monthName: monthNameForOffset(demoDate, offset),
  }
}

export interface CategoryDrilldownData {
  rows: Transaction[]
  total_pence: number
  byVendorPence: Array<{ vendor: string; total_pence: number }>
  monthName: string
}

export function categoryDrilldownView(
  txns: Transaction[],
  category: string,
  period: SpendingPeriod = 'this_month',
  demoDate: string = DEFAULT_PINNED_DEMO_DATE,
): CategoryDrilldownData {
  const offset = PERIOD_TO_OFFSET[period]
  const rows = txns
    .filter(
      (t) =>
        t.month_offset === offset && t.category === category && t.amount_pence > 0,
    )
    .sort((a, b) => b.day - a.day)

  const map = new Map<string, number>()
  let total_pence = 0
  for (const tx of rows) {
    total_pence += tx.amount_pence
    map.set(tx.vendor, (map.get(tx.vendor) ?? 0) + tx.amount_pence)
  }

  const byVendorPence = Array.from(map.entries())
    .map(([vendor, val]) => ({ vendor, total_pence: val }))
    .sort((a, b) => b.total_pence - a.total_pence)

  return {
    rows,
    total_pence,
    byVendorPence,
    monthName: monthNameForOffset(demoDate, offset),
  }
}

export interface VendorHistoryData {
  canonicalVendor: string
  rows: Transaction[]
  periodRows: Transaction[]
  periodTotalPence: number
  threeMonthTotalPence: number
  buckets: MonthBucket[]
  monthName: string
}

export function vendorHistoryView(
  txns: Transaction[],
  vendor: string,
  period: SpendingPeriod = 'this_month',
  demoDate: string = DEFAULT_PINNED_DEMO_DATE,
): VendorHistoryData {
  const offset = PERIOD_TO_OFFSET[period]
  const { canonical, matched } = matchVendorRows(txns, vendor)
  const sortedAll = [...matched].sort((a, b) =>
    a.month_offset !== b.month_offset ? a.month_offset - b.month_offset : b.day - a.day,
  )
  const periodRows = sortedAll.filter((t) => t.month_offset === offset)
  const periodTotalPence = periodRows.reduce((sum, t) => sum + t.amount_pence, 0)
  const threeMonthTotalPence = sortedAll.reduce((sum, t) => sum + t.amount_pence, 0)

  return {
    canonicalVendor: canonical || vendor,
    rows: sortedAll,
    periodRows,
    periodTotalPence,
    threeMonthTotalPence,
    buckets: bucketByMonth(txns, { vendor, excludeIncome: true }, demoDate),
    monthName: monthNameForOffset(demoDate, offset),
  }
}
