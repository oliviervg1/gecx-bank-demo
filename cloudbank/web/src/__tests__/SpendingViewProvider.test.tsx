import { describe, it, expect } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { SpendingViewProvider, useSpendingView } from '../agent/SpendingViewProvider'
import { PageProvider, usePage } from '../pages/PageProvider'

let captured: ReturnType<typeof useSpendingView> | null = null
let capturedPage: string | null = null

function Probe() {
  captured = useSpendingView()
  capturedPage = usePage().page
  return null
}

function renderWithProvider() {
  captured = null
  capturedPage = null
  return render(
    <PageProvider>
      <SpendingViewProvider>
        <Probe />
      </SpendingViewProvider>
    </PageProvider>,
  )
}

describe('SpendingViewProvider & unified ui_view_state sync', () => {
  it('defaults to overview and this_month with zeroed calculators', () => {
    renderWithProvider()
    expect(captured?.view).toBe('overview')
    expect(captured?.period).toBe('this_month')
    expect(captured?.extraMonthlyPence).toBe(0)
    expect(captured?.monthlyOverpaymentPence).toBe(0)
  })

  it('updates view, category, vendor, and direction via setView', async () => {
    renderWithProvider()
    await act(async () => {
      captured?.setView({ view: 'category', category: 'coffee_shops' })
    })
    expect(captured?.view).toBe('category')
    expect(captured?.category).toBe('coffee_shops')
    expect(captured?.direction).toBe('forward')

    await act(async () => {
      captured?.setView({ view: 'overview' })
    })
    expect(captured?.view).toBe('overview')
    expect(captured?.category).toBeUndefined()
    expect(captured?.direction).toBe('back')
  })

  it('synchronizes page, calculators, and anomaly_status via applyServerUiState and resets cleanly', async () => {
    renderWithProvider()
    await act(async () => {
      captured?.applyServerUiState({
        seq: 1,
        page: 'spending',
        view: 'overview',
        period: 'last_month',
        highlight_vendor: 'Netflix',
        anomaly_status: 'confirmed',
      })
    })
    expect(capturedPage).toBe('spending')
    expect(captured?.period).toBe('last_month')
    expect(captured?.highlightVendor).toBe('Netflix')
    expect(captured?.anomalyStatus).toBe('confirmed')

    await act(async () => {
      captured?.applyServerUiState({
        seq: 2,
        page: 'savings',
        extra_monthly_pence: 4500,
        custom_target_pence: 1500000,
      })
    })
    expect(capturedPage).toBe('savings')
    expect(captured?.extraMonthlyPence).toBe(4500)
    expect(captured?.customTargetPence).toBe(1500000)

    await act(async () => {
      captured?.resetUiState()
    })
    expect(capturedPage).toBe('home')
    expect(captured?.extraMonthlyPence).toBe(0)
    expect(captured?.anomalyStatus).toBe('')
  })
})

function DirectionProbe() {
  const { view, setView, direction } = useSpendingView()
  return (
    <div>
      <span data-testid="view">{view}</span>
      <span data-testid="direction">{direction}</span>
      <button onClick={() => setView({ view: 'category', category: 'coffee_shops' })}>drill</button>
      <button onClick={() => setView({ view: 'overview' })}>overview</button>
    </div>
  )
}

describe('SpendingViewProvider direction', () => {
  it('tracks forward into subview and back into overview', () => {
    render(
      <SpendingViewProvider>
        <DirectionProbe />
      </SpendingViewProvider>,
    )
    act(() => {
      fireEvent.click(screen.getByText('drill'))
    })
    expect(screen.getByTestId('view').textContent).toBe('category')
    expect(screen.getByTestId('direction').textContent).toBe('forward')

    act(() => {
      fireEvent.click(screen.getByText('overview'))
    })
    expect(screen.getByTestId('view').textContent).toBe('overview')
    expect(screen.getByTestId('direction').textContent).toBe('back')
  })
})
