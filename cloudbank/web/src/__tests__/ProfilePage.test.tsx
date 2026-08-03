import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ProfilePage } from '../pages/ProfilePage'
import { ToastProvider } from '../components/ToastProvider'
import { PersonaProvider } from '../personas/PersonaProvider'
import { AgentContext } from '../agent/AgentProvider'
import type { Registry } from '../agent/clientFunctions'

function makeAgent() {
  return {
    connState: 'ready' as const, micState: 'idle' as const,
    transcript: null, agentText: null, errorMessage: null,
    registry: { register: () => {}, unregister: () => {}, dispatch: async () => ({ id: '', response: {} }) } as unknown as Registry,
    startMic: vi.fn().mockResolvedValue(undefined),
    stopMic: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
  }
}

function renderProfile(agent = makeAgent()) {
  render(
    <PersonaProvider>
      <AgentContext.Provider value={agent as never}>
        <ToastProvider><ProfilePage /></ToastProvider>
      </AgentContext.Provider>
    </PersonaProvider>,
  )
  return agent
}

describe('ProfilePage', () => {
  it('renders the user identity from the fixture', () => {
    renderProfile()
    expect(screen.getByText('Chloe Williams')).toBeInTheDocument()
    expect(screen.getByText('chloe.williams@example.com')).toBeInTheDocument()
    expect(screen.getByText('CW')).toBeInTheDocument()
  })

  it('renders the 4 settings rows', () => {
    renderProfile()
    expect(screen.getByText('Personal Details')).toBeInTheDocument()
    expect(screen.getByText('Notifications')).toBeInTheDocument()
    expect(screen.getByText('Privacy & Security')).toBeInTheDocument()
    expect(screen.getByText('Help & Support')).toBeInTheDocument()
  })

  it('Personal Details tap fires a "Coming soon" toast', () => {
    renderProfile()
    fireEvent.click(screen.getByRole('button', { name: /personal details/i }))
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument()
  })

  it('Log out tap calls agent.disconnect and shows the logged-out placeholder', () => {
    const a = renderProfile()
    act(() => { fireEvent.click(screen.getByRole('button', { name: /log out securely/i })) })
    expect(a.disconnect).toHaveBeenCalled()
    expect(screen.getByText(/you've been logged out/i)).toBeInTheDocument()
  })

  it('renders the app-version footnote', () => {
    renderProfile()
    expect(screen.getByText('App Version 4.2.1')).toBeInTheDocument()
  })
})
