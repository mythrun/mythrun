import { BAYER_4X4 } from '../Dither/bayer.ts'

// Pure wave/notch math for the Spinner's "diagonal dither wave" — Miklos's LOCKED
// final design. A 12×12 grid of HARD binary cells (opacity 0 or 1, never between)
// where a continuous wave LEVEL — a sin() of each cell's DIAGONAL position — sets
// each cell ON/OFF per frame, so the lit dither flows up the diagonal on a loop.
// Two opposite corners (top-left + bottom-right) are NOTCHED: a triangular cut
// that never lights (always paper).
//
// This module is PURE (no DOM, no React, no time source — `T` is passed in) so the
// wave/notch math is unit-testable in isolation. The Spinner component runs a
// requestAnimationFrame loop that, each frame, computes `T = elapsed / SPEED_MS`
// and calls `isOn(x, y, T)` to drive each cell's opacity directly (a continuous
// function of diagonal position can't be expressed as a CSS keyframe).
//
// It REUSES the locked BAYER matrix from ../Dither/bayer.ts (DRY — the brand
// matrix is defined once, there). NOTE: the chaos term here is the design's tuned
// `hash01` (an explicit integer hash, distinct from bayer.ts's `chaosAt`) at a
// 0.10 weight — this is the exact threshold Miklos tuned, so we replicate it here
// rather than route through Dither's 0.15-chaos helper (which uses a different
// hash); only the matrix is shared.

/** Locked: 12×12 grid. */
export const GRID = 12

/** Locked: no gap between cells (the dither reads as a continuous field). */
export const GAP = 0

/** Locked: 10% pseudorandom chaos blended into the 90% ordered Bayer threshold. */
export const SPINNER_CHAOS = 0.1

/** Locked: one full wave period, in ms (`T` advances 1.0 per period). */
export const SPEED_MS = 1800

/** Locked: the wave's baseline density (also the static reduced-motion level). */
export const DENSITY = 0.4

/** A cell (x,y) is notched (always paper) iff `x+y < NOTCH_NEAR` (top-left) or
 *  `x+y > NOTCH_FAR` (bottom-right). NOTCH_NEAR=2 cuts 3 cells from the top-left
 *  corner; NOTCH_FAR = 2*(GRID-1)-2 = 20 cuts 3 from the bottom-right. */
export const NOTCH_NEAR = 2
export const NOTCH_FAR = 2 * (GRID - 1) - 2

/** The reduced-motion static frame is evaluated at the baseline DENSITY level. */
export const STATIC_LEVEL = DENSITY

/**
 * The design's tuned deterministic pseudorandom value in [0, 1) for cell (x, y) —
 * an explicit integer hash (NOT Math.random), so the grain is stable across
 * renders. Mechanical computation (the dither formula), deterministic by
 * construction. `>>> 0` forces an unsigned 32-bit result before the modulo.
 */
export function hash01(x: number, y: number): number {
  return (((x * 73856093) ^ (y * 19349663)) >>> 0) % 997 / 997
}

/**
 * The blended threshold for cell (x, y): 90% ordered Bayer + 10% tuned chaos. A
 * cell is ON when this threshold is BELOW the wave level. The ordered term reuses
 * the locked BAYER matrix (already normalized to [0,1) in bayer.ts); `% 4` keeps
 * both lookups in range, and `?? 0` keeps the access total for
 * `noUncheckedIndexedAccess` without a banned non-null assertion.
 */
export function thresholdAt(x: number, y: number): number {
  const ordered = BAYER_4X4[y % 4]?.[x % 4] ?? 0
  return (1 - SPINNER_CHAOS) * ordered + SPINNER_CHAOS * hash01(x, y)
}

/** The diagonal coordinate of cell (x,y): the mean of its two cell-center
 *  positions, in [0,1). Low at the top-left, high at the bottom-right — this is
 *  what makes the wave travel ALONG the diagonal. */
export function axisAt(x: number, y: number): number {
  return ((x + 0.5) / GRID + (y + 0.5) / GRID) / 2
}

/** The continuous wave level at normalized time `T` for a cell at diagonal `axis`.
 *  `DENSITY + (1-DENSITY)*0.9*sin(2π(T - axis))` — a sin() whose phase is the
 *  cell's diagonal position, so the level crest sweeps down the diagonal as T
 *  advances. Swings ~[-0.14, 0.94] around the 0.40 baseline. */
export function levelAt(T: number, axis: number): number {
  return DENSITY + (1 - DENSITY) * 0.9 * Math.sin(2 * Math.PI * (T - axis))
}

/** Whether cell (x,y) is in a notched corner (always paper). */
export function isNotched(x: number, y: number): boolean {
  return x + y < NOTCH_NEAR || x + y > NOTCH_FAR
}

/** HARD binary decision: a notched cell is never on; otherwise on iff its
 *  threshold is below the wave level at normalized time `T`. */
export function isOn(x: number, y: number, T: number): boolean {
  if (isNotched(x, y)) return false
  return thresholdAt(x, y) < levelAt(T, axisAt(x, y))
}

/** One spinner cell: its grid coords, whether it is notched (always paper), and
 *  whether it is lit in the static reduced-motion frame (level = DENSITY). */
export interface WaveCell {
  x: number
  y: number
  notched: boolean
  staticLit: boolean
}

/**
 * Build the spinner's static cell geometry: the full GRID×GRID grid with each
 * cell's notch flag + its static-frame lit state (the reduced-motion fallback,
 * evaluated at the baseline DENSITY level so the square shows a legible ~40%
 * dither). The animated state is computed per-frame by the component via `isOn`.
 */
export function buildCells(): WaveCell[] {
  const cells: WaveCell[] = []
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const notched = isNotched(x, y)
      cells.push({
        x,
        y,
        notched,
        staticLit: !notched && thresholdAt(x, y) < STATIC_LEVEL,
      })
    }
  }
  return cells
}
