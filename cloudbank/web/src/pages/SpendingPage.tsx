import type { ReactNode } from 'react'
import {
  useBankingViewState,
  type SpendingView,
} from '../agent/BankingViewStateProvider'
import { PageTransition } from '../components/PageTransition'
import { SegmentedTabPanels } from '../components/SegmentedTabs'
import { OverviewView } from './spending/OverviewView'
import { CategoryDrilldownView } from './spending/CategoryDrilldownView'
import { MonthlyTrendView } from './spending/MonthlyTrendView'
import {
  SPENDING_SUBVIEW_TABS,
  SPENDING_TAB_ID_PREFIX,
  isSpendingTopSubview,
} from './spending/SpendingHeader'
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
  const { view, category, vendor, direction } = useBankingViewState()
  return (
    <PageTransition pageKey={`${view}-${category ?? ''}-${vendor ?? ''}`} direction={direction}>
      {isSpendingTopSubview(view) ? (
        <SegmentedTabPanels
          idPrefix={SPENDING_TAB_ID_PREFIX}
          tabs={SPENDING_SUBVIEW_TABS}
          activeId={view}
          renderPanel={(tabId) => renderView(tabId, category, vendor)}
        />
      ) : (
        renderView(view, category, vendor)
      )}
    </PageTransition>
  )
}
