import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MotionConfig } from 'framer-motion'
import { PageTransition } from '../components/PageTransition'

function withReducedMotion(ui: React.ReactNode) {
  return <MotionConfig reducedMotion="always">{ui}</MotionConfig>
}

describe('PageTransition', () => {
  it('renders its children', () => {
    render(withReducedMotion(
      <PageTransition pageKey="home" direction="forward">
        <div>Home content</div>
      </PageTransition>,
    ))
    expect(screen.getByText('Home content')).toBeInTheDocument()
  })

  it('switches children when pageKey changes', async () => {
    const { rerender } = render(withReducedMotion(
      <PageTransition pageKey="home" direction="forward">
        <div>Home content</div>
      </PageTransition>,
    ))
    expect(screen.getByText('Home content')).toBeInTheDocument()
    rerender(withReducedMotion(
      <PageTransition pageKey="mortgage" direction="forward">
        <div>Mortgage content</div>
      </PageTransition>,
    ))
    expect(await screen.findByText('Mortgage content')).toBeInTheDocument()
  })
})
