import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MotionConfig } from 'framer-motion'
import { SpendingPage } from '../pages/SpendingPage'
import { PersonaProvider } from '../personas/PersonaProvider'
import { AgentRegistryContext } from '../agent/AgentRegistryContext'
import {
  SpendingViewProvider,
  useSpendingView,
  type SpendingViewState,
} from '../agent/SpendingViewProvider'
import { ToastProvider } from '../components/ToastProvider'
import { createRegistry } from '../agent/clientFunctions'

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: 400, height: 240, top: 0, left: 0, bottom: 240, right: 400, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect
  }
})
afterAll(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
})

// Capture setView so tests can drive view changes the same way the production
// SpendingDataBinder does (via the get_* tools' `show` flag side effect). This
// keeps SpendingPage tests focused on rendering behaviour, not on the agent
// tool plumbing.
let setView: ((next: SpendingViewState) => void) | null = null
function SetViewProbe() {
  setView = useSpendingView().setView
  return null
}

function renderSpending() {
  setView = null
  // MotionConfig reducedMotion="always" collapses framer-motion's transitions
  // to opacity-only ~80ms — without this, the AnimatePresence(mode="wait") in
  // SpendingPage keeps the outgoing sub-view mounted while the exit animation
  // plays, and synchronous getByText after dispatch fires before the new
  // sub-view's text exists in the DOM.
  return render(
    <MotionConfig reducedMotion="always">
      <PersonaProvider>
        <AgentRegistryContext.Provider value={createRegistry()}>
          <ToastProvider>
            <SpendingViewProvider>
              <SetViewProbe />
              <SpendingPage />
            </SpendingViewProvider>
          </ToastProvider>
        </AgentRegistryContext.Provider>
      </PersonaProvider>
    </MotionConfig>,
  )
}

describe('SpendingPage (view switcher)', () => {
  it('renders the "Spending" page title with search + filter buttons', () => {
    renderSpending()
    expect(screen.getByText('Spending')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /filter/i })).toBeInTheDocument()
  })

  it('renders the RECENT label and a transactions list with ListRow per transaction', () => {
    renderSpending()
    expect(screen.getByText('RECENT')).toBeInTheDocument()
    expect(screen.getAllByText('Netflix').length).toBeGreaterThan(0)
  })

  it('does NOT render a pie chart in the Overview', () => {
    renderSpending()
    expect(document.querySelector('[data-chart-slot="category_chart"]')).toBeNull()
  })

  it('switches to category_drilldown when setView is called', async () => {
    renderSpending()
    await act(async () => {
      setView!({ view: 'category_drilldown', category: 'coffee_shops' })
    })
    // findByText waits for the AnimatePresence(mode="wait") exit + enter cycle
    // before the new sub-view's breadcrumb appears in the DOM.
    expect(await screen.findByText(/Spending › Coffee shops/)).toBeInTheDocument()
  })

  it('switches to subscriptions_audit when setView is called', async () => {
    renderSpending()
    await act(async () => {
      setView!({ view: 'subscriptions_audit' })
    })
    expect(await screen.findByText(/Spending › Subscriptions/)).toBeInTheDocument()
  })

  it('switches to vendor_history when setView is called', async () => {
    renderSpending()
    await act(async () => {
      setView!({ view: 'vendor_history', vendor: 'Tesco' })
    })
    expect(await screen.findByText(/Spending › Tesco/)).toBeInTheDocument()
  })

  it('switches to monthly_trend (overall) when setView is called', async () => {
    renderSpending()
    await act(async () => {
      setView!({ view: 'monthly_trend' })
    })
    expect(await screen.findByText(/Spending › Trend$/)).toBeInTheDocument()
  })
})
