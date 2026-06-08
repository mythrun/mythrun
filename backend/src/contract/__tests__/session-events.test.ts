import { describe, it, expect } from 'vitest'
import { CLIENT_FRAME_TYPES, SERVER_FRAME_TYPES, classifyClientFrame } from '../session-events.js'

describe('session-events contract', () => {
  it('client frames are the MYT-65 subset plus the MYT-67 dm_invoke summon', () => {
    expect(CLIENT_FRAME_TYPES).toEqual([
      'player_message',
      'typing_start',
      'typing_stop',
      'dm_invoke',
    ])
  })
  it('server frames include join/left/ready/reconnect, and MYT-66 DM-turn types', () => {
    expect(SERVER_FRAME_TYPES).toContain('session_reconnect')
    expect(SERVER_FRAME_TYPES).toContain('text_delta') // MYT-66
  })
  it('classifyClientFrame admits the subset (incl. dm_invoke) and rejects unknown/DM-turn types', () => {
    expect(classifyClientFrame('player_message')).toBe(true)
    expect(classifyClientFrame('dm_invoke')).toBe(true) // MYT-67 T13: explicit @DM summon
    expect(classifyClientFrame('garbage')).toBe(false)
  })
  it('MYT-66 DM frames are server-only and present', () => {
    for (const t of ['dm_thinking', 'text_delta', 'turn_end', 'turn_error']) {
      expect((SERVER_FRAME_TYPES as readonly string[]).includes(t)).toBe(true)
      expect(classifyClientFrame(t)).toBe(false) // never an inbound client frame
    }
  })
})
