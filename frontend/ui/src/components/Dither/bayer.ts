// The brand's LOCKED dither formula, expressed as pure math.
// Source: ../../Design/mythrun-design/brand/guidelines.md → "The dither formula
// (locked)" + brand/decisions.md → "Why dithering is the gradient rendering
// technique". Reference pin: Return of the Obra Dinn.
//
//   Threshold matrix : 4×4 standard ordered Bayer (no row rotation).
//   Cell size        : 8px (preview / small surface), 6px (hero / full-bleed).
//   Band length      : 20 dithered cells, framed by two SOLID color blocks.
//   Chaos blend      : 15% pseudorandom, 85% ordered Bayer.
//   Composition      : two-color ground→accent (no smooth gradient).
//
// This module is PURE (no DOM) so the formula is unit-testable in isolation; the
// Dither component consumes the cell grid it produces and paints SVG <rect>s.

/** Locked: 20 dithered cells between the two solid framing blocks. */
export const BAND_CELLS = 20

/** Locked: 15% pseudorandom chaos blended into the 85% ordered Bayer threshold. */
export const CHAOS = 0.15

/** Locked cell sizes (px). `preview` is the default small-surface grain; `hero`
 *  is the chunkier full-bleed grain. The grain must stay visible AS grain. */
export const CELL_PX = { preview: 8, hero: 6 } as const

/**
 * The standard 4×4 ordered Bayer threshold matrix, normalized to [0, 1). The
 * canonical integer matrix is
 *   [ 0  8  2 10 ]
 *   [12  4 14  6 ]
 *   [ 3 11  1  9 ]
 *   [15  7 13  5 ]
 * each entry divided by 16 to give an even spread of thresholds. No row
 * rotation (the brand pins the standard ordered matrix).
 */
export const BAYER_4X4: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((v) => v / 16))

/**
 * A deterministic pseudorandom value in [0, 1) for cell (x, y) — a cheap integer
 * hash, NOT Math.random, so the texture is stable across renders (an SSR/CSR
 * mismatch or a re-render must not reshuffle the grain). This is mechanical
 * computation (the dither formula), not a "random number the LLM generates" —
 * it's deterministic by construction.
 */
export function chaosAt(x: number, y: number): number {
  // A small xorshift-style integer scramble over the cell coordinates.
  let h = (x * 374761393 + y * 668265263) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  h = (h * 1274126177) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return h / 0xffffffff
}

/**
 * The blended threshold for cell (x, y): 85% ordered Bayer + 15% chaos. A cell
 * is painted with the ACCENT color when this threshold is BELOW the band ramp
 * value `t` (0 = pure ground, 1 = pure accent); otherwise it stays GROUND. The
 * ordered term gives the crisp Bayer grid; the chaos term breaks the perfect
 * grid without tipping into noise.
 */
export function thresholdAt(x: number, y: number): number {
  // `% 4` always yields 0..3, so both lookups are in-range; the `?? 0` keeps the
  // access total for `noUncheckedIndexedAccess` without a banned non-null `!`.
  const ordered = BAYER_4X4[y % 4]?.[x % 4] ?? 0
  return (1 - CHAOS) * ordered + CHAOS * chaosAt(x, y)
}

/** One painted cell: its grid coords + whether it is accent (true) or ground. */
export interface DitherCell {
  x: number
  y: number
  accent: boolean
}

/**
 * Build the dither cell grid for a band that is `crossCells` wide on the cross
 * axis and `BAND_CELLS` long on the transition axis. `t` runs 0→1 across the
 * BAND_CELLS steps (the ground→accent ramp); each cell is accent when its
 * blended threshold falls under the ramp. The transition index `i` maps to the
 * grid's y (vertical, the default) — the component transposes for horizontal.
 */
export function buildBand(crossCells: number): DitherCell[] {
  const cells: DitherCell[] = []
  for (let i = 0; i < BAND_CELLS; i++) {
    // Ramp value at this step. Midpoints of the BAND_CELLS bins give a balanced
    // 0→1 sweep (first bin > 0, last bin < 1) so neither solid block is duplicated.
    const t = (i + 0.5) / BAND_CELLS
    for (let x = 0; x < crossCells; x++) {
      cells.push({ x, y: i, accent: thresholdAt(x, i) < t })
    }
  }
  return cells
}
