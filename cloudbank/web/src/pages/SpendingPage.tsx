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
    case 'category':
      return <CategoryDrilldownView category={category ?? 'groceries'} />
    case 'trend':
      return <MonthlyTrendView category={category} vendor={vendor} />
    case 'subscriptions':
      return <SubscriptionsAuditView />
    case 'vendor':
      return <VendorHistoryView vendor={vendor ?? ''} />
  }
}

export function SpendingPage() {
  const { view, category, vendor, direction } = useSpendingView()
  return (
    <PageTransition pageKey={`${view}-${category ?? ''}-${vendor ?? ''}`} direction={direction}>
      {renderView(view, category, vendor)}
    </PageTransition>
  )
}
