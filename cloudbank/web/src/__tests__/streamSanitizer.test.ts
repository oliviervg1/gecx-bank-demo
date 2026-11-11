import { describe, it, expect } from 'vitest'
import { sanitizeAgentProse, stripDiagnosisBlocks } from '../agent/streamSanitizer'
import { getFixture } from '../data/fixture'

describe('streamSanitizer', () => {
  it('preserves uppercase merchant and account acronyms from active fixtures and UK banking terms', () => {
    const sarah = getFixture('sarah')
    const out = sanitizeAgentProse(
      'Your BT broadband, OVO Energy, TSB, NHS, GWR, NOW, and TFL payments earn 4.50% AER inside FSCS limits.',
      sarah,
    )
    expect(out).toBe(
      'Your BT broadband, OVO Energy, TSB, NHS, GWR, NOW, and TFL payments earn 4.50% AER inside FSCS limits.',
    )
  })

  it('strips Composite v2 inline audio tags while preserving mathematical angle-bracket comparisons', () => {
    expect(
      sanitizeAgentProse('<warmly> Hello Chloe! <short pause> Notice x<y and y>z holds, as does a < b and c > d. <sigh>'),
    ).toBe('Hello Chloe! Notice x<y and y>z holds, as does a < b and c > d.')
  })

  it('strips nested [Diagnosis context: ...] blocks using bracket-depth scanning', () => {
    const raw =
      '[Diagnosis context: tool [assist_everyday_banking] returned [ok]] Your current balance is £4,250.75.'
    expect(stripDiagnosisBlocks(raw).trim()).toBe('Your current balance is £4,250.75.')
    expect(sanitizeAgentProse(raw)).toBe('Your current balance is £4,250.75.')
  })

  it('normalises ALL-CAPS lexical-stress words while respecting sentence-start casing', () => {
    expect(sanitizeAgentProse('ABSOLUTELY happy to check your REALLY large pot.')).toBe(
      'Absolutely happy to check your really large pot.',
    )
  })
})
