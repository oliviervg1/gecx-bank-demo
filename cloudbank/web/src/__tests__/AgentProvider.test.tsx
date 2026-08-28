import { describe, it, expect, vi } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { AgentProvider, useAgent } from '../agent/AgentProvider'
import { PersonaProvider } from '../personas/PersonaProvider'
import App from '../App'
import type { createRegistry } from '../agent/clientFunctions'

function Probe() {
  const { reconnect, disconnect, connState, errorMessage } = useAgent()
  return (
    <div>
      <span data-testid="state">{connState}</span>
      <span data-testid="error">{errorMessage ?? ''}</span>
      <button onClick={reconnect}>reconnect</button>
      <button onClick={disconnect}>disconnect</button>
    </div>
  )
}

/**
 * Drop-in WebSocket fake that exposes the constructed instances so tests can
 * drive onopen/onmessage/onclose. Each new construction is recorded; the
 * test can grab the latest, fire the open handler, deliver server frames,
 * and close it as if from the server side.
 *
 * Returns an installer + uninstaller so each test can scope its own fake
 * without leaking across cases.
 */
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
    constructor(public url: string) { instances.push(this) }
    send(data: string): void { this.sent.push(data) }
    close(): void {
      if (this.readyState === FakeSocket.CLOSED) return
      this.readyState = FakeSocket.CLOSED
      this.onclose?.()
    }
    /** Test helper: simulate server-side handshake completion. */
    openFromServer(): void {
      this.readyState = FakeSocket.OPEN
      this.onopen?.()
    }
    /** Test helper: deliver a server-sent envelope. */
    deliver(msg: Record<string, unknown>): void {
      this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent)
    }
    /** Test helper: simulate the server closing the WS. */
    closeFromServer(): void { this.close() }
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

async function flushMicrotasks() {
  // The connect effect schedules its WebSocket construction synchronously,
  // but React state updates from onmessage/onclose handlers settle on the
  // microtask queue. Two yields cover most reasonable handler chains.
  await Promise.resolve()
  await Promise.resolve()
}

describe('AgentProvider', () => {
  it('exposes reconnect and disconnect actions', () => {
    render(
      <PersonaProvider>
        <AgentProvider>
          <Probe />
        </AgentProvider>
      </PersonaProvider>,
    )
    expect(screen.getByText('reconnect')).toBeInTheDocument()
    expect(screen.getByText('disconnect')).toBeInTheDocument()
  })

  it('disconnect closes the websocket and sets connState to idle', () => {
    render(
      <PersonaProvider>
        <AgentProvider>
          <Probe />
        </AgentProvider>
      </PersonaProvider>,
    )
    act(() => { fireEvent.click(screen.getByText('disconnect')) })
    expect(screen.getByTestId('state').textContent).toBe('idle')
  })

  it('sends only {first_name} variables on the start frame', async () => {
    const sent: string[] = []
    const origWebSocket = globalThis.WebSocket as unknown as { prototype: { send: (data: string) => void } }
    const origSend = origWebSocket.prototype.send
    origWebSocket.prototype.send = function (data: string) { sent.push(data); origSend.call(this, data) }

    const OrigWS = globalThis.WebSocket
    const PatchedWS = function (this: { onopen: (() => void) | null }, url: string) {
      const instance = new (OrigWS as unknown as new (u: string) => object)(url) as {
        onopen: (() => void) | null
        send: (data: string) => void
      }
      const proxy = new Proxy(instance, {
        set(target, prop, value) {
          ;(target as Record<string | symbol, unknown>)[prop] = value
          if (prop === 'onopen' && typeof value === 'function') {
            queueMicrotask(() => (value as () => void)())
          }
          return true
        },
      })
      return proxy
    } as unknown as typeof WebSocket
    PatchedWS.prototype = OrigWS.prototype
    ;(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = PatchedWS

    try {
      await act(async () => {
        render(
          <PersonaProvider>
            <AgentProvider>
              <Probe />
            </AgentProvider>
          </PersonaProvider>,
        )
        await Promise.resolve()
        await Promise.resolve()
      })
      const startFrame = sent.find((s) => JSON.parse(s).type === 'start')
      expect(startFrame).toBeDefined()
      const parsed = JSON.parse(startFrame as string)
      expect(parsed.persona).toBe('chloe')
      expect(parsed.variables).toEqual({ first_name: 'Chloe' })
    } finally {
      origWebSocket.prototype.send = origSend
      ;(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = OrigWS
    }
  })

  it('auto-retries up to 3 times on upstream failure, then shows error pill', async () => {
    const spy = installWebSocketSpy()
    vi.useFakeTimers()
    try {
      await act(async () => {
        render(
          <PersonaProvider>
            <AgentProvider>
              <Probe />
            </AgentProvider>
          </PersonaProvider>,
        )
        await flushMicrotasks()
      })
      // Initial attempt + 3 auto-retries = 4 total WS constructions. Each
      // attempt receives an error envelope and then a server close, mimicking
      // CES's failed_precondition path through the updated proxy.
      //
      // Retries are scheduled behind an exponential backoff, so each failure
      // has to run the timer out before the next socket is constructed.
      const fail = async () => {
        const ws = spy.instances[spy.instances.length - 1]
        await act(async () => {
          ws.openFromServer()
          ws.deliver({ type: 'error', message: 'upstream closed (1007): failed_precondition' })
          ws.closeFromServer()
          await flushMicrotasks()
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000)
          await flushMicrotasks()
        })
      }
      await fail()
      expect(spy.instances).toHaveLength(2)            // initial + 1 retry
      expect(screen.getByTestId('state').textContent).toBe('connecting')
      await fail()
      expect(spy.instances).toHaveLength(3)            // + 2nd retry
      await fail()
      expect(spy.instances).toHaveLength(4)            // + 3rd retry
      // Fourth failure exhausts the budget — pill must appear with the last
      // error message from the server.
      await fail()
      expect(spy.instances).toHaveLength(4)            // no further attempts
      expect(screen.getByTestId('state').textContent).toBe('error')
      expect(screen.getByTestId('error').textContent).toContain('failed_precondition')
    } finally {
      vi.useRealTimers()
      spy.restore()
    }
  })

  // The proxy sends 'ready' as soon as it has pushed config upstream, BEFORE
  // CES has validated anything — and the transient `failed_precondition`
  // closes the socket after that point. So a session that reaches 'ready' and
  // then dies must still burn retry budget; otherwise every retry zeroes the
  // counter and the loop never terminates. The previous version of this test
  // asserted the opposite and passed only because its fake delivered 'error'
  // without a preceding 'ready' — a sequence the real proxy cannot produce.
  it('does NOT reset the auto-retry budget on ready alone (ready precedes upstream validation)', async () => {
    const spy = installWebSocketSpy()
    vi.useFakeTimers()
    try {
      await act(async () => {
        render(
          <PersonaProvider>
            <AgentProvider>
              <Probe />
            </AgentProvider>
          </PersonaProvider>,
        )
        await flushMicrotasks()
      })
      // Every attempt reaches 'ready' and then dies — exactly the
      // failed_precondition shape.
      const readyThenDie = async () => {
        const ws = spy.instances[spy.instances.length - 1]
        await act(async () => {
          ws.openFromServer()
          ws.deliver({ type: 'ready' })
          ws.deliver({ type: 'error', message: 'upstream closed (1007): failed_precondition' })
          ws.closeFromServer()
          await flushMicrotasks()
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000)
          await flushMicrotasks()
        })
      }
      await readyThenDie()
      await readyThenDie()
      await readyThenDie()
      expect(spy.instances).toHaveLength(4)   // initial + 3 retries
      await readyThenDie()
      // Budget exhausted: the Retry pill appears instead of a 5th socket.
      expect(spy.instances).toHaveLength(4)
      expect(screen.getByTestId('state').textContent).toBe('error')
    } finally {
      vi.useRealTimers()
      spy.restore()
    }
  })

  it('resets the auto-retry budget once a session produces real upstream traffic', async () => {
    const spy = installWebSocketSpy()
    vi.useFakeTimers()
    try {
      await act(async () => {
        render(
          <PersonaProvider>
            <AgentProvider>
              <Probe />
            </AgentProvider>
          </PersonaProvider>,
        )
        await flushMicrotasks()
      })
      const failOnce = async () => {
        const ws = spy.instances[spy.instances.length - 1]
        await act(async () => {
          ws.openFromServer()
          ws.deliver({ type: 'error', message: 'upstream closed (1007)' })
          ws.closeFromServer()
          await flushMicrotasks()
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000)
          await flushMicrotasks()
        })
      }
      // Burn two retries.
      await failOnce()
      await failOnce()
      expect(spy.instances).toHaveLength(3)

      // Third attempt gets all the way to real agent output — that, not
      // 'ready', is proof the session is genuinely healthy.
      await act(async () => {
        const ws = spy.instances[2]
        ws.openFromServer()
        ws.deliver({ type: 'ready' })
        ws.deliver({ type: 'transcript', text: 'hello' })
        await flushMicrotasks()
      })
      expect(screen.getByTestId('state').textContent).toBe('ready')

      // The budget is now full again, so this drop retries rather than
      // tripping the pill.
      await act(async () => {
        spy.instances[2].closeFromServer()
        await flushMicrotasks()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
        await flushMicrotasks()
      })
      expect(spy.instances).toHaveLength(4)
      expect(screen.getByTestId('state').textContent).toBe('connecting')
    } finally {
      vi.useRealTimers()
      spy.restore()
    }
  })

  it('does not retry after a clean end-session close', async () => {
    const spy = installWebSocketSpy()
    try {
      await act(async () => {
        render(
          <PersonaProvider>
            <AgentProvider>
              <Probe />
            </AgentProvider>
          </PersonaProvider>,
        )
        await flushMicrotasks()
      })
      const ws = spy.instances[spy.instances.length - 1]
      await act(async () => {
        ws.openFromServer()
        ws.deliver({ type: 'ready' })
        ws.deliver({ type: 'end' })
        await flushMicrotasks()
      })
      // Only the initial attempt; 'end' must not trigger a reconnect.
      expect(spy.instances).toHaveLength(1)
      expect(screen.getByTestId('state').textContent).toBe('idle')
    } finally {
      spy.restore()
    }
  })

  it('manual reconnect resets the auto-retry budget', async () => {
    const spy = installWebSocketSpy()
    try {
      await act(async () => {
        render(
          <PersonaProvider>
            <AgentProvider>
              <Probe />
            </AgentProvider>
          </PersonaProvider>,
        )
        await flushMicrotasks()
      })
      const failOnce = async () => {
        const ws = spy.instances[spy.instances.length - 1]
        await act(async () => {
          ws.openFromServer()
          ws.deliver({ type: 'error', message: 'upstream closed' })
          ws.closeFromServer()
          await flushMicrotasks()
        })
      }
      // Exhaust the budget → pill.
      await failOnce(); await failOnce(); await failOnce(); await failOnce()
      expect(screen.getByTestId('state').textContent).toBe('error')
      const attemptsAtPill = spy.instances.length
      // User taps Retry — should reset budget and start a new cycle.
      await act(async () => {
        fireEvent.click(screen.getByText('reconnect'))
        await flushMicrotasks()
      })
      expect(spy.instances.length).toBe(attemptsAtPill + 1)
      // Fail again 3 times → still 'connecting' (3 retries left).
      await failOnce(); await failOnce(); await failOnce()
      expect(screen.getByTestId('state').textContent).toBe('connecting')
      // 4th failure trips the pill again.
      await failOnce()
      expect(screen.getByTestId('state').textContent).toBe('error')
    } finally {
      spy.restore()
    }
  })

  // ── CES session resumption ──────────────────────────────────────────────
  // CES closes a BidiRunSession that receives no speech after ~20-30s with
  // 1007 failed_precondition. The reconnect is therefore routine, not an
  // error — but a reconnect on a fresh session id starts a blank
  // conversation. The id below is what carries the context across the gap.

  const startFrames = (instances: { sent: string[] }[]) =>
    instances
      .flatMap((ws) => ws.sent)
      .map((raw) => JSON.parse(raw))
      .filter((m) => m.type === 'start')

  it('sends a session id on the start frame', async () => {
    const spy = installWebSocketSpy()
    try {
      await act(async () => {
        render(
          <PersonaProvider>
            <AgentProvider>
              <Probe />
            </AgentProvider>
          </PersonaProvider>,
        )
        await flushMicrotasks()
      })
      await act(async () => {
        spy.instances[0].openFromServer()
        await flushMicrotasks()
      })
      const [start] = startFrames(spy.instances)
      expect(start.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )
    } finally {
      spy.restore()
    }
  })

  it('reuses the session id after a session that produced agent output', async () => {
    const spy = installWebSocketSpy()
    vi.useFakeTimers()
    try {
      await act(async () => {
        render(
          <PersonaProvider>
            <AgentProvider>
              <Probe />
            </AgentProvider>
          </PersonaProvider>,
        )
        await flushMicrotasks()
      })
      // A real conversation happened, so there IS context worth resuming.
      await act(async () => {
        const ws = spy.instances[0]
        ws.openFromServer()
        ws.deliver({ type: 'ready' })
        ws.deliver({ type: 'text', text: "You've spent £83 at Costa." })
        await flushMicrotasks()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_000)   // CES idle window
        await flushMicrotasks()
      })
      await act(async () => {
        spy.instances[0].closeFromServer()
        await flushMicrotasks()
      })
      // The replacement socket is constructed when React commits the effect
      // after the backoff timer fires, so flush before reaching for it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
        await flushMicrotasks()
      })
      await act(async () => {
        spy.instances[1].openFromServer()
        await flushMicrotasks()
      })
      const frames = startFrames(spy.instances)
      expect(frames).toHaveLength(2)
      expect(frames[1].sessionId).toBe(frames[0].sessionId)
    } finally {
      vi.useRealTimers()
      spy.restore()
    }
  })

  it('discards the session id when a session produced no agent output', async () => {
    // Two cases collapse into one rule. A tab nobody spoke to holds no context
    // worth resuming; and a session resumed onto an expired CES id comes back
    // mute — it accepts the config, answers nothing, and dies at the idle
    // timeout. Reusing that id again would keep the agent deaf forever, so a
    // silent session always yields a fresh id.
    const spy = installWebSocketSpy()
    vi.useFakeTimers()
    try {
      await act(async () => {
        render(
          <PersonaProvider>
            <AgentProvider>
              <Probe />
            </AgentProvider>
          </PersonaProvider>,
        )
        await flushMicrotasks()
      })
      await act(async () => {
        const ws = spy.instances[0]
        ws.openFromServer()
        ws.deliver({ type: 'ready' })   // proxy-level only; no agent output
        await flushMicrotasks()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_000)
        await flushMicrotasks()
      })
      await act(async () => {
        spy.instances[0].closeFromServer()
        await flushMicrotasks()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
        await flushMicrotasks()
      })
      await act(async () => {
        spy.instances[1].openFromServer()
        await flushMicrotasks()
      })
      const frames = startFrames(spy.instances)
      expect(frames).toHaveLength(2)
      expect(frames[1].sessionId).not.toBe(frames[0].sessionId)
    } finally {
      vi.useRealTimers()
      spy.restore()
    }
  })

  it('keeps reconnecting past the retry budget when each session was long-lived', async () => {
    // The idle close arrives ~20-30s in, on a session that was working. That
    // is routine, so it must not consume the budget reserved for a genuinely
    // broken upstream — otherwise an untouched tab reaches the Retry pill
    // after 4 idle cycles (~2 minutes) and the demo is dead.
    const spy = installWebSocketSpy()
    vi.useFakeTimers()
    try {
      await act(async () => {
        render(
          <PersonaProvider>
            <AgentProvider>
              <Probe />
            </AgentProvider>
          </PersonaProvider>,
        )
        await flushMicrotasks()
      })
      const idleCycle = async () => {
        const ws = spy.instances[spy.instances.length - 1]
        await act(async () => {
          ws.openFromServer()
          ws.deliver({ type: 'ready' })
          await flushMicrotasks()
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(25_000)
          ws.deliver({ type: 'error', message: 'upstream closed (1007): failed_precondition' })
          ws.closeFromServer()
          await flushMicrotasks()
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000)
          await flushMicrotasks()
        })
      }
      // Six cycles — twice the MAX_AUTO_RETRIES budget.
      for (let i = 0; i < 6; i++) await idleCycle()
      expect(spy.instances).toHaveLength(7)
      expect(screen.getByTestId('state').textContent).toBe('connecting')
    } finally {
      vi.useRealTimers()
      spy.restore()
    }
  })

  it('still surfaces the Retry pill when sessions die immediately', async () => {
    // The complement of the test above: a genuinely broken upstream kills
    // sockets right after handshake, and that must still exhaust the budget
    // rather than reconnect forever.
    const spy = installWebSocketSpy()
    vi.useFakeTimers()
    try {
      await act(async () => {
        render(
          <PersonaProvider>
            <AgentProvider>
              <Probe />
            </AgentProvider>
          </PersonaProvider>,
        )
        await flushMicrotasks()
      })
      const dieImmediately = async () => {
        const ws = spy.instances[spy.instances.length - 1]
        await act(async () => {
          ws.openFromServer()
          ws.deliver({ type: 'error', message: 'upstream 403' })
          ws.closeFromServer()
          await flushMicrotasks()
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000)
          await flushMicrotasks()
        })
      }
      await dieImmediately()
      await dieImmediately()
      await dieImmediately()
      await dieImmediately()
      expect(spy.instances).toHaveLength(4)
      expect(screen.getByTestId('state').textContent).toBe('error')
    } finally {
      vi.useRealTimers()
      spy.restore()
    }
  })

  it('registers all 5 spending-data ClientFunctions plus navigate_to', async () => {
    await act(async () => {
      render(<App />)
      await Promise.resolve()
      await Promise.resolve()
    })
    // SpendingDataBinder exposes the live registry on window in dev/test so
    // we can probe it without restructuring App.
    const w = window as unknown as { __agentRegistry?: ReturnType<typeof createRegistry> }
    expect(w.__agentRegistry).toBeDefined()
    const expected = [
      'navigate_to',
      'get_overview', 'get_category_breakdown', 'get_vendor_breakdown',
      'get_monthly_trend', 'get_subscriptions',
    ]
    for (const name of expected) {
      const env = await w.__agentRegistry!.dispatch({ id: name, name, args: {} })
      // Either an `output` envelope (handler ran) OR a `handler_error` envelope
      // (handler exists but threw on empty args). Both prove registration. The
      // only failure mode we guard against is `unknown_function`.
      const failed = 'error' in env.response && env.response.error.startsWith('unknown_function')
      expect(failed, `${name} should be registered`).toBe(false)
    }
    // There is no set_spending_view function — the `show` flag on the get_*
    // tools does that job. Probing for it must fail.
    const removed = await w.__agentRegistry!.dispatch({ id: 'r', name: 'set_spending_view', args: {} })
    expect('error' in removed.response && removed.response.error.startsWith('unknown_function'))
      .toBe(true)
  })
})
