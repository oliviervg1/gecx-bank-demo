import { useState, type FormEvent } from 'react'
import { ExternalLink, Send, Sparkles } from 'lucide-react'
import { useAgent } from '../agent/AgentProvider'
import { usePersona } from '../personas/PersonaProvider'
import type { ServerSearchSuggestionsMsg } from '../agent/protocol'

export type InspectorNodeId = 'audio' | 'topology' | 'controllers'

const AGENTS = [
  { id: 'root_agent', label: 'root_agent', role: 'Intent Router' },
  { id: 'everyday_banking_agent', label: 'everyday_banking_agent', role: 'Spending & Search' },
  { id: 'savings_agent', label: 'savings_agent', role: 'Pot & Projections' },
  { id: 'mortgage_agent', label: 'mortgage_agent', role: 'Overpay & Rates' },
] as const

function isSafeHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function buildSandboxedSuggestionDoc(htmlSnippet: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<base target="_blank">',
    '<style>html,body{margin:0;padding:4px 6px;font-family:system-ui,-apple-system,sans-serif;font-size:12px;background:#ffffff;color:#141413;overflow:hidden;}</style>',
    '</head><body>',
    htmlSnippet,
    '</body></html>',
  ].join('')
}

function SearchSuggestionsBlock({
  suggestions,
}: {
  suggestions: ServerSearchSuggestionsMsg
}) {
  const safeCitations = suggestions.citations.filter((c) => isSafeHttpUrl(c.uri ?? c.url))

  return (
    <div className="mt-2 space-y-1.5" data-testid="search-suggestions-block">
      {suggestions.htmls.map((html, idx) => (
        <iframe
          key={`gss-html-${idx}`}
          title={`Google Search suggestion ${idx + 1}`}
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={buildSandboxedSuggestionDoc(html)}
          className="w-full h-10 rounded-lg border border-brand-divider bg-white"
        />
      ))}

      {(suggestions.webSearchQueries.length > 0 || safeCitations.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.webSearchQueries.map((query) => (
            <a
              key={`q-${query}`}
              href={`https://www.google.com/search?q=${encodeURIComponent(query)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-brand-divider bg-[#faf9f6] text-[11px] font-medium text-brand-text hover:border-brand-green"
            >
              <span>Search: {query}</span>
              <ExternalLink size={11} className="text-brand-muted" />
            </a>
          ))}

          {safeCitations.map((cit, idx) => {
            const href = String(cit.uri ?? cit.url)
            const label = String(cit.title ?? href)
            return (
              <a
                key={`cit-${idx}-${href}`}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-brand-divider bg-white text-[11px] font-medium text-brand-green hover:underline"
              >
                <span className="truncate max-w-[200px]">{label}</span>
                <ExternalLink size={11} />
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function GecxInspectorPane() {
  const agent = useAgent()
  const { persona, demoDate } = usePersona()
  const [selectedNode, setSelectedNode] = useState<InspectorNodeId>('topology')
  const [draftText, setDraftText] = useState('')

  const latestDiag =
    agent.diagnostics.length > 0
      ? agent.diagnostics[agent.diagnostics.length - 1]
      : null

  function handleTextSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = draftText.trim()
    if (!trimmed) return
    agent.submitText(trimmed)
    setDraftText('')
  }

  return (
    <section
      aria-label="GECX Architecture Inspector and Concierge Stream"
      className="flex flex-col h-full bg-white border border-brand-divider rounded-xl overflow-hidden"
    >
      {/* Pane Header */}
      <div className="px-4 py-3 border-b border-brand-divider flex items-center justify-between shrink-0">
        <div>
          <div className="text-[11px] uppercase tracking-[0.08em] text-brand-muted font-semibold">
            GECX Live Architecture Inspector
          </div>
          <div className="text-[14px] font-bold text-brand-text leading-tight mt-0.5">
            gemini-composite-v2 · BidiRunSession
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono text-brand-muted">
          <span className="px-2 py-0.5 rounded border border-brand-divider bg-[#faf9f6] text-brand-text">
            phase: {agent.phase}
          </span>
          <span className="px-2 py-0.5 rounded border border-brand-divider bg-[#faf9f6] text-brand-green font-semibold">
            seq: {agent.latestUiState?.seq ?? 0}
          </span>
        </div>
      </div>

      {/* Interactive 3-Node SVG Architecture Diagram */}
      <div className="px-4 pt-3 pb-2.5 border-b border-brand-divider bg-[#faf9f6] shrink-0">
        <svg
          viewBox="0 0 600 84"
          className="w-full h-[76px] select-none"
          role="group"
          aria-label="Interactive 3-node GECX pipeline diagram"
        >
          {/* Connecting hairlines */}
          <line x1="184" y1="42" x2="210" y2="42" stroke="#b8892e" strokeWidth="1.5" />
          <polygon points="210,42 204,38 204,46" fill="#b8892e" />
          <line x1="390" y1="42" x2="416" y2="42" stroke="#b8892e" strokeWidth="1.5" />
          <polygon points="416,42 410,38 410,46" fill="#b8892e" />

          {/* Node 1: Caller & Audio Worklet */}
          <g
            role="button"
            tabIndex={0}
            aria-label="Inspect Node 1: Caller and Audio Worklet"
            aria-pressed={selectedNode === 'audio'}
            data-testid="inspector-node-audio"
            onClick={() => setSelectedNode('audio')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setSelectedNode('audio')
              }
            }}
            className="cursor-pointer"
          >
            <rect
              x="4"
              y="8"
              width="180"
              height="68"
              rx="8"
              fill="#ffffff"
              stroke={selectedNode === 'audio' ? '#0a4d35' : '#e5e3dc'}
              strokeWidth={selectedNode === 'audio' ? '2' : '1'}
            />
            <text x="16" y="27" fill="#63615b" fontSize="9.5" fontWeight="600" letterSpacing="0.06em">
              01 · AUDIO &amp; RELAY
            </text>
            <text x="16" y="45" fill="#141413" fontSize="12" fontWeight="700">
              16 kHz Worklet + Proxy
            </text>
            <text x="16" y="62" fill="#0a4d35" fontSize="10.5" fontWeight="600">
              {agent.pushToTalk ? 'PTT 100ms · <=2.5s VAD' : 'Live 100ms stream'}
            </text>
          </g>

          {/* Node 2: CXAS Hub & 3 Spokes */}
          <g
            role="button"
            tabIndex={0}
            aria-label="Inspect Node 2: CXAS Hub and 3 Spokes"
            aria-pressed={selectedNode === 'topology'}
            data-testid="inspector-node-topology"
            onClick={() => setSelectedNode('topology')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setSelectedNode('topology')
              }
            }}
            className="cursor-pointer"
          >
            <rect
              x="210"
              y="8"
              width="180"
              height="68"
              rx="8"
              fill="#ffffff"
              stroke={selectedNode === 'topology' ? '#0a4d35' : '#e5e3dc'}
              strokeWidth={selectedNode === 'topology' ? '2' : '1'}
            />
            <text x="222" y="27" fill="#63615b" fontSize="9.5" fontWeight="600" letterSpacing="0.06em">
              02 · 4-AGENT TOPOLOGY
            </text>
            <text x="222" y="45" fill="#141413" fontSize="12" fontWeight="700">
              Hub &amp; Silent Callbacks
            </text>
            <text x="222" y="62" fill="#0a4d35" fontSize="10.5" fontWeight="600">
              {agent.activeAgentName}
            </text>
          </g>

          {/* Node 3: Python Controllers & 3-Tier UI Sync */}
          <g
            role="button"
            tabIndex={0}
            aria-label="Inspect Node 3: Python Controllers and 3-Tier State"
            aria-pressed={selectedNode === 'controllers'}
            data-testid="inspector-node-controllers"
            onClick={() => setSelectedNode('controllers')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setSelectedNode('controllers')
              }
            }}
            className="cursor-pointer"
          >
            <rect
              x="416"
              y="8"
              width="180"
              height="68"
              rx="8"
              fill="#ffffff"
              stroke={selectedNode === 'controllers' ? '#0a4d35' : '#e5e3dc'}
              strokeWidth={selectedNode === 'controllers' ? '2' : '1'}
            />
            <text x="428" y="27" fill="#63615b" fontSize="9.5" fontWeight="600" letterSpacing="0.06em">
              03 · CONTROLLERS &amp; SYNC
            </text>
            <text x="428" y="45" fill="#141413" fontSize="12" fontWeight="700">
              3-Tier ui_view_state
            </text>
            <text x="428" y="62" fill="#b8892e" fontSize="10.5" fontWeight="600">
              {agent.latestUiState
                ? `seq ${agent.latestUiState.seq} · Tier ${agent.latestUiTier ?? 1}`
                : '0 prompt tokens · pence'}
            </text>
          </g>
        </svg>

        {/* Active Node Inspection Panel */}
        <div
          data-testid={`inspector-panel-${selectedNode}`}
          className="mt-2 p-2.5 rounded-lg border border-brand-divider bg-white text-[12px]"
        >
          {selectedNode === 'audio' && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <div>
                <span className="text-brand-muted">Session ID:</span>{' '}
                <span className="font-mono text-brand-text">
                  {agent.sessionId ? agent.sessionId.slice(0, 14) : 'pending'}
                </span>
              </div>
              <div>
                <span className="text-brand-muted">Seeded Persona:</span>{' '}
                <span className="font-semibold text-brand-text">
                  {persona} ({demoDate})
                </span>
              </div>
              <div>
                <span className="text-brand-muted">Worklet Resampler:</span>{' '}
                <span className="text-brand-text">16/44.1/48 kHz → 16 kHz (1,600 samples)</span>
              </div>
              <div>
                <span className="text-brand-muted">Keepalive / Expiry:</span>{' '}
                <span className="text-brand-text">10s LINEAR16 silence · 900s idle pause</span>
              </div>
            </div>
          )}

          {selectedNode === 'topology' && (
            <div>
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {AGENTS.map((a) => {
                  const isActive = agent.activeAgentName === a.id
                  return (
                    <span
                      key={a.id}
                      data-active={isActive}
                      className={
                        'px-2 py-0.5 rounded border text-[11px] font-mono ' +
                        (isActive
                          ? 'bg-brand-green text-white border-brand-green font-semibold'
                          : 'bg-[#faf9f6] text-brand-muted border-brand-divider')
                      }
                    >
                      {a.label}
                    </span>
                  )
                })}
              </div>
              <div className="text-[11px] text-brand-muted leading-snug">
                Silent <code className="font-mono text-brand-text">before_model_callback</code>{' '}
                transfers (<code className="font-mono text-brand-text">Part.from_agent_transfer</code>) · Chirp 3 HD{' '}
                <strong className="font-medium text-brand-text">Aoede</strong> · 3 guardrails active (0808 157 0100).
              </div>
            </div>
          )}

          {selectedNode === 'controllers' && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-brand-muted">
                  Exact integer <code className="font-mono text-brand-text">*_pence</code> &amp;{' '}
                  <code className="font-mono text-brand-text">*_bps</code> ·{' '}
                  <code className="font-mono text-brand-text">customer_snapshot</code> = 0 prompt tokens
                </span>
                {latestDiag?.rootSpan && (
                  <span className="text-[11px] font-mono text-brand-green">
                    turn #{latestDiag.turnIndex ?? agent.diagnostics.length}
                  </span>
                )}
              </div>

              {agent.latestUiState ? (
                <pre
                  data-testid="inspector-ui-state-json"
                  className="m-0 p-2 rounded bg-[#faf9f6] border border-brand-divider font-mono text-[11px] text-brand-text overflow-x-auto max-h-20"
                >
                  {JSON.stringify(
                    { tier: agent.latestUiTier, ...agent.latestUiState },
                    null,
                    2,
                  )}
                </pre>
              ) : (
                <div className="text-[11px] text-brand-muted">
                  No <code className="font-mono">ui_view_state</code> emitted yet in this session.
                </div>
              )}

              {latestDiag && (
                <details className="text-[11px]">
                  <summary className="cursor-pointer font-semibold text-brand-green select-none">
                    Latest Turn Diagnostics ({latestDiag.toolCalls.length} tool call
                    {latestDiag.toolCalls.length === 1 ? '' : 's'})
                  </summary>
                  <pre
                    data-testid="inspector-turn-diagnostics-json"
                    className="mt-1 p-2 rounded bg-[#faf9f6] border border-brand-divider font-mono text-[10.5px] text-brand-text overflow-x-auto max-h-28"
                  >
                    {JSON.stringify(
                      {
                        agentTransfers: latestDiag.agentTransfers,
                        toolCalls: latestDiag.toolCalls,
                        toolResponses: latestDiag.toolResponses,
                        updatedVariables: latestDiag.updatedVariables,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Pure-Prose Conversation Stream */}
      <div
        data-testid="conversation-stream"
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3"
      >
        {agent.turns.length === 0 ? (
          <div className="h-full flex flex-col justify-center items-start max-w-md py-4">
            <div className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] text-brand-green font-semibold mb-1.5">
              <Sparkles size={13} className="text-brand-gold" />
              <span>Multi-Product Concierge Ready</span>
            </div>
            <p className="text-[13px] text-brand-muted leading-relaxed">
              Hold the <strong className="font-semibold text-brand-text">Hold to talk</strong> pill (or Spacebar) or type a prompt below. Try asking:
            </p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {[
                'Give me a quick look at my spending this month.',
                'Show me what putting £45 a month into savings does.',
                'Compare my fixed-rate renewal options.',
              ].map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => agent.submitText(prompt)}
                  className="text-left px-2.5 py-1.5 rounded-lg border border-brand-divider bg-[#faf9f6] text-[12px] text-brand-text hover:border-brand-green transition-colors"
                >
                  &ldquo;{prompt}&rdquo;
                </button>
              ))}
            </div>
          </div>
        ) : (
          agent.turns.map((turn) => (
            <div
              key={turn.id}
              data-testid={`turn-${turn.role}`}
              className={
                'flex flex-col ' + (turn.role === 'user' ? 'items-end' : 'items-start')
              }
            >
              <div className="flex items-center gap-1.5 mb-1 text-[11px] text-brand-muted">
                <span className="font-semibold">
                  {turn.role === 'user' ? 'You' : 'Cloudbank Concierge'}
                </span>
                {turn.interrupted && (
                  <span
                    data-testid="interrupted-badge"
                    className="text-[10px] font-medium px-1.5 py-0.2 rounded border border-brand-gold/50 text-brand-gold bg-[#fcf9f2]"
                  >
                    (interrupted)
                  </span>
                )}
              </div>

              {turn.text && (
                <div
                  className={
                    'max-w-[90%] px-3.5 py-2.5 rounded-xl text-[13.5px] leading-relaxed ' +
                    (turn.role === 'user'
                      ? 'bg-brand-green text-white'
                      : 'bg-[#faf9f6] border border-brand-divider text-brand-text')
                  }
                >
                  {turn.text}
                </div>
              )}

              {turn.searchSuggestions && (
                <div className="w-full max-w-[90%]">
                  <SearchSuggestionsBlock suggestions={turn.searchSuggestions} />
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Text Turn Input Bar */}
      <form
        onSubmit={handleTextSubmit}
        className="px-3 py-2.5 border-t border-brand-divider bg-white flex items-center gap-2 shrink-0"
      >
        <input
          type="text"
          aria-label="Message Cloudbank concierge"
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          placeholder="Type a banking question or hold Spacebar to speak…"
          className="flex-1 px-3 py-2 rounded-lg border border-brand-divider bg-[#faf9f6] text-[13px] text-brand-text placeholder:text-brand-muted focus:outline-none focus:bg-white focus:border-brand-green"
        />
        <button
          type="submit"
          aria-label="Send message"
          disabled={!draftText.trim()}
          className="px-3 py-2 rounded-lg bg-brand-green text-white text-[13px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 transition-opacity"
        >
          <Send size={14} />
          <span>Send</span>
        </button>
      </form>
    </section>
  )
}
