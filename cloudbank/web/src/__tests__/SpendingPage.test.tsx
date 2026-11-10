import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MotionConfig } from 'framer-motion'
import { SpendingPage } from '../pages/SpendingPage'
import { PersonaProvider } from '../personas/PersonaProvider'
import {
  SpendingViewProvider,
  useSpendingView,
  type SpendingViewState,
} from '../agent/SpendingViewProvider'

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: 400,
      height: 240,
      top: 0,
      left: 0,
      bottom: 240,
      right: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
  }
})
afterAll(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
})

let setView: ((next: SpendingViewState) => void) | null = null
function SetViewProbe() {
  setView = useSpendingView().setView
  return null
}

function renderSpending() {
  setView = null
  return render(
    <MotionConfig reducedMotion="always">
      <PersonaProvider initialDemoDate="2026-11-24">
        <SpendingViewProvider>
          <SetViewProbe />
          <SpendingPage />
        </SpendingViewProvider>
      </PersonaProvider>
    </MotionConfig>,
  )
}

describe('SpendingPage (view switcher)', () => {
  it('renders November spending headline (£2,018.64) and flagged Netflix anomaly banner', () => {
    renderSpending()
    expect(screen.getByText('£2,018.64')).toBeInTheDocument()
    expect(screen.getByTestId('anomaly-banner')).toHaveTextContent('Netflix')
  })

  it('switches across category, subscriptions, vendor, and trend views cleanly', async () => {
    renderSpending()

    await act(async () => {
      setView!({ view: 'category', category: 'coffee_shops' })
    })
    expect(await screen.findByText(/Spending › Coffee shops/)).toBeInTheDocument()

    await act(async () => {
      setView!({ view: 'subscriptions' })
    })
    expect(await screen.findByText(/Spending › Subscriptions/)).toBeInTheDocument()

    await act(async () => {
      setView!({ view: 'vendor', vendor: 'Tesco' })
    })
    expect(await screen.findByText(/Spending › Tesco/)).toBeInTheDocument()

    await act(async () => {
      setView!({ view: 'trend', category: 'groceries' })
    })
    expect(await screen.findByText(/Spending › Trend › Groceries/)).toBeInTheDocument()
  })
})
