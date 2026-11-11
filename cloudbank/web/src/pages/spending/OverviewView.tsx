import { useMemo } from 'react'
import { AlertTriangle, CheckCircle2, ChevronRight, ShieldAlert } from 'lucide-react'
import { SpendingHeader } from './SpendingHeader'
import { TransactionRow } from './TransactionRow'
import { useFixture } from '../../data/useFixture'
import { usePersona } from '../../personas/PersonaProvider'
import { useBankingViewState } from '../../agent/BankingViewStateProvider'
import { formatGBPFromPence } from '../../util/currency'
import {
  PERIOD_TO_OFFSET,
  monthNameForOffset,
} from '../../util/demoClock'
import { vendorsEqual } from '../../util/spendingViews'

function prettyCategory(c: string): string {
  const s = c.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function OverviewView() {
  const fixture = useFixture()
  const { demoDate } = usePersona()
  const { period, highlightVendor, anomalyStatus, setView } = useBankingViewState()

  const offset = PERIOD_TO_OFFSET[period]
  const monthName = monthNameForOffset(demoDate, offset)
  const prevMonthName = offset < 2 ? monthNameForOffset(demoDate, (offset + 1) as 1 | 2) : null

  const { monthTxns, totalPence, prevTotalPence, byCategory, anomalyTx, priorAnomalyPence } =
    useMemo(() => {
      const mTxns = fixture.transactions
        .filter((t) => t.month_offset === offset && t.amount_pence > 0)
        .sort((a, b) => b.day - a.day)
      const tot = mTxns.reduce((sum, t) => sum + t.amount_pence, 0)

      const pTot =
        offset < 2
          ? fixture.transactions
              .filter((t) => t.month_offset === offset + 1 && t.amount_pence > 0)
              .reduce((sum, t) => sum + t.amount_pence, 0)
          : null

      const catMap = new Map<string, number>()
      for (const tx of mTxns) {
        catMap.set(tx.category, (catMap.get(tx.category) ?? 0) + tx.amount_pence)
      }
      const cats = Array.from(catMap.entries())
        .map(([category, amount_pence]) => ({ category, amount_pence }))
        .sort((a, b) => b.amount_pence - a.amount_pence)

      const anom = offset === 0 ? mTxns.find((t) => t.is_anomaly) ?? null : null
      const priorMatch = anom
        ? fixture.transactions.find(
            (t) => t.month_offset === 1 && vendorsEqual(t.vendor, anom.vendor),
          )
        : undefined

      return {
        monthTxns: mTxns,
        totalPence: tot,
        prevTotalPence: pTot,
        byCategory: cats,
        anomalyTx: anom,
        priorAnomalyPence: priorMatch?.amount_pence ?? null,
      }
    }, [fixture.transactions, offset])

  const diffPence = prevTotalPence !== null ? totalPence - prevTotalPence : null

  return (
    <div className="pb-6">
      <SpendingHeader />

      {/* Monthly Total Headline */}
      <div className="py-4 border-b border-brand-divider">
        <div className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-medium">
          {monthName} Total Spend
        </div>
        <div className="flex items-baseline justify-between mt-1">
          <div className="text-[1.875rem] font-bold tracking-[-0.02em] text-brand-text tabular-nums leading-none">
            {formatGBPFromPence(totalPence)}
          </div>
          {diffPence !== null && prevMonthName && (
            <div className="text-[0.8125rem] text-brand-muted tabular-nums">
              {diffPence > 0
                ? `+${formatGBPFromPence(diffPence)} vs ${prevMonthName}`
                : diffPence < 0
                  ? `${formatGBPFromPence(diffPence)} vs ${prevMonthName}`
                  : `Matches ${prevMonthName}`}
            </div>
          )}
        </div>
      </div>

      {/* Flagged Anomaly Banner (Current Month) */}
      {anomalyTx && (
        <div
          data-testid="anomaly-banner"
          className={
            'mt-4 p-3.5 rounded-xl border ' +
            (anomalyStatus === 'unrecognised'
              ? 'border-brand-danger/40 bg-[#fdf6f6]'
              : anomalyStatus === 'confirmed'
                ? 'border-brand-green/30 bg-[#f6faf8]'
                : 'border-brand-gold-text/45 bg-[#fcf9f2]')
          }
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2.5">
              {anomalyStatus === 'unrecognised' ? (
                <ShieldAlert
                  size={18}
                  aria-hidden="true"
                  className="text-brand-danger shrink-0 mt-0.5"
                />
              ) : anomalyStatus === 'confirmed' ? (
                <CheckCircle2
                  size={18}
                  aria-hidden="true"
                  className="text-brand-green shrink-0 mt-0.5"
                />
              ) : (
                <AlertTriangle
                  size={18}
                  aria-hidden="true"
                  className="text-brand-gold-text shrink-0 mt-0.5"
                />
              )}
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[0.875rem] font-semibold text-brand-text">
                    {anomalyTx.vendor} · {formatGBPFromPence(anomalyTx.amount_pence)}
                  </span>
                  <span
                    data-testid="anomaly-status-badge"
                    className={
                      'text-[0.6875rem] font-semibold px-2 py-0.5 rounded-full border ' +
                      (anomalyStatus === 'unrecognised'
                        ? 'border-brand-danger/40 text-brand-danger bg-white'
                        : anomalyStatus === 'confirmed'
                          ? 'border-brand-green/40 text-brand-green bg-white'
                          : 'border-brand-gold-text/50 text-brand-gold-text bg-white')
                    }
                  >
                    {anomalyStatus === 'unrecognised'
                      ? 'Marked as not recognised'
                      : anomalyStatus === 'confirmed'
                        ? 'Confirmed'
                        : 'Flagged charge'}
                  </span>
                </div>
                <p className="text-[0.75rem] text-brand-muted mt-1 leading-snug">
                  {anomalyStatus === 'unrecognised'
                    ? 'Marked on screen as not recognised. Check with household members, freeze your card in Profile, or contact Cloudbank support to raise a formal dispute.'
                    : anomalyStatus === 'confirmed'
                      ? `Plan charge on ${anomalyTx.day} ${monthName} confirmed.`
                      : `Charged on ${anomalyTx.day} ${monthName}${
                          priorAnomalyPence !== null
                            ? ` (up from ${formatGBPFromPence(priorAnomalyPence)} last month)`
                            : ''
                        }.`}
                </p>
              </div>
            </div>
            {anomalyTx.is_subscription && (
              <button
                type="button"
                onClick={() =>
                  setView({
                    view: 'subscriptions',
                    highlightVendor: anomalyTx.vendor,
                  })
                }
                className="min-h-8 px-1.5 inline-flex items-center text-[0.75rem] font-semibold text-brand-green shrink-0 hover:underline"
              >
                Subscriptions
              </button>
            )}
          </div>
        </div>
      )}

      {/* Category Breakdown */}
      <div className="mt-5">
        <div className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-semibold mb-1.5">
          By Category
        </div>
        <div className="divide-y divide-brand-divider border-t border-b border-brand-divider">
          {byCategory.map(({ category, amount_pence }) => (
            <button
              key={category}
              type="button"
              onClick={() => setView({ view: 'category', category, period })}
              className="min-h-11 w-full flex items-center justify-between py-2.5 text-left hover:bg-[#faf9f6] transition-colors"
            >
              <span className="text-[0.875rem] font-medium text-brand-text">
                {prettyCategory(category)}
              </span>
              <span className="inline-flex items-center gap-1.5 text-[0.875rem] font-semibold text-brand-text tabular-nums">
                {formatGBPFromPence(amount_pence)}
                <ChevronRight size={15} aria-hidden="true" className="text-brand-muted" />
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Statement Transactions */}
      <div className="mt-5">
        <div className="text-[0.6875rem] uppercase tracking-[0.08em] text-brand-muted font-semibold mb-1.5">
          {monthName} Transactions ({monthTxns.length})
        </div>
        <div className="divide-y divide-brand-divider border-t border-b border-brand-divider">
          {monthTxns.map((tx) => {
            const isHighlighted = highlightVendor
              ? vendorsEqual(tx.vendor, highlightVendor)
              : Boolean(tx.is_anomaly)
            const badge =
              tx.is_anomaly && anomalyStatus === 'unrecognised'
                ? 'Not recognised'
                : tx.is_anomaly && anomalyStatus === 'confirmed'
                  ? 'Confirmed'
                  : undefined
            return (
              <TransactionRow
                key={tx.id}
                transaction={tx}
                highlighted={isHighlighted}
                autoScroll={false}
                statusBadge={badge}
                onClick={() => setView({ view: 'vendor', vendor: tx.vendor, period })}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
