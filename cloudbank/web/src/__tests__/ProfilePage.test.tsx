import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ProfilePage } from '../pages/ProfilePage'
import { ToastProvider } from '../components/ToastProvider'
import { PersonaProvider } from '../personas/PersonaProvider'
import { AgentContext } from '../agent/AgentProvider'

function makeAgent() {
  return {
    phase: 'ready' as const,
    connState: 'ready' as const,
    micState: 'idle' as const,
    sessionId: 'sess-1',
    turns: [],
    diagnostics: [],
    activeAgentName: 'root_agent',
    latestUiState: null,
    latestUiTier: null,
    transcript: null,
    agentText: null,
    errorMessage: null,
    micDenied: false,
    pushToTalk: true,
    beginTalking: vi.fn().mockResolvedValue(undefined),
    endTalking: vi.fn(),
    startMic: vi.fn().mockResolvedValue(undefined),
    stopMic: vi.fn(),
    submitText: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
  }
}

function renderProfile(agent = makeAgent()) {
  render(
    <PersonaProvider>
      <AgentContext.Provider value={agent}>
        <ToastProvider>
          <ProfilePage />
        </ToastProvider>
      </AgentContext.Provider>
    </PersonaProvider>,
  )
  return agent
}

describe('ProfilePage', () => {
  it('renders customer identity, card freeze controls, and specialist support numbers', () => {
    renderProfile()
    expect(screen.getByText('Chloe Williams')).toBeInTheDocument()
    expect(screen.getByText('chloe.williams@example.com')).toBeInTheDocument()
    expect(screen.getByText('Debit Card Controls')).toBeInTheDocument()
    expect(screen.getByText(/0808 157 0100/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Freeze card' }))
    expect(screen.getByRole('button', { name: 'Unfreeze' })).toBeInTheDocument()
  })

  it('calls agent.disconnect on Log out and reconnects on Sign back in', () => {
    const a = renderProfile()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /log out securely/i }))
    })
    expect(a.disconnect).toHaveBeenCalled()
    expect(screen.getByText(/signed out/i)).toBeInTheDocument()

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /sign back in/i }))
    })
    expect(a.reconnect).toHaveBeenCalled()
  })
})
