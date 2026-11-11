// Builds the lean ClientStart WebSocket handshake frame.
// Persona financial snapshots are loaded server-side by cloudbank/proxy from
// cloudbank/shared/personas/*.json and are never transmitted from the browser.

import {
  DEFAULT_PINNED_DEMO_DATE,
  isValidIsoCalendarDate,
  resolveTimeOfDay,
} from '../util/demoClock'
import type { ClientStartMsg, PersonaId, TimeOfDay } from './protocol'

export interface BuildClientStartOptions {
  demoDate?: string
  timeOfDay?: TimeOfDay
  now?: Date
  sessionId?: string | null
  lastUiSeq?: number | null
}

export function buildClientStart(
  persona: PersonaId,
  opts: BuildClientStartOptions = {},
): ClientStartMsg {
  const demoDate =
    opts.demoDate && isValidIsoCalendarDate(opts.demoDate)
      ? opts.demoDate
      : DEFAULT_PINNED_DEMO_DATE
  const timeOfDay = opts.timeOfDay ?? resolveTimeOfDay(opts.now)

  const msg: ClientStartMsg = {
    type: 'start',
    persona,
    timeOfDay,
    demoDate,
  }

  if (typeof opts.sessionId === 'string' && opts.sessionId.length > 0) {
    msg.sessionId = opts.sessionId
    if (
      typeof opts.lastUiSeq === 'number' &&
      Number.isFinite(opts.lastUiSeq) &&
      opts.lastUiSeq >= 0
    ) {
      msg.lastUiSeq = Math.trunc(opts.lastUiSeq)
    }
  }

  return msg
}
