import { describe, it, expect } from 'vitest'
import { CLIENT_FRAME_TYPES, SERVER_FRAME_TYPES, classifyClientFrame } from '../session-events.js'

describe('session-events contract', () => {
  it('client frames are the MYT-65 subset plus dm_invoke, end_session, and resume_combat', () => {
    expect(CLIENT_FRAME_TYPES).toEqual([
      'player_message',
      'typing_start',
      'typing_stop',
      'dm_invoke',
      'end_session',
      'resume_combat',
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

  describe('MYT-68 DM-turn frames', () => {
    it('server allowlist gains skill_check / dice_roll / dm_message', () => {
      expect(SERVER_FRAME_TYPES).toContain('skill_check')
      expect(SERVER_FRAME_TYPES).toContain('dice_roll')
      expect(SERVER_FRAME_TYPES).toContain('dm_message')
    })
    it('roll_complete stays OFF the live client allowlist (no handler — spec §3.8)', () => {
      expect(CLIENT_FRAME_TYPES).not.toContain('roll_complete')
      expect(classifyClientFrame('roll_complete')).toBe(false)
    })
  })

  describe('MYT-70 ledger_update frame', () => {
    it('server allowlist gains ledger_update', () => {
      expect(SERVER_FRAME_TYPES).toContain('ledger_update')
    })
    it('ledger_update is server-only — never an inbound client frame', () => {
      expect(CLIENT_FRAME_TYPES).not.toContain('ledger_update')
      expect(classifyClientFrame('ledger_update')).toBe(false)
    })
  })

  describe('MYT-74a session-end frames', () => {
    it('end_session is an accepted inbound client frame', () => {
      expect(CLIENT_FRAME_TYPES).toContain('end_session')
      expect(classifyClientFrame('end_session')).toBe(true)
    })
    it('session_end is server-only — never an inbound client frame', () => {
      expect(SERVER_FRAME_TYPES).toContain('session_end')
      expect(CLIENT_FRAME_TYPES).not.toContain('session_end')
      expect(classifyClientFrame('session_end')).toBe(false)
    })
  })

  describe('MYT-75 combat L1 frames', () => {
    it('server allowlist gains mode_change / combat_started / combat_resolved', () => {
      expect(SERVER_FRAME_TYPES).toContain('mode_change')
      expect(SERVER_FRAME_TYPES).toContain('combat_started')
      expect(SERVER_FRAME_TYPES).toContain('combat_resolved')
    })
    it('the combat server frames are server-only — never inbound client frames', () => {
      for (const t of ['mode_change', 'combat_started', 'combat_resolved']) {
        expect(CLIENT_FRAME_TYPES).not.toContain(t)
        expect(classifyClientFrame(t)).toBe(false)
      }
    })
    it('resume_combat is an accepted inbound client frame (MYT-75 T8)', () => {
      expect(CLIENT_FRAME_TYPES).toContain('resume_combat')
      expect(classifyClientFrame('resume_combat')).toBe(true)
    })
  })
})
