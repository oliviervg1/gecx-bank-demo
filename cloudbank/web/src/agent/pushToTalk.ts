// Push-to-talk flag, parsed from `?ptt=`. Mirrors personas/personas.ts.
//
// ON by default. In a large room with a separate PA the microphone hears the
// agent's own voice off the walls; browser echo cancellation cannot help,
// because its reference is the device's own output, not the room's. The result
// is the agent interrupting itself. Hold-to-talk removes the possibility.
//
// `?ptt=0` restores the always-listening behaviour for small rooms, where
// hands-free is part of the pitch.

export const DEFAULT_PUSH_TO_TALK = true

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no'])
const ENABLED_VALUES = new Set(['1', 'true', 'on', 'yes'])

export function parsePushToTalk(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_PUSH_TO_TALK
  const lower = raw.toLowerCase()
  if (DISABLED_VALUES.has(lower)) return false
  if (ENABLED_VALUES.has(lower)) return true
  // Unrecognised value: fall back to the default rather than guessing. An
  // unreadable flag should not silently leave the mic live in a big room.
  return DEFAULT_PUSH_TO_TALK
}

export function readPushToTalkFromLocation(): boolean {
  const search = typeof window === 'undefined' ? '' : window.location.search
  return parsePushToTalk(new URLSearchParams(search).get('ptt'))
}
