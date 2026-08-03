import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PersonaProvider, usePersona } from '../personas/PersonaProvider'

function PersonaProbe() {
  const { persona } = usePersona()
  return <div data-testid="persona">{persona}</div>
}

describe('PersonaProvider', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/')
  })

  it('defaults to chloe when no URL param is present', () => {
    render(
      <PersonaProvider>
        <PersonaProbe />
      </PersonaProvider>,
    )
    expect(screen.getByTestId('persona').textContent).toBe('chloe')
  })

  it('reads the persona from the URL query string', () => {
    window.history.replaceState({}, '', '/?persona=david')
    render(
      <PersonaProvider>
        <PersonaProbe />
      </PersonaProvider>,
    )
    expect(screen.getByTestId('persona').textContent).toBe('david')
  })

  it('falls back to chloe for an unknown persona id', () => {
    window.history.replaceState({}, '', '/?persona=mystery')
    render(
      <PersonaProvider>
        <PersonaProbe />
      </PersonaProvider>,
    )
    expect(screen.getByTestId('persona').textContent).toBe('chloe')
  })

  it('throws when usePersona is used outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<PersonaProbe />)).toThrow(/usePersona/i)
    spy.mockRestore()
  })
})
