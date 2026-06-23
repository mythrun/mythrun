import { describe, it, expect } from 'vitest'
import { BAYER_4X4 } from '../Dither/bayer.ts'
import {
  GRID,
  GAP,
  SPINNER_CHAOS,
  SPEED_MS,
  DENSITY,
  NOTCH_NEAR,
  NOTCH_FAR,
  STATIC_LEVEL,
  hash01,
  thresholdAt,
  axisAt,
  levelAt,
  isNotched,
  isOn,
  buildCells,
} from './develop.ts'

// The pure wave/notch math for the Spinner's "diagonal dither wave". It REUSES
// the locked BAYER matrix from ../Dither/bayer.ts (DRY — the matrix is never
// duplicated). The wave LEVEL is a continuous sin() of each cell's diagonal axis,
// so the lit pattern (hard binary cells) flows across the grid; two opposite
// corners are notched (always paper). All of it is unit-tested here without a DOM.

describe('locked config', () => {
  it("bakes Miklos's tuned constants", () => {
    expect(GRID).toBe(12)
    expect(GAP).toBe(0)
    expect(SPINNER_CHAOS).toBe(0.1)
    expect(SPEED_MS).toBe(1800)
    expect(DENSITY).toBe(0.4)
  })

  it('derives the notch bounds from GRID', () => {
    expect(NOTCH_NEAR).toBe(2)
    // 2*(GRID-1) - 2 = 2*11 - 2 = 20.
    expect(NOTCH_FAR).toBe(2 * (GRID - 1) - 2)
    expect(NOTCH_FAR).toBe(20)
  })

  it('static (reduced-motion) frame is the DENSITY level', () => {
    expect(STATIC_LEVEL).toBe(DENSITY)
  })
})

describe('hash01', () => {
  it('matches the locked integer hash, in [0, 1)', () => {
    const expected = (x: number, y: number) =>
      ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 997) / 997
    const pairs: [number, number][] = [
      [0, 0],
      [3, 7],
      [11, 11],
      [5, 2],
    ]
    for (const [x, y] of pairs) {
      expect(hash01(x, y)).toBeCloseTo(expected(x, y), 12)
    }
  })

  it('is deterministic (stable grain, no Math.random)', () => {
    expect(hash01(4, 9)).toBe(hash01(4, 9))
    expect(hash01(0, 0)).toBeGreaterThanOrEqual(0)
    expect(hash01(0, 0)).toBeLessThan(1)
  })
})

describe('thresholdAt', () => {
  it('blends 90% ordered BAYER + 10% chaos (the tuned 0.10 chaos)', () => {
    const pairs: [number, number][] = [
      [0, 0],
      [6, 6],
      [11, 4],
    ]
    for (const [x, y] of pairs) {
      const ordered = BAYER_4X4[y % 4]?.[x % 4] ?? 0
      const expected = (1 - SPINNER_CHAOS) * ordered + SPINNER_CHAOS * hash01(x, y)
      expect(thresholdAt(x, y)).toBeCloseTo(expected, 12)
    }
  })

  it('stays within [0, 1)', () => {
    const t = thresholdAt(2, 3)
    expect(t).toBeGreaterThanOrEqual(0)
    expect(t).toBeLessThan(1)
  })
})

describe('axisAt — the diagonal coordinate', () => {
  it('is ((x+0.5)/GRID + (y+0.5)/GRID)/2', () => {
    expect(axisAt(0, 0)).toBeCloseTo((0.5 / GRID + 0.5 / GRID) / 2, 12)
    expect(axisAt(11, 11)).toBeCloseTo((11.5 / GRID + 11.5 / GRID) / 2, 12)
  })

  it('grows monotonically along the diagonal (top-left low, bottom-right high)', () => {
    expect(axisAt(0, 0)).toBeLessThan(axisAt(5, 5))
    expect(axisAt(5, 5)).toBeLessThan(axisAt(11, 11))
  })
})

describe('levelAt — the continuous wave', () => {
  it('is DENSITY + (1-DENSITY)*0.9*sin(2π(T - axis))', () => {
    const T = 0.37
    const axis = axisAt(4, 6)
    const expected = DENSITY + (1 - DENSITY) * 0.9 * Math.sin(2 * Math.PI * (T - axis))
    expect(levelAt(T, axis)).toBeCloseTo(expected, 12)
  })

  it('swings continuously between ~ -0.14 and ~ 0.94 (so cells flow ON and OFF)', () => {
    // peak = 0.40 + 0.54 = 0.94; trough = 0.40 - 0.54 = -0.14.
    const samples: number[] = []
    for (let i = 0; i < 200; i++) samples.push(levelAt(i / 200, 0))
    expect(Math.max(...samples)).toBeCloseTo(0.94, 2)
    expect(Math.min(...samples)).toBeCloseTo(-0.14, 2)
  })
})

describe('isNotched — the two cut corners', () => {
  it('notches exactly the 3 top-left cells (x+y < 2)', () => {
    expect(isNotched(0, 0)).toBe(true)
    expect(isNotched(1, 0)).toBe(true)
    expect(isNotched(0, 1)).toBe(true)
    // The next diagonal in is NOT notched.
    expect(isNotched(1, 1)).toBe(false)
    expect(isNotched(2, 0)).toBe(false)
    expect(isNotched(0, 2)).toBe(false)
  })

  it('notches exactly the 3 bottom-right cells (x+y > 20)', () => {
    expect(isNotched(11, 11)).toBe(true) // 22
    expect(isNotched(11, 10)).toBe(true) // 21
    expect(isNotched(10, 11)).toBe(true) // 21
    // x+y == 20 is the boundary and NOT notched.
    expect(isNotched(11, 9)).toBe(false) // 20
    expect(isNotched(9, 11)).toBe(false) // 20
    expect(isNotched(10, 10)).toBe(false) // 20
  })

  it('removes 3 cells from each notched corner (6 total)', () => {
    let notched = 0
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) if (isNotched(x, y)) notched++
    }
    expect(notched).toBe(6)
  })
})

describe('isOn — the hard binary decision', () => {
  it('a notched cell is NEVER on', () => {
    expect(isOn(0, 0, 0.0)).toBe(false)
    expect(isOn(11, 11, 0.25)).toBe(false)
    // across a full cycle it stays off.
    for (let i = 0; i < 50; i++) expect(isOn(0, 1, i / 50)).toBe(false)
  })

  it('an un-notched cell is on iff threshold < level (hard binary)', () => {
    const x = 6
    const y = 5
    const T = 0.3
    const expected = thresholdAt(x, y) < levelAt(T, axisAt(x, y))
    expect(isOn(x, y, T)).toBe(expected)
  })

  it('toggles over a cycle (the cell flows on and off — a real wave)', () => {
    const states = new Set<boolean>()
    for (let i = 0; i < 100; i++) states.add(isOn(6, 6, i / 100))
    expect(states.size).toBe(2) // sees both ON and OFF
  })
})

describe('buildCells — the static geometry', () => {
  it('builds the full GRID × GRID grid', () => {
    expect(buildCells().length).toBe(GRID * GRID)
  })

  it('flags the 6 notched cells', () => {
    expect(buildCells().filter((c) => c.notched).length).toBe(6)
  })

  it('lights a legible ~40% static subset (the reduced-motion frame), notch excluded', () => {
    const cells = buildCells()
    const lit = cells.filter((c) => c.staticLit)
    // Static frame = threshold < DENSITY (0.40), and never a notched cell.
    expect(lit.length).toBeGreaterThan(0)
    expect(lit.length).toBeLessThan(cells.length)
    for (const c of cells) {
      const expected = !c.notched && thresholdAt(c.x, c.y) < STATIC_LEVEL
      expect(c.staticLit).toBe(expected)
    }
    // No notched cell is ever static-lit.
    expect(cells.some((c) => c.notched && c.staticLit)).toBe(false)
  })

  it('is deterministic across calls', () => {
    expect(buildCells()).toEqual(buildCells())
  })
})
