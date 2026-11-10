import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MotionConfig } from 'framer-motion'
import App from '../App'

interface CapturedSocket {
  url: string
  sent: string[]
  open: () => void
  deliver: (msg: Record<string, unknown>) => void
  close: () => void
}

let sockets: CapturedSocket[] = []
const origWS = globalThis.WebSocket

const BANNED_TECHNICAL_TOKENS = [
  'gemini-composite-v2',
  'BidiRunSession',
  'before_model_callback',
  'Part.from_agent_transfer',
  'ui_view_state',
  'root_agent',
  'everyday_banking_agent',
  'savings_agent',
  'mortgage_agent',
  '16 kHz',
  'Worklet',
  'phase:',
  'seq:',
]

beforeEach(() => {
  sockets = []
  class FakeWS {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 3
    readyState = FakeWS.CONNECTING
    onopen: (() => void) | null = null
    onmessage: ((e: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null
    onclose: (() => void) | null = null
    sent: string[] = []
    constructor(public url: string) {
      sockets.push({
        url,
        sent: this.sent,
        open: () => {
          this.readyState = FakeWS.OPEN
          this.onopen?.()
        },
        deliver: (msg) => {
          this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent)
        },
        close: () => {
          this.readyState = FakeWS.CLOSED
          this.onclose?.()
        },
      })
    }
    send(d: string) {
      this.sent.push(d)
    }
    close() {
      this.readyState = FakeWS.CLOSED
      this.onclose?.()
    }
  }
  ;(globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  cleanup()
  ;(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = origWS
  window.history.replaceState({}, '', '/')
})

describe('Executive ConciergePanel & full ui_view_state screen sync', () => {
  it('renders executive greeting on ready, calm Reconnect status on error, and zero technical jargon', async () => {
    render(
      <MotionConfig reducedMotion="always">
        <App />
      </MotionConfig>,
    )

    const ws = sockets[sockets.length - 1]
    await act(async () => {
      ws.open()
      ws.deliver({ type: 'ready', sessionId: 'sess-exec' })
    })

    expect(screen.getByText('How can I help today, Chloe?')).toBeInTheDocument()
    expect(screen.queryByTestId('active-specialist-pill')).toBeNull()

    const attributeStrings: string[] = []
    for (const el of Array.from(document.querySelectorAll('[aria-label], [title]'))) {
      const aria = el.getAttribute('aria-label')
      const title = el.getAttribute('title')
      if (aria) attributeStrings.push(aria)
      if (title) attributeStrings.push(title)
    }
    const combinedVisibleAndA11y = `${document.body.textContent ?? ''} ${attributeStrings.join(' ')}`
    for (const token of BANNED_TECHNICAL_TOKENS) {
      expect(combinedVisibleAndA11y).not.toContain(token)
    }

    // Error state shows calm executive note instead of ready greeting or raw error codes.
    await act(async () => {
      ws.deliver({ type: 'error', message: 'upstream 1007 failed_precondition' })
    })
    expect(screen.getByTestId('concierge-unavailable-state')).toHaveTextContent(
      "We couldn't reach the concierge. Select Reconnect to try again.",
    )
    expect(screen.queryByText('How can I help today, Chloe?')).toBeNull()

    // Clicking Reconnect opens a fresh socket.
    fireEvent.click(screen.getAllByRole('button', { name: 'Reconnect' })[0])
    expect(sockets.length).toBeGreaterThan(1)
  })

  it('drives every field of ui_view_state.schema.json across all 5 tabs, updates plain-English specialist pills, and sandboxes search HTML', async () => {
    render(
      <MotionConfig reducedMotion="always">
        <App />
      </MotionConfig>,
    )

    const ws = sockets[sockets.length - 1]
    await act(async () => {
      ws.open()
      ws.deliver({ type: 'ready', sessionId: 'sess-e2e' })
    })

    // 1. Spending overview + highlight_vendor + anomaly_status + Everyday Banking pill
    await act(async () => {
      ws.deliver({
        type: 'ui_state',
        tier: 1,
        state: {
          seq: 1,
          page: 'spending',
          view: 'overview',
          period: 'this_month',
          highlight_vendor: 'Netflix',
          anomaly_status: 'unrecognised',
        },
      })
    })
    expect(await screen.findByTestId('anomaly-status-badge')).toHaveTextContent(
      'Marked as not recognised',
    )
    expect(screen.getByTestId('active-specialist-pill')).toHaveTextContent('Everyday Banking')

    // 2. Spending category + period ('last_month') and vendor subviews
    await act(async () => {
      ws.deliver({
        type: 'ui_state',
        tier: 1,
        state: {
          seq: 2,
          page: 'spending',
          view: 'category',
          period: 'last_month',
          category: 'coffee_shops',
        },
      })
    })
    expect(await screen.findByText(/Spending › Coffee shops/)).toBeInTheDocument()
    expect(screen.getByText(/October · Coffee shops/i)).toBeInTheDocument()

    await act(async () => {
      ws.deliver({
        type: 'ui_state',
        tier: 1,
        state: {
          seq: 3,
          page: 'spending',
          view: 'vendor',
          period: 'this_month',
          vendor: 'Tesco',
        },
      })
    })
    expect(await screen.findByText(/Spending › Tesco/)).toBeInTheDocument()

    // 3. Sanitized assistant prose + interrupted badge + sandboxed search_suggestions + hidden diagnostics
    await act(async () => {
      ws.deliver({
        type: 'text',
        partial: true,
        text: '<neutral> Let me check your Netflix plan.',
      })
      ws.deliver({ type: 'interrupt' })
      ws.deliver({
        type: 'text',
        partial: false,
        text: '<reassuring> To cancel Netflix, open Account settings. [Diagnosis context: internal raw search payload]',
      })
      ws.deliver({
        type: 'search_suggestions',
        htmls: ['<div class="chip">how to cancel Netflix UK</div>'],
        webSearchQueries: ['how to cancel Netflix subscription UK'],
        citations: [
          { title: 'Netflix Help Centre', uri: 'https://help.netflix.com/cancel' },
          { title: 'Evil URI', uri: 'javascript:alert(1)' },
        ],
      })
      ws.deliver({
        type: 'turn_diagnostics',
        turnIndex: 1,
        agentTransfers: [{ targetAgent: 'everyday_banking_agent' }],
      })
      ws.deliver({ type: 'turn_complete', turnIndex: 1 })
    })

    const stream = screen.getByTestId('conversation-stream')
    expect(stream).toHaveAttribute('role', 'log')
    expect(stream).toHaveAttribute('aria-live', 'polite')
    expect(stream.textContent).toContain('To cancel Netflix, open Account settings.')
    expect(stream.textContent).toContain('(Interrupted)')
    expect(stream.textContent).not.toContain('Diagnosis context')
    expect(stream.textContent).not.toContain('<reassuring>')
    expect(stream.textContent).not.toContain('everyday_banking_agent')

    const iframe = stream.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox')
    // Duplicate webSearchQueries pill is suppressed when sandboxed htmls chip is present.
    expect(screen.queryByText('how to cancel Netflix subscription UK')).toBeNull()
    expect(screen.getByText('Netflix Help Centre')).toBeInTheDocument()
    expect(screen.queryByText('Evil URI')).toBeNull()

    // 4. Savings projection sync (extra_monthly_pence + custom_target_pence + Savings pill)
    await act(async () => {
      ws.deliver({
        type: 'ui_state',
        tier: 1,
        state: {
          seq: 4,
          page: 'savings',
          extra_monthly_pence: 4500,
          custom_target_pence: 1500000,
        },
      })
    })
    expect(await screen.findByText('Home Emergency Pot')).toBeInTheDocument()
    expect(screen.getByText('+£45.00/mo')).toBeInTheDocument()
    expect(screen.getByTestId('active-specialist-pill')).toHaveTextContent('Savings')

    // 5. Mortgage overpay sync (subview + monthly_overpayment_pence + lump_sum_overpayment_pence + Mortgages pill)
    await act(async () => {
      ws.deliver({
        type: 'ui_state',
        tier: 1,
        state: {
          seq: 5,
          page: 'mortgage',
          subview: 'overpay',
          monthly_overpayment_pence: 20000,
          lump_sum_overpayment_pence: 500000,
        },
      })
    })
    expect(await screen.findByTestId('mortgage-overpay-view')).toBeInTheDocument()
    expect(screen.getByText('+£200.00/mo')).toBeInTheDocument()
    expect(screen.getByTestId('active-specialist-pill')).toHaveTextContent('Mortgages')

    // 6. Profile & Home page sync
    await act(async () => {
      ws.deliver({ type: 'ui_state', tier: 1, state: { seq: 6, page: 'profile' } })
    })
    expect(await screen.findByText('Debit Card Controls')).toBeInTheDocument()

    await act(async () => {
      ws.deliver({ type: 'ui_state', tier: 1, state: { seq: 7, page: 'home' } })
    })
    expect(await screen.findByText('Accounts Overview')).toBeInTheDocument()
  })

  it('shows microphone permission guidance instead of connection error when mic is blocked on an open socket, keeping text input live', async () => {
    const origMediaDevices = navigator.mediaDevices
    const origAudioCtx = globalThis.AudioContext
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
          ),
      },
    })
    // Provide a stub AudioContext so createAudioCapture reaches getUserMedia.
    ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
      state = 'running'
      sampleRate = 48000
      audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }
      resume = vi.fn().mockResolvedValue(undefined)
      close = vi.fn().mockResolvedValue(undefined)
      createMediaStreamSource = vi.fn()
      createGain = vi.fn(() => ({ gain: { value: 0 }, connect: vi.fn() }))
      destination = {}
    }

    try {
      Object.assign(HTMLElement.prototype, {
        setPointerCapture: vi.fn(),
        releasePointerCapture: vi.fn(),
      })

      render(
        <MotionConfig reducedMotion="always">
          <App />
        </MotionConfig>,
      )

      const ws = sockets[sockets.length - 1]
      await act(async () => {
        ws.open()
        ws.deliver({ type: 'ready', sessionId: 'sess-mic-denied' })
      })

      const pill = screen.getByRole('button', { name: /Hold to talk/i })
      await act(async () => {
        fireEvent.pointerDown(pill, { pointerId: 1 })
      })

      // Panel displays microphone-permission guidance, NOT "Concierge connection unavailable".
      expect(screen.getByTestId('concierge-mic-blocked-state')).toHaveTextContent(
        /Allow microphone access in your browser to speak/i,
      )
      expect(screen.queryByTestId('concierge-unavailable-state')).toBeNull()
      expect(screen.queryByText(/Concierge connection unavailable/i)).toBeNull()
      expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()

      // Pill tooltip uses plain executive guidance, never leaking NotAllowedError.
      const blockedPill = screen.getByRole('button', { name: /Microphone off/i })
      expect(blockedPill).toHaveAttribute(
        'title',
        'Allow microphone access in your browser, then hold to talk',
      )

      // Text input remains the immediate path forward over the SAME open socket!
      const input = screen.getByLabelText('Ask your Cloudbank concierge')
      fireEvent.change(input, { target: { value: 'Show my savings pot' } })
      fireEvent.submit(input.closest('form')!)

      expect(sockets).toHaveLength(1)
      const textFrames = ws.sent
        .map((raw) => JSON.parse(raw) as { type: string; text?: string })
        .filter((m) => m.type === 'text')
      expect(textFrames).toEqual([{ type: 'text', text: 'Show my savings pot' }])
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: origMediaDevices,
      })
      ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = origAudioCtx
    }
  })

  it('tailors starter prompts per persona (renter Tom vs ERC-near Sarah), auto-scrolls on new turns, and opens mobile concierge drawer', async () => {
    window.history.replaceState({}, '', '/?persona=tom')
    const { unmount } = render(
      <MotionConfig reducedMotion="always">
        <App />
      </MotionConfig>,
    )

    const wsTom = sockets[sockets.length - 1]
    await act(async () => {
      wsTom.open()
      wsTom.deliver({ type: 'ready', sessionId: 'sess-tom' })
    })

    // Tom is a renter: starter prompts offer first-home borrowing instead of mortgage overpay/renewal.
    expect(
      screen.getByRole('button', { name: 'How much could I borrow for my first home?' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /overpaying my mortgage/i }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: /fixed-rate renewal/i }),
    ).toBeNull()

    // Switch to Sarah: shows £96 savings prompt and £400/mo ERC-near overpay prompt.
    fireEvent.click(screen.getByRole('button', { name: /Sarah/i }))
    const wsSarah = sockets[sockets.length - 1]
    await act(async () => {
      wsSarah.open()
      wsSarah.deliver({ type: 'ready', sessionId: 'sess-sarah' })
    })
    expect(
      screen.getByRole('button', {
        name: 'Show me what putting £96 a month extra into savings does.',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'What happens if I overpay my mortgage by £400 a month?',
      }),
    ).toBeInTheDocument()

    // Submit text -> shows thinking indicator and auto-scrolls conversation-stream.
    const scrollSpy = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollSpy
    fireEvent.click(
      screen.getByRole('button', {
        name: 'What happens if I overpay my mortgage by £400 a month?',
      }),
    )
    expect(screen.getByTestId('concierge-thinking-indicator')).toBeInTheDocument()
    expect(scrollSpy).toHaveBeenCalled()
    unmount()

    // Mobile view (?layout=mobile) exposes a clean toggle for the concierge chat drawer.
    window.history.replaceState({}, '', '/?layout=mobile')
    render(
      <MotionConfig reducedMotion="always">
        <App />
      </MotionConfig>,
    )
    const toggle = screen.getByTestId('mobile-concierge-toggle')
    fireEvent.click(toggle)
    expect(screen.getByTestId('mobile-concierge-drawer')).toBeInTheDocument()
  })
})
