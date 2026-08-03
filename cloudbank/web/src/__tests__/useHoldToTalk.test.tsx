// A mic that gets stuck open is the exact failure push-to-talk exists to
// prevent, so most of this file is about holds that end WITHOUT a matching
// "up" event: alt-tabbing away, the tab being hidden, a dropped keyup, a
// pointer dragged off the button, unmount mid-hold, and a hold that simply
// never ends.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { useHoldToTalk, MAX_HOLD_MS } from '../agent/useHoldToTalk'

function Probe({ enabled = true, onBegin, onEnd }: {
  enabled?: boolean; onBegin: () => void; onEnd: () => void
}) {
  const hold = useHoldToTalk({ enabled, onBegin, onEnd })
  return <button data-testid="pill" {...hold}>hold</button>
}

let onBegin: Mock<() => void>
let onEnd: Mock<() => void>

beforeEach(() => {
  onBegin = vi.fn<() => void>()
  onEnd = vi.fn<() => void>()
  // happy-dom's HTMLElement lacks pointer capture.
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(),
  })
})
afterEach(() => cleanup())

function pill() { return screen.getByTestId('pill') }

describe('pointer', () => {
  it('begins on pointerdown and ends on pointerup', () => {
    render(<Probe onBegin={onBegin} onEnd={onEnd} />)
    fireEvent.pointerDown(pill(), { pointerId: 1 })
    expect(onBegin).toHaveBeenCalledTimes(1)
    expect(onEnd).not.toHaveBeenCalled()
    fireEvent.pointerUp(pill(), { pointerId: 1 })
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('ends on pointercancel — a drag off the pill must not leave the mic live', () => {
    render(<Probe onBegin={onBegin} onEnd={onEnd} />)
    fireEvent.pointerDown(pill(), { pointerId: 1 })
    fireEvent.pointerCancel(pill(), { pointerId: 1 })
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('ignores a second pointerdown while already held', () => {
    render(<Probe onBegin={onBegin} onEnd={onEnd} />)
    fireEvent.pointerDown(pill(), { pointerId: 1 })
    fireEvent.pointerDown(pill(), { pointerId: 2 })
    expect(onBegin).toHaveBeenCalledTimes(1)
  })

  it('does nothing when disabled', () => {
    render(<Probe enabled={false} onBegin={onBegin} onEnd={onEnd} />)
    fireEvent.pointerDown(pill(), { pointerId: 1 })
    fireEvent.pointerUp(pill(), { pointerId: 1 })
    expect(onBegin).not.toHaveBeenCalled()
    expect(onEnd).not.toHaveBeenCalled()
  })
})

describe('spacebar', () => {
  it('begins on keydown and ends on keyup', () => {
    render(<Probe onBegin={onBegin} onEnd={onEnd} />)
    fireEvent.keyDown(window, { code: 'Space', key: ' ' })
    expect(onBegin).toHaveBeenCalledTimes(1)
    fireEvent.keyUp(window, { code: 'Space', key: ' ' })
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('ignores auto-repeat, so holding does not re-trigger', () => {
    render(<Probe onBegin={onBegin} onEnd={onEnd} />)
    fireEvent.keyDown(window, { code: 'Space', key: ' ' })
    fireEvent.keyDown(window, { code: 'Space', key: ' ', repeat: true })
    fireEvent.keyDown(window, { code: 'Space', key: ' ', repeat: true })
    expect(onBegin).toHaveBeenCalledTimes(1)
  })

  it('ignores space typed into a text field', () => {
    render(
      <>
        <input data-testid="field" />
        <Probe onBegin={onBegin} onEnd={onEnd} />
      </>,
    )
    const field = screen.getByTestId('field')
    field.focus()
    fireEvent.keyDown(field, { code: 'Space', key: ' ', bubbles: true })
    expect(onBegin).not.toHaveBeenCalled()
  })

  it('ignores other keys', () => {
    render(<Probe onBegin={onBegin} onEnd={onEnd} />)
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a' })
    expect(onBegin).not.toHaveBeenCalled()
  })
})

describe('stuck-mic escape hatches', () => {
  it('releases when the window loses focus (alt-tab mid-hold)', () => {
    render(<Probe onBegin={onBegin} onEnd={onEnd} />)
    fireEvent.keyDown(window, { code: 'Space', key: ' ' })
    fireEvent.blur(window)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('releases when the tab is hidden', () => {
    render(<Probe onBegin={onBegin} onEnd={onEnd} />)
    fireEvent.pointerDown(pill(), { pointerId: 1 })
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    fireEvent(document, new Event('visibilitychange'))
    expect(onEnd).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  it('releases on unmount mid-hold', () => {
    const { unmount } = render(<Probe onBegin={onBegin} onEnd={onEnd} />)
    fireEvent.pointerDown(pill(), { pointerId: 1 })
    unmount()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('force-releases after the watchdog, if an up event never arrives', () => {
    vi.useFakeTimers()
    try {
      render(<Probe onBegin={onBegin} onEnd={onEnd} />)
      fireEvent.pointerDown(pill(), { pointerId: 1 })
      expect(onEnd).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(MAX_HOLD_MS + 100) })
      expect(onEnd).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not double-release when an up arrives after the watchdog fired', () => {
    vi.useFakeTimers()
    try {
      render(<Probe onBegin={onBegin} onEnd={onEnd} />)
      fireEvent.pointerDown(pill(), { pointerId: 1 })
      act(() => { vi.advanceTimersByTime(MAX_HOLD_MS + 100) })
      fireEvent.pointerUp(pill(), { pointerId: 1 })
      expect(onEnd).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('releasing when not held is a no-op', () => {
    render(<Probe onBegin={onBegin} onEnd={onEnd} />)
    fireEvent.pointerUp(pill(), { pointerId: 1 })
    fireEvent.keyUp(window, { code: 'Space', key: ' ' })
    expect(onEnd).not.toHaveBeenCalled()
  })
})
