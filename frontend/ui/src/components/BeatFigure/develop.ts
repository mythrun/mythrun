import { BAYER_4X4 } from '../Dither/bayer.ts'

// Pure quantized-fill / breathing math for the loading-beat family (SessionStartBeat,
// SessionPreparing, CharacterLoadingBeat). The design-lead brief, distilled:
//
//   Cells are the units. A full-width grid of HARD binary cells (on/off, never
//   partial opacity), fixed cell size (the Spinner idiom). A continuous signal is
//   expressed ONLY through per-cell Bayer thresholds — lit = threshold(x,y) < level —
//   so the DITHER is the interpolator; there is no smooth easing of position. Easing
//   lives in TIME (discrete quantized frames with dwell), never in a tweened box.
//
// Two channels, kept honest and separate (the two-question test: position never moves
// without real progress; no cell changes that isn't deliberately animated):
//   - POSITION (fillLevelAt) — a step function of the front column. Behind the front
//     the level is 1 (cells LOCKED solid, bit-identical every frame); ahead it is 0
//     (LOCKED paper); across a narrow FRONT_BAND it ramps 1→0 (a soft ink front, not a
//     hard line). Only front-band cells have a level in (0,1), so only they can flip.
//   - TEXTURE (the `seed`) — between real progress events the front band alone re-seeds
//     (litAt's chaos term is seed-mixed) so the ink front SHIMMERS in place without
//     advancing. Behind/ahead cells ignore the seed (level 0/1 short-circuits), so the
//     completed region stays locked.
//
// This module is PURE (no DOM, no React, no time source — `T`/`seed`/`frontX` are passed
// in) so all of it is unit-testable in isolation (the Spinner develop.ts pattern). The
// canvas controller (use-beat-canvas.ts) runs the rAF loop and calls these per cell.
//
// It REUSES the locked BAYER matrix from ../Dither/bayer.ts and the Spinner's tuned
// `hash01` 90/10 ordered/chaos blend (SPINNER_CHAOS), so the grain reads as the same
// brand dither as the Spinner and the Dither band.

/** Cell edge in CSS px — the dither unit. Larger than the Spinner's in-icon 1–4px so the
 *  grain reads as grain on a full-width band; the canvas maps one cell to `CELL_PX·dpr`
 *  whole device px (crisp at any DPR). */
export const CELL_PX = 6

/** Meter height in cells — the "low band" that spans the card width. 10·6 = 60px tall. */
export const ROWS = 10

/** The soft ink front width, in cells: the position fraction ramps 1→0 across this many
 *  columns so the advancing edge is a dithered front, not a hard line. Continuous (a float is
 *  fine); wide enough to read as an ink front, not a hard edge. */
export const FRONT_BAND = 5

/** The completed region's dither DENSITY — deliberately NOT 1.0: a flat solid slab abandons the
 *  dither-as-units medium the whole beat family is built on, so the filled region is a LOCKED
 *  DENSE dither (fixed seed → bit-identical frame to frame, the grammar's real requirement),
 *  dense enough to read as "inked in" while staying visibly 1-bit. */
export const FILLED_LEVEL = 0.78

/** The track's BASE density ahead of the front. 0 = a clean paper track (the ink grows on bare
 *  paper); a small positive value would stipple the whole track. Kept clean. */
export const BASE_LEVEL = 0

/** 90% ordered Bayer + 10% pseudorandom chaos — the Spinner's locked blend. */
export const CHAOS = 0.1

/** One breathing loop, in ms (`T` advances 1.0 per loop). */
export const BREATHE_MS = 3200

/** Frames a single real progress delta lands over (grammar: 3–4). */
export const STEP_COUNT = 4

/** Nominal dwell per advance frame, ms (grammar: ~90–110; the controller jitters it). */
export const STEP_MS = 100

/** Front-band re-seed cadence, ms (~7fps shimmer; grammar: 6–8fps). */
export const SHIMMER_MS = 140

/** Breathing density envelope floor/ceiling — a DELICATE range so the between-sessions hold
 *  reads calm and unhurried: a sparse drifting dither at the trough swelling to a moderate
 *  crest, never a busy full checkerboard. The field never fully clears (stays legibly textured)
 *  nor solidifies. */
export const BREATHE_LOW = 0.16
export const BREATHE_HIGH = 0.5

/** How much breathing phase lags across the diagonal (in whole cycles), so the breath TRAVELS
 *  as a diagonal wave rather than pulsing in unison. >1 keeps a dense band and a sparse band
 *  coexisting at all times (a moving swell, never an all-at-once checkerboard). */
export const BREATHE_PHASE_SPAN = 1.3

/** Clamp to [0, 1]. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * The Spinner's tuned deterministic pseudorandom value in [0, 1) for cell (x, y), with an
 * added `seed` term so the grain can be RE-seeded (the front-band shimmer / per-breath
 * variation). `seed = 0` reduces to the Spinner's exact `hash01` (xor-with-0 is identity).
 * An explicit integer hash (NOT Math.random) so a given (x, y, seed) is stable across
 * renders. `>>> 0` forces an unsigned 32-bit result before the modulo.
 */
export function hash01(x: number, y: number, seed = 0): number {
  return ((((x * 73856093) ^ (y * 19349663) ^ (seed * 83492791)) >>> 0) % 997) / 997
}

/**
 * The blended threshold for cell (x, y) at texture `seed`: 90% ordered Bayer + 10% seeded
 * chaos. A cell is ON when this threshold is BELOW its fill level. Reuses the locked BAYER
 * matrix (already normalized to [0,1)); `% 4` keeps both lookups in range and `?? 0` keeps
 * the access total for `noUncheckedIndexedAccess` without a banned non-null assertion.
 */
export function thresholdAt(x: number, y: number, seed = 0): number {
  const ordered = BAYER_4X4[y % 4]?.[x % 4] ?? 0
  return (1 - CHAOS) * ordered + CHAOS * hash01(x, y, seed)
}

/**
 * The POSITION channel: the fill FRACTION at column `x` for a front at fractional column
 * `frontX`. 1 at or behind `frontX - band` (completed); 0 at or ahead of `frontX` (track); a
 * linear 1→0 ramp across the FRONT_BAND between. This is the ONLY place the front's position
 * enters the render — honest and stepwise, no tween. `litAt` maps the fraction to a dither
 * DENSITY (BASE_LEVEL…FILLED_LEVEL).
 */
export function fillLevelAt(x: number, frontX: number, band = FRONT_BAND): number {
  const behind = frontX - x
  if (behind <= 0) return 0
  if (behind >= band) return 1
  return behind / band
}

/**
 * HARD binary cell decision for the fill. The position fraction maps to a dither density
 * (BASE_LEVEL ahead → FILLED_LEVEL behind), and the cell is lit iff its threshold is below
 * that density. The completed region (fraction 1 → FILLED_LEVEL, dense) and the track ahead
 * (fraction 0 → BASE_LEVEL) both use a FIXED seed → they are LOCKED dither, bit-identical frame
 * to frame; ONLY the front band (fraction strictly in (0,1)) reads the live `seed`, so the
 * shimmer is confined to the advancing ink front while everything else holds still.
 */
export function litAt(x: number, y: number, frontX: number, seed = 0, band = FRONT_BAND): boolean {
  const fraction = fillLevelAt(x, frontX, band)
  const density = BASE_LEVEL + (FILLED_LEVEL - BASE_LEVEL) * fraction
  if (density <= 0) return false
  const active = fraction > 0 && fraction < 1
  return thresholdAt(x, y, active ? seed : 0) < density
}

/**
 * Map a 0..1 progress `level` to a fractional front column across `cols`. Level 0 → front 0
 * (empty); level 1 → front `cols` (the front band sits at the right edge, a soft dithered
 * finish; everything left is solid). The 100% overshoot pushes past this to fully solidify.
 */
export function frontColFor(level: number, cols: number): number {
  return clamp01(level) * cols
}

/**
 * The decelerating advance schedule from front `from` to front `to` over `steps` frames:
 * a quadratic ease-OUT (a big first step, small last) sampled at the frame boundaries and
 * returned as the intermediate front positions (the start excluded, the exact target last).
 * The controller dwells on each — easing in TIME, position honest. A non-increase (`to ≤
 * from`; a fill never regresses) returns a single exact landing, so it snaps rather than
 * animating backward.
 */
export function advanceSchedule(from: number, to: number, steps = STEP_COUNT): number[] {
  if (to <= from || steps <= 1) return [to]
  const out: number[] = []
  for (let i = 1; i <= steps; i++) {
    const u = i / steps
    const eased = 1 - (1 - u) * (1 - u)
    out.push(from + (to - from) * eased)
  }
  out[out.length - 1] = to
  return out
}

/**
 * The asymmetric breathing envelope in [0, 1] for a cell's phase (any real; only the
 * fractional part matters). Rises over the first ~40% of the cycle and falls over the
 * remaining ~60% — an inhale quicker than the exhale — each leg a raised cosine so the turn
 * at the crest/trough is smooth (no kink). Peaks (1) at the 40% mark, troughs (0) at the
 * cycle ends.
 */
export function breatheEnvelope(phase: number): number {
  const p = phase - Math.floor(phase)
  if (p < 0.4) {
    return 0.5 - 0.5 * Math.cos(Math.PI * (p / 0.4))
  }
  return 0.5 + 0.5 * Math.cos(Math.PI * ((p - 0.4) / 0.6))
}

/** A cell's diagonal coordinate in [0, 1) — low at the top-left, high at the bottom-right —
 *  used to lag the breathing phase so the breath travels along the diagonal. */
export function axisAt(x: number, y: number, cols: number, rows: number): number {
  return ((x + 0.5) / cols + (y + 0.5) / rows) / 2
}

/**
 * The breathing fill level at cell (x, y) and normalized time `T` (advances 1.0 per
 * BREATHE_MS): the asymmetric envelope evaluated at a diagonally-lagged phase, mapped into
 * [BREATHE_LOW, BREATHE_HIGH] so the interior density swells and ebbs as a traveling wave.
 */
export function breatheLevelAt(x: number, y: number, cols: number, rows: number, T: number): number {
  const phase = T - axisAt(x, y, cols, rows) * BREATHE_PHASE_SPAN
  return BREATHE_LOW + (BREATHE_HIGH - BREATHE_LOW) * breatheEnvelope(phase)
}

/**
 * HARD binary cell decision for the breathing field. The texture seed is the cell's own
 * CYCLE INDEX (floor of its lagged phase), so the grain is stable WITHIN a breath (density
 * sweeps smoothly — no per-frame reshuffle / "wiggling mess") but differs BETWEEN cycles
 * (consecutive breaths aren't identical). Because each cell's cycle rolls over at its own
 * diagonally-staggered trough — where density is lowest and few cells are lit — the reseed
 * is nearly invisible.
 */
export function litBreatheAt(x: number, y: number, cols: number, rows: number, T: number): boolean {
  const phase = T - axisAt(x, y, cols, rows) * BREATHE_PHASE_SPAN
  const level = BREATHE_LOW + (BREATHE_HIGH - BREATHE_LOW) * breatheEnvelope(phase)
  return thresholdAt(x, y, Math.floor(phase)) < level
}
