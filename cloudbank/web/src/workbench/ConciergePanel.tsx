import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  AlertCircle,
  ExternalLink,
  Keyboard,
  MicOff,
  PauseCircle,
  RefreshCw,
  Send,
  Sparkles,
} from 'lucide-react'
import { useAgent } from '../agent/AgentProvider'
import {
  MAX_CLIENT_TEXT_CHARS,
  type ServerSearchSuggestionsMsg,
} from '../agent/protocol'
import type { SessionPhase } from '../agent/sessionMachine'
import type { CustomerSnapshot } from '../data/fixture'
import { useFixture } from '../data/useFixture'
import { prefersReducedMotion } from '../util/motion'

export function buildStarterPrompts(fixture: CustomerSnapshot): string[] {
  const { mortgage, savings } = fixture.accounts
  if (!mortgage) {
    return [
      'Give me a quick look at my spending this month.',
      'How much could I borrow for my first home?',
      `When will I reach my ${savings.goal_name} target?`,
      'Which recurring subscriptions am I paying for?',
    ]
  }

  const anomSub = fixture.transactions.find(
    (t) => t.month_offset === 0 && t.is_anomaly && t.category === 'subscriptions',
  )
  const extraWholePounds = anomSub
    ? Math.max(10, Math.round(anomSub.amount_pence / 100))
    : 45
  const remainingAllowance = Math.max(
    0,
    mortgage.annual_overpayment_allowance_pence - mortgage.overpaid_this_year_pence,
  )
  const mortgageOverpayPrompt =
    remainingAllowance < 500_000
      ? 'What happens if I overpay my mortgage by £400 a month?'
      : 'What would overpaying my mortgage by £200 a month save me?'

  return [
    'Give me a quick look at my spending this month.',
    `Show me what putting £${extraWholePounds} a month extra into savings does.`,
    mortgageOverpayPrompt,
    'Compare my fixed-rate renewal options.',
  ]
}

function resolveSpecialistLabel(activeAgentName: string, latestPage?: string): string | null {
  if (activeAgentName === 'everyday_banking_agent' || latestPage === 'spending') {
    return 'Everyday Banking'
  }
  if (activeAgentName === 'savings_agent' || latestPage === 'savings') {
    return 'Savings'
  }
  if (activeAgentName === 'mortgage_agent' || latestPage === 'mortgage') {
    return 'Mortgages'
  }
  return null
}

function describePoliteSessionStatus(phase: SessionPhase, pushToTalk: boolean): string {
  switch (phase) {
    case 'capturing':
      return pushToTalk ? 'Microphone active. Release to send.' : 'Listening.'
    case 'thinking':
      return 'Thinking…'
    case 'paused':
      return 'Concierge session paused.'
    case 'ended':
      return 'Concierge session ended.'
    default:
      return ''
  }
}

function isSafeHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

export function buildSandboxedSuggestionDoc(htmlSnippet: string): string {
  return [
    '<!doctype html>',
    '<html lang="en-GB"><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: https:; form-action \'none\';">',
    '<base target="_blank">',
    '<style>html,body{margin:0;padding:4px 6px;font-family:system-ui,-apple-system,sans-serif;font-size:12px;line-height:1.35;background:#ffffff;color:#141413;}</style>',
    '</head><body>',
    htmlSnippet,
    '</body></html>',
  ].join('')
}

const GENERIC_DOMAIN_PARTS = new Set([
  'com',
  'co',
  'uk',
  'org',
  'net',
  'gov',
  'help',
  'support',
  'www',
  'app',
])

const VIDEO_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'youtu.be'])

export function selectTopCitations(
  citations: Array<Record<string, unknown>>,
  turnText: string,
): Array<{ href: string; label: string }> {
  const turnWords = new Set(turnText.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
  const candidates: Array<{
    href: string
    label: string
    domain: string
    rank: number
    idx: number
  }> = []

  citations.forEach((cit, idx) => {
    const rawHref = cit.uri ?? cit.url
    if (!isSafeHttpUrl(rawHref)) return
    const parsed = new URL(rawHref)
    const domain = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const domainTokens = domain
      .split('.')
      .filter((part) => part.length >= 3 && !GENERIC_DOMAIN_PARTS.has(part))
    const matchesVendor = domainTokens.some((tok) => turnWords.has(tok))
    const isVideo = VIDEO_HOSTS.has(domain)
    const rank = matchesVendor ? 0 : isVideo ? 2 : 1
    candidates.push({
      href: rawHref,
      label: String(cit.title || domain),
      domain,
      rank,
      idx,
    })
  })

  candidates.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.idx - b.idx))

  const seenDomains = new Set<string>()
  const picked: Array<{ href: string; label: string }> = []
  for (const cand of candidates) {
    if (seenDomains.has(cand.domain)) continue
    seenDomains.add(cand.domain)
    picked.push({ href: cand.href, label: cand.label })
    if (picked.length >= 3) break
  }
  return picked
}

function SearchSuggestionsBlock({
  suggestions,
  turnText,
}: {
  suggestions: ServerSearchSuggestionsMsg
  turnText: string
}) {
  const safeCitations = useMemo(
    () => selectTopCitations(suggestions.citations, turnText),
    [suggestions.citations, turnText],
  )
  const fallbackQueries =
    suggestions.htmls.length === 0 ? suggestions.webSearchQueries : []
  const hasVisibleContent =
    suggestions.htmls.length > 0 || fallbackQueries.length > 0 || safeCitations.length > 0

  if (!hasVisibleContent) return null

  return (
    <div className="mt-2.5 space-y-1.5" data-testid="search-suggestions-block">
      <div className="text-[0.6875rem] font-medium text-brand-muted">
        Web search results (external merchant pages — not verified by Cloudbank)
      </div>

      {suggestions.htmls.map((html, idx) => (
        <iframe
          key={`gss-html-${idx}`}
          title={`Google Search web result suggestion ${idx + 1}`}
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={buildSandboxedSuggestionDoc(html)}
          className="w-full min-h-10 rounded-lg border border-brand-divider bg-white"
        />
      ))}

      {(fallbackQueries.length > 0 || safeCitations.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {fallbackQueries.map((query) => (
            <a
              key={`q-${query}`}
              href={`https://www.google.com/search?q=${encodeURIComponent(query)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="min-h-8 inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-brand-border-strong bg-[#faf9f6] text-[0.75rem] font-medium text-brand-text hover:border-brand-green transition-colors"
            >
              <span>{query}</span>
              <ExternalLink size={11} aria-hidden="true" className="text-brand-muted" />
            </a>
          ))}

          {safeCitations.map((cit, idx) => (
            <a
              key={`cit-${idx}-${cit.href}`}
              href={cit.href}
              target="_blank"
              rel="noopener noreferrer"
              className="min-h-8 inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-brand-border-strong bg-white text-[0.75rem] font-medium text-brand-green hover:underline"
            >
              <span className="truncate max-w-[13.75rem]">{cit.label}</span>
              <ExternalLink size={11} aria-hidden="true" />
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

interface ConciergePanelProps {
  headingLevel?: 'h1' | 'h2'
}

export function ConciergePanel({ headingLevel = 'h2' }: ConciergePanelProps = {}) {
  const agent = useAgent()
  const fixture = useFixture()
  const [draftText, setDraftText] = useState('')
  const streamRef = useRef<HTMLDivElement>(null)
  const endSentinelRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const prevTurnCountRef = useRef(0)

  const firstName = fixture.user.first_name
  const starterPrompts = useMemo(() => buildStarterPrompts(fixture), [fixture])
  const specialistLabel = resolveSpecialistLabel(
    agent.activeAgentName,
    agent.latestUiState?.page,
  )
  const spacebarEnabled = agent.spacebarShortcutEnabled ?? true
  const isMicBlockedOnly = agent.micDenied && agent.connState !== 'error'
  const isAuthExpired = Boolean(agent.authExpired)
  const handleReloadPage = () => {
    if (agent.reloadPage) {
      agent.reloadPage()
      return
    }
    window.location.reload()
  }
  const isStreaming =
    agent.phase === 'thinking' || agent.turns.some((turn) => turn.partial)
  const politePhaseAnnouncement = describePoliteSessionStatus(agent.phase, agent.pushToTalk)

  // Announce strictly finalized text-only assistant turns once. Suppress text injection
  // whenever the turn played 24 kHz WebAudio speech (`turn.hadAudio`), and alternate a
  // zero-width space on consecutive identical text-only replies so screen readers announce
  // repeated turns.
  const finalizedAssistantAnnouncement = useMemo(() => {
    let latestIdx = -1
    for (let i = agent.turns.length - 1; i >= 0; i--) {
      const turn = agent.turns[i]
      if (turn && turn.role === 'assistant' && !turn.partial && !turn.interrupted && turn.text) {
        latestIdx = i
        break
      }
    }
    if (latestIdx < 0) return ''
    const latestTurn = agent.turns[latestIdx]
    if (!latestTurn || latestTurn.hadAudio) return ''

    let textOnlyOrdinal = 0
    for (let i = 0; i <= latestIdx; i++) {
      const t = agent.turns[i]
      if (t && t.role === 'assistant' && !t.partial && !t.interrupted && t.text && !t.hadAudio) {
        textOnlyOrdinal += 1
      }
    }
    const repeatParitySuffix = textOnlyOrdinal > 1 && textOnlyOrdinal % 2 === 0 ? '\u200B' : ''
    return `Cloudbank Concierge: ${latestTurn.text}${repeatParitySuffix}`
  }, [agent.turns])

  useEffect(() => {
    const el = streamRef.current
    const lastTurn = agent.turns[agent.turns.length - 1]
    const userJustSubmitted =
      agent.turns.length > prevTurnCountRef.current && lastTurn?.role === 'user'
    prevTurnCountRef.current = agent.turns.length
    if (!el || agent.turns.length === 0) return

    if (userJustSubmitted || stickToBottomRef.current) {
      stickToBottomRef.current = true
      el.scrollTop = el.scrollHeight
      if (
        endSentinelRef.current &&
        typeof endSentinelRef.current.scrollIntoView === 'function'
      ) {
        endSentinelRef.current.scrollIntoView({
          block: 'end',
          behavior: userJustSubmitted && !prefersReducedMotion() ? 'smooth' : 'auto',
        })
      }
    }
  }, [agent.turns, agent.phase])

  function handleStreamScroll() {
    const el = streamRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom <= 80
  }

  function handleTextSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = draftText.trim()
    if (!trimmed) return
    agent.submitText(trimmed)
    setDraftText('')
  }

  const PanelHeadingTag = headingLevel
  const WelcomeHeadingTag = headingLevel === 'h1' ? 'h2' : 'h3'

  return (
    <section
      aria-label="Cloudbank Concierge"
      className="flex flex-col h-full bg-white border border-brand-divider rounded-xl overflow-hidden"
    >
      <div
        data-testid="concierge-turn-announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {finalizedAssistantAnnouncement}
      </div>

      <div
        data-testid="concierge-phase-announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {politePhaseAnnouncement}
      </div>

      {/* Clean Executive Header */}
      <div className="px-5 py-3.5 border-b border-brand-divider flex flex-wrap items-center justify-between gap-2.5 shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles size={16} aria-hidden="true" className="text-brand-gold-text" />
          <PanelHeadingTag className="text-[1rem] font-bold tracking-[-0.01em] text-brand-text leading-none">
            Cloudbank Concierge
          </PanelHeadingTag>
        </div>

        <div className="flex items-center gap-2">
          {agent.pushToTalk && agent.setSpacebarShortcutEnabled && (
            <button
              type="button"
              data-testid="spacebar-shortcut-toggle"
              aria-pressed={spacebarEnabled}
              aria-label="Spacebar hold-to-talk shortcut"
              onClick={() => agent.setSpacebarShortcutEnabled?.(!spacebarEnabled)}
              className={
                'min-h-8 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[0.6875rem] font-semibold transition-colors ' +
                (spacebarEnabled
                  ? 'border-brand-border-strong bg-[#faf9f6] text-brand-text hover:border-brand-green'
                  : 'border-brand-divider bg-white text-brand-muted hover:text-brand-text')
              }
            >
              <Keyboard size={12} aria-hidden="true" />
              <span>Spacebar: {spacebarEnabled ? 'On' : 'Off'}</span>
            </button>
          )}

          {specialistLabel && (
            <span
              data-testid="active-specialist-pill"
              className="px-2.5 py-1 rounded-full border border-brand-divider bg-[#faf9f6] text-[0.75rem] font-semibold text-brand-green"
            >
              {specialistLabel}
            </span>
          )}
        </div>
      </div>

      {/* Conversation Stream / Executive Welcome */}
      <div
        ref={streamRef}
        onScroll={handleStreamScroll}
        role="log"
        aria-label="Conversation transcript"
        aria-live="off"
        aria-busy={isStreaming}
        data-testid="conversation-stream"
        className="flex-1 min-h-0 overflow-y-auto px-5 py-5 space-y-4"
      >
        {agent.turns.length === 0 ? (
          isMicBlockedOnly ? (
            <div
              data-testid="concierge-mic-blocked-state"
              role="status"
              className="h-full flex flex-col justify-center items-start max-w-lg py-6"
            >
              <div className="inline-flex items-center gap-1.5 text-[0.75rem] font-semibold text-brand-muted mb-2">
                <MicOff size={15} aria-hidden="true" className="text-brand-gold-text" />
                <span>Microphone access is off</span>
              </div>
              <p className="text-[0.9375rem] text-brand-text leading-relaxed">
                Allow microphone access in your browser to speak, or choose a question or type below to continue.
              </p>

              <div className="mt-5 w-full space-y-2">
                {starterPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => agent.submitText(prompt)}
                    className="min-h-10 w-full text-left px-3.5 py-2.5 rounded-xl border border-brand-border-strong bg-[#faf9f6] text-[0.84375rem] text-brand-text hover:bg-white hover:border-brand-green transition-colors"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : agent.phase === 'error' ? (
            <div
              data-testid="concierge-unavailable-state"
              role="alert"
              className="h-full flex flex-col justify-center items-start max-w-md py-6"
            >
              <div className="inline-flex items-center gap-1.5 text-[0.75rem] font-semibold text-brand-muted mb-2">
                <AlertCircle size={15} aria-hidden="true" className="text-brand-gold-text" />
                <span>
                  {isAuthExpired ? 'Session expired' : 'Concierge connection unavailable'}
                </span>
              </div>
              <p className="text-[0.9375rem] text-brand-text leading-relaxed">
                {isAuthExpired
                  ? 'Your sign-in session has expired. Reload the page to sign in again.'
                  : "We couldn't reach the concierge. Select Reconnect to try again."}
              </p>
              <button
                type="button"
                onClick={isAuthExpired ? handleReloadPage : agent.reconnect}
                className="mt-4 min-h-9 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-brand-border-strong bg-[#faf9f6] text-[0.8125rem] font-semibold text-brand-green hover:border-brand-green transition-colors"
              >
                <RefreshCw size={14} aria-hidden="true" />
                <span>{isAuthExpired ? 'Reload page' : 'Reconnect'}</span>
              </button>
            </div>
          ) : agent.phase === 'paused' ? (
            <div
              data-testid="concierge-paused-state"
              role="status"
              className="h-full flex flex-col justify-center items-start max-w-md py-6"
            >
              <div className="inline-flex items-center gap-1.5 text-[0.75rem] font-semibold text-brand-gold-text mb-2">
                <PauseCircle size={15} aria-hidden="true" />
                <span>Session paused</span>
              </div>
              <p className="text-[0.9375rem] text-brand-text leading-relaxed">
                {agent.pushToTalk
                  ? 'Your concierge session paused after a quiet period. Hold or select the voice button above, or ask a question below to continue.'
                  : 'Your concierge session paused after a quiet period. Select the voice button above or ask a question below to continue.'}
              </p>
            </div>
          ) : (
            <div className="h-full flex flex-col justify-center items-start max-w-lg py-6">
              <WelcomeHeadingTag className="text-[1.375rem] font-bold tracking-[-0.02em] text-brand-text leading-tight">
                How can I help today, {firstName}?
              </WelcomeHeadingTag>
              <p className="text-[0.875rem] text-brand-muted leading-relaxed mt-1.5">
                {agent.pushToTalk ? (
                  spacebarEnabled ? (
                    <>
                      Hold or select{' '}
                      <strong className="font-semibold text-brand-text">Hold to talk</strong>, or
                      hold the Spacebar, to speak. You can also choose a question below.
                    </>
                  ) : (
                    <>
                      Hold or select{' '}
                      <strong className="font-semibold text-brand-text">Hold to talk</strong> above
                      to speak, or choose a question below.
                    </>
                  )
                ) : (
                  <>
                    Select{' '}
                    <strong className="font-semibold text-brand-text">Talk to concierge</strong>{' '}
                    above to start hands-free listening, or choose a question below.
                  </>
                )}
              </p>

              <div className="mt-5 w-full space-y-2">
                {starterPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => agent.submitText(prompt)}
                    className="min-h-10 w-full text-left px-3.5 py-2.5 rounded-xl border border-brand-border-strong bg-[#faf9f6] text-[0.84375rem] text-brand-text hover:bg-white hover:border-brand-green transition-colors"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (
          <>
            {agent.turns.map((turn) => (
              <div
                key={turn.id}
                data-testid={`turn-${turn.role}`}
                className={
                  'flex flex-col ' + (turn.role === 'user' ? 'items-end' : 'items-start')
                }
              >
                <div className="flex items-center gap-2 mb-1 text-[0.75rem] text-brand-muted">
                  <span className="font-medium">
                    {turn.role === 'user' ? 'You' : 'Cloudbank Concierge'}
                  </span>
                </div>

                {turn.text && (
                  <div
                    className={
                      'max-w-[88%] px-4 py-3 rounded-xl text-[0.90625rem] leading-relaxed ' +
                      (turn.role === 'user'
                        ? 'bg-brand-green text-white'
                        : 'bg-[#faf9f6] border border-brand-divider text-brand-text')
                    }
                  >
                    {turn.text}
                  </div>
                )}

                {turn.searchSuggestions && (
                  <div className="w-full max-w-[88%]">
                    <SearchSuggestionsBlock
                      suggestions={turn.searchSuggestions}
                      turnText={turn.text}
                    />
                  </div>
                )}
              </div>
            ))}

            {agent.phase === 'thinking' && (
              <div
                data-testid="concierge-thinking-indicator"
                className="flex items-center gap-2 text-[0.8125rem] text-brand-muted"
              >
                <Sparkles
                  size={14}
                  aria-hidden="true"
                  className="text-brand-gold-text animate-pulse motion-reduce:animate-none"
                />
                <span>Thinking…</span>
              </div>
            )}

            {isMicBlockedOnly ? (
              <div
                data-testid="concierge-mic-blocked-banner"
                role="status"
                className="p-3 rounded-xl border border-brand-divider bg-[#faf9f6] text-[0.8125rem] text-brand-text flex items-center gap-2.5"
              >
                <MicOff size={15} aria-hidden="true" className="text-brand-gold-text shrink-0" />
                <span>
                  Microphone access is off. Allow microphone access in your browser to speak, or type your question below.
                </span>
              </div>
            ) : (
              agent.phase === 'error' && (
                <div
                  data-testid="concierge-error-banner"
                  role="alert"
                  className="p-3 rounded-xl border border-brand-divider bg-[#faf9f6] text-[0.8125rem] text-brand-text flex items-center justify-between gap-3"
                >
                  <span>
                    {isAuthExpired
                      ? 'Your sign-in session has expired. Reload the page to continue.'
                      : "We couldn't reach the concierge. Select Reconnect to continue."}
                  </span>
                  <button
                    type="button"
                    onClick={isAuthExpired ? handleReloadPage : agent.reconnect}
                    className="min-h-8 px-2 font-semibold text-brand-green hover:underline shrink-0"
                  >
                    {isAuthExpired ? 'Reload page' : 'Reconnect'}
                  </button>
                </div>
              )
            )}

            <div ref={endSentinelRef} aria-hidden="true" />
          </>
        )}
      </div>

      {/* Bottom Input Bar */}
      <form
        onSubmit={handleTextSubmit}
        className="px-4 py-3 border-t border-brand-divider bg-white flex items-center gap-2.5 shrink-0"
      >
        <input
          type="text"
          aria-label="Ask your Cloudbank concierge"
          maxLength={MAX_CLIENT_TEXT_CHARS}
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          placeholder="Ask your Cloudbank concierge…"
          className="min-h-10 flex-1 px-3.5 py-2 rounded-lg border border-brand-border-strong bg-[#faf9f6] text-[0.84375rem] text-brand-text placeholder:text-brand-muted focus:bg-white focus:border-brand-green"
        />
        <button
          type="submit"
          aria-label="Send message"
          disabled={!draftText.trim()}
          className="min-h-10 px-3.5 py-2 rounded-lg bg-brand-green text-white text-[0.8125rem] font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 transition-opacity"
        >
          <Send size={14} aria-hidden="true" />
          <span>Send</span>
        </button>
      </form>
    </section>
  )
}
