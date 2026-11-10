import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TabBar } from '../components/TabBar'
import { PageContext } from '../pages/PageProvider'

function withPage(page: string, navigateTo = vi.fn()) {
  return (
    <PageContext.Provider
      value={{ page: page as never, navigateTo, direction: 'forward' } as never}
    >
      <TabBar />
    </PageContext.Provider>
  )
}

describe('TabBar (5 tabs)', () => {
  it('renders all 5 tab labels (Home, Spending, Savings, Mortgage, Profile)', () => {
    render(withPage('home'))
    expect(screen.getByText('Home')).toBeInTheDocument()
    expect(screen.getByText('Spending')).toBeInTheDocument()
    expect(screen.getByText('Savings')).toBeInTheDocument()
    expect(screen.getByText('Mortgage')).toBeInTheDocument()
    expect(screen.getByText('Profile')).toBeInTheDocument()
  })

  it('marks the active tab with data-active="true"', () => {
    render(withPage('savings'))
    expect(screen.getByRole('button', { name: /savings/i })).toHaveAttribute(
      'data-active',
      'true',
    )
    expect(screen.getByRole('button', { name: /^home$/i })).toHaveAttribute(
      'data-active',
      'false',
    )
  })

  it('calls navigateTo(pageId) when a tab is clicked', () => {
    const nav = vi.fn()
    render(withPage('home', nav))
    fireEvent.click(screen.getByRole('button', { name: /savings/i }))
    expect(nav).toHaveBeenCalledWith('savings')
  })
})
