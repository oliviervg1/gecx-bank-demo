import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Card } from '../components/Card'
import { HeroCard } from '../components/HeroCard'

describe('Card', () => {
  it('renders children inside a white surface', () => {
    render(<Card>Hello</Card>)
    const el = screen.getByText('Hello').closest('[data-card]')
    expect(el).not.toBeNull()
    expect(el).toHaveClass('bg-brand-card')
  })

  it('renders as a button when onClick is provided and dispatches the click', () => {
    const onClick = vi.fn()
    render(<Card onClick={onClick}>Tap me</Card>)
    const btn = screen.getByRole('button', { name: /tap me/i })
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders as a div (non-tappable) when no onClick is provided', () => {
    render(<Card>Static</Card>)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('HeroCard', () => {
  it('renders with the forest-green background and white text', () => {
    render(<HeroCard>Balance</HeroCard>)
    const el = screen.getByText('Balance').closest('[data-card]')
    expect(el).toHaveClass('bg-brand-green')
    expect(el).toHaveClass('text-white')
  })
})
