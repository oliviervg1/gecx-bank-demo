import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TabBar } from '../components/TabBar'
import { PageContext } from '../pages/PageProvider'

function withPage(page: string, navigateTo = vi.fn()) {
  return (
    <PageContext.Provider value={{ page: page as never, navigateTo, direction: 'forward' } as never}>
      <TabBar />
    </PageContext.Provider>
  )
}

describe('TabBar', () => {
  it('renders all 4 tab labels', () => {
    render(withPage('home'))
    expect(screen.getByText('Home')).toBeInTheDocument()
    expect(screen.getByText('Spending')).toBeInTheDocument()
    expect(screen.getByText('Mortgage')).toBeInTheDocument()
    expect(screen.getByText('Profile')).toBeInTheDocument()
  })

  it('marks the active tab with the green indicator class', () => {
    render(withPage('spending'))
    const spendingButton = screen.getByRole('button', { name: /spending/i })
    expect(spendingButton).toHaveAttribute('data-active', 'true')
    const homeButton = screen.getByRole('button', { name: /^home$/i })
    expect(homeButton).toHaveAttribute('data-active', 'false')
  })

  it('calls navigateTo(pageId) when a tab is tapped', () => {
    const nav = vi.fn()
    render(withPage('home', nav))
    fireEvent.click(screen.getByRole('button', { name: /mortgage/i }))
    expect(nav).toHaveBeenCalledWith('mortgage')
  })
})
