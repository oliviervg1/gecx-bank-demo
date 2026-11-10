import { StrictMode } from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'
import { AgentProvider, useAgent } from '../agent/AgentProvider'
import { PersonaProvider, usePersona } from '../personas/PersonaProvider'
import { getFixture } from '../data/fixture'

function installWebSocketSpy() {
  const instances: FakeSocket[] = []
  class FakeSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readyState = FakeSocket.CONNECTING
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    onmessage: ((e: MessageEvent) => void) | null = null
    sent: string[] = []
    constructor(public url: string) {
      instances.push(this)
    }
    send(data: string): void {
      this.sent.push(data)
    }
    close(): void {
      if (this.readyState === FakeSocket.CLOSED) return
      this.readyState = FakeSocket.CLOSED
      this.onclose?.()
    }
    openFromServer(): void {
      this.readyState = FakeSocket.OPEN
      this.onopen?.()
    }
    deliver(msg: Record<string, unknown>): void {
      this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent)
    }
  }
  const Orig = globalThis.WebSocket
  ;(globalThis as unknown as { WebSocket: typeof FakeSocket }).WebSocket = FakeSocket
  return {
    instances,
    restore: () => {
      ;(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = Orig
    },
  }
}

function Probe() {
  const { phase, connState, errorMessage, reconnect, disconnect } = useAgent()
  const { setPersona } = usePersona()
  return (
    <div>
      <span data-testid="phase">{phase}</span>
      <span data-testid="conn">{connState}</span>
      <span data-testid="error">{errorMessage ?? ''}</span>
      <button onClick={reconnect}>reconnect</button>
      <button onClick={disconnect}>disconnect</button>
      <button onClick={() => setPersona('david')}>switch-david</button>
    </div>
  )
}

beforeEach(() => {
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
})

describe('AgentProvider (sessionMachine integration)', () => {
  it('opens a single WebSocket under React StrictMode and sends the exact 5-key start frame with no heuristic sessionId', () => {
    const spy = installWebSocketSpy()
    try {
      render(
        <StrictMode>
          <PersonaProvider initialDemoDate="2026-11-24">
            <AgentProvider>
              <Probe />
            </AgentProvider>
          </PersonaProvider>
        </StrictMode>,
      )

      expect(spy.instances).toHaveLength(1)
      act(() => {
        spy.instances[0].openFromServer()
      })

      const startFrame = JSON.parse(spy.instances[0].sent[0])
      expect(startFrame.type).toBe('start')
      expect(startFrame.persona).toBe('chloe')
      expect(startFrame).not.toHaveProperty('sessionId')
      expect(Object.keys(startFrame.variables).sort()).toEqual([
        'customer_snapshot',
        'demo_date',
        'first_name',
        'persona_id',
        'time_of_day',
      ])
      expect(startFrame.variables.customer_snapshot).toEqual(getFixture('chloe'))
    } finally {
      spy.restore()
    }
  })

  it('reconnects with the same sessionId ONLY on ServerGoAway and omits sessionId on manual reconnect', () => {
    const spy = installWebSocketSpy()
    try {
      render(
        <PersonaProvider initialDemoDate="2026-11-24">
          <AgentProvider>
            <Probe />
          </AgentProvider>
        </PersonaProvider>,
      )
      act(() => {
        spy.instances[0].openFromServer()
        spy.instances[0].deliver({ type: 'ready', sessionId: 'ces-live-42' })
      })
      expect(screen.getByTestId('phase').textContent).toBe('ready')

      // ServerGoAway triggers automatic resume with sessionId === 'ces-live-42'.
      act(() => {
        spy.instances[0].deliver({ type: 'go_away', sessionId: 'ces-live-42' })
      })
      expect(spy.instances).toHaveLength(2)
      act(() => {
        spy.instances[1].openFromServer()
        spy.instances[1].deliver({ type: 'ready', sessionId: 'ces-live-42' })
      })
      expect(JSON.parse(spy.instances[1].sent[0]).sessionId).toBe('ces-live-42')

      // Manual reconnect starts a fresh session with no sessionId.
      act(() => {
        fireEvent.click(screen.getByText('reconnect'))
      })
      expect(spy.instances).toHaveLength(3)
      act(() => {
        spy.instances[2].openFromServer()
      })
      expect(JSON.parse(spy.instances[2].sent[0])).not.toHaveProperty('sessionId')
    } finally {
      spy.restore()
    }
  })

  it('transitions cleanly on session_expired, end, disconnect, and PERSONA_SWITCH', () => {
    const spy = installWebSocketSpy()
    try {
      render(
        <PersonaProvider initialDemoDate="2026-11-24">
          <AgentProvider>
            <Probe />
          </AgentProvider>
        </PersonaProvider>,
      )
      act(() => {
        spy.instances[0].openFromServer()
        spy.instances[0].deliver({ type: 'ready', sessionId: 's1' })
        spy.instances[0].deliver({ type: 'session_expired', message: 'paused' })
      })
      expect(screen.getByTestId('phase').textContent).toBe('paused')
      expect(screen.getByTestId('conn').textContent).toBe('idle')

      // Switching persona tears down and opens fresh David session.
      act(() => {
        fireEvent.click(screen.getByText('switch-david'))
      })
      expect(spy.instances).toHaveLength(2)
      act(() => {
        spy.instances[1].openFromServer()
      })
      const davidStart = JSON.parse(spy.instances[1].sent[0])
      expect(davidStart.persona).toBe('david')
      expect(davidStart.variables.first_name).toBe('David')

      // Disconnect sets idle/disconnected.
      act(() => {
        fireEvent.click(screen.getByText('disconnect'))
      })
      expect(screen.getByTestId('phase').textContent).toBe('disconnected')
      expect(screen.getByTestId('conn').textContent).toBe('idle')
    } finally {
      spy.restore()
    }
  })
})
