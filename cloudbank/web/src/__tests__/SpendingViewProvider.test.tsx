import { describe, it, expect } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  SpendingViewProvider,
  useSpendingView,
} from '../agent/SpendingViewProvider'

let captured: ReturnType<typeof useSpendingView> | null = null

function Probe() {
  captured = useSpendingView()
  return null
}

function renderWithProvider() {
  captured = null
  return render(
    <SpendingViewProvider>
      <Probe />
    </SpendingViewProvider>,
  )
}

describe('SpendingViewProvider', () => {
  it('defaults to overview view', () => {
    renderWithProvider()
    expect(captured?.view).toBe('overview')
    expect(captured?.category).toBeUndefined()
    expect(captured?.vendor).toBeUndefined()
  })

  it('setView({view:category_drilldown, category}) updates state', async () => {
    renderWithProvider()
    await act(async () => {
      captured?.setView({ view: 'category_drilldown', category: 'coffee_shops' })
    })
    expect(captured?.view).toBe('category_drilldown')
    expect(captured?.category).toBe('coffee_shops')
  })

  it('setView({view:vendor_history, vendor}) updates state', async () => {
    renderWithProvider()
    await act(async () => {
      captured?.setView({ view: 'vendor_history', vendor: 'Tesco' })
    })
    expect(captured?.view).toBe('vendor_history')
    expect(captured?.vendor).toBe('Tesco')
  })

  it('setView({view:overview}) clears category and vendor', async () => {
    renderWithProvider()
    await act(async () => {
      captured?.setView({ view: 'category_drilldown', category: 'coffee_shops' })
    })
    expect(captured?.category).toBe('coffee_shops')
    await act(async () => {
      captured?.setView({ view: 'overview' })
    })
    expect(captured?.view).toBe('overview')
    expect(captured?.category).toBeUndefined()
    expect(captured?.vendor).toBeUndefined()
  })
})

function DirectionProbe() {
  const { view, setView, direction } = useSpendingView()
  return (
    <div>
      <span data-testid="view">{view}</span>
      <span data-testid="direction">{direction}</span>
      <button onClick={() => setView({ view: 'category_drilldown', category: 'coffee_shops' })}>drill</button>
      <button onClick={() => setView({ view: 'overview' })}>overview</button>
    </div>
  )
}

describe('SpendingViewProvider direction', () => {
  it('starts in forward direction', () => {
    render(<SpendingViewProvider><DirectionProbe /></SpendingViewProvider>)
    expect(screen.getByTestId('direction').textContent).toBe('forward')
  })

  it('reports forward when entering a sub-view from overview', () => {
    render(<SpendingViewProvider><DirectionProbe /></SpendingViewProvider>)
    act(() => { fireEvent.click(screen.getByText('drill')) })
    expect(screen.getByTestId('view').textContent).toBe('category_drilldown')
    expect(screen.getByTestId('direction').textContent).toBe('forward')
  })

  it('reports back when returning to overview from a sub-view', () => {
    render(<SpendingViewProvider><DirectionProbe /></SpendingViewProvider>)
    act(() => { fireEvent.click(screen.getByText('drill')) })
    act(() => { fireEvent.click(screen.getByText('overview')) })
    expect(screen.getByTestId('view').textContent).toBe('overview')
    expect(screen.getByTestId('direction').textContent).toBe('back')
  })
})
