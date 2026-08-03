import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HomePage } from '../pages/home/HomePage'
import { PersonaProvider } from '../personas/PersonaProvider'
import { PageProvider } from '../pages/PageProvider'

function renderHome() {
  return render(
    <PersonaProvider>
      <PageProvider>
        <HomePage />
      </PageProvider>
    </PersonaProvider>,
  )
}

describe('HomePage', () => {
  it('renders the Overview title', () => {
    renderHome()
    expect(screen.getByText('Overview')).toBeInTheDocument()
  })

  it('renders the Current Account hero with a Spending action', () => {
    renderHome()
    expect(screen.getByText('Current Account')).toBeInTheDocument()
    expect(screen.getByText("This Month's Spending")).toBeInTheDocument()
    expect(screen.getByText(/Analyze/)).toBeInTheDocument()
  })

  it('renders the Mortgage card with a Manage action', () => {
    renderHome()
    expect(screen.getByText('Mortgage')).toBeInTheDocument()
    expect(screen.getByText(/Next Payment/)).toBeInTheDocument()
    expect(screen.getByText(/Manage/)).toBeInTheDocument()
  })

  it('renders the AI Concierge Insights card with a sentence about spending', () => {
    renderHome()
    expect(screen.getByText('AI Concierge Insights')).toBeInTheDocument()
    expect(screen.getByText(/spent £/)).toBeInTheDocument()
  })
})
