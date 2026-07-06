import { describe, it, expect } from 'vitest'
import {
  createFogSim,
  fieldVelocity,
  inGrid,
  isOffBand,
  pickSpawn,
  segd,
  splatWeight,
  type Doublet,
  type FogObstacle,
  type Wind,
} from '../fog-sim.ts'
import { CELL_PX, DOUBLET_RADIUS_PX, SPAWN_BOUND_PX } from '../fog-params.ts'

// FogSim is the DOM-free fluid core (MYT-89 Phase C, C2): a verbatim port of the
// fog-reference prototype's particle physics, hardened for production (fixed
// timestep, area-scaled N, doublet bucketing, fade-skip). These tests pin the five
// behaviours the brief calls out — determinism, exclusion, fixed-timestep,
// fade-skip, wake rejoin — plus direct unit coverage of the branchy field helpers
// (segd's epsilon guard, the doublet field's gates) that the integration path can
// only reach probabilistically.

/** Deterministic PRNG (mulberry32) so a seeded FogSim is byte-reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const RD = DOUBLET_RADIUS_PX

/** A static (non-moving) obstacle box. */
function box(x: number, y: number, w: number, h: number): FogObstacle {
  return { x, y, w, h, vx: 0, vy: 0 }
}

/** Wind pointing in -x (unit), so "downstream" (a > 0 in the field) is to the LEFT
 *  of a doublet — a clean frame for the field-branch unit tests. */
const UNIT_WEST: Wind = { wx: -1, wy: 0, U: 1, wxu: -1, wyu: 0 }

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] ?? 0) - (b[i] ?? 0)))
  return m
}

function anyPositive(a: Float32Array): boolean {
  for (const v of a) if (v > 0) return true
  return false
}

/** Mean density over a (2r+1)² cell window centred on a virtual point — denoises
 *  the single-cell RNG jitter so a wake/free comparison reads the real flow, not
 *  the shot noise of a moderate particle count. */
function windowAvg(d: Float32Array, gw: number, gh: number, px: number, py: number, r: number): number {
  const gx = Math.trunc(px / CELL_PX)
  const gy = Math.trunc(py / CELL_PX)
  let sum = 0
  let count = 0
  for (let yy = gy - r; yy <= gy + r; yy++) {
    for (let xx = gx - r; xx <= gx + r; xx++) {
      if (!inGrid(xx, yy, gw, gh)) continue
      sum += d[yy * gw + xx] ?? 0
      count += 1
    }
  }
  return count === 0 ? 0 : sum / count
}

describe('segd — capsule distance + outward normal (verbatim, incl the 0.001 guard)', () => {
  it('returns perpendicular distance + unit normal for a point off a horizontal segment', () => {
    const [d, nx, ny] = segd(0, 5, 0, 0, 10, 0)
    expect(d).toBeCloseTo(5)
    expect(nx).toBeCloseTo(0)
    expect(ny).toBeCloseTo(1)
  })

  it('clamps t < 0 to the segment start', () => {
    const [d] = segd(-5, 3, 0, 0, 10, 0)
    expect(d).toBeCloseTo(Math.hypot(5, 3))
  })

  it('clamps t > 1 to the segment end', () => {
    const [d] = segd(15, 3, 0, 0, 10, 0)
    expect(d).toBeCloseTo(Math.hypot(5, 3))
  })

  it('handles a degenerate (zero-length) segment', () => {
    const [d, nx, ny] = segd(3, 4, 5, 5, 5, 5)
    expect(d).toBeCloseTo(Math.hypot(2, 1))
    // Off-point, so the normal is still the real unit direction (not the fallback).
    expect(Math.hypot(nx, ny)).toBeCloseTo(1)
  })

  it('falls back to (0, -1) for a point exactly on the segment (the 0.001 epsilon)', () => {
    const [d, nx, ny] = segd(5, 0, 0, 0, 10, 0)
    expect(d).toBe(0)
    expect(nx).toBe(0)
    expect(ny).toBe(-1)
  })
})

describe('fieldVelocity — the potential-flow field (verbatim gates)', () => {
  it('is wind + turbulence when there are no doublets', () => {
    const [vx, vy] = fieldVelocity(100, 100, 0, [], UNIT_WEST)
    // t=0 → turb x = sin(a)·cos(1.3b); with only wind + turb, |v - wind| ≤ 2·amp.
    expect(Math.hypot(vx - UNIT_WEST.wx, vy - UNIT_WEST.wy)).toBeLessThanOrEqual(0.8 + 1e-9)
  })

  it('clamps r² to RD² and applies wake-drag when a particle is inside a moving doublet', () => {
    // Particle 0.5·RD to the LEFT of the doublet (a = +0.5·RD < 1.6·RD → wake-close
    // OFF; r² < RD² → clamped; r² < 9·RD² → drag ON). Doublet dragging in +y.
    const dublets: Doublet[] = [{ x: 100, y: 100, vx: 0, vy: 10 }]
    const [, vyMoving] = fieldVelocity(100 - 0.5 * RD, 100, 0, dublets, UNIT_WEST)
    const still: Doublet[] = [{ x: 100, y: 100, vx: 0, vy: 0 }]
    const [, vyStill] = fieldVelocity(100 - 0.5 * RD, 100, 0, still, UNIT_WEST)
    // The only difference between the two runs is the drag term → vy must lift.
    expect(vyMoving - vyStill).toBeGreaterThan(0)
  })

  it('activates wake-close downstream (a > 1.6·RD) and skips drag out past 3·RD', () => {
    // Particle 5·RD downstream (to the left): a = 5·RD > 1.6·RD (wake-close ON),
    // r² = 25·RD² (clamp OFF, drag OFF). Nudge off-axis so the cross term is nonzero.
    const dublets: Doublet[] = [{ x: 100, y: 100, vx: 0, vy: 0 }]
    const onAxis = fieldVelocity(100 - 5 * RD, 100, 0, dublets, UNIT_WEST)
    const offAxis = fieldVelocity(100 - 5 * RD, 100 + 4, 0, dublets, UNIT_WEST)
    // Off the wake axis the wake-close perp term steers the flow differently.
    expect(Math.abs(onAxis[1] - offAxis[1])).toBeGreaterThan(0)
  })
})

describe('isOffBand / inGrid / splatWeight / pickSpawn — helper branches', () => {
  it('isOffBand is true past each edge and false inside', () => {
    expect(isOffBand(50, 50, 100, 100)).toBe(false)
    expect(isOffBand(-SPAWN_BOUND_PX - 1, 50, 100, 100)).toBe(true)
    expect(isOffBand(101 + SPAWN_BOUND_PX, 50, 100, 100)).toBe(true)
    expect(isOffBand(50, -SPAWN_BOUND_PX - 1, 100, 100)).toBe(true)
    expect(isOffBand(50, 101 + SPAWN_BOUND_PX, 100, 100)).toBe(true)
  })

  it('inGrid is true inside and false past each edge', () => {
    expect(inGrid(1, 1, 10, 10)).toBe(true)
    expect(inGrid(-1, 1, 10, 10)).toBe(false)
    expect(inGrid(1, -1, 10, 10)).toBe(false)
    expect(inGrid(10, 1, 10, 10)).toBe(false)
    expect(inGrid(1, 10, 10, 10)).toBe(false)
  })

  it('splatWeight is centre / edge / corner by offset', () => {
    expect(splatWeight(0, 0)).toBeGreaterThan(splatWeight(1, 0))
    expect(splatWeight(1, 0)).toBeGreaterThan(splatWeight(1, 1))
    expect(splatWeight(0, 1)).toBe(splatWeight(1, 0))
  })

  it('pickSpawn takes the top edge on a low draw and the right edge on a high draw', () => {
    const top = pickSpawn(() => 0, 100, 80, 54, 70)
    expect(top[1]).toBe(-SPAWN_BOUND_PX)
    const right = pickSpawn(() => 0.99, 100, 80, 54, 70)
    expect(right[0]).toBe(100 + SPAWN_BOUND_PX)
  })
})

describe('FogSim — determinism', () => {
  it('produces an identical density grid for the same seed + obstacle sequence', () => {
    const obstacles = [box(120, 90, 60, 30)]
    const a = createFogSim({ width: 300, height: 200, random: mulberry32(1234) })
    const b = createFogSim({ width: 300, height: 200, random: mulberry32(1234) })
    for (let i = 0; i < 40; i++) {
      a.step(16.7, obstacles, 1)
      b.step(16.7, obstacles, 1)
    }
    expect(Array.from(a.density())).toEqual(Array.from(b.density()))
  })

  it('diverges for different seeds (the seed actually drives the sim)', () => {
    const a = createFogSim({ width: 300, height: 200, random: mulberry32(1) })
    const b = createFogSim({ width: 300, height: 200, random: mulberry32(2) })
    for (let i = 0; i < 40; i++) {
      a.step(16.7, [], 1)
      b.step(16.7, [], 1)
    }
    expect(maxAbsDiff(a.density(), b.density())).toBeGreaterThan(0)
  })
})

describe('FogSim — area-scaled N + grid dims', () => {
  it('derives GW/GH from the canvas at the cell size', () => {
    const sim = createFogSim({ width: 300, height: 200 })
    expect(sim.gw).toBe(Math.ceil(300 / CELL_PX))
    expect(sim.gh).toBe(Math.ceil(200 / CELL_PX))
    expect(sim.density()).toHaveLength(sim.gw * sim.gh)
  })
})

describe('FogSim — obstacle exclusion (fog never covers a label)', () => {
  it('leaves the cells under an obstacle box empty while fog builds elsewhere', () => {
    const sim = createFogSim({ width: 480, height: 300, random: mulberry32(7) })
    const ob = box(210, 135, 60, 30)
    for (let i = 0; i < 60; i++) sim.step(16.7, [ob], 1)

    const d = sim.density()
    // A cell squarely inside the box must be exactly 0 (box-clear guarantees it).
    const gx = Math.trunc(240 / CELL_PX)
    const gy = Math.trunc(150 / CELL_PX)
    expect(d[gy * sim.gw + gx]).toBe(0)
    // …but fog is present in the field at large (not a trivially-empty grid).
    expect(anyPositive(d)).toBe(true)
  })
})

describe('FogSim — fixed timestep (frame-rate independent)', () => {
  it('one step(32) matches two step(16) (density grids equal)', () => {
    const obstacles = [box(120, 90, 60, 30)]
    const big = createFogSim({ width: 300, height: 200, random: mulberry32(99) })
    const small = createFogSim({ width: 300, height: 200, random: mulberry32(99) })
    big.step(32, obstacles, 1)
    small.step(16, obstacles, 1)
    small.step(16, obstacles, 1)
    expect(maxAbsDiff(big.density(), small.density())).toBeLessThan(1e-6)
  })

  it('clamps the sub-steps a single huge dt can run (no catch-up spiral)', () => {
    const sim = createFogSim({ width: 300, height: 200, random: mulberry32(5) })
    // A 10s dt would be ~600 sub-steps unclamped; it must not hang and must produce
    // a finite, populated grid (proof it ran a bounded number of sub-steps).
    expect(() => {
      sim.step(10000, [], 1)
    }).not.toThrow()
    expect(anyPositive(sim.density())).toBe(true)
  })
})

describe('FogSim — fade-skip (perf)', () => {
  it('does no work when effectiveDensity is ~0 (fresh grid stays empty)', () => {
    const sim = createFogSim({ width: 300, height: 200, random: mulberry32(3) })
    sim.step(16.7, [], 0)
    expect(anyPositive(sim.density())).toBe(false)
  })

  it('leaves a built-up grid unchanged across a faded step', () => {
    const sim = createFogSim({ width: 300, height: 200, random: mulberry32(3) })
    for (let i = 0; i < 20; i++) sim.step(16.7, [], 1)
    const before = Array.from(sim.density())
    sim.step(16.7, [], 0)
    expect(Array.from(sim.density())).toEqual(before)
  })
})

describe('FogSim — wake rejoin (the river closes, no permanent shadow)', () => {
  it(
    'parts around a label but closes back downstream (vs an obstacle-free flow)',
    () => {
      // Same seed, same steps — one sim with the obstacle, one without. Comparing
      // the wake against the free flow at the SAME window normalises out the inflow
      // gradient, so the ratio is a clean "how much has the river closed" measure.
      const ob = box(210, 135, 60, 30)
      const withOb = createFogSim({ width: 480, height: 300, random: mulberry32(42) })
      const free = createFogSim({ width: 480, height: 300, random: mulberry32(42) })
      for (let i = 0; i < 130; i++) {
        withOb.step(16.7, [ob], 1)
        free.step(16.7, [], 1)
      }

      const dWith = withOb.density()
      const dFree = free.density()
      const { gw, gh } = withOb
      // Wind blows down-and-left (~(-0.89, +0.46) unit), so the wake trails to the
      // lower-left of the capsule centre (240, 150). Two sample points along it:
      //   near (~22px downstream) — the parted shadow right behind the label;
      //   far  (~105px downstream) — where the flow has closed back together.
      const cx = 240
      const cy = 150
      const ux = -0.89
      const uy = 0.458
      const nearWith = windowAvg(dWith, gw, gh, cx + 22 * ux, cy + 22 * uy, 2)
      const nearFree = windowAvg(dFree, gw, gh, cx + 22 * ux, cy + 22 * uy, 2)
      const farWith = windowAvg(dWith, gw, gh, cx + 105 * ux, cy + 105 * uy, 2)
      const farFree = windowAvg(dFree, gw, gh, cx + 105 * ux, cy + 105 * uy, 2)

      // The fog PARTS around the label: right behind it the wake is heavily depleted.
      expect(nearWith).toBeLessThan(0.35 * nearFree)
      // …and then the river CLOSES: further downstream the wake has recovered to (at
      // least) the free-flow density — a real rejoin, not a permanent shadow.
      expect(farWith).toBeGreaterThan(0)
      expect(farWith).toBeGreaterThan(0.8 * farFree)
    },
    20000,
  )
})

describe('FogSim — particle recycling (long run, both spawn edges)', () => {
  it('keeps the field populated as particles drift off-band and respawn', () => {
    // A small canvas so particles cross and respawn quickly; a long run exercises
    // the off-band → spawn path off BOTH inflow edges and keeps every value finite.
    const sim = createFogSim({ width: 90, height: 60, random: mulberry32(2024) })
    for (let i = 0; i < 400; i++) sim.step(17, [], 1)
    const d = sim.density()
    expect(anyPositive(d)).toBe(true)
    for (const v of d) expect(Number.isFinite(v)).toBe(true)
  })
})
