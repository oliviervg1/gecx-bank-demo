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
    <AgentContext value={value}>
      <ConciergePill />
    </AgentContext>
  )
}

describe('ConciergePill', () => {
  beforeEach(() => {
    Object.assign(HTMLElement.prototype, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    })
  })

  it('shows "Talk to concierge" in continuous mode and calls startMic on click', () => {
    const v = makeAgent({ pushToTalk: false })
    render(withAgent(v))
    expect(screen.getByText('Talk to concierge')).toBeInTheDocument()
    const pill = screen.getByRole('button')
    expect(pill).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(pill)
    expect(v.startMic).toHaveBeenCalled()
  })

  it('shows "Session paused · Hold to talk" on idle expiry (phase="paused") and holds cleanly', () => {
    const v = makeAgent({ pushToTalk: true, phase: 'paused', connState: 'idle' })
    render(withAgent(v))
    expect(screen.getByText('Session paused · Hold to talk')).toBeInTheDocument()
    const pill = screen.getByRole('button')
    fireEvent.pointerDown(pill, { pointerId: 1 })
    expect(v.beginTalking).toHaveBeenCalledTimes(1)
  })

  it('supports accessible Click / Enter toggle-to-talk with aria-pressed in push-to-talk mode without nested aria-live', () => {
    const vReady = makeAgent({ pushToTalk: true, phase: 'ready' })
    const { rerender } = render(withAgent(vReady))
    const pill = screen.getByRole('button', { name: 'Hold to talk' })
    expect(pill).toHaveAttribute('aria-pressed', 'false')
    expect(pill.querySelector('[aria-live]')).toBeNull()

    // Synthetic click (screen reader / Enter / switch control) starts capture.
    fireEvent.click(pill, { detail: 0 })
    expect(vReady.beginTalking).toHaveBeenCalledTimes(1)

    const vCapturing = makeAgent({
      pushToTalk: true,
      phase: 'capturing',
      micState: 'held',
    })
    rerender(withAgent(vCapturing))
    const activePill = screen.getByRole('button', { name: 'Release to send' })
    expect(activePill).toHaveAttribute('aria-pressed', 'true')

    // Second synthetic click ends capture cleanly.
    fireEvent.click(activePill, { detail: 0 })
    expect(vCapturing.endTalking).toHaveBeenCalledTimes(1)
  })

  it('allows holding during agentSpeaking for deliberate barge-in while ignoring pointer clicks', () => {
    const v = makeAgent({ pushToTalk: true, phase: 'agentSpeaking', micState: 'speaking' })
    render(withAgent(v))
    expect(screen.getByText('Speaking')).toBeInTheDocument()
    const pill = screen.getByRole('button')
    fireEvent.click(pill, { detail: 1 })
    expect(v.stopMic).not.toHaveBeenCalled()
    expect(v.beginTalking).not.toHaveBeenCalled()
    fireEvent.pointerDown(pill, { pointerId: 1, button: 0 })
    expect(v.beginTalking).toHaveBeenCalledTimes(1)
  })

  it('uses aria-disabled instead of native disabled while connecting so keyboard focus is never dropped', () => {
    const v = makeAgent({ pushToTalk: true, phase: 'connecting', connState: 'connecting' })
    render(withAgent(v))
    const pill = screen.getByRole('button', { name: 'Connecting…' })
    expect(pill).not.toBeDisabled()
    expect(pill).toHaveAttribute('aria-disabled', 'true')
    pill.focus()
    expect(pill).toHaveFocus()
    fireEvent.pointerDown(pill, { pointerId: 1 })
    fireEvent.click(pill)
    expect(v.beginTalking).not.toHaveBeenCalled()
  })

  it('shows "Reconnect" on transport error without arming mic capture on pointerDown', () => {
    const v = makeAgent({ pushToTalk: true, phase: 'error', connState: 'error', micDenied: false })
    render(withAgent(v))
    const pill = screen.getByRole('button', { name: 'Reconnect' })
    fireEvent.pointerDown(pill, { pointerId: 1 })
    expect(v.beginTalking).not.toHaveBeenCalled()
    fireEvent.click(pill)
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
    expect(screen.getByText('Microphone off')).toBeInTheDocument()
    expect(pill).toHaveAttribute(
      'title',
      'Allow microphone access in your browser, then hold to talk',
    )
    expect(pill.getAttribute('title')).not.toContain('NotAllowedError')
  })
})
