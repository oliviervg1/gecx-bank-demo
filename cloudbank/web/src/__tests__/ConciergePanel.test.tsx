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
  it('renders executive greeting on ready, mode-aware helper copy for ?ptt=0, calm Reconnect status on error, and zero technical jargon', async () => {
    const { unmount } = render(
      <MotionConfig reducedMotion="always">
        <App />
      </MotionConfig>,
    )

    const ws = sockets[sockets.length - 1]!
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

    await act(async () => {
      ws.deliver({ type: 'error', message: 'upstream 1007 failed_precondition' })
    })
    expect(screen.getByTestId('concierge-unavailable-state')).toHaveTextContent(
      "We couldn't reach the concierge. Select Reconnect to try again.",
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'Reconnect' })[0]!)
    expect(sockets.length).toBeGreaterThan(1)
    unmount()

    // Continuous mode (?ptt=0) renders hands-free helper copy instead of "Hold to talk".
    window.history.replaceState({}, '', '/?ptt=0')
    render(
      <MotionConfig reducedMotion="always">
        <App />
      </MotionConfig>,
    )
    const wsCont = sockets[sockets.length - 1]!
    await act(async () => {
      wsCont.open()
      wsCont.deliver({ type: 'ready', sessionId: 'sess-cont' })
    })
    expect(screen.getByText(/start hands-free listening/i)).toBeInTheDocument()
  })

  it('drives every field of ui_view_state across all 5 tabs, announces navigation + finalized turns politely, and sandboxes search HTML', async () => {
    render(
      <MotionConfig reducedMotion="always">
        <App />
      </MotionConfig>,
    )

    const ws = sockets[sockets.length - 1]!
    await act(async () => {
      ws.open()
      ws.deliver({ type: 'ready', sessionId: 'sess-e2e' })
    })

    // 1. Spending overview + highlight_vendor + anomaly_status + polite navigation announcement
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
    expect(screen.getByTestId('ui-navigation-announcer')).toHaveTextContent(
      'Showing Spending: Overview',
    )

    // 2. Spending category + vendor subviews
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
    expect(screen.getByTestId('ui-navigation-announcer')).toHaveTextContent(
      'Showing Spending: Coffee shops',
    )

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

    // 3. Streaming partial sets aria-busy without spamming aria-live; final turn updates polite announcer once.
    await act(async () => {
      ws.deliver({
        type: 'text',
        partial: true,
        text: '<neutral> Your spend is £77.15 HIGHER than October and Netflix was FLAGGED.',
      })
    })
    const stream = screen.getByTestId('conversation-stream')
    expect(stream).toHaveAttribute('role', 'log')
    expect(stream).toHaveAttribute('aria-live', 'off')
    expect(stream).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByTestId('concierge-turn-announcer')).toHaveTextContent('')

    await act(async () => {
      ws.deliver({ type: 'interrupt' })
      ws.deliver({
        type: 'text',
        partial: false,
        text: '<reassuring> To cancel Netflix in the UK, open Account settings or FREEZE your card (4.50% AER, no ERC via BACS or CHAPS). [Diagnosis context: internal [nested] search payload]',
      })
      ws.deliver({
        type: 'search_suggestions',
        htmls: ['<div class="chip">how to cancel Netflix UK</div>'],
        webSearchQueries: ['how to cancel Netflix subscription UK'],
        citations: [
          { title: 'youtube.com', uri: 'https://www.youtube.com/shorts/BgZfIYTa-cA' },
          { title: 'thenational.scot', uri: 'https://www.thenational.scot/cancel-netflix/' },
          { title: 'subsorted.co.uk', uri: 'https://subsorted.co.uk/cancel-netflix.html' },
          { title: 'Netflix Help Centre', uri: 'https://help.netflix.com/cancel' },
          { title: 'Duplicate Netflix', uri: 'https://help.netflix.com/en/node/407' },
          { title: 'emma-app.com', uri: 'https://emma-app.com/how-to-cancel/netflix' },
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

    expect(stream).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByTestId('concierge-turn-announcer')).toHaveTextContent(
      'Cloudbank Concierge: To cancel Netflix in the UK, open Account settings or freeze your card (4.50% AER, no ERC via BACS or CHAPS).',
    )
    expect(stream.textContent).not.toContain('HIGHER')
    expect(stream.textContent).not.toContain('FLAGGED')
    expect(stream.textContent).not.toContain('FREEZE')
    expect(stream.textContent).not.toContain('Diagnosis context')
    expect(stream.textContent).not.toContain('<reassuring>')

    const iframe = stream.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox')
    const citationLinks = Array.from(
      screen.getByTestId('search-suggestions-block').querySelectorAll('a'),
    )
    expect(citationLinks).toHaveLength(3)
    expect(citationLinks[0]).toHaveTextContent('Netflix Help Centre')

    // 4. Savings, Mortgage, Profile, and Home sync
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
    expect(screen.getByTestId('ui-navigation-announcer')).toHaveTextContent(
      'Showing Mortgage: Overpay',
    )

    await act(async () => {
      ws.deliver({ type: 'ui_state', tier: 1, state: { seq: 6, page: 'profile' } })
    })
    expect(await screen.findByText('Debit Card Controls')).toBeInTheDocument()

    await act(async () => {
      ws.deliver({ type: 'ui_state', tier: 1, state: { seq: 7, page: 'home' } })
    })
    expect(await screen.findByText('Accounts Overview')).toBeInTheDocument()
  })

  it('shows microphone permission guidance instead of connection error when mic is blocked on an open socket', async () => {
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
    ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
      state = 'running'
      sampleRate = 48000
      audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }
      resume = vi.fn().mockResolvedValue(undefined)
      close = vi.fn().mockResolvedValue(undefined)
      createMediaStreamSource = vi.fn()
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

      const ws = sockets[sockets.length - 1]!
      await act(async () => {
        ws.open()
        ws.deliver({ type: 'ready', sessionId: 'sess-mic-denied' })
      })

      const pill = screen.getByRole('button', { name: /Hold to talk/i })
      await act(async () => {
        fireEvent.pointerDown(pill, { pointerId: 1, button: 0 })
      })

      expect(screen.getByTestId('concierge-mic-blocked-state')).toHaveTextContent(
        /Allow microphone access in your browser to speak/i,
      )
      expect(screen.queryByTestId('concierge-unavailable-state')).toBeNull()

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

  it('tailors starter prompts per persona and opens mobile concierge drawer with h1 heading', async () => {
    window.history.replaceState({}, '', '/?persona=tom')
    const { unmount } = render(
      <MotionConfig reducedMotion="always">
        <App />
      </MotionConfig>,
    )

    const wsTom = sockets[sockets.length - 1]!
    await act(async () => {
      wsTom.open()
      wsTom.deliver({ type: 'ready', sessionId: 'sess-tom' })
    })

    expect(
      screen.getByRole('button', { name: 'How much could I borrow for my first home?' }),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Sarah/i }))
    const wsSarah = sockets[sockets.length - 1]!
    await act(async () => {
      wsSarah.open()
      wsSarah.deliver({ type: 'ready', sessionId: 'sess-sarah' })
    })
    expect(
      screen.getByRole('button', {
        name: 'What happens if I overpay my mortgage by £400 a month?',
      }),
    ).toBeInTheDocument()
    unmount()

    window.history.replaceState({}, '', '/?layout=mobile')
    render(
      <MotionConfig reducedMotion="always">
        <App />
      </MotionConfig>,
    )
    expect(screen.getByRole('button', { name: 'Desktop View' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mobile-concierge-toggle'))
    expect(screen.getByTestId('mobile-concierge-drawer')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 1, name: 'Cloudbank Concierge' }),
    ).toBeInTheDocument()
  })
})
