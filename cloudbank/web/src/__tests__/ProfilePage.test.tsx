import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MotionConfig } from 'framer-motion'
import App from '../App'
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

describe('ProfilePage & app-level sign-out', () => {
  it('renders customer identity, card freeze controls with visible toast, and specialist support numbers', () => {
    renderProfile()
    expect(screen.getByText('Chloe Williams')).toBeInTheDocument()
    expect(screen.getByText('chloe.williams@example.com')).toBeInTheDocument()
    expect(screen.getByText('Debit Card Controls')).toBeInTheDocument()
    expect(screen.getByText(/0808 157 0100/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Freeze card' }))
    expect(screen.getByRole('button', { name: 'Unfreeze' })).toBeInTheDocument()
    expect(screen.getByText('Your debit card is frozen.')).toBeInTheDocument()
  })

  it('calls agent.disconnect({ clearTurns: true }) on standalone Log out and reconnects on Sign back in', () => {
    const a = renderProfile()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /log out securely/i }))
    })
    expect(a.disconnect).toHaveBeenCalledWith({ clearTurns: true })
    expect(screen.getByRole('heading', { level: 1, name: /signed out/i })).toBeInTheDocument()

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /sign back in/i }))
    })
    expect(a.reconnect).toHaveBeenCalled()
  })

  it('lifts Log out securely to app level, hiding TabBar, ConciergePanel, and turns until Sign back in or persona switch', async () => {
    render(
      <MotionConfig reducedMotion="always">
        <App />
      </MotionConfig>,
    )

    // Submit a question so a turn is visible in ConciergePanel, then navigate to Profile.
    const input = screen.getByLabelText('Ask your Cloudbank concierge')
    fireEvent.change(input, { target: { value: 'Secret balance check' } })
    fireEvent.submit(input.closest('form')!)
    expect(screen.getByText('Secret balance check')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Profile' }))
    expect(await screen.findByText('Chloe Williams')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /log out securely/i }))

    // Full app is locked behind signed-out screen: TabBar, ConciergePanel, and transcript are gone!
    expect(screen.getByTestId('signed-out-screen')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: /signed out/i })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: /primary banking navigation/i })).toBeNull()
    expect(screen.queryByTestId('conversation-stream')).toBeNull()
    expect(screen.queryByText('Secret balance check')).toBeNull()

    // Signing back in restores Home with a clean empty transcript!
    fireEvent.click(screen.getByRole('button', { name: /sign back in/i }))
    expect(await screen.findByText('Accounts Overview')).toBeInTheDocument()
    expect(screen.queryByText('Secret balance check')).toBeNull()
  })
})
