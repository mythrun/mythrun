import type { ServerFrame } from '@mythrun/contract/events'

// The session-progress brain (myth-atxhx) — how the play surface reads the
// mechanical progress fraction the wire carries (myth-nu0hm), and the two
// decisions derived from it.
//
// WHAT THE FRACTION IS. Purely mechanical: token budget + FT context fill,
// whichever ceiling is nearer. It carries no plot information (enforced
// ignorance holds — there is nothing narrative to leak), and the server already
// makes it monotonic and coarse (0.05 steps). This module adds NO smoothing of
// its own; a second opinion about the same number is how two surfaces start
// disagreeing.
//
// WHY A BAND, NOT A PERCENT. The fraction is COST-derived, so a rendered "62%"
// reads as "62% of your money spent" — a spend meter over the fiction, in a
// product whose whole register is paper-y and un-gamified. What the player
// actually needs is narrative room ("how much session is left to plan a landing
// in"), which is forward-looking, where a spent-percentage is backward-looking.
// So the number never reaches the screen: it collapses to four coarse words.
// Four is deliberate — enough to pace a story, too few to watch tick.
//
// WHY THE END CONTROL IS GATED ON IT. A Mythrun session is a play UNIT, not a
// sitting: you can leave and rejoin any time, and the credit is debited at
// session START, so ending early refunds nothing. Voluntarily ending early is
// therefore pure value destruction, and an always-available end control is a
// footgun. Near the end it inverts: at 85% "end here, on this beat" is craft —
// the player picks the landing instead of letting the budget cliff pick a
// random mid-scene moment. Hence one threshold, and a hard default of NOT
// showing the control when there is no signal at all.

/** The coarse position vocabulary — the ONLY session-progress words the player
 *  ever sees. There is deliberately no numeric variant. */
export type SessionProgressBand = 'early' | 'middle' | 'late' | 'close'

/** The fraction at or above which ending becomes a craft choice rather than
 *  self-harm, so the end control surfaces. Single-sourced: the `late` band
 *  starts here too. */
export const END_CONTROL_FRACTION = 0.7

/** The `middle` band floor, and the `close` band floor. Coarse by design. */
const MIDDLE_FRACTION = 0.35
const CLOSE_FRACTION = 0.9

/** Clamp a wire fraction into 0..1, or null it if it is not a real number.
 *  Structural validation of a numeric field, not judgment. */
function usableFraction(fraction: number | null): number | null {
  if (fraction === null || !Number.isFinite(fraction)) return null
  return Math.min(1, Math.max(0, fraction))
}

/** The coarse band a fraction names, or null when there is no signal yet (an
 *  older frame, or before the first turn completes). Null means "say nothing" —
 *  never a default band. */
export function progressBand(fraction: number | null): SessionProgressBand | null {
  const usable = usableFraction(fraction)
  if (usable === null) return null
  if (usable < MIDDLE_FRACTION) return 'early'
  if (usable < END_CONTROL_FRACTION) return 'middle'
  if (usable < CLOSE_FRACTION) return 'late'
  return 'close'
}

/** Whether the voluntary end-session control may be offered at all. False
 *  without a signal — the safe default, since the control cannot be undone. */
export function canOfferEnd(fraction: number | null): boolean {
  const usable = usableFraction(fraction)
  return usable !== null && usable >= END_CONTROL_FRACTION
}

/** The wire read: the fraction a frame carries, or null.
 *
 *  THREE frames may carry it (myth-nu0hm). `turn_end` is the once-per-turn beat.
 *  `session_reconnect` is the one a REAL client actually gets on every connect —
 *  the shipped transport sends `seedLastSeq: 0`, so `parseLastSeq` sees a valid 0
 *  and the server takes the reconnect branch. `session_ready` only reaches a
 *  client that connects with no `lastSeq` at all (the ws-transport smoke). All
 *  three are read identically.
 *
 *  `progress` is an ADDITIVE optional field, so a frame without it is normal,
 *  not an error — and null here means "no statement", never "reset to zero"
 *  (the fold holds the last known value). That distinction earns its keep on
 *  `session_reconnect`, which is ALSO the frame the corrected-turn whole-turn
 *  replace rides (`turnPublisher.turnReplace`) and which deliberately carries no
 *  progress: an audit-corrected retry must not blank the readout.
 *
 *  The payload check is structural boundary validation of parsed network JSON —
 *  the same posture parseClientFrame takes on the way in — not a second opinion
 *  about the value. The server owns monotonicity, 0.05 coarseness, and the
 *  omit-when-zero / omit-on-read-failure rules. */
export function frameProgressFraction(frame: ServerFrame): number | null {
  if (frame.type !== 'turn_end' && frame.type !== 'session_ready' && frame.type !== 'session_reconnect') {
    return null
  }
  if (!('progress' in frame)) return null
  const progress: unknown = frame.progress
  if (typeof progress !== 'object' || progress === null || !('fraction' in progress)) return null
  const fraction: unknown = progress.fraction
  return typeof fraction === 'number' ? fraction : null
}
