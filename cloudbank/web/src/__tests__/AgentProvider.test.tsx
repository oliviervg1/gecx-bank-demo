import { StrictMode } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'
import { AgentProvider, useAgent } from '../agent/AgentProvider'
import { BankingViewStateProvider } from '../agent/BankingViewStateProvider'
import { PersonaProvider, usePersona } from '../personas/PersonaProvider'

interface FakeSocketInstance {
  url: string
  sent: string[]
  readyState: number
  openFromServer: () => void
  deliver: (msg: Record<string, unknown>) => void
  closeFromServer: () => void
}

function installWebSocketSpy() {
  const instances: FakeSocketInstance[] = []
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
      const readState = () => this.readyState
      instances.push({
        url,
        sent: this.sent,
        get readyState() {
          return readState()
        },
        openFromServer: () => {
          this.readyState = FakeSocket.OPEN
          this.onopen?.()
        },
        deliver: (msg) => {
          this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent)
        },
        closeFromServer: () => {
          if (this.readyState === FakeSocket.CLOSED) return
          this.readyState = FakeSocket.CLOSED
          this.onclose?.()
        },
      })
    }
    send(data: string): void {
      this.sent.push(data)
    }
    close(): void {
      if (this.readyState === FakeSocket.CLOSED) return
      this.readyState = FakeSocket.CLOSED
      this.onclose?.()
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
  const {
    phase,
    connState,
    authExpired,
    errorMessage,
    reconnect,
    reloadPage,
    disconnect,
    submitText,
  } = useAgent()
  const { setPersona } = usePersona()
  return (
    <div>
      <span data-testid="phase">{phase}</span>
      <span data-testid="conn">{connState}</span>
      <span data-testid="auth-expired">{authExpired ? 'true' : 'false'}</span>
      <span data-testid="error">{errorMessage ?? ''}</span>
      <button onClick={reconnect}>reconnect</button>
      <button onClick={() => reloadPage?.()}>reload-page</button>
      <button onClick={() => disconnect()}>disconnect</button>
      <button onClick={() => setPersona('david')}>switch-david</button>
      <button onClick={() => submitText('Ping')}>send-text</button>
    </div>
  )
}

function renderWithProviders(strict = false, onReloadPage?: () => void) {
  const tree = (
    <PersonaProvider initialDemoDate="2026-11-24">
      <BankingViewStateProvider>
        <AgentProvider onReloadPage={onReloadPage}>
          <Probe />
        </AgentProvider>
      </BankingViewStateProvider>
    </PersonaProvider>
  )
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree)
}

beforeEach(() => {
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
})

describe('AgentProvider (sessionMachine integration)', () => {
  it('opens a single WebSocket under React StrictMode and sends the lean server-owned start frame', () => {
    const spy = installWebSocketSpy()
    try {
      renderWithProviders(true)

      expect(spy.instances).toHaveLength(1)
      act(() => {
        spy.instances[0]!.openFromServer()
      })

      const startFrame = JSON.parse(spy.instances[0]!.sent[0]!) as Record<string, unknown>
      expect(startFrame.type).toBe('start')
      expect(startFrame.persona).toBe('chloe')
      expect(startFrame.demoDate).toBe('2026-11-24')
      expect(['morning', 'afternoon', 'evening']).toContain(startFrame.timeOfDay)
      expect(startFrame).not.toHaveProperty('variables')
      expect(startFrame).not.toHaveProperty('sessionId')
    } finally {
      spy.restore()
    }
  })

  it('reconnects with sessionId + lastUiSeq on ServerGoAway and transient WS_CLOSED, and omits sessionId on manual reconnect', () => {
    const spy = installWebSocketSpy()
    vi.useFakeTimers()
    try {
      renderWithProviders()
      act(() => {
        spy.instances[0]!.openFromServer()
        spy.instances[0]!.deliver({ type: 'ready', sessionId: 'live-42' })
        spy.instances[0]!.deliver({
          type: 'ui_state',
          tier: 1,
          state: { seq: 4, page: 'savings', extra_monthly_pence: 4500 },
        })
      })
      expect(screen.getByTestId('phase').textContent).toBe('ready')

      act(() => {
        spy.instances[0]!.deliver({ type: 'go_away', sessionId: 'live-42' })
      })
      expect(spy.instances).toHaveLength(2)
      act(() => {
        spy.instances[1]!.openFromServer()
        spy.instances[1]!.deliver({ type: 'ready', sessionId: 'live-42' })
      })
      const resumedStart = JSON.parse(spy.instances[1]!.sent[0]!) as Record<string, unknown>
      expect(resumedStart.sessionId).toBe('live-42')
      expect(resumedStart.lastUiSeq).toBe(4)

      // Transient WS_CLOSED in ready schedules backoff reconnect with sessionId='live-42'!
      act(() => {
        spy.instances[1]!.closeFromServer()
        vi.advanceTimersByTime(400)
      })
      expect(spy.instances).toHaveLength(3)
      act(() => {
        spy.instances[2]!.openFromServer()
        spy.instances[2]!.deliver({ type: 'ready', sessionId: 'live-42' })
      })
      expect(JSON.parse(spy.instances[2]!.sent[0]!).sessionId).toBe('live-42')

      act(() => {
        fireEvent.click(screen.getByText('reconnect'))
      })
      expect(spy.instances).toHaveLength(4)
      act(() => {
        spy.instances[3]!.openFromServer()
      })
      expect(JSON.parse(spy.instances[3]!.sent[0]!)).not.toHaveProperty('sessionId')
    } finally {
      vi.useRealTimers()
      spy.restore()
    }
  })

  it('applies bounded exponential backoff (max 3 resume attempts) and 10,000ms connect timeout without infinite storm', () => {
    const spy = installWebSocketSpy()
    vi.useFakeTimers()
    try {
      renderWithProviders()
      act(() => {
        spy.instances[0]!.openFromServer()
        spy.instances[0]!.deliver({ type: 'ready', sessionId: 'live-backoff' })
      })

      // Initial GoAway opens socket #2 immediately.
      act(() => {
        spy.instances[0]!.deliver({ type: 'go_away', sessionId: 'live-backoff' })
      })
      expect(spy.instances).toHaveLength(2)

      // Socket #2 closes before ready -> backs off (attempt 1: ~250ms) instead of immediate loop!
      act(() => {
        spy.instances[1]!.closeFromServer()
      })
      expect(spy.instances).toHaveLength(2)

      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(spy.instances).toHaveLength(3)

      // Socket #3 closes -> attempt 2 (~500ms)
      act(() => {
        spy.instances[2]!.closeFromServer()
        vi.advanceTimersByTime(700)
      })
      expect(spy.instances).toHaveLength(4)

      // Socket #4 closes -> attempt 3 (~1000ms)
      act(() => {
        spy.instances[3]!.closeFromServer()
        vi.advanceTimersByTime(1400)
      })
      expect(spy.instances).toHaveLength(5)

      // Socket #5 stalls in CONNECTING for 10,000ms -> connect timeout fires -> max attempts reached -> error!
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(screen.getByTestId('phase').textContent).toBe('error')
      expect(spy.instances).toHaveLength(5)
    } finally {
      vi.useRealTimers()
      spy.restore()
    }
  })

  it('transitions cleanly on session_expired, disconnect, and PERSONA_SWITCH', () => {
    const spy = installWebSocketSpy()
    try {
      renderWithProviders()
      act(() => {
        spy.instances[0]!.openFromServer()
        spy.instances[0]!.deliver({ type: 'ready', sessionId: 's1' })
        spy.instances[0]!.deliver({ type: 'session_expired', message: 'paused' })
      })
      expect(screen.getByTestId('phase').textContent).toBe('paused')
      expect(screen.getByTestId('conn').textContent).toBe('idle')

      act(() => {
        fireEvent.click(screen.getByText('switch-david'))
      })
      expect(spy.instances).toHaveLength(2)
      act(() => {
        spy.instances[1]!.openFromServer()
      })
      const davidStart = JSON.parse(spy.instances[1]!.sent[0]!) as Record<string, unknown>
      expect(davidStart.persona).toBe('david')
      expect(davidStart).not.toHaveProperty('variables')

      act(() => {
        fireEvent.click(screen.getByText('disconnect'))
      })
      expect(screen.getByTestId('phase').textContent).toBe('disconnected')
      expect(screen.getByTestId('conn').textContent).toBe('idle')
    } finally {
      spy.restore()
    }
  })

  it('enforces the exact 15,000ms thinking watchdog timer', () => {
    const spy = installWebSocketSpy()
    vi.useFakeTimers()
    try {
      renderWithProviders()
      act(() => {
        spy.instances[0]!.openFromServer()
        spy.instances[0]!.deliver({ type: 'ready', sessionId: 's-watchdog' })
      })
      act(() => {
        fireEvent.click(screen.getByText('send-text'))
      })
      expect(screen.getByTestId('phase').textContent).toBe('thinking')

      act(() => {
        vi.advanceTimersByTime(14_999)
      })
      expect(screen.getByTestId('phase').textContent).toBe('thinking')

      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(screen.getByTestId('phase').textContent).toBe('ready')
    } finally {
      vi.useRealTimers()
      spy.restore()
    }
  })

  it.each([
    ['401 Unauthorized', { status: 401, type: 'basic' }],
    ['403 Forbidden', { status: 403, type: 'basic' }],
    ['opaqueredirect', { status: 0, type: 'opaqueredirect' }],
  ])(
    'probes /health on pre-ready WS close and halts reconnects with reload prompt on %s',
    async (_label, probeResp) => {
      const spy = installWebSocketSpy()
      const origFetch = globalThis.fetch
      const reloadSpy = vi.fn()
      const fetchMock = vi.fn().mockResolvedValue(probeResp as Response)
      globalThis.fetch = fetchMock as unknown as typeof fetch
      vi.useFakeTimers()
      try {
        renderWithProviders(false, reloadSpy)
        act(() => {
          spy.instances[0]!.openFromServer()
          spy.instances[0]!.deliver({ type: 'ready', sessionId: 'live-iap' })
        })

        // Simulate GoAway -> resume socket closes before ready because IAP session expired
        act(() => {
          spy.instances[0]!.deliver({ type: 'go_away', sessionId: 'live-iap' })
        })
        expect(spy.instances).toHaveLength(2)

        await act(async () => {
          spy.instances[1]!.closeFromServer()
          await Promise.resolve()
        })

        expect(fetchMock).toHaveBeenCalledWith(
          '/health',
          expect.objectContaining({
            method: 'GET',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
            credentials: 'same-origin',
            redirect: 'manual',
          }),
        )
        expect(screen.getByTestId('phase').textContent).toBe('error')
        expect(screen.getByTestId('auth-expired').textContent).toBe('true')
        expect(screen.getByTestId('error').textContent).toContain('Reload the page')
        expect(screen.getByTestId('error').textContent).not.toContain('localhost proxy')

        // Advancing timers MUST NOT trigger any further reconnect attempts
        act(() => {
          vi.advanceTimersByTime(5_000)
        })
        expect(spy.instances).toHaveLength(2)

        fireEvent.click(screen.getByText('reload-page'))
        expect(reloadSpy).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
        globalThis.fetch = origFetch
        spy.restore()
      }
    },
  )
})
