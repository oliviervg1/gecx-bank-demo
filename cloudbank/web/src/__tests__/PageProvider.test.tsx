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
      <button onClick={() => navigateTo('savings')}>savings</button>
      <button onClick={() => navigateTo('home')}>home</button>
      <button onClick={() => navigateTo('profile')}>profile</button>
    </div>
  )
}

describe('PageProvider', () => {
  it('exposes all 5 page IDs in tab order', () => {
    expect(ALL_PAGES).toEqual(['home', 'spending', 'savings', 'mortgage', 'profile'])
  })

  it('defaults to home and tracks forward/back tab index transitions', () => {
    render(
      <PageProvider>
        <Probe />
      </PageProvider>,
    )
    expect(screen.getByTestId('page').textContent).toBe('home')
    expect(screen.getByTestId('direction').textContent).toBe('forward')

    act(() => {
      fireEvent.click(screen.getByText('savings'))
    })
    expect(screen.getByTestId('page').textContent).toBe('savings')
    expect(screen.getByTestId('direction').textContent).toBe('forward')

    act(() => {
      fireEvent.click(screen.getByText('home'))
    })
    expect(screen.getByTestId('page').textContent).toBe('home')
    expect(screen.getByTestId('direction').textContent).toBe('back')
  })
})
