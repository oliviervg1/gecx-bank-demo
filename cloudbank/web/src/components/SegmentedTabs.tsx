import { useRef, type KeyboardEvent, type ReactNode } from 'react'

export interface SegmentedTabItem<T extends string> {
  id: T
  label: string
}

export function getSegmentedTabId(idPrefix: string, tabId: string): string {
  return `${idPrefix}-tab-${tabId}`
}

export function getSegmentedPanelId(idPrefix: string, tabId: string): string {
  return `${idPrefix}-panel-${tabId}`
}

interface SegmentedTabsProps<T extends string> {
  idPrefix: string
  ariaLabel: string
  tabs: ReadonlyArray<SegmentedTabItem<T>>
  activeId: T
  onSelect: (id: T) => void
}

export function SegmentedTabs<T extends string>({
  idPrefix,
  ariaLabel,
  tabs,
  activeId,
  onSelect,
}: SegmentedTabsProps<T>) {
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    if (tabs.length === 0) return
    let nextIndex: number | null = null
    if (e.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % tabs.length
    } else if (e.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
    } else if (e.key === 'Home') {
      nextIndex = 0
    } else if (e.key === 'End') {
      nextIndex = tabs.length - 1
    }
    if (nextIndex === null) return
    e.preventDefault()
    const targetTab = tabs[nextIndex]
    if (!targetTab) return
    onSelect(targetTab.id)
    buttonRefs.current[targetTab.id]?.focus()
  }

  return (
    <div className="flex items-center gap-4 mt-3" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab, idx) => {
        const active = activeId === tab.id
        return (
          <button
            key={tab.id}
            ref={(el) => {
              buttonRefs.current[tab.id] = el
            }}
            id={getSegmentedTabId(idPrefix, tab.id)}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={getSegmentedPanelId(idPrefix, tab.id)}
            tabIndex={active ? 0 : -1}
            data-active={active}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className={
              'min-h-9 px-1 pt-1 pb-1.5 text-[0.8125rem] border-b-2 transition-colors inline-flex items-center ' +
              (active
                ? 'border-brand-green text-brand-green font-semibold'
                : 'border-transparent text-brand-muted hover:text-brand-text')
            }
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}

interface SegmentedTabPanelsProps<T extends string> {
  idPrefix: string
  tabs: ReadonlyArray<SegmentedTabItem<T>>
  activeId: T
  renderPanel: (id: T) => ReactNode
}

export function SegmentedTabPanels<T extends string>({
  idPrefix,
  tabs,
  activeId,
  renderPanel,
}: SegmentedTabPanelsProps<T>) {
  return (
    <>
      {tabs.map((tab) => {
        const active = tab.id === activeId
        return (
          <div
            key={tab.id}
            id={getSegmentedPanelId(idPrefix, tab.id)}
            role="tabpanel"
            aria-labelledby={getSegmentedTabId(idPrefix, tab.id)}
            hidden={!active}
          >
            {active ? renderPanel(tab.id) : null}
          </div>
        )
      })}
    </>
  )
}
