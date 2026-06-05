import { describe, it, expect } from 'vitest'
import { CLIENT_FRAME_TYPES, SERVER_FRAME_TYPES, classifyClientFrame } from '../session-events.js'

describe('session-events contract', () => {
  it('client frames are the MYT-65 subset only (no DM-turn types)', () => {
    expect(CLIENT_FRAME_TYPES).toEqual(['player_message', 'typing_start', 'typing_stop'])
    expect(CLIENT_FRAME_TYPES).not.toContain('dm_invoke') // MYT-66+
  })
  it('server frames include join/left/ready/reconnect, and MYT-66 DM-turn types', () => {
    expect(SERVER_FRAME_TYPES).toContain('session_reconnect')
    expect(SERVER_FRAME_TYPES).toContain('text_delta') // MYT-66
  })
  it('classifyClientFrame admits the subset and rejects unknown/DM types', () => {
    expect(classifyClientFrame('player_message')).toBe(true)
    expect(classifyClientFrame('dm_invoke')).toBe(false)
    expect(classifyClientFrame('garbage')).toBe(false)
  })
  it('MYT-66 DM frames are server-only and present', () => {
    for (const t of ['dm_thinking', 'text_delta', 'turn_end', 'turn_error']) {
      expect((SERVER_FRAME_TYPES as readonly string[]).includes(t)).toBe(true)
      expect(classifyClientFrame(t)).toBe(false) // never an inbound client frame
    }
  })
})
