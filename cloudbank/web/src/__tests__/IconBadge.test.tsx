import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ShoppingCart } from 'lucide-react'
import { IconBadge } from '../components/IconBadge'
import { iconForCategory } from '../components/iconForCategory'

describe('IconBadge', () => {
  it('renders the icon inside a circular tinted container', () => {
    render(<IconBadge icon={ShoppingCart} tone="green" data-testid="b" />)
    const el = screen.getByTestId('b')
    expect(el).toHaveClass('rounded-full')
    expect(el.querySelector('svg')).not.toBeNull()
  })

  it('applies distinct green and gold editorial tone styles', () => {
    const { rerender } = render(<IconBadge icon={ShoppingCart} tone="green" data-testid="b" />)
    const greenBg = screen.getByTestId('b').style.backgroundColor
    expect(greenBg).toContain('10, 77, 53')

    rerender(<IconBadge icon={ShoppingCart} tone="gold" data-testid="b" />)
    const goldBg = screen.getByTestId('b').style.backgroundColor
    expect(goldBg).toContain('184, 137, 46')
  })
})

describe('iconForCategory', () => {
  it('returns the right icon + tone for each category and muted fallback for unknown', () => {
    expect(iconForCategory('groceries').tone).toBe('green')
    expect(iconForCategory('coffee_shops').tone).toBe('gold')
    expect(iconForCategory('subscriptions').tone).toBe('green')
    expect(iconForCategory('income').tone).toBe('gold')
    expect(iconForCategory('mystery' as never).tone).toBe('muted')
  })
})
