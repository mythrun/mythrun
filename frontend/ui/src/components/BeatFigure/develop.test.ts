import { describe, it, expect } from 'vitest'
import { BAYER_4X4 } from '../Dither/bayer.ts'
import {
  CHAOS,
  FRONT_BAND,
  ROWS,
  STEP_COUNT,
  BREATHE_LOW,
  BREATHE_HIGH,
  clamp01,
  hash01,
  thresholdAt,
  fillLevelAt,
  litAt,
  frontColFor,
  advanceSchedule,
  breatheEnvelope,
  axisAt,
  breatheLevelAt,
  litBreatheAt,
} from './develop.ts'

// Pure quantized-fill / breathing math (the Spinner develop.ts pattern). Everything here is a
// deterministic function of its inputs, so it is unit-tested in isolation without a DOM. The
// two invariants the whole grammar hangs on:
//   - POSITION is honest: fillLevelAt is 1 behind the front (locked solid), 0 ahead (locked
//     paper), a ramp only across the FRONT_BAND — so litAt's behind/ahead cells never depend on
//     the shimmer seed (the completed region is bit-identical frame to frame).
//   - EASING is in time: advanceSchedule lands the front over a few decelerating frames, exact
//     at the target, and never animates backward (a fill can't regress).

describe('clamp01', () => {
  it('clamps to [0, 1]', () => {
    expect(clamp01(-0.5)).toBe(0)
    expect(clamp01(1.5)).toBe(1)
    expect(clamp01(0.42)).toBe(0.42)
  })
})

describe('hash01', () => {
  it('is a deterministic value in [0, 1)', () => {
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        const v = hash01(x, y)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThan(1)
        expect(hash01(x, y)).toBe(v)
      }
    }
  })

  it('re-seeds: seed=0 is the base grain, a different seed generally shifts it', () => {
    // seed=0 is the identity (xor-with-0), so it must equal the un-seeded default.
    expect(hash01(3, 5, 0)).toBe(hash01(3, 5))
    // Across a patch, most cells change when the seed changes (the shimmer / per-cycle variation).
    let changed = 0
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) if (hash01(x, y, 1) !== hash01(x, y, 0)) changed++
    }
    expect(changed).toBeGreaterThan(40)
  })
})

describe('thresholdAt', () => {
  it('is the 90/10 ordered-Bayer + seeded-chaos blend, in [0, 1)', () => {
    const x = 6
    const y = 3
    const ordered = BAYER_4X4[y % 4]?.[x % 4] ?? 0
    const expected = (1 - CHAOS) * ordered + CHAOS * hash01(x, y, 2)
    expect(thresholdAt(x, y, 2)).toBeCloseTo(expected, 12)
    for (let i = 0; i < 32; i++) {
      const v = thresholdAt(i, (i * 7) % 4, i)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('fillLevelAt', () => {
  it('is 1 well behind the front, 0 at/ahead of it, and a ramp across the band', () => {
    const frontX = 20
    expect(fillLevelAt(5, frontX)).toBe(1) // far behind → locked solid
    expect(fillLevelAt(20, frontX)).toBe(0) // exactly at the front → not yet filled
    expect(fillLevelAt(25, frontX)).toBe(0) // ahead → locked paper
    expect(fillLevelAt(frontX - FRONT_BAND, frontX)).toBe(1) // trailing band edge = solid
    // Midway through the band → a partial level in (0, 1).
    const mid = fillLevelAt(frontX - FRONT_BAND / 2, frontX)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    expect(mid).toBeCloseTo(0.5, 6)
  })

  it('is monotonic non-decreasing as a column moves back from the front', () => {
    const frontX = 30
    let prev = -1
    for (let x = 33; x >= 25; x--) {
      const level = fillLevelAt(x, frontX)
      expect(level).toBeGreaterThanOrEqual(prev)
      prev = level
    }
  })
})

describe('litAt', () => {
  it('LOCKS the completed region (bit-identical across seeds) and the track ahead OFF', () => {
    const frontX = 40
    for (let seed = 1; seed < 6; seed++) {
      for (let y = 0; y < ROWS; y++) {
        // Behind the band → the SAME as the fixed-seed frame regardless of the shimmer seed
        // (locked dense dither, not a flat slab — some cells are paper, but they never change).
        expect(litAt(10, y, frontX, seed)).toBe(litAt(10, y, frontX, 0))
        expect(litAt(frontX - FRONT_BAND - 1, y, frontX, seed)).toBe(litAt(frontX - FRONT_BAND - 1, y, frontX, 0))
        // Ahead of the front → always dark (a clean paper track), any seed.
        expect(litAt(frontX, y, frontX, seed)).toBe(false)
        expect(litAt(frontX + 5, y, frontX, seed)).toBe(false)
      }
    }
  })

  it('makes the completed region DENSE but not solid (dither, not a slab)', () => {
    const frontX = 60
    let lit = 0
    let total = 0
    for (let x = 0; x < frontX - FRONT_BAND; x++) {
      for (let y = 0; y < ROWS; y++) {
        total++
        if (litAt(x, y, frontX, 0)) lit++
      }
    }
    const coverage = lit / total
    expect(coverage).toBeGreaterThan(0.8) // reads as filled
    expect(coverage).toBeLessThan(1) // but still dithered — some paper shows through
  })

  it('lets the FRONT BAND shimmer: some band cell flips as the seed changes', () => {
    const frontX = 40
    // A band column (fraction in (0,1)) that lights under one seed and not another somewhere in
    // the rows — the shimmer confined to the front.
    let sawFlip = false
    for (let bx = frontX - FRONT_BAND + 1; bx < frontX; bx++) {
      for (let y = 0; y < ROWS; y++) {
        if (litAt(bx, y, frontX, 0) !== litAt(bx, y, frontX, 3)) sawFlip = true
      }
    }
    expect(sawFlip).toBe(true)
  })
})

describe('frontColFor', () => {
  it('maps 0..1 progress to a front column across the width, clamped', () => {
    expect(frontColFor(0, 100)).toBe(0)
    expect(frontColFor(1, 100)).toBe(100)
    expect(frontColFor(0.5, 100)).toBe(50)
    expect(frontColFor(-1, 100)).toBe(0)
    expect(frontColFor(2, 100)).toBe(100)
  })
})

describe('advanceSchedule', () => {
  it('lands the front over STEP_COUNT decelerating frames, exact at the target', () => {
    const steps = advanceSchedule(0, 40)
    expect(steps).toHaveLength(STEP_COUNT)
    expect(steps.at(-1)).toBe(40) // exact landing
    // Strictly increasing (never regress within an advance).
    for (let i = 1; i < steps.length; i++) expect((steps[i] ?? 0) > (steps[i - 1] ?? 0)).toBe(true)
    // Decelerating: the first delta is the largest, the last the smallest (ease-out).
    const first = (steps[0] ?? 0) - 0
    const last = (steps.at(-1) ?? 0) - (steps.at(-2) ?? 0)
    expect(first).toBeGreaterThan(last)
  })

  it('snaps (no backward animation) when the target is not ahead — a fill never regresses', () => {
    expect(advanceSchedule(40, 40)).toEqual([40])
    expect(advanceSchedule(40, 10)).toEqual([10])
  })
})

describe('breatheEnvelope', () => {
  it('rises to a crest at 40% of the cycle and troughs at the ends', () => {
    expect(breatheEnvelope(0)).toBeCloseTo(0, 6)
    expect(breatheEnvelope(0.4)).toBeCloseTo(1, 6)
    expect(breatheEnvelope(0.999)).toBeLessThan(0.01)
  })

  it('is periodic and bounded in [0, 1]', () => {
    for (let i = 0; i < 40; i++) {
      const p = i / 13
      const v = breatheEnvelope(p)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      expect(breatheEnvelope(p + 3)).toBeCloseTo(v, 12) // period 1
    }
  })

  it('is asymmetric — the inhale (40%) is quicker than the exhale (60%)', () => {
    // Same displacement from the crest: 0.1 before vs 0.15 after cover the same envelope drop
    // only because the exhale is stretched — so at equal time offsets the exhale sits higher.
    expect(breatheEnvelope(0.3)).toBeLessThan(breatheEnvelope(0.5))
  })
})

describe('axisAt / breatheLevelAt', () => {
  it('axisAt is a diagonal coordinate in [0, 1)', () => {
    expect(axisAt(0, 0, 10, 10)).toBeGreaterThan(0)
    expect(axisAt(9, 9, 10, 10)).toBeLessThan(1)
    expect(axisAt(9, 9, 10, 10)).toBeGreaterThan(axisAt(0, 0, 10, 10))
  })

  it('breatheLevelAt stays within the density envelope [LOW, HIGH]', () => {
    for (let x = 0; x < 12; x++) {
      for (let t = 0; t < 10; t++) {
        const level = breatheLevelAt(x, x % ROWS, 40, ROWS, t / 3)
        expect(level).toBeGreaterThanOrEqual(BREATHE_LOW - 1e-9)
        expect(level).toBeLessThanOrEqual(BREATHE_HIGH + 1e-9)
      }
    }
  })
})

describe('litBreatheAt', () => {
  it('is a deterministic boolean for a given cell + time', () => {
    const a = litBreatheAt(4, 2, 40, ROWS, 1.25)
    expect(typeof a).toBe('boolean')
    expect(litBreatheAt(4, 2, 40, ROWS, 1.25)).toBe(a)
  })

  it('modulates the field density over the breath cycle (the field is never static)', () => {
    const cols = 40
    const count = (T: number): number => {
      let n = 0
      for (let x = 0; x < cols; x++) for (let y = 0; y < ROWS; y++) if (litBreatheAt(x, y, cols, ROWS, T)) n++
      return n
    }
    // Across a full loop the total lit count must swing — the breath is real motion, not a
    // frozen texture (phase-span-independent: it only asserts the field isn't constant).
    const counts = Array.from({ length: 12 }, (_, i) => count(i / 12))
    expect(Math.max(...counts)).toBeGreaterThan(Math.min(...counts))
  })
})
