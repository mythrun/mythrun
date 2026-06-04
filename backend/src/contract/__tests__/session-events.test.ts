import { describe, it, expect } from 'vitest'
import { CLIENT_FRAME_TYPES, SERVER_FRAME_TYPES, classifyClientFrame } from '../session-events.js'

describe('session-events contract', () => {
  it('client frames are the MYT-65 subset only (no DM-turn types)', () => {
    expect(CLIENT_FRAME_TYPES).toEqual(['player_message', 'typing_start', 'typing_stop'])
    expect(CLIENT_FRAME_TYPES).not.toContain('dm_invoke') // MYT-66+
  })
  it('server frames include join/left/ready/reconnect, not text_delta', () => {
    expect(SERVER_FRAME_TYPES).toContain('session_reconnect')
    expect(SERVER_FRAME_TYPES).not.toContain('text_delta') // MYT-66+
  })
  it('classifyClientFrame admits the subset and rejects unknown/DM types', () => {
    expect(classifyClientFrame('player_message')).toBe(true)
    expect(classifyClientFrame('dm_invoke')).toBe(false)
    expect(classifyClientFrame('garbage')).toBe(false)
  })
})
