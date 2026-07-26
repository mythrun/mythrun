import { describe, it, expect } from 'vitest'
import type { ServerFrame } from '@mythrun/contract/events'
import {
  END_CONTROL_FRACTION,
  canOfferEnd,
  frameProgressFraction,
  progressBand,
} from '../session-progress.ts'

// The session-progress brain (myth-atxhx) — the pure derivations the play surface
// reads the mechanical `fraction` through. Two invariants are load-bearing and pinned
// here:
//   • the fraction is NEVER rendered as a number (the band is the whole vocabulary) —
//     asserted by shape: progressBand's range is four words, not a percentage;
//   • the end control is UNAVAILABLE without a fraction and below the near-end
//     threshold. A missing signal must never open the most destructive control.

describe('progressBand', () => {
  it('has no band at all without a fraction (an older frame, or before the first turn)', () => {
    expect(progressBand(null)).toBeNull()
  })

  it('bands the fraction into four coarse words — never a number', () => {
    expect(progressBand(0)).toBe('early')
    expect(progressBand(0.3)).toBe('early')
    expect(progressBand(0.35)).toBe('middle')
    expect(progressBand(0.65)).toBe('middle')
    expect(progressBand(0.7)).toBe('late')
    expect(progressBand(0.85)).toBe('late')
    expect(progressBand(0.9)).toBe('close')
    expect(progressBand(1)).toBe('close')
  })

  it('clamps an out-of-range fraction rather than inventing a fifth band', () => {
    expect(progressBand(-0.2)).toBe('early')
    expect(progressBand(1.4)).toBe('close')
  })

  it('treats a non-finite fraction as no signal (never a band)', () => {
    expect(progressBand(Number.NaN)).toBeNull()
    expect(progressBand(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('canOfferEnd', () => {
  it('withholds the end control when there is no progress signal at all', () => {
    // The safe default: a frame that carries no fraction must not open the control.
    expect(canOfferEnd(null)).toBe(false)
  })

  it('withholds the end control early — ending there destroys a paid session', () => {
    expect(canOfferEnd(0)).toBe(false)
    expect(canOfferEnd(0.1)).toBe(false)
    expect(canOfferEnd(0.65)).toBe(false)
  })

  it('offers the end control from the near-end threshold on — choosing the landing is craft', () => {
    expect(canOfferEnd(END_CONTROL_FRACTION)).toBe(true)
    expect(canOfferEnd(0.85)).toBe(true)
    expect(canOfferEnd(1)).toBe(true)
  })

  it('agrees exactly with the late/close bands (one threshold, not two)', () => {
    expect(canOfferEnd(END_CONTROL_FRACTION)).toBe(progressBand(END_CONTROL_FRACTION) === 'late')
    expect(END_CONTROL_FRACTION).toBe(0.7)
  })

  it('withholds the end control on a non-finite fraction', () => {
    expect(canOfferEnd(Number.NaN)).toBe(false)
  })
})

describe('frameProgressFraction', () => {
  it('reads the fraction off a turn_end (the once-per-turn beat)', () => {
    const frame = { type: 'turn_end', turnId: 'T1', progress: { fraction: 0.45 } } as unknown as ServerFrame
    expect(frameProgressFraction(frame)).toBe(0.45)
  })

  it('reads the fraction off a session_ready (a joining client is not blank)', () => {
    const frame = { type: 'session_ready', progress: { fraction: 0.75 } } as unknown as ServerFrame
    expect(frameProgressFraction(frame)).toBe(0.75)
  })

  it('reads the fraction off a session_reconnect — the arm a real client actually gets', () => {
    // The shipped transport connects with seedLastSeq: 0, so the server's
    // parseLastSeq sees a valid 0 and answers session_reconnect, never
    // session_ready. This is the frame that un-blanks a joining player.
    const frame = {
      type: 'session_reconnect',
      messages: [],
      participants: [],
      mode: 'exploration',
      progress: { fraction: 0.6 },
    } as unknown as ServerFrame
    expect(frameProgressFraction(frame)).toBe(0.6)
  })

  it('returns no signal for a progress-less session_reconnect (the turn-replace case)', () => {
    // session_reconnect also carries the corrected-turn whole-turn replace, which
    // deliberately publishes no progress. Null here means "no statement" — the
    // fold holds the last known value rather than blanking the readout.
    expect(
      frameProgressFraction({ type: 'session_reconnect', messages: [], participants: [], mode: 'exploration' }),
    ).toBeNull()
  })

  it('returns no signal for a progress-less turn_end (the additive-field case)', () => {
    expect(frameProgressFraction({ type: 'turn_end', turnId: 'T1' })).toBeNull()
  })

  it('returns no signal for frames that never carry progress', () => {
    expect(frameProgressFraction({ type: 'typing_stop', userId: 'u1' })).toBeNull()
    expect(frameProgressFraction({ type: 'session_end', reason: 'normal' })).toBeNull()
  })

  it('ignores a malformed payload rather than banding garbage', () => {
    const noFraction = { type: 'turn_end', turnId: 'T1', progress: {} } as unknown as ServerFrame
    const notANumber = { type: 'turn_end', turnId: 'T1', progress: { fraction: 'half' } } as unknown as ServerFrame
    const notAnObject = { type: 'turn_end', turnId: 'T1', progress: 0.5 } as unknown as ServerFrame
    expect(frameProgressFraction(noFraction)).toBeNull()
    expect(frameProgressFraction(notANumber)).toBeNull()
    expect(frameProgressFraction(notAnObject)).toBeNull()
  })
})
