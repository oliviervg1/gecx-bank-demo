// Format a GBP amount as a 2-decimal string with thousand separators.
// Returns just the number string (no currency symbol) — the £ symbol is
// rendered as a separate styled span / prefix at the call sites.
//
// formatGBP(1245.5)       === '1,245.50'
// formatGBP(214500)       === '214,500.00'
// formatGBP(0)            === '0.00'
// formatGBP(-3200)        === '-3,200.00'
export function formatGBP(value: number): string {
  return value.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
