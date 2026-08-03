import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SectionHeader } from '../components/SectionHeader'

describe('SectionHeader', () => {
  it('renders the title text', () => {
    render(<SectionHeader title="Overview" />)
    expect(screen.getByText('Overview')).toBeInTheDocument()
  })

  it('renders an optional right slot', () => {
    render(<SectionHeader title="Spending" right={<button>filter</button>} />)
    expect(screen.getByRole('button', { name: 'filter' })).toBeInTheDocument()
  })

  it('uses the page-title size by default', () => {
    render(<SectionHeader title="Overview" />)
    const h = screen.getByText('Overview')
    expect(h.tagName).toBe('H1')
    expect(h).toHaveClass('text-[28px]')
  })

  it('uses a smaller size when variant="section"', () => {
    render(<SectionHeader title="Manage" variant="section" />)
    const h = screen.getByText('Manage')
    expect(h.tagName).toBe('H2')
    expect(h).toHaveClass('text-[18px]')
  })
})
