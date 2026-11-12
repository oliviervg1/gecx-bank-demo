import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Columns2, Landmark, Lock, MessageSquare, Smartphone } from 'lucide-react'
import { useBankingViewState } from '../agent/BankingViewStateProvider'
import { useAuthSessionOptional } from '../auth/AuthProvider'
import { ConciergePill } from '../components/ConciergePill'
import { HeaderBar } from '../components/HeaderBar'
import { PhoneFrame } from '../components/PhoneFrame'
import { TabBar } from '../components/TabBar'
import { PAGE_TITLES, usePage } from '../pages/PageProvider'
import { parsePersona, PERSONA_OPTIONS, type Persona } from '../personas/personas'
import { usePersona } from '../personas/PersonaProvider'
import { ConciergePanel } from './ConciergePanel'

export type WorkbenchViewMode = 'split' | 'mobile'

function readInitialViewMode(): WorkbenchViewMode {
  if (typeof window === 'undefined') return 'split'
  const raw = new URLSearchParams(window.location.search).get('layout')
  return raw === 'mobile' ? 'mobile' : 'split'
}

function SignedOutScreen({ onSignBackIn }: { onSignBackIn: () => void }) {
  return (
    <div
      data-testid="signed-out-screen"
      className="h-full flex items-center justify-center p-6"
    >
      <div className="max-w-md w-full p-6 rounded-xl border border-brand-divider bg-white text-center">
        <div className="w-11 h-11 rounded-full bg-[#faf9f6] border border-brand-divider flex items-center justify-center mx-auto mb-3 text-brand-green">
          <Lock size={18} aria-hidden="true" />
        </div>
        <h1
          tabIndex={-1}
          className="text-[1.25rem] font-bold tracking-[-0.01em] text-brand-text mb-2"
        >
          You&apos;ve been signed out
        </h1>
        <p className="text-[0.875rem] text-brand-muted leading-relaxed mb-5">
          Your active concierge session has been closed and your conversation history has been cleared from this screen.
        </p>
        <button
          type="button"
          onClick={onSignBackIn}
          className="min-h-10 px-5 py-2 rounded-lg bg-brand-green text-white text-[0.875rem] font-semibold hover:bg-brand-green-deep transition-colors"
        >
          Sign back in
        </button>
      </div>
    </div>
  )
}

interface Props {
  bankingContent: ReactNode
}

export function WorkbenchLayout({ bankingContent }: Props) {
  const { persona, setPersona } = usePersona()
  const { page } = usePage()
  const { navigationAnnouncement } = useBankingViewState()
  const auth = useAuthSessionOptional()
  const signedOut = auth?.signedOut ?? false

  const [viewMode, setViewMode] = useState<WorkbenchViewMode>(readInitialViewMode)
  // Scope strictly to `persona` (never `${persona}:${page}`) so agent-driven cross-page
  // ServerUiState updates never yank the mobile chat drawer closed mid-reply.
  const [conciergeOpenScope, setConciergeOpenScope] = useState<Persona | null>(null)
  const mobileConciergeOpen = !signedOut && conciergeOpenScope === persona

  const mobileFrameToggleRef = useRef<HTMLButtonElement>(null)
  const responsiveToggleRef = useRef<HTMLButtonElement>(null)

  const toggleMobileConcierge = useCallback(() => {
    setConciergeOpenScope((prev) => (prev === persona ? null : persona))
  }, [persona])

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = signedOut ? 'Cloudbank — Signed out' : PAGE_TITLES[page]
    }
  }, [signedOut, page])

  useEffect(() => {
    if (!mobileConciergeOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setConciergeOpenScope(null)
      const toggleBtn =
        viewMode === 'mobile' ? mobileFrameToggleRef.current : responsiveToggleRef.current
      window.setTimeout(() => {
        toggleBtn?.focus()
      }, 0)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [mobileConciergeOpen, viewMode])

  const skipAndAnnouncer = (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-3.5 focus:py-2 focus:rounded-lg focus:bg-brand-green focus:text-white focus:text-sm focus:font-semibold"
      >
        Skip to main content
      </a>
      <div
        data-testid="ui-navigation-announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {navigationAnnouncement}
      </div>
    </>
  )

  if (viewMode === 'mobile') {
    return (
      <div className="min-h-dvh bg-brand-bg flex flex-col">
        {skipAndAnnouncer}

        <nav
          aria-label="Workbench view controls"
          className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4 py-2 border-b border-brand-divider bg-white text-[0.75rem]"
        >
          <div className="flex items-center gap-2">
            <span className="text-brand-muted font-medium">Mobile View</span>
            <select
              aria-label="Customer persona"
              value={persona}
              onChange={(e) => setPersona(parsePersona(e.target.value))}
              className="min-h-9 px-2.5 py-1 rounded-lg border border-brand-border-strong bg-white text-[0.75rem] font-semibold text-brand-text"
            >
              {PERSONA_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.name} · {opt.role}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => setViewMode('split')}
            className="min-h-9 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-brand-border-strong text-brand-green font-semibold hover:bg-[#faf9f6]"
          >
            <Columns2 size={14} aria-hidden="true" />
            <span>Desktop View</span>
          </button>
        </nav>

        <PhoneFrame
          header={
            signedOut ? (
              <header className="flex items-center gap-2 px-4 py-3 border-b border-brand-divider bg-white shrink-0">
                <Landmark size={18} aria-hidden="true" className="text-brand-green" />
                <span className="text-[0.9375rem] font-semibold tracking-[-0.01em] text-brand-text">
                  Cloudbank
                </span>
              </header>
            ) : (
              <HeaderBar
                onToggleConcierge={toggleMobileConcierge}
                conciergeOpen={mobileConciergeOpen}
                toggleButtonRef={mobileFrameToggleRef}
              />
            )
          }
          footer={signedOut ? undefined : <TabBar />}
        >
          {signedOut && auth ? (
            <SignedOutScreen onSignBackIn={auth.signBackIn} />
          ) : mobileConciergeOpen ? (
            <div className="h-full p-3" data-testid="mobile-concierge-drawer">
              <ConciergePanel headingLevel="h1" />
            </div>
          ) : (
            <div className="h-full overflow-y-auto px-4">{bankingContent}</div>
          )}
        </PhoneFrame>
      </div>
    )
  }

  return (
    <div className="min-h-dvh md:h-dvh md:min-h-[36rem] flex flex-col bg-brand-bg text-brand-text md:overflow-hidden">
      {skipAndAnnouncer}

      {/* Clean Executive Top Header Bar */}
      <header className="px-4 lg:px-6 py-2.5 bg-white border-b border-brand-divider flex flex-wrap items-center justify-between gap-2.5 shrink-0">
        {/* Left: Cloudbank Wordmark */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Landmark size={19} aria-hidden="true" className="text-brand-green" />
            <span className="text-[1rem] font-bold tracking-[-0.02em] text-brand-text">
              Cloudbank
            </span>
          </div>
          <span className="hidden md:inline-block h-4 w-px bg-brand-divider" />
          <span className="hidden md:inline text-[0.75rem] text-brand-muted font-medium">
            Personal Banking
          </span>
        </div>

        {/* Center: Compact <640px Persona Selector + >=640px Segmented Persona Switcher */}
        <select
          aria-label="Customer persona"
          value={persona}
          onChange={(e) => setPersona(parsePersona(e.target.value))}
          className="sm:hidden min-h-9 px-2.5 py-1 rounded-lg border border-brand-border-strong bg-white text-[0.75rem] font-semibold text-brand-text"
        >
          {PERSONA_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.name} · {opt.role}
            </option>
          ))}
        </select>

        <div
          role="group"
          aria-label="Customer persona"
          className="hidden sm:inline-flex items-center rounded-lg border border-brand-border-strong bg-[#faf9f6] p-0.5"
        >
          {PERSONA_OPTIONS.map((opt) => {
            const active = persona === opt.id
            return (
              <button
                key={opt.id}
                type="button"
                aria-pressed={active}
                data-persona-id={opt.id}
                data-active={active}
                onClick={() => setPersona(opt.id)}
                className={
                  'min-h-8 px-2.5 py-1 rounded-md text-[0.75rem] transition-colors ' +
                  (active
                    ? 'bg-white text-brand-green font-semibold border border-brand-border-strong'
                    : 'text-brand-muted hover:text-brand-text')
                }
                title={`${opt.name} · ${opt.role}`}
              >
                {opt.name}
                <span className="hidden xl:inline text-brand-muted font-normal">
                  {' '}
                  · {opt.role}
                </span>
              </button>
            )
          })}
        </div>

        {/* Right: Discreet Mobile View Toggle + Responsive Chat Toggle + Voice Button */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setViewMode('mobile')}
            className="hidden md:inline-flex min-h-9 items-center gap-1.5 px-3 py-1.5 rounded-lg border border-brand-border-strong bg-white text-[0.75rem] font-medium text-brand-muted hover:text-brand-text hover:bg-[#faf9f6]"
          >
            <Smartphone size={14} aria-hidden="true" />
            <span>Mobile View</span>
          </button>

          {!signedOut && (
            <>
              <button
                ref={responsiveToggleRef}
                type="button"
                data-testid="responsive-concierge-toggle"
                aria-label={mobileConciergeOpen ? 'Show banking view' : 'Show concierge chat'}
                aria-pressed={mobileConciergeOpen}
                onClick={toggleMobileConcierge}
                className={
                  'md:hidden min-h-9 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[0.75rem] font-medium transition-colors ' +
                  (mobileConciergeOpen
                    ? 'border-brand-green bg-[#faf9f6] text-brand-green font-semibold'
                    : 'border-brand-border-strong bg-white text-brand-muted hover:text-brand-text')
                }
              >
                <MessageSquare size={14} aria-hidden="true" />
                <span>Chat</span>
              </button>

              <ConciergePill />
            </>
          )}
        </div>
      </header>

      {/* Split-Screen Canvas (#f7f6f2 stone background, unified #ffffff surfaces) */}
      {signedOut && auth ? (
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 min-h-0 p-3 lg:p-4 max-w-[100rem] w-full mx-auto"
        >
          <SignedOutScreen onSignBackIn={auth.signBackIn} />
        </main>
      ) : (
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 min-h-0 p-3 lg:p-4 grid grid-cols-1 md:grid-cols-2 gap-3 lg:gap-4 max-w-[100rem] w-full mx-auto"
        >
          {/* Left Surface: 5-Tab Cloudbank Retail Banking App */}
          <section
            aria-label="Cloudbank Personal Banking"
            className={
              (mobileConciergeOpen ? 'hidden md:flex ' : 'flex ') +
              'flex-col h-full min-h-0 bg-white border border-brand-divider rounded-xl overflow-hidden'
            }
          >
            <div className="flex-1 min-h-0 overflow-y-auto px-5">{bankingContent}</div>
            <TabBar />
          </section>

          {/* Right Surface: Clean Executive Concierge Conversation Panel */}
          <div
            className={
              (mobileConciergeOpen ? 'flex ' : 'hidden md:flex ') +
              'flex-col h-full min-h-0'
            }
          >
            <ConciergePanel headingLevel={mobileConciergeOpen ? 'h1' : 'h2'} />
          </div>
        </main>
      )}
    </div>
  )
}
