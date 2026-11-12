import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ShoppingCart } from 'lucide-react'
import { ListRow } from '../components/ListRow'
import { IconBadge } from '../components/IconBadge'

describe('ListRow', () => {
  it('renders title, subtitle, and right slot', () => {
    render(
      <ListRow
        icon={<IconBadge icon={ShoppingCart} tone="green" />}
        title="Waitrose & Partners"
        subtitle="Groceries · Today"
        right={<span>£64.20</span>}
      />,
    )
    expect(screen.getByText('Waitrose & Partners')).toBeInTheDocument()
    expect(screen.getByText('Groceries · Today')).toBeInTheDocument()
    expect(screen.getByText('£64.20')).toBeInTheDocument()
  })

  it('renders as a button when onClick is provided and dispatches', () => {
    const onClick = vi.fn()
    render(
      <ListRow
        icon={<IconBadge icon={ShoppingCart} tone="green" />}
        title="Settings"
        onClick={onClick}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /settings/i }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders as a div when no onClick is provided', () => {
    render(
      <ListRow icon={<IconBadge icon={ShoppingCart} tone="green" />} title="Static" />,
    )
    expect(screen.queryByRole('button')).toBeNull()
  })
})
