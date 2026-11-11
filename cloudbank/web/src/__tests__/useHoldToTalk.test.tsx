import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { useHoldToTalk, MAX_HOLD_MS } from '../agent/useHoldToTalk'

function Probe({
  enabled = true,
  onBegin,
  onEnd,
}: {
  enabled?: boolean
  onBegin: () => void
  onEnd: () => void
}) {
  const hold = useHoldToTalk({ enabled, onBegin, onEnd })
  return (
    <button data-testid="pill" data-concierge-pill="true" {...hold}>
      hold
    </button>
  )
}

let onBegin: Mock<() => void>
let onEnd: Mock<() => void>

beforeEach(() => {
  onBegin = vi.fn<() => void>()
  onEnd = vi.fn<() => void>()
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  })
})
afterEach(() => cleanup())

function pill() {
  return screen.getByTestId('pill')
}

describe('pointer', () => {
  it('begins on primary pointerdown and ends on pointerup', () => {
    render(<Probe onBegin={onBegin} onEnd={onEnd} />)
    fireEvent.pointerDown(pill(), { pointerId: 1, button: 0 })
    expect(onBegin).toHaveBeenCalledTimes(1)
    expect(onEnd).not.toHaveBeenCalled()
    fireEvent.pointerUp(pill(), { pointerId: 1, button: 0 })
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('ignores right-click and middle-click pointerdown so context menus never lock the mic open', () => {
    render(<Probe onBegin={onBegin} onEnd={onEnd} />)
    fireEvent.pointerDown(pill(), { pointerId: 1, pointerType: 'mouse', button: 2 })
    fireEvent.pointerDown(pill(), { pointerId: 2, pointerType: 'mouse', button: 1 })
    expect(onBegin).not.toHaveBeenCalled()
  })

  it('ends on pointercancel when dragged off the pill', () => {
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
  it('begins on keydown and ends on keyup, ignoring auto-repeat and text inputs', () => {
    render(
      <>
        <input data-testid="field" />
        <Probe onBegin={onBegin} onEnd={onEnd} />
      </>,
    )
    fireEvent.keyDown(window, { code: 'Space', key: ' ' })
    fireEvent.keyDown(window, { code: 'Space', key: ' ', repeat: true })
    expect(onBegin).toHaveBeenCalledTimes(1)
    fireEvent.keyUp(window, { code: 'Space', key: ' ' })
    expect(onEnd).toHaveBeenCalledTimes(1)

    const field = screen.getByTestId('field')
    field.focus()
    fireEvent.keyDown(field, { code: 'Space', key: ' ', bubbles: true })
    expect(onBegin).toHaveBeenCalledTimes(1)
  })

  it('ignores space on keyboard-focused (:focus-visible) buttons/tabs, while keeping Spacebar active after mouse clicks', () => {
    render(
      <>
        <button type="button" data-testid="other-btn">
          Other
        </button>
        <div role="tab" tabIndex={0} data-testid="other-tab">
          Tab
        </div>
        <Probe onBegin={onBegin} onEnd={onEnd} />
      </>,
    )
    const otherBtn = screen.getByTestId('other-btn')
    const otherTab = screen.getByTestId('other-tab')

    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab' })
    otherBtn.focus()
    fireEvent.keyDown(otherBtn, { code: 'Space', key: ' ', bubbles: true })
    expect(onBegin).not.toHaveBeenCalled()

    otherTab.focus()
    fireEvent.keyDown(otherTab, { code: 'Space', key: ' ', bubbles: true })
    expect(onBegin).not.toHaveBeenCalled()

    fireEvent.pointerDown(otherBtn, { pointerId: 1, bubbles: true })
    otherBtn.focus()
    fireEvent.click(otherBtn)
    fireEvent.keyDown(otherBtn, { code: 'Space', key: ' ', bubbles: true })
    expect(onBegin).toHaveBeenCalledTimes(1)
    fireEvent.keyUp(otherBtn, { code: 'Space', key: ' ', bubbles: true })
    expect(onEnd).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab' })
    pill().focus()
    fireEvent.keyDown(pill(), { code: 'Space', key: ' ', bubbles: true })
    expect(onBegin).toHaveBeenCalledTimes(2)
  })
})

describe('stuck-mic escape hatches', () => {
  it('releases on window blur, hidden tab, unmount, and 30s MAX_HOLD_MS watchdog without double-releasing', () => {
    vi.useFakeTimers()
    try {
      const { unmount } = render(<Probe onBegin={onBegin} onEnd={onEnd} />)
      fireEvent.keyDown(window, { code: 'Space', key: ' ' })
      fireEvent.blur(window)
      expect(onEnd).toHaveBeenCalledTimes(1)

      fireEvent.pointerDown(pill(), { pointerId: 1 })
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      fireEvent(document, new Event('visibilitychange'))
      expect(onEnd).toHaveBeenCalledTimes(2)
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })

      fireEvent.pointerDown(pill(), { pointerId: 1 })
      act(() => {
        vi.advanceTimersByTime(MAX_HOLD_MS + 100)
      })
      fireEvent.pointerUp(pill(), { pointerId: 1 })
      expect(onEnd).toHaveBeenCalledTimes(3)

      fireEvent.pointerDown(pill(), { pointerId: 1 })
      unmount()
      expect(onEnd).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })
})
