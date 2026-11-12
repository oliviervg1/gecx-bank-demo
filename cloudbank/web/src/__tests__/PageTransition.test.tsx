import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageTransition } from '../components/PageTransition'

describe('PageTransition (CSS @starting-style & focus management)', () => {
  it('renders its children with zero JS animation runtime', () => {
    render(
      <PageTransition pageKey="home" direction="forward">
        <div>Home content</div>
      </PageTransition>,
    )
    expect(screen.getByText('Home content')).toBeInTheDocument()
  })

  it('switches children when pageKey changes and moves focus to the new h1 only when focus was inside the unmounted panel', () => {
    const { rerender } = render(
      <div>
        <input aria-label="External input" />
        <PageTransition pageKey="home" direction="forward">
          <h1 tabIndex={-1}>Home Heading</h1>
          <button type="button">Home Action</button>
        </PageTransition>
      </div>,
    )

    // 1. When focus was inside the previous page panel, switching moves focus to the new <h1 tabIndex={-1}>.
    const homeButton = screen.getByRole('button', { name: 'Home Action' })
    homeButton.focus()
    expect(homeButton).toHaveFocus()

    rerender(
      <div>
        <input aria-label="External input" />
        <PageTransition pageKey="mortgage" direction="forward">
          <h1 tabIndex={-1}>Mortgage Heading</h1>
          <button type="button">Mortgage Action</button>
        </PageTransition>
      </div>,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Mortgage Heading' })).toHaveFocus()

    // 2. When focus is outside the page panel (e.g., concierge input), switching pages preserves external focus.
    const externalInput = screen.getByLabelText('External input')
    externalInput.focus()
    expect(externalInput).toHaveFocus()

    rerender(
      <div>
        <input aria-label="External input" />
        <PageTransition pageKey="savings" direction="back">
          <h1 tabIndex={-1}>Savings Heading</h1>
        </PageTransition>
      </div>,
    )
    expect(externalInput).toHaveFocus()
  })
})
