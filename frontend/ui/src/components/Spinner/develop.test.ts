import { describe, it, expect } from 'vitest'
import { thresholdAt } from '../Dither/bayer.ts'
import {
  SPINNER_GRID,
  SPINNER_CELLS,
  DEVELOP_DURATION_MS,
  buildDevelopCells,
} from './develop.ts'

// The pure cell math for the "dither develop" spinner. It REUSES the locked
// Bayer threshold from ../Dither/bayer.ts (DRY — the matrix is never duplicated)
// to lay out a square grid where each cell's animation-delay is keyed to its
// Bayer threshold (low threshold develops first) and a fixed static-lit flag
// gives the reduced-motion fallback a legible ~50% dither.

describe('buildDevelopCells', () => {
  it('builds a full SPINNER_GRID × SPINNER_GRID square', () => {
    const cells = buildDevelopCells()
    expect(cells.length).toBe(SPINNER_GRID * SPINNER_GRID)
    expect(cells.length).toBe(SPINNER_CELLS)
  })

  it('keys each cell delay to its Bayer threshold × the develop duration', () => {
    const cells = buildDevelopCells()
    for (const c of cells) {
      // The develop ORDER: a cell with a low Bayer threshold lights first, so
      // its delay is small; the delay is the threshold scaled into the cycle.
      const expected = thresholdAt(c.x, c.y) * DEVELOP_DURATION_MS
      expect(c.delayMs).toBeCloseTo(expected, 6)
    }
  })

  it('orders develop low-threshold-first (a sweep, not all at once)', () => {
    const cells = buildDevelopCells()
    const delays = cells.map((c) => c.delayMs)
    // A genuine sweep: more than one distinct delay, spanning [0, duration).
    expect(new Set(delays).size).toBeGreaterThan(1)
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...delays)).toBeLessThan(DEVELOP_DURATION_MS)
  })

  it('lights a legible ~50% subset for the static (reduced-motion) fallback', () => {
    const cells = buildDevelopCells()
    const lit = cells.filter((c) => c.staticLit)
    // Neither empty (blank box) nor full (solid block): a readable dither. The
    // static threshold is 0.5, so lit === threshold < 0.5.
    expect(lit.length).toBeGreaterThan(0)
    expect(lit.length).toBeLessThan(cells.length)
    for (const c of cells) {
      expect(c.staticLit).toBe(thresholdAt(c.x, c.y) < 0.5)
    }
  })

  it('is deterministic across calls (stable grain, no Math.random)', () => {
    expect(buildDevelopCells()).toEqual(buildDevelopCells())
  })

  it('sets a calm develop cycle (3.5–4s) — slower than the 2.4s prototype', () => {
    expect(DEVELOP_DURATION_MS).toBeGreaterThanOrEqual(3500)
    expect(DEVELOP_DURATION_MS).toBeLessThanOrEqual(4000)
  })
})
