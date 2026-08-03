import { describe, it, expect, afterEach } from 'vitest'
import {
  parsePushToTalk,
  readPushToTalkFromLocation,
  DEFAULT_PUSH_TO_TALK,
} from '../agent/pushToTalk'

describe('parsePushToTalk', () => {
  it('defaults to ON when the flag is absent', () => {
    // The default matters: a demo run without the flag, in a big room, must
    // not have a live mic.
    expect(DEFAULT_PUSH_TO_TALK).toBe(true)
    expect(parsePushToTalk(null)).toBe(true)
    expect(parsePushToTalk(undefined)).toBe(true)
    expect(parsePushToTalk('')).toBe(true)
  })

  it.each(['0', 'false', 'off', 'no', 'FALSE', 'Off'])('treats %s as disabled', (v) => {
    expect(parsePushToTalk(v)).toBe(false)
  })

  it.each(['1', 'true', 'on', 'yes', 'TRUE'])('treats %s as enabled', (v) => {
    expect(parsePushToTalk(v)).toBe(true)
  })

  it('falls back to the default on an unrecognised value', () => {
    // Fail safe, not open: a typo'd flag should not leave the mic live.
    expect(parsePushToTalk('maybe')).toBe(DEFAULT_PUSH_TO_TALK)
  })
})

describe('readPushToTalkFromLocation', () => {
  afterEach(() => window.history.replaceState({}, '', '/'))

  it('reads ?ptt=0 as disabled', () => {
    window.history.replaceState({}, '', '/?ptt=0')
    expect(readPushToTalkFromLocation()).toBe(false)
  })

  it('is on with no query string', () => {
    window.history.replaceState({}, '', '/')
    expect(readPushToTalkFromLocation()).toBe(true)
  })

  it('coexists with the persona flag', () => {
    window.history.replaceState({}, '', '/?persona=david&ptt=0')
    expect(readPushToTalkFromLocation()).toBe(false)
  })
})
