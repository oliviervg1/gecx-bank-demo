// Strips internal diagnosis notes, Composite v2 inline audio tags, and platform tags
// so the Workbench conversation stream displays strictly clean customer-facing prose.

const DIAGNOSIS_BLOCK_RE = /\s*\[Diagnosis context:[\s\S]*?(?:\]|$)/gi
const PLATFORM_ENVELOPE_RE =
  /<\s*(?:state_update|context|event)\b[^>]*>[\s\S]*?<\s*\/\s*(?:state_update|context|event)\s*>/gi
const AUDIO_TAG_RE =
  /<\s*\/?\s*(?:warm|empathetic|calm|clear|positive|sympathetic|enthusiasm|relief|interest|determination|breath|sigh|sighs|laugh|chuckle|chuckles|exhales|gasp|whispers|whispering|short\s+pause|long\s+pause|prosody(?:\s+[^>]*)?)\s*>/gi
const AGENT_TOKEN_RE = /\{@AGENT:\s*[a-zA-Z0-9_]+\}/gi

export function sanitizeAgentProse(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(PLATFORM_ENVELOPE_RE, ' ')
    .replace(DIAGNOSIS_BLOCK_RE, ' ')
    .replace(AUDIO_TAG_RE, ' ')
    .replace(AGENT_TOKEN_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
