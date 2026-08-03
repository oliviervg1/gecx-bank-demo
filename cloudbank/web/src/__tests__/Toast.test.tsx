import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { ToastProvider, useToast } from '../components/ToastProvider'

function Probe({ message, variant, label = 'fire' }: { message: string; variant?: 'info' | 'error'; label?: string }) {
  const { show } = useToast()
  return <button onClick={() => show(message, variant)}>{label}</button>
}

describe('ToastProvider', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('shows a toast when useToast().show() is called', () => {
    render(
      <ToastProvider>
        <Probe message="Saved." />
      </ToastProvider>,
    )
    act(() => { screen.getByRole('button', { name: 'fire' }).click() })
    expect(screen.getByText('Saved.')).toBeInTheDocument()
  })

  it('auto-dismisses after 4 seconds', () => {
    render(
      <ToastProvider>
        <Probe message="Temporary." />
      </ToastProvider>,
    )
    act(() => { screen.getByRole('button', { name: 'fire' }).click() })
    expect(screen.getByText('Temporary.')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(4100) })
    expect(screen.queryByText('Temporary.')).toBeNull()
  })

  it('replaces an existing toast when a new one is shown', () => {
    render(
      <ToastProvider>
        <Probe message="First" label="first" />
        <Probe message="Second" label="second" />
      </ToastProvider>,
    )
    act(() => { screen.getByRole('button', { name: 'first' }).click() })
    expect(screen.getByText('First')).toBeInTheDocument()
    act(() => { screen.getByRole('button', { name: 'second' }).click() })
    expect(screen.getByText('Second')).toBeInTheDocument()
    expect(screen.queryByText('First')).toBeNull()
  })

  it('renders error variant with a red border', () => {
    render(
      <ToastProvider>
        <Probe message="Bang." variant="error" />
      </ToastProvider>,
    )
    act(() => { screen.getByRole('button', { name: 'fire' }).click() })
    const toast = screen.getByText('Bang.').closest('[data-toast]')
    expect(toast).toHaveClass('border-brand-danger')
  })
})
