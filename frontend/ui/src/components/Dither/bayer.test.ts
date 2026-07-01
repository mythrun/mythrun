import { describe, it, expect } from 'vitest'
import {
  BAND_CELLS,
  CHAOS,
  CELL_PX,
  CROSS_CELLS,
  FRAME_CELLS,
  AXIS_CELLS,
  BAYER_4X4,
  chaosAt,
  thresholdAt,
  buildBand,
  buildField,
} from './bayer.ts'

// Guards on the LOCKED brand dither formula. If any of these change, the dither
// has drifted from the brand spec (guidelines.md → "The dither formula (locked)").

describe('dither formula constants (locked)', () => {
  it('pins the band length to 20 dithered cells', () => {
    expect(BAND_CELLS).toBe(20)
  })

  it('pins chaos to 15%', () => {
    expect(CHAOS).toBe(0.15)
  })

  it('pins the cell sizes (8px preview, 6px hero)', () => {
    expect(CELL_PX.preview).toBe(8)
    expect(CELL_PX.hero).toBe(6)
  })
})

describe('BAYER_4X4', () => {
  it('is the standard 4×4 ordered matrix normalized to [0,1), no row rotation', () => {
    // The canonical integer matrix / 16.
    expect(BAYER_4X4).toEqual([
      [0 / 16, 8 / 16, 2 / 16, 10 / 16],
      [12 / 16, 4 / 16, 14 / 16, 6 / 16],
      [3 / 16, 11 / 16, 1 / 16, 9 / 16],
      [15 / 16, 7 / 16, 13 / 16, 5 / 16],
    ])
  })

  it('has 16 distinct, evenly-spread thresholds', () => {
    const flat = BAYER_4X4.flat()
    expect(new Set(flat).size).toBe(16)
    expect(Math.min(...flat)).toBe(0)
    expect(Math.max(...flat)).toBe(15 / 16)
  })
})

describe('chaosAt', () => {
  it('is deterministic for the same cell (stable across renders)', () => {
    expect(chaosAt(3, 7)).toBe(chaosAt(3, 7))
  })

  it('stays within [0, 1)', () => {
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        const v = chaosAt(x, y)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThan(1)
      }
    }
  })

  it('varies between cells (not a constant)', () => {
    const vals = new Set([chaosAt(0, 0), chaosAt(1, 0), chaosAt(0, 1), chaosAt(5, 9)])
    expect(vals.size).toBeGreaterThan(1)
  })
})

describe('thresholdAt', () => {
  it('blends 85% ordered Bayer + 15% chaos', () => {
    const ordered = BAYER_4X4[0]?.[0] ?? Number.NaN // (0,0) → 0
    const expected = 0.85 * ordered + 0.15 * chaosAt(0, 0)
    expect(thresholdAt(0, 0)).toBeCloseTo(expected, 12)
  })

  it('stays within [0, 1)', () => {
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        const v = thresholdAt(x, y)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThan(1)
      }
    }
  })
})

describe('buildBand', () => {
  it('produces BAND_CELLS rows × crossCells columns', () => {
    const cells = buildBand(6)
    expect(cells).toHaveLength(BAND_CELLS * 6)
  })

  it('is mostly ground at the start of the ramp and mostly accent at the end', () => {
    const cross = 24
    const cells = buildBand(cross)
    const accentInRow = (row: number) =>
      cells.filter((c) => c.y === row && c.accent).length
    // First step: ramp value is small → few accent cells. Last step: large → many.
    expect(accentInRow(0)).toBeLessThan(accentInRow(BAND_CELLS - 1))
    expect(accentInRow(0)).toBeLessThan(cross / 2)
    expect(accentInRow(BAND_CELLS - 1)).toBeGreaterThan(cross / 2)
  })

  it('is monotonic-ish: the accent count never collapses to zero past the midpoint', () => {
    const cells = buildBand(24)
    for (let row = BAND_CELLS / 2; row < BAND_CELLS; row++) {
      expect(cells.filter((c) => c.y === row && c.accent).length).toBeGreaterThan(0)
    }
  })
})

describe('buildField', () => {
  it('produces a full rows × cols field (every cell, both axes)', () => {
    const cells = buildField(10, 8)
    expect(cells).toHaveLength(10 * 8)
  })

  it('is pure GROUND at the top row and pure ACCENT at the bottom row', () => {
    const cols = 24
    const rows = 12
    const cells = buildField(cols, rows)
    const accentInRow = (row: number) =>
      cells.filter((c) => c.y === row && c.accent).length
    // t = 0 at the top → no cell clears its (≥ 0) threshold; t = 1 at the bottom
    // → every cell clears its (< 1) threshold. The cover's solid-ish edges.
    expect(accentInRow(0)).toBe(0)
    expect(accentInRow(rows - 1)).toBe(cols)
  })

  it('sweeps ground→accent: the accent share rises down the field', () => {
    const cols = 24
    const rows = 16
    const cells = buildField(cols, rows)
    const accentInRow = (row: number) =>
      cells.filter((c) => c.y === row && c.accent).length
    // A quarter-way down is sparser than three-quarters-way down.
    expect(accentInRow(Math.floor(rows / 4))).toBeLessThan(accentInRow(Math.floor((rows * 3) / 4)))
  })

  it('degenerates a single-row field to pure accent (no divide-by-zero)', () => {
    const cells = buildField(6, 1)
    expect(cells).toHaveLength(6)
    expect(cells.every((c) => c.accent)).toBe(true)
  })
})

describe('tile geometry constants', () => {
  it('pins CROSS_CELLS, FRAME_CELLS, and the derived AXIS_CELLS', () => {
    expect(CROSS_CELLS).toBeGreaterThan(0)
    expect(FRAME_CELLS).toBeGreaterThan(0)
    // The transition axis is ground frame + band + accent frame.
    expect(AXIS_CELLS).toBe(FRAME_CELLS + BAND_CELLS + FRAME_CELLS)
  })

  it('makes the cross axis a multiple of the 4-cell Bayer period (seamless H-tile)', () => {
    // The ordered Bayer term repeats every 4 cells; a CROSS_CELLS that is a clean
    // multiple keeps the *ordered* grid tiling without a seam (chaos still breaks
    // the perfect grid, which is the intended grain).
    expect(CROSS_CELLS % 4).toBe(0)
  })
})
