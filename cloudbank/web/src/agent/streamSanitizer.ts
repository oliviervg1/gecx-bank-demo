// Strips internal diagnosis notes, Composite v2 inline audio/stage tags, and platform tags,
// and normalises 4+-letter ALL-CAPS TTS lexical-stress words while preserving genuine acronyms,
// so the Workbench conversation stream displays strictly clean customer-facing prose.

const DIAGNOSIS_BLOCK_RE = /\s*\[Diagnosis context:[\s\S]*?(?:\]|$)/gi
const PLATFORM_ENVELOPE_RE =
  /<\s*(?:state_update|context|event)\b[^>]*>[\s\S]*?<\s*\/\s*(?:state_update|context|event)\s*>/gi
const PROSODY_OR_BREAK_TAG_RE = /<\s*\/?\s*(?:prosody|break)\b[^>]*>/gi
// Generic 1-to-4-word inline stage/audio tags such as <warm>, <neutral>, <reassuring>,
// <excited>, <short pause>, <soft sigh>, </warm>, while preserving numeric '< £50' prose.
const GENERIC_AUDIO_TAG_RE =
  /<\/?[a-zA-Z][a-zA-Z-]*(?:\s+[a-zA-Z][a-zA-Z-]*){0,3}\s*\/?>/g
const AGENT_TOKEN_RE = /\{@AGENT:\s*[a-zA-Z0-9_]+\}/gi

// Genuine banking, regulatory, payment-rail, and geographic acronyms preserved in uppercase.
const PRESERVED_ACRONYMS = new Set([
  'AER',
  'APR',
  'APRC',
  'ASOS',
  'ATM',
  'BACS',
  'CHAPS',
  'ERC',
  'FCA',
  'FSCS',
  'GBP',
  'GDPR',
  'HMRC',
  'HSBC',
  'IBAN',
  'IKEA',
  'ISA',
  'LIBOR',
  'LISA',
  'LTV',
  'PAYE',
  'PIN',
  'SEPA',
  'SIPP',
  'SONIA',
  'SVR',
  'SWIFT',
  'UK',
  'VAT',
])

const ALL_CAPS_STRESS_TOKEN_RE =
  /(?<![A-Za-z0-9])([A-Z]+(?:-[A-Z]+)+|[A-Z]{4,})(['’]S)?(?![A-Za-z0-9])/g

function normalizeCapsStressWords(text: string): string {
  return text.replace(
    ALL_CAPS_STRESS_TOKEN_RE,
    (match: string, base: string, possessive: string | undefined, offset: number, full: string) => {
      const lettersOnly = base.replace(/-/g, '')
      if (lettersOnly.length < 4) return match
      if (PRESERVED_ACRONYMS.has(base)) {
        return possessive ? `${base}${possessive.toLowerCase()}` : match
      }

      const loweredBase = base.includes('-')
        ? base
            .split('-')
            .map((part) => (PRESERVED_ACRONYMS.has(part) ? part : part.toLowerCase()))
            .join('-')
        : base.toLowerCase()
      const lowered = possessive ? `${loweredBase}${possessive.toLowerCase()}` : loweredBase

      const before = full.slice(0, offset)
      const after = full.slice(offset + match.length)
      const atSentenceStart =
        (/^\s*['"“‘([]?$/.test(before) || /[.!?]\s+['"“‘([]?$/.test(before)) &&
        /^\s+[a-z]/.test(after)
      if (atSentenceStart && lowered[0] >= 'a' && lowered[0] <= 'z') {
        return lowered[0].toUpperCase() + lowered.slice(1)
      }
      return lowered
    },
  )
}

export function sanitizeAgentProse(raw: string): string {
  if (!raw) return ''
  const stripped = raw
    .replace(PLATFORM_ENVELOPE_RE, ' ')
    .replace(DIAGNOSIS_BLOCK_RE, ' ')
    .replace(PROSODY_OR_BREAK_TAG_RE, ' ')
    .replace(GENERIC_AUDIO_TAG_RE, ' ')
    .replace(AGENT_TOKEN_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalizeCapsStressWords(stripped)
}
