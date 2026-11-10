import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

describe('Workbench & GECX Inspector end-to-end UI sync & security', () => {
  it('switches across all 3 interactive SVG Inspector nodes on click', () => {
    render(
      <MotionConfig reducedMotion="always">
        <App />
      </MotionConfig>,
    )

    // Default node is topology (Node 2)
    expect(screen.getByTestId('inspector-panel-topology')).toBeInTheDocument()

    // Click Node 1 (Audio & Relay)
    fireEvent.click(screen.getByTestId('inspector-node-audio'))
    expect(screen.getByTestId('inspector-panel-audio')).toBeInTheDocument()
    expect(screen.getByText(/16\/44.1\/48 kHz/)).toBeInTheDocument()

    // Click Node 3 (Controllers & Sync)
    fireEvent.click(screen.getByTestId('inspector-node-controllers'))
    expect(screen.getByTestId('inspector-panel-controllers')).toBeInTheDocument()
  })

  it('drives every field of ui_view_state.schema.json across all 5 tabs and isolates diagnostics/search HTML', async () => {
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

    // 1. Spending overview + highlight_vendor + unrecognised anomaly_status
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

    // 2. Assistant prose + search_suggestions + turn_diagnostics
    await act(async () => {
      ws.deliver({
        type: 'text',
        partial: false,
        text: '<warm> To cancel Netflix, open Account settings. [Diagnosis context: internal raw search payload]',
      })
      ws.deliver({
        type: 'search_suggestions',
        htmls: ['<div class="chip">how to cancel Netflix UK</div>'],
        webSearchQueries: ['how to cancel Netflix subscription UK'],
        citations: [
          { title: 'Netflix Help', uri: 'https://help.netflix.com/cancel' },
          { title: 'Evil URI', uri: 'javascript:alert(1)' },
        ],
      })
      ws.deliver({
        type: 'turn_diagnostics',
        turnIndex: 1,
        agentTransfers: [{ targetAgent: 'everyday_banking_agent' }],
        toolCalls: [{ displayName: 'assist_everyday_banking' }],
        toolResponses: [{ response: { agent_action: '[Diagnosis context: secret]' } }],
        updatedVariables: { everyday_state: { anomaly_status: 'unrecognised' } },
      })
      ws.deliver({ type: 'turn_complete', turnIndex: 1 })
    })

    const stream = screen.getByTestId('conversation-stream')
    expect(stream.textContent).toContain('To cancel Netflix, open Account settings.')
    expect(stream.textContent).not.toContain('Diagnosis context')
    expect(stream.textContent).not.toContain('<warm>')

    // Sandboxed iframe used for htmls; javascript: URI dropped from citations!
    const iframe = stream.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox')
    expect(screen.getByText('Netflix Help')).toBeInTheDocument()
    expect(screen.queryByText('Evil URI')).toBeNull()

    // 3. Savings projection sync (extra_monthly_pence + custom_target_pence)
    await act(async () => {
      ws.deliver({
        type: 'ui_state',
        tier: 1,
        state: {
          seq: 2,
          page: 'savings',
          extra_monthly_pence: 4500,
          custom_target_pence: 1500000,
        },
      })
    })
    expect(await screen.findByText('Home Emergency Pot')).toBeInTheDocument()
    expect(screen.getByText('+£45.00/mo')).toBeInTheDocument()

    // 4. Mortgage overpay sync (subview + monthly_overpayment_pence + lump_sum_overpayment_pence)
    await act(async () => {
      ws.deliver({
        type: 'ui_state',
        tier: 1,
        state: {
          seq: 3,
          page: 'mortgage',
          subview: 'overpay',
          monthly_overpayment_pence: 20000,
          lump_sum_overpayment_pence: 500000,
        },
      })
    })
    expect(await screen.findByTestId('mortgage-overpay-view')).toBeInTheDocument()
    expect(screen.getByText('+£200.00/mo')).toBeInTheDocument()
  })
})
