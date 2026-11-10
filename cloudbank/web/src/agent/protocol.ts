// Browser ↔ proxy WebSocket protocol.
// Mirrors cloudbank/proxy/src/proxy/protocol.py message-for-message.

import type { CustomerSnapshot } from '../data/fixture'
import type { SpendingPeriod } from '../util/demoClock'

export type PersonaId = 'chloe' | 'david' | 'tom' | 'sarah'

export interface SeedVariables {
  persona_id: PersonaId
  first_name: string
  demo_date: string
  time_of_day: 'morning' | 'afternoon' | 'evening'
  customer_snapshot: CustomerSnapshot
}

export interface UiViewStatePayload {
  seq: number
  page: 'home' | 'spending' | 'savings' | 'mortgage' | 'profile'
  view?: 'overview' | 'category' | 'vendor' | 'trend' | 'subscriptions'
  period?: SpendingPeriod
  category?: string
  vendor?: string
  highlight_vendor?: string
  anomaly_status?: 'confirmed' | 'unrecognised'
  extra_monthly_pence?: number
  custom_target_pence?: number
  subview?: 'overview' | 'overpay' | 'rates'
  monthly_overpayment_pence?: number
  lump_sum_overpayment_pence?: number
}

export type ClientMsg =
  | {
      type: 'start'
      persona: PersonaId
      variables: SeedVariables
      sessionId?: string | null
    }
  | { type: 'audio'; data: string }
  | { type: 'text'; text: string }
  | { type: 'stop' }

export interface ServerReadyMsg {
  type: 'ready'
  sessionId: string
}

export interface ServerTranscriptMsg {
  type: 'transcript'
  text: string
  isFinal: boolean
}

export interface ServerTextMsg {
  type: 'text'
  text: string
  partial: boolean
}

export interface ServerAudioMsg {
  type: 'audio'
  data: string
}

export interface ServerUiStateMsg {
  type: 'ui_state'
  state: UiViewStatePayload
  tier: 1 | 2 | 3
}

export interface ServerTurnDiagnosticsMsg {
  type: 'turn_diagnostics'
  turnIndex?: number
  agentTransfers: Array<Record<string, unknown>>
  toolCalls: Array<Record<string, unknown>>
  toolResponses: Array<Record<string, unknown>>
  updatedVariables: Record<string, unknown>
  rootSpan?: Record<string, unknown>
}

export interface ServerSearchSuggestionsMsg {
  type: 'search_suggestions'
  htmls: string[]
  webSearchQueries: string[]
  citations: Array<Record<string, unknown>>
}

export interface ServerTurnCompleteMsg {
  type: 'turn_complete'
  turnIndex?: number
}

export interface ServerGoAwayMsg {
  type: 'go_away'
  sessionId: string
}

export interface ServerSessionExpiredMsg {
  type: 'session_expired'
  message: string
}

export interface ServerInterruptMsg {
  type: 'interrupt'
}

export interface ServerEndMsg {
  type: 'end'
}

export interface ServerErrorMsg {
  type: 'error'
  message: string
  field?: string
}

export type ServerMsg =
  | ServerReadyMsg
  | ServerTranscriptMsg
  | ServerTextMsg
  | ServerAudioMsg
  | ServerUiStateMsg
  | ServerTurnDiagnosticsMsg
  | ServerSearchSuggestionsMsg
  | ServerTurnCompleteMsg
  | ServerGoAwayMsg
  | ServerSessionExpiredMsg
  | ServerInterruptMsg
  | ServerEndMsg
  | ServerErrorMsg

const SERVER_TYPES = new Set([
  'ready',
  'transcript',
  'text',
  'audio',
  'ui_state',
  'turn_diagnostics',
  'search_suggestions',
  'turn_complete',
  'go_away',
  'session_expired',
  'interrupt',
  'end',
  'error',
])

const VALID_UI_PAGES = new Set(['home', 'spending', 'savings', 'mortgage', 'profile'])

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

export function parseServerMsg(raw: string): ServerMsg {
  const parsed: unknown = JSON.parse(raw)
  if (!isPlainObject(parsed) || typeof parsed.type !== 'string') {
    throw new Error('unknown server message: missing type')
  }
  if (!SERVER_TYPES.has(parsed.type)) {
    throw new Error(`unknown server message: ${parsed.type}`)
  }

  switch (parsed.type) {
    case 'ready':
      if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) {
        throw new Error('ready frame: missing sessionId')
      }
      break
    case 'audio':
      if (typeof parsed.data !== 'string' || !parsed.data) {
        throw new Error('audio frame: missing data')
      }
      break
    case 'transcript':
      if (typeof parsed.text !== 'string') {
        throw new Error('transcript frame: missing text')
      }
      return {
        type: 'transcript',
        text: parsed.text,
        isFinal: Boolean(parsed.isFinal),
      }
    case 'text':
      if (typeof parsed.text !== 'string') {
        throw new Error('text frame: missing text')
      }
      return {
        type: 'text',
        text: parsed.text,
        partial: Boolean(parsed.partial),
      }
    case 'ui_state': {
      if (
        !isPlainObject(parsed.state) ||
        typeof parsed.state.page !== 'string' ||
        !VALID_UI_PAGES.has(parsed.state.page) ||
        typeof parsed.state.seq !== 'number' ||
        !Number.isFinite(parsed.state.seq)
      ) {
        throw new Error('ui_state frame: invalid state')
      }
      const tier: 1 | 2 | 3 = parsed.tier === 2 || parsed.tier === 3 ? parsed.tier : 1
      return {
        type: 'ui_state',
        state: parsed.state as unknown as UiViewStatePayload,
        tier,
      }
    }
    case 'turn_diagnostics':
      return {
        type: 'turn_diagnostics',
        turnIndex: typeof parsed.turnIndex === 'number' ? parsed.turnIndex : undefined,
        agentTransfers: Array.isArray(parsed.agentTransfers)
          ? (parsed.agentTransfers as Array<Record<string, unknown>>)
          : [],
        toolCalls: Array.isArray(parsed.toolCalls)
          ? (parsed.toolCalls as Array<Record<string, unknown>>)
          : [],
        toolResponses: Array.isArray(parsed.toolResponses)
          ? (parsed.toolResponses as Array<Record<string, unknown>>)
          : [],
        updatedVariables: isPlainObject(parsed.updatedVariables) ? parsed.updatedVariables : {},
        rootSpan: isPlainObject(parsed.rootSpan) ? parsed.rootSpan : undefined,
      }
    case 'search_suggestions':
      return {
        type: 'search_suggestions',
        htmls: Array.isArray(parsed.htmls)
          ? parsed.htmls.filter((x): x is string => typeof x === 'string')
          : [],
        webSearchQueries: Array.isArray(parsed.webSearchQueries)
          ? parsed.webSearchQueries.filter((x): x is string => typeof x === 'string')
          : [],
        citations: Array.isArray(parsed.citations)
          ? parsed.citations.filter(isPlainObject)
          : [],
      }
    case 'go_away':
      if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) {
        throw new Error('go_away frame: missing sessionId')
      }
      break
    case 'session_expired':
      if (typeof parsed.message !== 'string') {
        throw new Error('session_expired frame: missing message')
      }
      break
    case 'error':
      if (typeof parsed.message !== 'string') {
        throw new Error('error frame: missing message')
      }
      break
  }

  return parsed as unknown as ServerMsg
}

export function serializeClientMsg(msg: ClientMsg): string {
  if (msg.type === 'start' && (msg.sessionId === undefined || msg.sessionId === null)) {
    return JSON.stringify({
      type: 'start',
      persona: msg.persona,
      variables: msg.variables,
    })
  }
  return JSON.stringify(msg)
}
