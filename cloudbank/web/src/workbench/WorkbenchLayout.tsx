import { useState, type ReactNode } from 'react'
import { Columns2, Landmark, Smartphone } from 'lucide-react'
import { ConciergePill } from '../components/ConciergePill'
import { HeaderBar } from '../components/HeaderBar'
import { PhoneFrame } from '../components/PhoneFrame'
import { TabBar } from '../components/TabBar'
import { PERSONA_OPTIONS } from '../personas/personas'
import { usePersona } from '../personas/PersonaProvider'
import { ConciergePanel } from './ConciergePanel'

export type WorkbenchViewMode = 'split' | 'mobile'

function readInitialViewMode(): WorkbenchViewMode {
  if (typeof window === 'undefined') return 'split'
  const raw = new URLSearchParams(window.location.search).get('layout')
  return raw === 'mobile' ? 'mobile' : 'split'
}

interface Props {
  bankingContent: ReactNode
}

export function WorkbenchLayout({ bankingContent }: Props) {
  const { persona, setPersona } = usePersona()
  const [viewMode, setViewMode] = useState<WorkbenchViewMode>(readInitialViewMode)

  if (viewMode === 'mobile') {
    return (
      <div className="min-h-screen bg-brand-bg flex flex-col">
        {/* Minimal mode return strip hidden on <=420px mobile viewports */}
        <div className="hidden sm:flex items-center justify-between px-4 py-2 border-b border-brand-divider bg-white text-[12px]">
          <span className="text-brand-muted font-medium">Mobile Banking View</span>
          <button
            type="button"
            onClick={() => setViewMode('split')}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-brand-divider text-brand-green font-semibold hover:bg-[#faf9f6]"
          >
            <Columns2 size={14} />
            <span>Desktop View</span>
          </button>
        </div>

        <PhoneFrame header={<HeaderBar />} footer={<TabBar />}>
          <div className="h-full overflow-y-auto px-4">{bankingContent}</div>
        </PhoneFrame>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-brand-bg text-brand-text overflow-hidden">
      {/* Clean Executive Top Header Bar */}
      <header className="px-4 lg:px-6 py-2.5 bg-white border-b border-brand-divider flex flex-wrap items-center justify-between gap-3 shrink-0">
        {/* Left: Cloudbank Wordmark */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Landmark size={19} aria-hidden="true" className="text-brand-green" />
            <span className="text-[16px] font-bold tracking-[-0.02em] text-brand-text">
              Cloudbank
            </span>
          </div>
          <span className="hidden md:inline-block h-4 w-px bg-brand-divider" />
          <span className="hidden md:inline text-[12px] text-brand-muted font-medium">
            Personal Banking
          </span>
        </div>

        {/* Center: Customer Persona Switcher */}
        <div
          role="group"
          aria-label="Customer persona"
          className="hidden sm:inline-flex items-center rounded-lg border border-brand-divider bg-[#faf9f6] p-0.5"
        >
          {PERSONA_OPTIONS.map((opt) => {
            const active = persona === opt.id
            return (
              <button
                key={opt.id}
                type="button"
                data-persona-id={opt.id}
                data-active={active}
                onClick={() => setPersona(opt.id)}
                className={
                  'px-2.5 py-1 rounded-md text-[12px] transition-colors ' +
                  (active
                    ? 'bg-white text-brand-green font-semibold border border-brand-divider'
                    : 'text-brand-muted hover:text-brand-text')
                }
                title={`${opt.name} — ${opt.role}`}
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

        {/* Right: Discreet Mobile View Toggle + Voice Button */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setViewMode('mobile')}
            className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-brand-divider bg-white text-[12px] font-medium text-brand-muted hover:text-brand-text hover:bg-[#faf9f6]"
          >
            <Smartphone size={14} />
            <span>Mobile View</span>
          </button>

          <ConciergePill />
        </div>
      </header>

      {/* Split-Screen Canvas (#f7f6f2 stone background, unified #ffffff left/right surfaces) */}
      <main className="flex-1 min-h-0 p-3 lg:p-4 grid grid-cols-1 md:grid-cols-2 gap-3 lg:gap-4 max-w-[1600px] w-full mx-auto">
        {/* Left Surface: 5-Tab Cloudbank Retail Banking App */}
        <section
          aria-label="Cloudbank Personal Banking"
          className="flex flex-col h-full min-h-0 bg-white border border-brand-divider rounded-xl overflow-hidden"
        >
          <div className="flex-1 min-h-0 overflow-y-auto px-5">{bankingContent}</div>
          <TabBar />
        </section>

        {/* Right Surface: Clean Executive Concierge Conversation Panel */}
        <div className="hidden md:flex flex-col h-full min-h-0">
          <ConciergePanel />
        </div>
      </main>
    </div>
  )
}
