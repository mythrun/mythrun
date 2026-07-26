import { describe, it, expect } from 'vitest'
import {
  CLIENT_FRAME_TYPES,
  classifyClientFrame,
  PROSE_SSE_EVENTS,
  type ServerFrame,
  type SessionProgress,
} from '../events/index.js'

describe('@mythrun/contract/events', () => {
  it('re-exports the session-events client allowlist', () => {
    expect(CLIENT_FRAME_TYPES).toContain('player_message')
  })

  it('re-exports the session-events classify tripwire', () => {
    expect(classifyClientFrame('player_message')).toBe(true)
  })

  it('re-exports the pipeline-events prose allowlist', () => {
    expect(PROSE_SSE_EVENTS[0]).toBe('prep-delta')
  })

  // myth-nu0hm — the mechanical session-progress signal. These are compile-time
  // assertions as much as runtime ones: the `satisfies ServerFrame` on each
  // literal is what actually pins the shape the backend publisher and the play
  // surface both build against.
  describe('SessionProgress (myth-nu0hm)', () => {
    it('rides turn_end as an OPTIONAL field', () => {
      const withProgress = {
        type: 'turn_end',
        turnId: 't-1',
        progress: { fraction: 0.65 },
      } satisfies ServerFrame
      expect(withProgress.progress.fraction).toBe(0.65)

      // Optional + additive: the pre-myth-nu0hm shape still type-checks, so no
      // existing consumer or publisher breaks.
      const withoutProgress = { type: 'turn_end', turnId: 't-1' } satisfies ServerFrame
      expect(withoutProgress).not.toHaveProperty('progress')
    })

    it('rides session_ready as an OPTIONAL field', () => {
      const withProgress = {
        type: 'session_ready',
        progress: { fraction: 0.35 },
      } satisfies ServerFrame
      expect(withProgress.progress.fraction).toBe(0.35)

      const withoutProgress = { type: 'session_ready' } satisfies ServerFrame
      expect(withoutProgress).not.toHaveProperty('progress')
    })

    it('rides session_reconnect — the arm every real client actually receives', () => {
      // The shipped web client connects with seedLastSeq:0, so it always sends
      // `lastSeq=0` and the server takes the RECONNECT branch. Without this arm
      // the fraction never reaches a joining player at all.
      const withProgress = {
        type: 'session_reconnect',
        messages: [],
        participants: [],
        mode: 'exploration',
        progress: { fraction: 0.45 },
      } satisfies ServerFrame
      expect(withProgress.progress.fraction).toBe(0.45)

      // Absent on the corrected-turn whole-turn-replace, which reuses this frame
      // kind but makes no progress statement.
      const replace = {
        type: 'session_reconnect',
        messages: [],
        participants: [],
        mode: 'exploration',
      } satisfies ServerFrame
      expect(replace).not.toHaveProperty('progress')
    })

    it('is a readonly single-field shape — nothing narrative rides it', () => {
      // Enforced ignorance: this is the PLAYER-facing number, so the type is
      // deliberately one mechanical scalar. Widening it is the review flag.
      const progress: SessionProgress = { fraction: 0.5 }
      expect(Object.keys(progress)).toEqual(['fraction'])
    })
  })
})
