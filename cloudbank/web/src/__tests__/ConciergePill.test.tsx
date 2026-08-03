import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConciergePill } from '../components/ConciergePill'
import { AgentContext } from '../agent/AgentProvider'
import type { Registry } from '../agent/clientFunctions'

function makeAgent(overrides: Partial<{
  connState: 'idle' | 'connecting' | 'ready' | 'error'
  micState: 'idle' | 'listening' | 'held' | 'speaking' | 'muted'
  startMic: () => Promise<void>
  stopMic: () => void
  reconnect: () => void
  pushToTalk: boolean
  beginTalking: () => Promise<void>
  endTalking: () => void
}> = {}) {
  return {
    connState: 'ready' as const,
    micState: 'idle' as const,
    transcript: null,
    agentText: null,
    errorMessage: null,
    registry: { register: () => {}, unregister: () => {}, dispatch: async () => ({ id: '', response: {} }) } as unknown as Registry,
    startMic: vi.fn().mockResolvedValue(undefined),
    stopMic: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    // Defaults to the ALWAYS-ON mode so the pre-existing cases below keep
    // describing that mode. Push-to-talk has its own block.
    pushToTalk: false,
    beginTalking: vi.fn().mockResolvedValue(undefined),
    endTalking: vi.fn(),
    ...overrides,
  }
}

function withAgent(value: ReturnType<typeof makeAgent>) {
  return (
    <AgentContext.Provider value={value as never}>
      <ConciergePill />
    </AgentContext.Provider>
  )
}

describe('ConciergePill', () => {
  it('shows "Talk to concierge" when ready and idle in always-on mode', () => {
    render(withAgent(makeAgent()))
    expect(screen.getByText('Talk to concierge')).toBeInTheDocument()
  })

  it('calls startMic when tapped in idle state', () => {
    const v = makeAgent()
    render(withAgent(v))
    fireEvent.click(screen.getByRole('button'))
    expect(v.startMic).toHaveBeenCalled()
  })

  it('shows "Listening" and calls stopMic when listening', () => {
    const v = makeAgent({ micState: 'listening' })
    render(withAgent(v))
    expect(screen.getByText('Listening')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(v.stopMic).toHaveBeenCalled()
  })

  it('shows "Speaking" when the agent is speaking', () => {
    render(withAgent(makeAgent({ micState: 'speaking' })))
    expect(screen.getByText('Speaking')).toBeInTheDocument()
  })

  it('shows "Mic blocked" when muted', () => {
    render(withAgent(makeAgent({ micState: 'muted' })))
    expect(screen.getByText('Mic blocked')).toBeInTheDocument()
  })

  it('shows "Connecting…" while connecting and ignores taps', () => {
    const v = makeAgent({ connState: 'connecting' })
    render(withAgent(v))
    expect(screen.getByText('Connecting…')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(v.startMic).not.toHaveBeenCalled()
  })

  it('shows "Retry" when in error state and calls reconnect on tap', () => {
    const v = makeAgent({ connState: 'error' })
    render(withAgent(v))
    expect(screen.getByText('Retry')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(v.reconnect).toHaveBeenCalled()
  })
})

describe('ConciergePill — push-to-talk', () => {
  beforeEach(() => {
    Object.assign(HTMLElement.prototype, {
      setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(),
    })
  })

  it('invites a hold rather than a tap when ready and idle', () => {
    render(withAgent(makeAgent({ pushToTalk: true })))
    expect(screen.getByText('Hold to talk')).toBeInTheDocument()
    expect(screen.queryByText('Talk to concierge')).not.toBeInTheDocument()
  })

  it('shows the live-mic state while held', () => {
    render(withAgent(makeAgent({ pushToTalk: true, micState: 'held' })))
    // Deliberately unmistakable from the back of a room.
    expect(screen.getByText('Release to send')).toBeInTheDocument()
  })

  it('calls beginTalking on press and endTalking on release', () => {
    const agent = makeAgent({ pushToTalk: true })
    render(withAgent(agent))
    const pill = screen.getByRole('button')
    fireEvent.pointerDown(pill, { pointerId: 1 })
    expect(agent.beginTalking).toHaveBeenCalledTimes(1)
    fireEvent.pointerUp(pill, { pointerId: 1 })
    expect(agent.endTalking).toHaveBeenCalledTimes(1)
  })

  it('does not start the mic on a plain click', () => {
    // In push-to-talk a click must not latch the mic on — that would be the
    // always-listening behaviour the mode exists to avoid.
    const agent = makeAgent({ pushToTalk: true })
    render(withAgent(agent))
    fireEvent.click(screen.getByRole('button'))
    expect(agent.startMic).not.toHaveBeenCalled()
  })

  it('is inert while the agent is speaking, since the mic is already silent', () => {
    const agent = makeAgent({ pushToTalk: true, micState: 'speaking' })
    render(withAgent(agent))
    fireEvent.click(screen.getByRole('button'))
    expect(agent.stopMic).not.toHaveBeenCalled()
  })

  it('does not hold while connecting', () => {
    const agent = makeAgent({ pushToTalk: true, connState: 'connecting' })
    render(withAgent(agent))
    fireEvent.pointerDown(screen.getByRole('button'), { pointerId: 1 })
    expect(agent.beginTalking).not.toHaveBeenCalled()
  })

  it('?ptt=0 keeps the original click-to-start behaviour', () => {
    const agent = makeAgent({ pushToTalk: false })
    render(withAgent(agent))
    fireEvent.click(screen.getByRole('button'))
    expect(agent.startMic).toHaveBeenCalledTimes(1)
    expect(agent.beginTalking).not.toHaveBeenCalled()
  })
})
