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

  it('uses green tone styling by default', () => {
    render(<IconBadge icon={ShoppingCart} tone="green" data-testid="b" />)
    const el = screen.getByTestId('b')
    expect(el.style.backgroundColor).toBe('rgba(10, 77, 53, 0.1)')
    expect(el.style.color).toBe('rgb(10, 77, 53)')
  })

  it('uses gold tone styling', () => {
    render(<IconBadge icon={ShoppingCart} tone="gold" data-testid="b" />)
    const el = screen.getByTestId('b')
    expect(el.style.backgroundColor).toBe('rgba(200, 155, 60, 0.12)')
    expect(el.style.color).toBe('rgb(200, 155, 60)')
  })
})

describe('iconForCategory', () => {
  it('returns the right icon + tone for each category', () => {
    expect(iconForCategory('groceries').tone).toBe('green')
    expect(iconForCategory('coffee_shops').tone).toBe('gold')
    expect(iconForCategory('transport').tone).toBe('green')
    expect(iconForCategory('subscriptions').tone).toBe('green')
    expect(iconForCategory('eating_out').tone).toBe('gold')
    expect(iconForCategory('shopping').tone).toBe('green')
    expect(iconForCategory('bills').tone).toBe('green')
    expect(iconForCategory('entertainment').tone).toBe('gold')
    expect(iconForCategory('income').tone).toBe('gold')
  })

  it('returns a fallback for unknown categories', () => {
    const { tone, icon } = iconForCategory('mystery' as never)
    expect(tone).toBe('muted')
    expect(icon).toBeDefined()
  })
})
