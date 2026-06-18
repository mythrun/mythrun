// MYT-74d T3: speaker attribution — one source of truth for "who said it",
// shared by the WS replay path and transcript search.
import { describe, expect, it } from 'vitest'
import { resolveSpeaker, DEPARTED_AUTHOR_NAME, DM_SPEAKER_NAME } from '../attribution.js'

describe('resolveSpeaker', () => {
  const map = new Map<string, string>([['u-1', 'Bram Ironhide']])

  it('null user_id (DM-authored) → DM', () => {
    expect(resolveSpeaker(null, map)).toBe(DM_SPEAKER_NAME)
    expect(DM_SPEAKER_NAME).toBe('DM')
  })

  it('a user present in the map → the character name', () => {
    expect(resolveSpeaker('u-1', map)).toBe('Bram Ironhide')
  })

  it('a non-null user absent from the map (departed player) → Former player, not DM', () => {
    expect(resolveSpeaker('u-gone', map)).toBe(DEPARTED_AUTHOR_NAME)
    expect(DEPARTED_AUTHOR_NAME).toBe('Former player')
    expect(resolveSpeaker('u-gone', map)).not.toBe(DM_SPEAKER_NAME)
  })
})
