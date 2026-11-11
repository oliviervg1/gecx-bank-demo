// Strips internal diagnosis notes, Composite v2 inline audio/stage tags, and platform envelopes,
// and normalises ALL-CAPS TTS lexical-stress words while preserving genuine banking, UK, and
// active-fixture merchant/account acronyms so the Workbench displays clean customer-facing prose.

import { allFixtures, type CustomerSnapshot } from '../data/fixture'

const PLATFORM_ENVELOPE_RE =
  /<\s*(?:state_update|context|event)\b[^>]*>[\s\S]*?<\s*\/\s*(?:state_update|context|event)\s*>/gi
const CLOSED_UNTRUSTED_SNIPPET_RE =
  /<\s*untrusted_web_snippet\b[^>]*>[\s\S]*?<\s*\/\s*untrusted_web_snippet\s*>/gi
const UNCLOSED_UNTRUSTED_SNIPPET_RE = /<\s*untrusted_web_snippet\b[^>]*>[\s\S]*$/gi
const ORPHAN_UNTRUSTED_SNIPPET_CLOSE_RE = /<\s*\/\s*untrusted_web_snippet\s*>/gi
const PROSODY_OR_BREAK_TAG_RE = /<\s*\/?\s*(?:prosody|break)\b[^>]*>/gi
const AGENT_TOKEN_RE = /\{@AGENT:\s*[a-zA-Z0-9_]+\}/gi

// Explicit Composite v2 inline vocal-delivery, emotion, paralinguistic, and pause vocabulary.
// Restricting `<...>` stripping to tags composed of known vocal/stage words (bounded outside
// alphanumeric tokens) ensures mathematical or prose comparisons such as `x<y and y>z` or
// `a < b and c > d` are never eaten.
export const COMPOSITE_AUDIO_TAG_WORDS: ReadonlySet<string> = new Set([
  'admiration',
  'adoration',
  'aggression',
  'agitation',
  'alarm',
  'amused',
  'amusement',
  'anger',
  'angry',
  'annoyance',
  'anxiety',
  'anxious',
  'apologetic',
  'apologetically',
  'argh',
  'audible',
  'awe',
  'beat',
  'bored',
  'breath',
  'breathe',
  'breathes',
  'breathing',
  'brief',
  'bright',
  'cackle',
  'cackles',
  'calm',
  'calmly',
  'cautious',
  'celebratory',
  'cheerful',
  'cheerfully',
  'chuckle',
  'chuckles',
  'clear',
  'clearly',
  'clears',
  'concerned',
  'confident',
  'confidently',
  'confused',
  'confusion',
  'conversational',
  'cough',
  'coughs',
  'cries',
  'cry',
  'crying',
  'curiosity',
  'curious',
  'curiously',
  'deadpan',
  'deep',
  'determination',
  'disgusted',
  'earnest',
  'empathetic',
  'empathetically',
  'encouraging',
  'enthusiasm',
  'enthusiastic',
  'excited',
  'excitedly',
  'excitement',
  'exhale',
  'exhales',
  'extremely',
  'fast',
  'faster',
  'fearful',
  'firm',
  'formal',
  'friendly',
  'frustrated',
  'frustration',
  'gasp',
  'gasps',
  'gentle',
  'gently',
  'giggle',
  'giggles',
  'grateful',
  'groan',
  'groans',
  'happy',
  'heavy',
  'hesitation',
  'hope',
  'inhale',
  'inhales',
  'interest',
  'kind',
  'laugh',
  'laughing',
  'laughs',
  'light',
  'lightly',
  'long',
  'low',
  'matter-of-fact',
  'measured',
  'medium',
  'natural',
  'negative',
  'nervousness',
  'neutral',
  'pace',
  'panic',
  'pant',
  'pants',
  'pause',
  'pauses',
  'polite',
  'politely',
  'positive',
  'professional',
  'quick',
  'quiet',
  'quietly',
  'reassuring',
  'reassuringly',
  'relaxed',
  'relief',
  'relieved',
  'robotic',
  'sad',
  'sarcasm',
  'scared',
  'serious',
  'seriously',
  'seriousness',
  'short',
  'shouting',
  'sigh',
  'sighing',
  'sighs',
  'sleepy',
  'slight',
  'slow',
  'slower',
  'slowly',
  'smile',
  'smiling',
  'sneeze',
  'sneezes',
  'snicker',
  'snickers',
  'snort',
  'snorts',
  'sob',
  'sobs',
  'soft',
  'softly',
  'speaking',
  'steady',
  'supportive',
  'surprised',
  'sympathetic',
  'tension',
  'thoughtful',
  'thoughtfully',
  'throat',
  'throat-clearing',
  'tone',
  'tsk',
  'uhm',
  'um',
  'understanding',
  'upbeat',
  'urgent',
  'voice',
  'warm',
  'warmly',
  'whimper',
  'whimpers',
  'whisper',
  'whispering',
  'whispers',
  'yawn',
  'yawns',
  'yelling',
])

const CANDIDATE_ANGLE_TAG_RE =
  /(?<![A-Za-z0-9])<\/?\s*([a-zA-Z][a-zA-Z-]*(?:\s+[a-zA-Z][a-zA-Z-]*){0,4})\s*\/?>(?![A-Za-z0-9])/g

// Genuine banking, regulatory, payment-rail, UK utility/transport, and geographic acronyms.
const BASE_PRESERVED_ACRONYMS = new Set([
  'AER',
  'AI',
  'APR',
  'APRC',
  'ASOS',
  'ATM',
  'BACS',
  'BBC',
  'BT',
  'CHAPS',
  'CX',
  'CXAS',
  'DD',
  'DVLA',
  'EE',
  'ERC',
  'EU',
  'FCA',
  'FSCS',
  'GBP',
  'GDPR',
  'GECX',
  'GWR',
  'HMRC',
  'HSBC',
  'IBAN',
  'ID',
  'IKEA',
  'ISA',
  'ITV',
  'LIBOR',
  'LISA',
  'LTV',
  'NHS',
  'NI',
  'NOW',
  'OVO',
  'PA',
  'PAYE',
  'PIN',
  'RAC',
  'SEPA',
  'SIPP',
  'SMS',
  'SONIA',
  'SVR',
  'SWIFT',
  'TFL',
  'TFGM',
  'TSB',
  'TV',
  'UK',
  'US',
  'VAT',
])

const UPPERCASE_WORD_RE = /\b[A-Z]{2,}\b/g

function collectUppercaseTokensFromFixture(fixture: CustomerSnapshot, target: Set<string>): void {
  const sources: string[] = [
    fixture.accounts.current.name,
    fixture.accounts.savings.name,
    fixture.accounts.savings.goal_name,
  ]
  if (fixture.accounts.mortgage) {
    sources.push(fixture.accounts.mortgage.address, fixture.accounts.mortgage.rate_type)
  }
  for (const tx of fixture.transactions) {
    sources.push(tx.vendor)
  }
  for (const src of sources) {
    const matches = src.match(UPPERCASE_WORD_RE)
    if (matches) {
      for (const token of matches) {
        target.add(token)
      }
    }
  }
}

const PRESERVED_ACRONYM_CACHE = new WeakMap<CustomerSnapshot, ReadonlySet<string>>()

const DEFAULT_PRESERVED_ACRONYMS: ReadonlySet<string> = (() => {
  const entries = allFixtures()
  const merged = new Set<string>(BASE_PRESERVED_ACRONYMS)
  for (const [, fixture] of entries) {
    collectUppercaseTokensFromFixture(fixture, merged)
  }
  for (const [, fixture] of entries) {
    PRESERVED_ACRONYM_CACHE.set(fixture, merged)
  }
  return merged
})()

function resolvePreservedAcronyms(activeFixture?: CustomerSnapshot): ReadonlySet<string> {
  if (!activeFixture) return DEFAULT_PRESERVED_ACRONYMS
  const cached = PRESERVED_ACRONYM_CACHE.get(activeFixture)
  if (cached) return cached
  const custom = new Set<string>(DEFAULT_PRESERVED_ACRONYMS)
  collectUppercaseTokensFromFixture(activeFixture, custom)
  PRESERVED_ACRONYM_CACHE.set(activeFixture, custom)
  return custom
}

/**
 * Strips `[Diagnosis context: ...]` blocks using bracket-depth scanning so nested `[...]`
 * substrings inside a diagnosis note never terminate stripping prematurely.
 */
export function stripDiagnosisBlocks(input: string): string {
  const lower = input.toLowerCase()
  const marker = '[diagnosis context:'
  let cursor = 0
  let out = ''

  while (cursor < input.length) {
    const start = lower.indexOf(marker, cursor)
    if (start === -1) {
      out += input.slice(cursor)
      break
    }
    out += input.slice(cursor, start)
    let depth = 0
    let idx = start
    while (idx < input.length) {
      const ch = input.charAt(idx)
      if (ch === '[') {
        depth += 1
      } else if (ch === ']') {
        depth -= 1
        if (depth === 0) {
          idx += 1
          break
        }
      }
      idx += 1
    }
    out += ' '
    cursor = idx
  }

  return out
}

function stripCompositeAudioTags(input: string): string {
  return input.replace(CANDIDATE_ANGLE_TAG_RE, (fullMatch: string, innerWords: string) => {
    const words = innerWords
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
    if (words.length === 0) return fullMatch
    const isCompositeStageTag = words.every((w) => COMPOSITE_AUDIO_TAG_WORDS.has(w))
    return isCompositeStageTag ? ' ' : fullMatch
  })
}

const ALL_CAPS_STRESS_TOKEN_RE =
  /(?<![A-Za-z0-9])([A-Z]+(?:-[A-Z]+)+|[A-Z]{2,})(['\u2019]S)?(?![A-Za-z0-9])/g

function normalizeCapsStressWords(text: string, preserved: ReadonlySet<string>): string {
  return text.replace(
    ALL_CAPS_STRESS_TOKEN_RE,
    (
      match: string,
      base: string,
      possessive: string | undefined,
      offset: number,
      full: string,
    ) => {
      const lettersOnly = base.replace(/-/g, '')
      if (lettersOnly.length < 2) return match
      if (preserved.has(base)) {
        return possessive ? `${base}${possessive.toLowerCase()}` : match
      }

      const loweredBase = base.includes('-')
        ? base
            .split('-')
            .map((part) => (preserved.has(part) ? part : part.toLowerCase()))
            .join('-')
        : base.toLowerCase()
      const lowered = possessive ? `${loweredBase}${possessive.toLowerCase()}` : loweredBase

      const before = full.slice(0, offset)
      const after = full.slice(offset + match.length)
      const atSentenceStart =
        (/^\s*['"\u201c\u2018([]?$/.test(before) ||
          /[.!?]\s+['"\u201c\u2018([]?$/.test(before)) &&
        /^\s+[a-z]/.test(after)
      const firstChar = lowered.charAt(0)
      if (atSentenceStart && firstChar >= 'a' && firstChar <= 'z') {
        return firstChar.toUpperCase() + lowered.slice(1)
      }
      return lowered
    },
  )
}

export function sanitizeAgentProse(raw: string, activeFixture?: CustomerSnapshot): string {
  if (!raw) return ''
  const preserved = resolvePreservedAcronyms(activeFixture)

  const withoutEnvelopes = raw
    .replace(PLATFORM_ENVELOPE_RE, ' ')
    .replace(CLOSED_UNTRUSTED_SNIPPET_RE, ' ')
    .replace(UNCLOSED_UNTRUSTED_SNIPPET_RE, ' ')
    .replace(ORPHAN_UNTRUSTED_SNIPPET_CLOSE_RE, ' ')
  const withoutDiagnosis = stripDiagnosisBlocks(withoutEnvelopes)
  const stripped = stripCompositeAudioTags(
    withoutDiagnosis.replace(PROSODY_OR_BREAK_TAG_RE, ' '),
  )
    .replace(AGENT_TOKEN_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return normalizeCapsStressWords(stripped, preserved)
}
