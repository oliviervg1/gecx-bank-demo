// Single source of truth for persona ids and URL/debug-menu parsing.
// The TS type lives in `agent/protocol.ts` (`Persona`) — keeping that import
// avoids drift between the WS protocol and this module.

import type { ClientMsg } from '../agent/protocol'

// Extract the `persona` literal off the discriminated `start` variant so this
// list cannot drift from the WS protocol contract.
type StartMsg = Extract<ClientMsg, { type: 'start' }>
export type Persona = StartMsg['persona']

export const ALL_PERSONAS: readonly Persona[] = ['chloe', 'david', 'tom', 'sarah']
export const DEFAULT_PERSONA: Persona = 'chloe'

const PERSONA_SET = new Set<string>(ALL_PERSONAS)

export function parsePersona(raw: string | null | undefined): Persona {
  if (!raw) return DEFAULT_PERSONA
  const lower = raw.toLowerCase()
  return PERSONA_SET.has(lower) ? (lower as Persona) : DEFAULT_PERSONA
}
