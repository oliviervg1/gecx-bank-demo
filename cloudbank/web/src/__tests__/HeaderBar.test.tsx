import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HeaderBar } from '../components/HeaderBar'
import { PersonaProvider } from '../personas/PersonaProvider'
import { AgentProvider } from '../agent/AgentProvider'

describe('HeaderBar', () => {
  it('renders the Cloudbank wordmark and the concierge pill', () => {
    render(
      <PersonaProvider>
        <AgentProvider>
          <HeaderBar />
        </AgentProvider>
      </PersonaProvider>,
    )
    expect(screen.getByText('Cloudbank')).toBeInTheDocument()
    expect(document.querySelector('button[type="button"]')).not.toBeNull()
  })
})
