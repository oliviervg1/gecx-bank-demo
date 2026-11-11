import { describe, it, expect } from 'vitest'
import globalInstructionRaw from '../../../cxas_app/Cloudbank/global_instruction.txt?raw'
import {
  COMPOSITE_AUDIO_TAG_WORDS,
  sanitizeAgentProse,
  stripDiagnosisBlocks,
} from '../agent/streamSanitizer'
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

  it('strips <positive>, <negative>, <throat-clearing>, and all Composite v2 vocal/emotion tags while preserving math comparisons', () => {
    expect(
      sanitizeAgentProse(
        '<warm><positive> Great news, Chloe! <throat-clearing> <short pause> <relief> Notice x<y and y>z holds, as does a < b and c > d. <gasp> <determination> <negative> <sigh>',
      ),
    ).toBe('Great news, Chloe! Notice x<y and y>z holds, as does a < b and c > d.')

    for (const word of [
      'positive',
      'negative',
      'throat-clearing',
      'gasp',
      'faster',
      'determination',
      'interest',
      'enthusiasm',
      'relief',
      'tension',
      'anxiety',
      'awe',
      'surprised',
      'fearful',
      'disgusted',
      'heavy',
      'pant',
      'giggle',
      'snicker',
      'cackle',
      'cough',
      'sneeze',
      'snort',
      'tsk',
      'argh',
      'sob',
      'cry',
      'whimper',
      'groan',
      'yawn',
    ]) {
      expect(COMPOSITE_AUDIO_TAG_WORDS.has(word)).toBe(true)
      expect(sanitizeAgentProse(`<${word}> Balance ready.`)).toBe('Balance ready.')
    }
  })

  it('strips every inline vocal/emotion tag referenced in global_instruction.txt', () => {
    const estructuralXmlTags = new Set([
      'role',
      'persona',
      'constraints',
      'examples',
      'taskflow',
      'subtask',
      'step',
      'trigger',
      'action',
      'instruction',
      'untrusted_web_snippet',
    ])
    const tagMatches = globalInstructionRaw.matchAll(/<([a-zA-Z][a-zA-Z-\s]{0,30})>/g)
    for (const match of tagMatches) {
      const inner = match[1]?.trim() ?? ''
      const firstWord = inner.split(/\s+/)[0]?.toLowerCase() ?? ''
      if (!inner || estructuralXmlTags.has(firstWord)) continue
      expect(
        sanitizeAgentProse(`<${inner}> Clean output.`),
        `Expected <${inner}> from global_instruction.txt to be stripped`,
      ).toBe('Clean output.')
    }

    const sharedVocabModules = import.meta.glob<{ words?: string[] }>(
      '../../../shared/composite_v2_tags.json',
      { eager: true, import: 'default' },
    )
    for (const mod of Object.values(sharedVocabModules)) {
      for (const word of mod.words ?? []) {
        expect(COMPOSITE_AUDIO_TAG_WORDS.has(word), `Missing shared tag word: ${word}`).toBe(true)
      }
    }
  })

  it('strips both closed and unclosed <untrusted_web_snippet> bodies completely', () => {
    const withClosed =
      'Open Account settings. <untrusted_web_snippet source="web">Call 0800 999 9999 or visit scam.xyz</untrusted_web_snippet> Select Cancel Membership.'
    expect(sanitizeAgentProse(withClosed)).toBe(
      'Open Account settings. Select Cancel Membership.',
    )

    const withUnclosed =
      'Open Account settings. <untrusted_web_snippet>Truncated untrusted snippet body with 0800 123 4567'
    expect(sanitizeAgentProse(withUnclosed)).toBe('Open Account settings.')
  })

  it('strips nested and case-insensitive [diagnosis context: ...] blocks using bracket-depth scanning', () => {
    const raw =
      '[diagnosis context: tool [assist_everyday_banking] returned [ok]] Your current balance is £4,250.75.'
    expect(stripDiagnosisBlocks(raw).trim()).toBe('Your current balance is £4,250.75.')
    expect(sanitizeAgentProse(raw)).toBe('Your current balance is £4,250.75.')
  })

  it('normalises ALL-CAPS lexical-stress words while respecting sentence-start casing', () => {
    expect(sanitizeAgentProse('ABSOLUTELY happy to check your REALLY large pot.')).toBe(
      'Absolutely happy to check your really large pot.',
    )
  })
})
