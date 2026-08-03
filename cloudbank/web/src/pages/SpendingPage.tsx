import type { ReactNode } from 'react'
import { useSpendingView, type SpendingView } from '../agent/SpendingViewProvider'
import { PageTransition } from '../components/PageTransition'
import { OverviewView } from './spending/OverviewView'
import { CategoryDrilldownView } from './spending/CategoryDrilldownView'
import { MonthlyTrendView } from './spending/MonthlyTrendView'
import { SubscriptionsAuditView } from './spending/SubscriptionsAuditView'
import { VendorHistoryView } from './spending/VendorHistoryView'

function renderView(view: SpendingView, category?: string, vendor?: string): ReactNode {
  switch (view) {
    case 'overview':
      return <OverviewView />
    case 'category_drilldown':
      // category presence is guaranteed by the provider's handler validation;
      // the `!` is safe and the type narrows for the view component.
      return <CategoryDrilldownView category={category!} />
    case 'monthly_trend':
      return <MonthlyTrendView category={category} vendor={vendor} />
    case 'subscriptions_audit':
      return <SubscriptionsAuditView />
    case 'vendor_history':
      return <VendorHistoryView vendor={vendor!} />
  }
}

export function SpendingPage() {
  const { view, category, vendor, direction } = useSpendingView()
  // Nested PageTransition (Plan Task 20): slides between sub-views inside the
  // Spending tab, while the outer App-level PageTransition handles tab swaps.
  // `direction` comes from SpendingViewProvider: forward when drilling into a
  // sub-view, back when returning to overview (Plan Task 13).
  return (
    <PageTransition pageKey={view} direction={direction}>
      {renderView(view, category, vendor)}
    </PageTransition>
  )
}
