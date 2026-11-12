import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { ToastProvider, useToast } from '../components/ToastProvider'

function Probe({
  message,
  variant,
  label = 'fire',
}: {
  message: string
  variant?: 'info' | 'error'
  label?: string
}) {
  const { show } = useToast()
  return <button onClick={() => show(message, variant)}>{label}</button>
}

describe('ToastProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows a fixed viewport toast inside a persistent polite status region and supports manual dismiss', () => {
    render(
      <ToastProvider>
        <Probe message="Saved." />
      </ToastProvider>,
    )
    expect(screen.getByRole('status')).toBeInTheDocument()
    act(() => {
      screen.getByRole('button', { name: 'fire' }).click()
    })
    expect(screen.getByText('Saved.')).toBeInTheDocument()
    const fixedContainer = screen.getByRole('status').parentElement
    expect(fixedContainer?.className).toContain('fixed')

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  it('auto-dismisses after 4 seconds', () => {
    render(
      <ToastProvider>
        <Probe message="Temporary." />
      </ToastProvider>,
    )
    act(() => {
      screen.getByRole('button', { name: 'fire' }).click()
    })
    expect(screen.getByText('Temporary.')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(4100)
    })
    expect(screen.queryByText('Temporary.')).toBeNull()
  })

  it('replaces an existing toast when a new one is shown', () => {
    render(
      <ToastProvider>
        <Probe message="First" label="first" />
        <Probe message="Second" label="second" />
      </ToastProvider>,
    )
    act(() => {
      screen.getByRole('button', { name: 'first' }).click()
    })
    expect(screen.getByText('First')).toBeInTheDocument()
    act(() => {
      screen.getByRole('button', { name: 'second' }).click()
    })
    expect(screen.getByText('Second')).toBeInTheDocument()
    expect(screen.queryByText('First')).toBeNull()
  })

  it('renders error variant inside an assertive role="alert" live region with a red border', () => {
    render(
      <ToastProvider>
        <Probe message="Bang." variant="error" />
      </ToastProvider>,
    )
    act(() => {
      screen.getByRole('button', { name: 'fire' }).click()
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Bang.')
    const toast = screen.getByText('Bang.').closest('[data-toast]')
    expect(toast).toHaveClass('border-brand-danger')
  })
})
