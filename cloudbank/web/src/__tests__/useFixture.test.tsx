import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useFixture } from '../data/useFixture'
import { PersonaProvider } from '../personas/PersonaProvider'

// PersonaProvider defaults to chloe when no ?persona= param is present.
function Wrapper({ children }: { children: ReactNode }) {
  return <PersonaProvider>{children}</PersonaProvider>
}

describe('useFixture', () => {
  it('returns the chloe fixture by default', () => {
    const { result } = renderHook(() => useFixture(), { wrapper: Wrapper })
    expect(result.current?.user.first_name).toBe('Chloe')
    expect(result.current?.transactions.length).toBeGreaterThan(20)
  })

  it('every transaction carries a stable id and a category', () => {
    const { result } = renderHook(() => useFixture(), { wrapper: Wrapper })
    const txns = result.current!.transactions
    for (const t of txns) {
      expect(t.id).toMatch(/^txn-/)
      expect(t.category).toBeTruthy()
    }
  })

  it('Netflix is flagged as the anomaly subscription', () => {
    const { result } = renderHook(() => useFixture(), { wrapper: Wrapper })
    const t = result.current!.transactions.find((x) => x.id === 'txn-netflix')
    expect(t).toBeDefined()
    expect(t!.vendor).toBe('Netflix')
    expect(t!.is_anomaly).toBe(true)
    expect(t!.is_subscription).toBe(true)
    expect(t!.amount).toBe(45)
  })
})
