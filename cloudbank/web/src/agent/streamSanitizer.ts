// Strips internal diagnosis notes, Composite v2 inline audio/stage tags, and platform tags
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

export function sanitizeAgentProse(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(PLATFORM_ENVELOPE_RE, ' ')
    .replace(DIAGNOSIS_BLOCK_RE, ' ')
    .replace(PROSODY_OR_BREAK_TAG_RE, ' ')
    .replace(GENERIC_AUDIO_TAG_RE, ' ')
    .replace(AGENT_TOKEN_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
