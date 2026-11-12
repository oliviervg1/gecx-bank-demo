// Browser-to-proxy WebSocket wire protocol.
// Validated against cloudbank/shared/ws_protocol.schema.json in both Vitest and Pytest.

import type { SpendCategory } from '../data/fixture'
import type { SpendingPeriod } from '../util/demoClock'

export const MAX_AUDIO_B64_LEN = 87_384
export const MAX_CLIENT_TEXT_CHARS = 8_192

export type PersonaId = 'chloe' | 'david' | 'tom' | 'sarah'
export type TimeOfDay = 'morning' | 'afternoon' | 'evening'

export type UiPageId = 'home' | 'spending' | 'savings' | 'mortgage' | 'profile'
export type UiSpendingViewId = 'overview' | 'category' | 'vendor' | 'trend' | 'subscriptions'
export type UiMortgageSubviewId = 'overview' | 'overpay' | 'rates'
export type WireAnomalyStatus = 'confirmed' | 'unrecognised'

export interface UiViewStatePayload {
  seq: number
  page: UiPageId
  view?: UiSpendingViewId
  period?: SpendingPeriod
  category?: SpendCategory | string
  vendor?: string
  highlight_vendor?: string
  anomaly_status?: WireAnomalyStatus
  anomaly_by_vendor?: Record<string, WireAnomalyStatus>
  extra_monthly_pence?: number
  custom_target_pence?: number
  subview?: UiMortgageSubviewId
  monthly_overpayment_pence?: number
  lump_sum_overpayment_pence?: number
}

export interface ClientStartMsg {
  type: 'start'
  persona: PersonaId
  timeOfDay?: TimeOfDay
  demoDate?: string
  sessionId?: string | null
  lastUiSeq?: number | null
}

export type ClientMsg =
  | ClientStartMsg
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

const VALID_UI_PAGES = new Set<UiPageId>(['home', 'spending', 'savings', 'mortgage', 'profile'])
const VALID_UI_VIEWS = new Set<UiSpendingViewId>([
  'overview',
  'category',
  'vendor',
  'trend',
  'subscriptions',
])
const VALID_UI_PERIODS = new Set<SpendingPeriod>(['this_month', 'last_month', 'two_months_ago'])
const VALID_UI_CATEGORIES = new Set<string>([
  'groceries',
  'coffee_shops',
  'eating_out',
  'subscriptions',
  'transport',
  'shopping',
  'bills',
  'entertainment',
])
const VALID_UI_SUBVIEWS = new Set<UiMortgageSubviewId>(['overview', 'overpay', 'rates'])
const ALLOWED_UI_STATE_KEYS = new Set<string>([
  'seq',
  'page',
  'view',
  'period',
  'category',
  'vendor',
  'highlight_vendor',
  'anomaly_status',
  'anomaly_by_vendor',
  'extra_monthly_pence',
  'custom_target_pence',
  'subview',
  'monthly_overpayment_pence',
  'lump_sum_overpayment_pence',
])
// Matches forbidden angle brackets and ASCII control characters per ws_protocol.schema.json.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_VENDOR_CHAR_RE = /[<>\u0000-\u001f\u007f]/

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

function isValidUiPage(val: unknown): val is UiPageId {
  return typeof val === 'string' && VALID_UI_PAGES.has(val as UiPageId)
}

function isValidUiView(val: unknown): val is UiSpendingViewId {
  return typeof val === 'string' && VALID_UI_VIEWS.has(val as UiSpendingViewId)
}

function isValidUiPeriod(val: unknown): val is SpendingPeriod {
  return typeof val === 'string' && VALID_UI_PERIODS.has(val as SpendingPeriod)
}

function isValidUiSubview(val: unknown): val is UiMortgageSubviewId {
  return typeof val === 'string' && VALID_UI_SUBVIEWS.has(val as UiMortgageSubviewId)
}

function isValidAnomalyStatus(val: unknown): val is WireAnomalyStatus {
  return val === 'confirmed' || val === 'unrecognised'
}

function parseBoundedPence(val: unknown, field: string): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error(`ui_state frame: invalid ${field}`)
  }
  const truncated = Math.trunc(val)
  if (truncated < 0 || truncated > 1_000_000_000) {
    throw new Error(`ui_state frame: out-of-range ${field}`)
  }
  return truncated
}

function parseSafeVendorString(val: unknown, field: string): string {
  if (
    typeof val !== 'string' ||
    val.length < 1 ||
    val.length > 120 ||
    FORBIDDEN_VENDOR_CHAR_RE.test(val)
  ) {
    throw new Error(`ui_state frame: invalid ${field}`)
  }
  return val
}

export function parseUiViewStatePayload(raw: unknown): UiViewStatePayload {
  if (!isPlainObject(raw)) {
    throw new Error('ui_state frame: invalid state')
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_UI_STATE_KEYS.has(key)) {
      throw new Error(`ui_state frame: unexpected property ${key}`)
    }
  }
  if (!isValidUiPage(raw.page)) {
    throw new Error('ui_state frame: invalid state')
  }
  if (typeof raw.seq !== 'number' || !Number.isFinite(raw.seq)) {
    throw new Error('ui_state frame: invalid state')
  }
  const seq = Math.trunc(raw.seq)
  if (seq < 1 || seq > 1_000_000) {
    throw new Error('ui_state frame: invalid seq')
  }

  const out: UiViewStatePayload = {
    seq,
    page: raw.page,
  }

  if (raw.view !== undefined) {
    if (!isValidUiView(raw.view)) {
      throw new Error('ui_state frame: invalid view')
    }
    out.view = raw.view
  }
  if (raw.period !== undefined) {
    if (!isValidUiPeriod(raw.period)) {
      throw new Error('ui_state frame: invalid period')
    }
    out.period = raw.period
  }
  if (raw.category !== undefined) {
    if (typeof raw.category !== 'string' || !VALID_UI_CATEGORIES.has(raw.category)) {
      throw new Error('ui_state frame: invalid category')
    }
    out.category = raw.category
  }
  if (raw.vendor !== undefined) {
    out.vendor = parseSafeVendorString(raw.vendor, 'vendor')
  }
  if (raw.highlight_vendor !== undefined) {
    out.highlight_vendor = parseSafeVendorString(raw.highlight_vendor, 'highlight_vendor')
  }
  if (raw.anomaly_status !== undefined) {
    if (!isValidAnomalyStatus(raw.anomaly_status)) {
      throw new Error('ui_state frame: invalid anomaly_status')
    }
    out.anomaly_status = raw.anomaly_status
  }
  if (raw.anomaly_by_vendor !== undefined) {
    if (!isPlainObject(raw.anomaly_by_vendor)) {
      throw new Error('ui_state frame: invalid anomaly_by_vendor')
    }
    const byVendor: Record<string, WireAnomalyStatus> = {}
    for (const [vendorKey, statusVal] of Object.entries(raw.anomaly_by_vendor)) {
      const safeKey = parseSafeVendorString(vendorKey, 'anomaly_by_vendor')
      if (!isValidAnomalyStatus(statusVal)) {
        throw new Error('ui_state frame: invalid anomaly_by_vendor status')
      }
      byVendor[safeKey] = statusVal
    }
    out.anomaly_by_vendor = byVendor
  }
  if (raw.extra_monthly_pence !== undefined) {
    out.extra_monthly_pence = parseBoundedPence(raw.extra_monthly_pence, 'extra_monthly_pence')
  }
  if (raw.custom_target_pence !== undefined) {
    out.custom_target_pence = parseBoundedPence(raw.custom_target_pence, 'custom_target_pence')
  }
  if (raw.subview !== undefined) {
    if (!isValidUiSubview(raw.subview)) {
      throw new Error('ui_state frame: invalid subview')
    }
    out.subview = raw.subview
  }
  if (raw.monthly_overpayment_pence !== undefined) {
    out.monthly_overpayment_pence = parseBoundedPence(
      raw.monthly_overpayment_pence,
      'monthly_overpayment_pence',
    )
  }
  if (raw.lump_sum_overpayment_pence !== undefined) {
    out.lump_sum_overpayment_pence = parseBoundedPence(
      raw.lump_sum_overpayment_pence,
      'lump_sum_overpayment_pence',
    )
  }

  return out
}

export function parseServerMsg(raw: string): ServerMsg {
  const parsed: unknown = JSON.parse(raw)
  if (!isPlainObject(parsed) || typeof parsed.type !== 'string') {
    throw new Error('unknown server message: missing type')
  }

  switch (parsed.type) {
    case 'ready': {
      if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) {
        throw new Error('ready frame: missing sessionId')
      }
      return { type: 'ready', sessionId: parsed.sessionId }
    }
    case 'audio': {
      if (typeof parsed.data !== 'string' || parsed.data.length === 0) {
        throw new Error('audio frame: missing data')
      }
      return { type: 'audio', data: parsed.data }
    }
    case 'transcript': {
      if (typeof parsed.text !== 'string') {
        throw new Error('transcript frame: missing text')
      }
      return {
        type: 'transcript',
        text: parsed.text,
        isFinal: Boolean(parsed.isFinal),
      }
    }
    case 'text': {
      if (typeof parsed.text !== 'string') {
        throw new Error('text frame: missing text')
      }
      return {
        type: 'text',
        text: parsed.text,
        partial: Boolean(parsed.partial),
      }
    }
    case 'ui_state': {
      const state = parseUiViewStatePayload(parsed.state)
      let tier: 1 | 2 | 3 = 1
      if (parsed.tier !== undefined) {
        if (parsed.tier !== 1 && parsed.tier !== 2 && parsed.tier !== 3) {
          throw new Error('ui_state frame: invalid tier')
        }
        tier = parsed.tier
      }
      return {
        type: 'ui_state',
        state,
        tier,
      }
    }
    case 'turn_diagnostics': {
      const agentTransfers = Array.isArray(parsed.agentTransfers)
        ? parsed.agentTransfers.filter(isPlainObject)
        : []
      const out: ServerTurnDiagnosticsMsg = {
        type: 'turn_diagnostics',
        agentTransfers,
      }
      if (typeof parsed.turnIndex === 'number' && Number.isInteger(parsed.turnIndex)) {
        out.turnIndex = parsed.turnIndex
      }
      return out
    }
    case 'search_suggestions': {
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
    }
    case 'turn_complete': {
      const out: ServerTurnCompleteMsg = { type: 'turn_complete' }
      if (typeof parsed.turnIndex === 'number' && Number.isInteger(parsed.turnIndex)) {
        out.turnIndex = parsed.turnIndex
      }
      return out
    }
    case 'go_away': {
      if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) {
        throw new Error('go_away frame: missing sessionId')
      }
      return { type: 'go_away', sessionId: parsed.sessionId }
    }
    case 'session_expired': {
      if (typeof parsed.message !== 'string') {
        throw new Error('session_expired frame: missing message')
      }
      return { type: 'session_expired', message: parsed.message }
    }
    case 'interrupt':
      return { type: 'interrupt' }
    case 'end':
      return { type: 'end' }
    case 'error': {
      if (typeof parsed.message !== 'string') {
        throw new Error('error frame: missing message')
      }
      const out: ServerErrorMsg = { type: 'error', message: parsed.message }
      if (typeof parsed.field === 'string') {
        out.field = parsed.field
      }
      return out
    }
    default:
      throw new Error(`unknown server message: ${parsed.type}`)
  }
}

export function serializeClientMsg(msg: ClientMsg): string {
  if (msg.type === 'start') {
    const startPayload: Record<string, unknown> = {
      type: 'start',
      persona: msg.persona,
    }
    if (msg.timeOfDay !== undefined) {
      startPayload.timeOfDay = msg.timeOfDay
    }
    if (msg.demoDate !== undefined) {
      startPayload.demoDate = msg.demoDate
    }
    if (typeof msg.sessionId === 'string' && msg.sessionId.length > 0) {
      startPayload.sessionId = msg.sessionId
    }
    if (typeof msg.lastUiSeq === 'number' && Number.isFinite(msg.lastUiSeq) && msg.lastUiSeq >= 0) {
      startPayload.lastUiSeq = Math.trunc(msg.lastUiSeq)
    }
    return JSON.stringify(startPayload)
  }
  if (msg.type === 'audio') {
    if (typeof msg.data !== 'string' || msg.data.length === 0 || msg.data.length > MAX_AUDIO_B64_LEN) {
      throw new Error(`audio frame: data length must be between 1 and ${MAX_AUDIO_B64_LEN}`)
    }
    return JSON.stringify(msg)
  }
  if (msg.type === 'text') {
    if (typeof msg.text !== 'string' || msg.text.length > MAX_CLIENT_TEXT_CHARS) {
      throw new Error(`text frame: text exceeds maximum length ${MAX_CLIENT_TEXT_CHARS}`)
    }
    return JSON.stringify(msg)
  }
  return JSON.stringify(msg)
}
