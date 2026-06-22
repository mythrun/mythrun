import { thresholdAt } from '../Dither/bayer.ts'

// Pure cell math for the Spinner's "dither develop" loader. It REUSES the locked
// 4×4 Bayer threshold from ../Dither/bayer.ts (DRY — the brand matrix is defined
// once, there) to lay out a small square of cells whose per-cell animation-delay
// is keyed to the Bayer threshold. Low threshold develops FIRST; high threshold
// last — so the dither sweeps up (fill) and recedes (fade) in threshold order,
// like ink developing on the page.
//
// This module is PURE (no DOM, no React) so the layout is unit-testable in
// isolation; the Spinner component consumes the cell list and renders the grid.

/** The grid is SPINNER_GRID × SPINNER_GRID cells. 8 reads as grain at the icon
 *  sizes (16/20/24px) without dissolving into noise — the 4×4 Bayer period tiles
 *  twice across, so the develop order repeats coherently. */
export const SPINNER_GRID = 8

/** Total cells in the square. */
export const SPINNER_CELLS = SPINNER_GRID * SPINNER_GRID

/**
 * One full develop → recede cycle, in ms. ~3.7s with a gentle ease: calm and
 * patient (the 2.4s prototype read "a little fast"; the brand wants ink
 * developing, not a frantic loader). The per-cell delay spans this window so the
 * sweep fills the whole cycle.
 */
export const DEVELOP_DURATION_MS = 3700

/** Static (reduced-motion) threshold: a cell is lit when its Bayer threshold is
 *  below this. 0.5 → a balanced ~50% dither, the legible resting square. */
export const STATIC_THRESHOLD = 0.5

/** One spinner cell: its grid coords, the develop delay (ms), and whether it is
 *  lit in the static reduced-motion fallback. */
export interface DevelopCell {
  x: number
  y: number
  delayMs: number
  staticLit: boolean
}

/**
 * Build the spinner's cell grid. Each cell's `delayMs` is its Bayer threshold
 * scaled into the develop window (low threshold = small delay = develops first),
 * and `staticLit` is the fixed ~50% dither used when motion is reduced.
 */
export function buildDevelopCells(): DevelopCell[] {
  const cells: DevelopCell[] = []
  for (let y = 0; y < SPINNER_GRID; y++) {
    for (let x = 0; x < SPINNER_GRID; x++) {
      const threshold = thresholdAt(x, y)
      cells.push({
        x,
        y,
        delayMs: threshold * DEVELOP_DURATION_MS,
        staticLit: threshold < STATIC_THRESHOLD,
      })
    }
  }
  return cells
}
