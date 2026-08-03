import { useEffect } from 'react'
import { PhoneFrame } from './components/PhoneFrame'
import { HeaderBar } from './components/HeaderBar'
import { TabBar } from './components/TabBar'
import { PageTransition } from './components/PageTransition'
import { HomePage } from './pages/home/HomePage'
import { SpendingPage } from './pages/SpendingPage'
import { MortgagePage } from './pages/mortgage/MortgagePage'
import { ProfilePage } from './pages/ProfilePage'
import { AgentProvider, useAgent } from './agent/AgentProvider'
import { SpendingViewProvider, useSpendingView, type SpendingViewState } from './agent/SpendingViewProvider'
import { PersonaProvider } from './personas/PersonaProvider'
import { PageProvider, usePage, ALL_PAGES, type PageId } from './pages/PageProvider'
import { ToastProvider } from './components/ToastProvider'
import { spendingHandlers } from './agent/handlers/spendingHandlers'
import { useFixture } from './data/useFixture'

function CurrentPage() {
  const { page } = usePage()
  switch (page) {
    case 'home': return <HomePage />
    case 'spending': return <SpendingPage />
    case 'mortgage': return <MortgagePage />
    case 'profile': return <ProfilePage />
    default: {
      const _exhaustive: never = page
      throw new Error(`unhandled page: ${String(_exhaustive)}`)
    }
  }
}

function NavigateToBinder() {
  const { registry } = useAgent()
  const { navigateTo } = usePage()
  useEffect(() => {
    registry.register('navigate_to', (args) => {
      const pageId = String(args?.pageId ?? '')
      if (!(ALL_PAGES as readonly string[]).includes(pageId)) {
        throw new Error(`unknown_page: ${pageId}`)
      }
      navigateTo(pageId as PageId)
      return {}
    })
    return () => registry.unregister('navigate_to')
  }, [registry, navigateTo])
  return null
}

// Map each data tool to the SpendingView it surfaces in the on-screen chart.
// Used by SpendingDataBinder's `show` side-effect — when args.show is true,
// the handler still returns its pure data result AND the binder also
// navigates to spending + flips the SpendingPage view to match. Lets the
// agent achieve "show me + tell me" in a single tool call instead of a
// multi-tool turn (the multi-tool pattern was unreliable in CES — model
// dropped speech or replied "I'm having trouble").
function viewForToolArgs(name: keyof typeof spendingHandlers, args: Record<string, unknown>): SpendingViewState {
  switch (name) {
    case 'get_overview':
      return { view: 'overview' }
    case 'get_category_breakdown':
      return { view: 'category_drilldown', category: String(args.category ?? '') }
    case 'get_vendor_breakdown':
      return { view: 'vendor_history', vendor: String(args.vendor ?? '') }
    case 'get_monthly_trend':
      return {
        view: 'monthly_trend',
        category: args.category ? String(args.category) : undefined,
        vendor: args.vendor ? String(args.vendor) : undefined,
      }
    case 'get_subscriptions':
      return { view: 'subscriptions_audit' }
  }
}

function SpendingDataBinder() {
  const { registry } = useAgent()
  const { navigateTo } = usePage()
  const { setView } = useSpendingView()
  const fixture = useFixture()
  useEffect(() => {
    // Expose the registry on window for the AgentProvider test that asserts
    // all expected handlers are wired up. DEV-only: in a production build this
    // handed any script on the page (or anyone at the devtools console) the
    // ability to re-register get_* / navigate_to and control what the agent is
    // told.
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      (window as unknown as { __agentRegistry?: typeof registry }).__agentRegistry = registry
    }
    const names = ['get_overview', 'get_category_breakdown', 'get_vendor_breakdown',
                   'get_monthly_trend', 'get_subscriptions'] as const
    for (const name of names) {
      registry.register(name, (args) => {
        // ctx carries the ACTIVE persona's fixture. Without it the handlers
        // fall back to their chloe.json default, so ?persona=david would
        // show David's screens while the agent narrated Chloe's numbers.
        const result = spendingHandlers[name](args, { fixture })
        // Side effect: when the agent passes show=true the customer wants to
        // SEE the slice, not just hear about it. Navigate + set view to
        // match the data the agent is about to narrate. Skip when the
        // handler reported an error — don't navigate into a broken state.
        if (args.show === true && !('error' in result)) {
          navigateTo('spending')
          setView(viewForToolArgs(name, args))
        }
        return result
      })
    }
    return () => {
      for (const name of names) registry.unregister(name)
    }
  }, [registry, navigateTo, setView, fixture])
  return null
}

function AppShell() {
  const { page, direction } = usePage()
  return (
    <PhoneFrame footer={<TabBar />}>
      <div className="flex flex-col h-full">
        <HeaderBar />
        <div className="flex-1 overflow-y-auto px-3">
          <PageTransition pageKey={page} direction={direction}>
            <CurrentPage />
          </PageTransition>
        </div>
      </div>
    </PhoneFrame>
  )
}

export default function App() {
  return (
    <PersonaProvider>
      <PageProvider>
        <AgentProvider>
          <ToastProvider>
            <SpendingViewProvider>
              <NavigateToBinder />
              <SpendingDataBinder />
              <AppShell />
            </SpendingViewProvider>
          </ToastProvider>
        </AgentProvider>
      </PageProvider>
    </PersonaProvider>
  )
}
