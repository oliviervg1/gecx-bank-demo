// Hold-to-talk and accessible toggle-to-talk input handling: pointer press-and-hold,
// Spacebar hold-to-talk for laptop presentations, and Click / Enter toggle-to-talk
// for screen readers, switch controls, voice control, and quick taps.
//
// Every way a hold or latched toggle can end without a matching release event is
// guarded: secondary mouse buttons ignored, pointer leaving the element, tab losing
// focus, window being hidden, unmount mid-hold, a 30-second hold watchdog, and a
// 60-second latched toggle-to-talk safety timer.

import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

// A continuous hold longer than 30s or latched toggle longer than 60s is force-released.
export const MAX_HOLD_MS = 30_000
export const MAX_LATCH_MS = 60_000
export const TAP_LATCH_THRESHOLD_MS = 220

const INTERACTIVE_SELECTOR =
  'button, a[href], summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"]'

const KEYBOARD_NAV_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
])

interface Options {
  enabled: boolean
  onBegin: () => void | Promise<void>
  onEnd: () => void
  allowClickToggle?: boolean
  isCapturing?: boolean
  canClickStart?: boolean
  enableSpacebar?: boolean
}

export interface HoldHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
  onClick?: (e: ReactMouseEvent<HTMLElement>) => void
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

function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible')
  } catch {
    return false
  }
}

function shouldIgnoreSpacebarTarget(
  target: EventTarget | null,
  pointerFocused: Element | null,
): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (isTypingTarget(target)) return true
  const interactive = target.closest(INTERACTIVE_SELECTOR)
  if (!interactive) return false
  if (interactive.getAttribute('data-concierge-pill') === 'true') return false
  // Mouse-clicked buttons retain DOM focus in Chrome without :focus-visible;
  // only yield Space when the interactive control has keyboard focus.
  if (interactive === pointerFocused) return false
  return isFocusVisible(interactive)
}

export function useHoldToTalk({
  enabled,
  onBegin,
  onEnd,
  allowClickToggle = false,
  isCapturing = false,
  canClickStart = true,
  enableSpacebar = true,
}: Options): HoldHandlers {
  const holdingRef = useRef(false)
  const watchdogRef = useRef<number | null>(null)
  const tapReleaseTimerRef = useRef<number | null>(null)
  const suppressClickTimerRef = useRef<number | null>(null)
  const pointerDownAtRef = useRef<number | null>(null)
  const closingToggleOnPointerRef = useRef(false)
  const suppressNextClickRef = useRef(false)
  const pointerFocusedRef = useRef<Element | null>(null)

  const onBeginRef = useRef(onBegin)
  const onEndRef = useRef(onEnd)
  const isCapturingRef = useRef(isCapturing)

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current)
      watchdogRef.current = null
    }
  }, [])

  const clearTapReleaseTimer = useCallback(() => {
    if (tapReleaseTimerRef.current !== null) {
      clearTimeout(tapReleaseTimerRef.current)
      tapReleaseTimerRef.current = null
    }
  }, [])

  const clearSuppressClick = useCallback(() => {
    suppressNextClickRef.current = false
    if (suppressClickTimerRef.current !== null) {
      clearTimeout(suppressClickTimerRef.current)
      suppressClickTimerRef.current = null
    }
  }, [])

  const markSuppressNextClick = useCallback(() => {
    clearSuppressClick()
    suppressNextClickRef.current = true
    suppressClickTimerRef.current = window.setTimeout(() => {
      suppressClickTimerRef.current = null
      suppressNextClickRef.current = false
    }, 0)
  }, [clearSuppressClick])

  const armWatchdog = useCallback(
    (timeoutMs: number = MAX_HOLD_MS) => {
      clearWatchdog()
      watchdogRef.current = window.setTimeout(() => {
        watchdogRef.current = null
        if (holdingRef.current || isCapturingRef.current) {
          holdingRef.current = false
          onEndRef.current()
        }
      }, timeoutMs)
    },
    [clearWatchdog],
  )

  useEffect(() => {
    onBeginRef.current = onBegin
    onEndRef.current = onEnd
    isCapturingRef.current = isCapturing
    if (!isCapturing && pointerDownAtRef.current === null && tapReleaseTimerRef.current === null) {
      holdingRef.current = false
      clearWatchdog()
    } else if (isCapturing && enabled && watchdogRef.current === null) {
      armWatchdog(MAX_LATCH_MS)
    }
  }, [onBegin, onEnd, isCapturing, enabled, clearWatchdog, armWatchdog])

  const release = useCallback(() => {
    clearTapReleaseTimer()
    pointerDownAtRef.current = null
    closingToggleOnPointerRef.current = false
    if (!holdingRef.current && !isCapturingRef.current) return
    holdingRef.current = false
    clearWatchdog()
    onEndRef.current()
  }, [clearTapReleaseTimer, clearWatchdog])

  const press = useCallback(
    (watchdogMs: number = MAX_HOLD_MS) => {
      clearTapReleaseTimer()
      if (holdingRef.current) return
      holdingRef.current = true
      armWatchdog(watchdogMs)
      void onBeginRef.current()
    },
    [armWatchdog, clearTapReleaseTimer],
  )

  useEffect(() => {
    if (!enabled) return

    const onWindowPointerDown = (e: PointerEvent | MouseEvent) => {
      if (e.target instanceof HTMLElement) {
        pointerFocusedRef.current = e.target.closest(INTERACTIVE_SELECTOR)
      } else {
        pointerFocusedRef.current = null
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (KEYBOARD_NAV_KEYS.has(e.key)) {
        pointerFocusedRef.current = null
        return
      }
      if (!enableSpacebar) return
      if (e.code !== 'Space' && e.key !== ' ') return
      if (e.repeat || e.isComposing || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
      if (shouldIgnoreSpacebarTarget(e.target, pointerFocusedRef.current)) return
      e.preventDefault()
      press(MAX_HOLD_MS)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (!enableSpacebar) return
      if (e.code !== 'Space' && e.key !== ' ') return
      if (e.isComposing) return
      if (!holdingRef.current && shouldIgnoreSpacebarTarget(e.target, pointerFocusedRef.current)) {
        return
      }
      if (!holdingRef.current) return
      e.preventDefault()
      release()
    }
    const onBlur = () => release()
    const onVisibility = () => {
      if (document.hidden) release()
    }

    window.addEventListener('pointerdown', onWindowPointerDown, true)
    window.addEventListener('mousedown', onWindowPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pointerdown', onWindowPointerDown, true)
      window.removeEventListener('mousedown', onWindowPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      release()
    }
  }, [enabled, enableSpacebar, press, release])

  useEffect(
    () => () => {
      clearTapReleaseTimer()
      clearSuppressClick()
      clearWatchdog()
    },
    [clearTapReleaseTimer, clearSuppressClick, clearWatchdog],
  )

  const handlers: HoldHandlers = {
    onPointerDown: (e) => {
      if (!enabled) return
      // Ignore secondary/middle mouse buttons so right-click context menus never lock the mic open.
      if (typeof e.button === 'number' && e.button !== 0) return

      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* unsupported */
      }

      if (allowClickToggle && (holdingRef.current || isCapturingRef.current)) {
        closingToggleOnPointerRef.current = true
        pointerDownAtRef.current = Date.now()
        return
      }

      closingToggleOnPointerRef.current = false
      pointerDownAtRef.current = Date.now()
      press(MAX_HOLD_MS)
    },
    onPointerUp: (e) => {
      if (!enabled) return
      if (typeof e.button === 'number' && e.button !== 0) return

      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* already gone */
      }

      if (!allowClickToggle) {
        release()
        return
      }

      const downAt = pointerDownAtRef.current
      pointerDownAtRef.current = null
      if (downAt === null) {
        return
      }

      if (closingToggleOnPointerRef.current) {
        closingToggleOnPointerRef.current = false
        markSuppressNextClick()
        release()
        return
      }

      const heldMs = Date.now() - downAt
      if (heldMs >= TAP_LATCH_THRESHOLD_MS) {
        markSuppressNextClick()
        release()
        return
      }

      // Quick tap (< 220ms): if released on the button, onClick will fire synchronously
      // and cancel this fallback timer to latch toggle-to-talk open; if dragged off the
      // button (no click), this timer immediately releases the mic on the next tick.
      clearTapReleaseTimer()
      tapReleaseTimerRef.current = window.setTimeout(() => {
        tapReleaseTimerRef.current = null
        release()
      }, 0)
    },
    onPointerCancel: (e) => {
      if (!enabled) return
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* already gone */
      }
      release()
    },
  }

  if (allowClickToggle) {
    handlers.onClick = (e) => {
      if (!enabled) return
      if (suppressNextClickRef.current) {
        clearSuppressClick()
        return
      }
      // If a quick pointer tap just completed on the pill, cancel the fallback release so
      // capture stays latched open (with 60s safety cap) until the user clicks/presses Enter again.
      if (tapReleaseTimerRef.current !== null) {
        clearTapReleaseTimer()
        holdingRef.current = true
        armWatchdog(MAX_LATCH_MS)
        return
      }
      // Synthetic click from keyboard Enter, screen reader, switch control, or voice control.
      if (holdingRef.current || isCapturingRef.current) {
        release()
        return
      }
      // During agent speech, plain pointer clicks do not barge in accidentally, while keyboard
      // Enter and assistive-technology synthetic clicks (detail === 0) can still toggle barge-in.
      if (!canClickStart && e.detail > 0) {
        return
      }
      press(MAX_LATCH_MS)
    }
  }

  return handlers
}
