import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConciergePill } from '../components/ConciergePill'
import { AgentContext, type AgentContextValue } from '../agent/AgentProvider'

function makeAgent(overrides: Partial<AgentContextValue> = {}): AgentContextValue {
  return {
    phase: 'ready',
    connState: 'ready',
    micState: 'idle',
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
    pushToTalk: false,
    beginTalking: vi.fn().mockResolvedValue(undefined),
    endTalking: vi.fn(),
    startMic: vi.fn().mockResolvedValue(undefined),
    stopMic: vi.fn(),
    submitText: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    ...overrides,
  }
}

function withAgent(value: AgentContextValue) {
  return (
    <AgentContext.Provider value={value}>
      <ConciergePill />
    </AgentContext.Provider>
  )
}

describe('ConciergePill', () => {
  beforeEach(() => {
    Object.assign(HTMLElement.prototype, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    })
  })

  it('shows "Talk to concierge" in always-on mode and calls startMic on click', () => {
    const v = makeAgent({ pushToTalk: false })
    render(withAgent(v))
    expect(screen.getByText('Talk to concierge')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(v.startMic).toHaveBeenCalled()
  })

  it('shows "Session paused — hold to talk" on idle expiry (phase="paused") and holds cleanly', () => {
    const v = makeAgent({ pushToTalk: true, phase: 'paused', connState: 'idle' })
    render(withAgent(v))
    expect(screen.getByText('Session paused — hold to talk')).toBeInTheDocument()
    const pill = screen.getByRole('button')
    fireEvent.pointerDown(pill, { pointerId: 1 })
    expect(v.beginTalking).toHaveBeenCalledTimes(1)
  })

  it('shows "Hold to talk" when ready in push-to-talk mode and "Release to send" when capturing', () => {
    const { rerender } = render(withAgent(makeAgent({ pushToTalk: true, phase: 'ready' })))
    expect(screen.getByText('Hold to talk')).toBeInTheDocument()

    rerender(
      withAgent(makeAgent({ pushToTalk: true, phase: 'capturing', micState: 'held' })),
    )
    expect(screen.getByText('Release to send')).toBeInTheDocument()
  })

  it('allows holding during agentSpeaking for deliberate barge-in while ignoring plain clicks', () => {
    const v = makeAgent({ pushToTalk: true, phase: 'agentSpeaking', micState: 'speaking' })
    render(withAgent(v))
    expect(screen.getByText('Speaking')).toBeInTheDocument()
    const pill = screen.getByRole('button')
    fireEvent.click(pill)
    expect(v.stopMic).not.toHaveBeenCalled()
    fireEvent.pointerDown(pill, { pointerId: 1 })
    expect(v.beginTalking).toHaveBeenCalledTimes(1)
  })

  it('does not hold while connecting', () => {
    const v = makeAgent({ pushToTalk: true, phase: 'connecting', connState: 'connecting' })
    render(withAgent(v))
    expect(screen.getByText('Connecting…')).toBeInTheDocument()
    fireEvent.pointerDown(screen.getByRole('button'), { pointerId: 1 })
    expect(v.beginTalking).not.toHaveBeenCalled()
  })

  it('shows "Reconnect" on transport error and calls reconnect on click', () => {
    const v = makeAgent({ pushToTalk: false, phase: 'error', connState: 'error' })
    render(withAgent(v))
    expect(screen.getByText('Reconnect')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(v.reconnect).toHaveBeenCalledTimes(1)
  })

  it('uses plain executive tooltip copy instead of leaking raw errorMessage on hover', () => {
    const { rerender } = render(
      withAgent(
        makeAgent({
          pushToTalk: false,
          phase: 'error',
          connState: 'error',
          errorMessage:
            'Connection error. Check that the localhost proxy is running on port 8080. upstream closed (1006)',
        }),
      ),
    )
    const pill = screen.getByRole('button')
    expect(pill).toHaveAttribute('title', 'Select Reconnect to start a new concierge session')
    expect(pill.getAttribute('title')).not.toContain('8080')
    expect(pill.getAttribute('title')).not.toContain('1006')
    expect(pill.getAttribute('title')).not.toContain('proxy')

    rerender(
      withAgent(
        makeAgent({
          pushToTalk: true,
          phase: 'error',
          connState: 'ready',
          micState: 'muted',
          micDenied: true,
          errorMessage: 'Audio capture failed (NotAllowedError: Permission denied). Hold to retry.',
        }),
      ),
    )
    expect(pill).toHaveAttribute(
      'title',
      'Allow microphone access in your browser, then hold to talk',
    )
    expect(pill.getAttribute('title')).not.toContain('NotAllowedError')
  })
})
