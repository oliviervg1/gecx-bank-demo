// Hold-to-talk input handling: pointer on the pill, plus the spacebar for
// presenting from a laptop.
//
// The dominant concern here is not ergonomics, it is a mic that gets stuck
// open. That is precisely the failure push-to-talk exists to prevent, so every
// way a hold can end without a matching "up" event is handled: the pointer
// leaving the element, the tab losing focus, the window being hidden, a lost
// keyup, and a hold that simply never ends.

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'

// A hold longer than this is assumed to be a lost event rather than a very
// long sentence. Generous — a rambling demo question is well under this.
export const MAX_HOLD_MS = 30_000

interface Options {
  enabled: boolean
  onBegin: () => void | Promise<void>
  onEnd: () => void
}

export interface HoldHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  )
}

export function useHoldToTalk({ enabled, onBegin, onEnd }: Options): HoldHandlers {
  const holdingRef = useRef(false)
  const watchdogRef = useRef<number | null>(null)
  // Keep the latest callbacks in refs so the global listeners below can be
  // installed once instead of being torn down and re-added on every render.
  const onBeginRef = useRef(onBegin)
  const onEndRef = useRef(onEnd)
  onBeginRef.current = onBegin
  onEndRef.current = onEnd

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current)
      watchdogRef.current = null
    }
  }, [])

  const release = useCallback(() => {
    if (!holdingRef.current) return
    holdingRef.current = false
    clearWatchdog()
    onEndRef.current()
  }, [clearWatchdog])

  const press = useCallback(() => {
    if (holdingRef.current) return
    holdingRef.current = true
    clearWatchdog()
    watchdogRef.current = window.setTimeout(() => {
      watchdogRef.current = null
      // Force-release rather than trusting an "up" that never came.
      if (holdingRef.current) {
        holdingRef.current = false
        onEndRef.current()
      }
    }, MAX_HOLD_MS)
    void onBeginRef.current()
  }, [clearWatchdog])

  // Spacebar, plus the global escape hatches. Installed once; `enabled` is
  // read through a ref-free closure because the effect re-runs when it flips.
  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return
      if (e.repeat) return                 // auto-repeat, not a new press
      if (isTypingTarget(e.target)) return // someone is typing a space
      e.preventDefault()                   // otherwise the page scrolls
      press()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return
      if (isTypingTarget(e.target)) return
      e.preventDefault()
      release()
    }
    // Alt-tabbing away mid-hold must not leave the mic live.
    const onBlur = () => release()
    const onVisibility = () => { if (document.hidden) release() }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      // Unmounting mid-hold counts as a release.
      release()
    }
  }, [enabled, press, release])

  useEffect(() => clearWatchdog, [clearWatchdog])

  return {
    onPointerDown: (e) => {
      if (!enabled) return
      // Capture so a pointer dragged off the pill still delivers its up event
      // here rather than to whatever is underneath.
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* unsupported */ }
      press()
    },
    onPointerUp: (e) => {
      if (!enabled) return
      try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already gone */ }
      release()
    },
    onPointerCancel: (e) => {
      if (!enabled) return
      try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already gone */ }
      release()
    },
  }
}
