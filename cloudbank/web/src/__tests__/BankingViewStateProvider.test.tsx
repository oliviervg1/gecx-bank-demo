import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  BankingViewStateProvider,
  useBankingViewState,
} from '../agent/BankingViewStateProvider'
import { PageProvider, usePage } from '../pages/PageProvider'

let captured: ReturnType<typeof useBankingViewState> | null = null
let capturedPage: string | null = null

function Probe() {
  captured = useBankingViewState()
  capturedPage = usePage().page
  return null
}

function renderWithProvider() {
  captured = null
  capturedPage = null
  return render(
    <PageProvider>
      <BankingViewStateProvider>
        <Probe />
      </BankingViewStateProvider>
    </PageProvider>,
  )
}

describe('BankingViewStateProvider & unified ui_view_state sync', () => {
  it('throws when useBankingViewState is used outside BankingViewStateProvider', () => {
    function BareProbe() {
      useBankingViewState()
      return null
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<BareProbe />)).toThrow(/useBankingViewState/i)
    spy.mockRestore()
  })

  it('defaults to overview and this_month with zeroed calculators', () => {
    renderWithProvider()
    expect(captured?.view).toBe('overview')
    expect(captured?.period).toBe('this_month')
    expect(captured?.extraMonthlyPence).toBe(0)
    expect(captured?.monthlyOverpaymentPence).toBe(0)
    expect(captured?.navigationAnnouncement).toBe('')
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

  it('synchronizes page, calculators, anomaly_status, and polite navigation announcements via applyServerUiState', async () => {
    renderWithProvider()
    await act(async () => {
      captured?.applyServerUiState({
        seq: 1,
        page: 'spending',
        view: 'subscriptions',
        period: 'last_month',
        highlight_vendor: 'Netflix',
        anomaly_status: 'confirmed',
      })
    })
    expect(capturedPage).toBe('spending')
    expect(captured?.period).toBe('last_month')
    expect(captured?.highlightVendor).toBe('Netflix')
    expect(captured?.anomalyStatus).toBe('confirmed')
    expect(captured?.navigationAnnouncement).toBe('Showing Spending: Subscriptions')

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
    expect(captured?.navigationAnnouncement).toBe('Showing Savings')

    await act(async () => {
      captured?.resetUiState()
    })
    expect(capturedPage).toBe('home')
    expect(captured?.extraMonthlyPence).toBe(0)
    expect(captured?.anomalyStatus).toBe('')
    expect(captured?.navigationAnnouncement).toBe('')
  })
})

function DirectionProbe() {
  const { view, setView, direction } = useBankingViewState()
  return (
    <div>
      <span data-testid="view">{view}</span>
      <span data-testid="direction">{direction}</span>
      <button onClick={() => setView({ view: 'category', category: 'coffee_shops' })}>drill</button>
      <button onClick={() => setView({ view: 'overview' })}>overview</button>
    </div>
  )
}

describe('BankingViewStateProvider direction', () => {
  it('tracks forward into subview and back into overview', () => {
    render(
      <BankingViewStateProvider>
        <DirectionProbe />
      </BankingViewStateProvider>,
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
