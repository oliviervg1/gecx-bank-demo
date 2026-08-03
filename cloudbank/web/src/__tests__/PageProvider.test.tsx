import { describe, it, expect } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { PageProvider, usePage, ALL_PAGES } from '../pages/PageProvider'

function Probe() {
  const { page, navigateTo, direction } = usePage()
  return (
    <div>
      <span data-testid="page">{page}</span>
      <span data-testid="direction">{direction}</span>
      <button onClick={() => navigateTo('spending')}>spending</button>
      <button onClick={() => navigateTo('home')}>home</button>
      <button onClick={() => navigateTo('profile')}>profile</button>
    </div>
  )
}

describe('PageProvider', () => {
  it('exposes exactly the 4 page ids in tab order', () => {
    expect(ALL_PAGES).toEqual(['home', 'spending', 'mortgage', 'profile'])
  })

  it('defaults to home', () => {
    render(<PageProvider><Probe /></PageProvider>)
    expect(screen.getByTestId('page').textContent).toBe('home')
    expect(screen.getByTestId('direction').textContent).toBe('forward')
  })

  it('reports forward direction when navigating to a tab with a higher index', () => {
    render(<PageProvider><Probe /></PageProvider>)
    act(() => { fireEvent.click(screen.getByText('spending')) })
    expect(screen.getByTestId('page').textContent).toBe('spending')
    expect(screen.getByTestId('direction').textContent).toBe('forward')
  })

  it('reports back direction when navigating to a tab with a lower index', () => {
    render(<PageProvider><Probe /></PageProvider>)
    act(() => { fireEvent.click(screen.getByText('profile')) })
    expect(screen.getByTestId('direction').textContent).toBe('forward')
    act(() => { fireEvent.click(screen.getByText('home')) })
    expect(screen.getByTestId('direction').textContent).toBe('back')
  })
})
