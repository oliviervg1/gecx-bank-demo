// Single source of truth for persona IDs, display metadata, and URL parsing.

import type { ClientMsg } from '../agent/protocol'

type StartMsg = Extract<ClientMsg, { type: 'start' }>
export type Persona = StartMsg['persona']

export const ALL_PERSONAS: readonly Persona[] = ['chloe', 'david', 'tom', 'sarah']
export const DEFAULT_PERSONA: Persona = 'chloe'

export interface PersonaOption {
  id: Persona
  name: string
  role: string
}

export const PERSONA_OPTIONS: readonly PersonaOption[] = [
  { id: 'chloe', name: 'Chloe', role: 'Homeowner' },
  { id: 'david', name: 'David', role: 'Remortgager' },
  { id: 'tom', name: 'Tom', role: 'First-Time Buyer' },
  { id: 'sarah', name: 'Sarah', role: 'Pre-Retirement' },
]

const PERSONA_SET = new Set<string>(ALL_PERSONAS)

export function parsePersona(raw: string | null | undefined): Persona {
  if (!raw) return DEFAULT_PERSONA
  const lower = raw.toLowerCase()
  return PERSONA_SET.has(lower) ? (lower as Persona) : DEFAULT_PERSONA
}
