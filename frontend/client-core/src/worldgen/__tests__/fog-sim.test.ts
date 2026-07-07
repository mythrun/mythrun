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
// timestep, area-scaled N, doublet bucketing, the spawn-scale drain). These tests
// pin the behaviours the brief calls out — determinism, exclusion, fixed-timestep,
// the drain (the fog clears by NOT respawning: population targets, the dormant
// fast-path, the reduced-motion population snap), wake rejoin — plus direct unit
// coverage of the branchy field helpers (segd's epsilon guard, the doublet field's
// gates) that the integration path can only reach probabilistically.

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

  it('culls a doublet beyond the 12·RD cutoff — the far field contributes exactly nothing', () => {
    // The doublet cutoff is the SAME 12·RD the bucket grid documents (far-field ≲1% of
    // |wind|). A doublet past it must leave the velocity bit-identical to no doublet at
    // all — the isotropic cull, not merely a small contribution.
    const far: Doublet[] = [{ x: 100 + 13 * RD, y: 100, vx: 5, vy: 5 }]
    expect(fieldVelocity(100, 100, 0, far, UNIT_WEST)).toEqual(fieldVelocity(100, 100, 0, [], UNIT_WEST))
  })

  it('keeps a doublet inside the 12·RD cutoff (the near field is evaluated)', () => {
    const near: Doublet[] = [{ x: 100 + 11 * RD, y: 100, vx: 0, vy: 0 }]
    expect(fieldVelocity(100, 100, 0, near, UNIT_WEST)).not.toEqual(fieldVelocity(100, 100, 0, [], UNIT_WEST))
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

  it('caps catch-up at 2 sub-steps per call and drops the rest of the backlog', () => {
    // The anti-jank valve (MYT-89 perf): catch-up sub-steps multiply per-frame cost
    // exactly when the machine is already over budget, so the cap is LOW (2). A 50ms
    // frame wants 3 sub-steps; it must run exactly 2 (matching two healthy 16.7ms
    // frames) and DROP the remainder — time dilates under overload, never a spiral.
    const a = createFogSim({ width: 300, height: 200, random: mulberry32(11) })
    const b = createFogSim({ width: 300, height: 200, random: mulberry32(11) })
    a.step(50, [], 1)
    b.step(16.7, [], 1)
    b.step(16.7, [], 1)
    expect(Array.from(a.density())).toEqual(Array.from(b.density()))
    // …and the dropped backlog doesn't leak into the next frame: both run 1 sub-step.
    a.step(16.7, [], 1)
    b.step(16.7, [], 1)
    expect(Array.from(a.density())).toEqual(Array.from(b.density()))
  })
})

describe('FogSim — spawn-scale drain (the fog clears by NOT respawning)', () => {
  // A small canvas so particles cross (and the drain completes) quickly: the wind
  // crosses ~0.7 px/sub-step, so the 90×60 field drains within a few hundred steps
  // and the residual low-pass decays below the drain epsilon soon after.

  it('drains the field EMPTY at spawnScale 0 — wind carries the fog off, nothing replaces it', () => {
    const sim = createFogSim({ width: 90, height: 60, random: mulberry32(31) })
    for (let i = 0; i < 40; i++) sim.step(17, [], 1)
    expect(anyPositive(sim.density())).toBe(true)
    for (let i = 0; i < 1200; i++) sim.step(17, [], 0)
    // Fully drained: the grid is EXACT zeros (the drain-complete transition zeroes
    // the invisible residual so the paint's `pd <= 0` skip covers every cell).
    expect(anyPositive(sim.density())).toBe(false)
  })

  it('goes DORMANT once drained — further steps leave the zeroed grid untouched', () => {
    const sim = createFogSim({ width: 90, height: 60, random: mulberry32(31) })
    for (let i = 0; i < 1200; i++) sim.step(17, [], 0)
    expect(anyPositive(sim.density())).toBe(false)
    const grid = sim.density() // by-reference — the dormant path must not realloc
    for (let i = 0; i < 50; i++) sim.step(17, [{ x: 30, y: 20, w: 20, h: 10, vx: 0, vy: 0 }], 0)
    expect(sim.density()).toBe(grid)
    expect(anyPositive(sim.density())).toBe(false)
  })

  it('holds a THINNER steady state at a mid scale (population tracks the target)', () => {
    const sum = (d: Float32Array): number => {
      let total = 0
      for (const v of d) total += v
      return total
    }
    const full = createFogSim({ width: 90, height: 60, random: mulberry32(7) })
    const half = createFogSim({ width: 90, height: 60, random: mulberry32(7) })
    for (let i = 0; i < 1200; i++) {
      full.step(17, [], 1)
      half.step(17, [], 0.5)
    }
    const fullSum = sum(full.density())
    const halfSum = sum(half.density())
    // Roughly half the particles → roughly half the integrated density: thinner
    // than the full field but decidedly NOT empty (a drained-vs-dimmed distinction).
    expect(halfSum).toBeGreaterThan(0.2 * fullSum)
    expect(halfSum).toBeLessThan(0.8 * fullSum)
  })

  it('re-arms when the scale rises — new fog blows back in from the spawn edges', () => {
    const sim = createFogSim({ width: 90, height: 60, random: mulberry32(13) })
    for (let i = 0; i < 1200; i++) sim.step(17, [], 0)
    expect(anyPositive(sim.density())).toBe(false)
    for (let i = 0; i < 600; i++) sim.step(17, [], 1)
    expect(anyPositive(sim.density())).toBe(true)
  })

  it('stays deterministic for the same seed + spawn-scale schedule', () => {
    const run = (): Float32Array => {
      const sim = createFogSim({ width: 120, height: 90, random: mulberry32(23) })
      for (let i = 0; i < 40; i++) sim.step(17, [], 1)
      for (let i = 0; i < 120; i++) sim.step(17, [], 0.4)
      for (let i = 0; i < 80; i++) sim.step(17, [], 0)
      return sim.density().slice()
    }
    expect(maxAbsDiff(run(), run())).toBe(0)
  })

  it('carries the drain across a resize — retired slots survive; a grown field re-arms', () => {
    const sim = createFogSim({ width: 90, height: 60, random: mulberry32(53) })
    for (let i = 0; i < 1200; i++) sim.step(17, [], 0)
    expect(anyPositive(sim.density())).toBe(false)
    // SHRINK while drained: every surviving slot stays retired (the dead-stack
    // rebuild) and the dormant state carries over — still empty, still a no-op.
    sim.setSize(60, 42)
    for (let i = 0; i < 30; i++) sim.step(17, [], 0)
    expect(anyPositive(sim.density())).toBe(false)
    // GROW: the revealed area warm-starts fresh particles, so the sim wakes — fog
    // is present again once the field steps at full spawn.
    sim.setSize(240, 180)
    for (let i = 0; i < 5; i++) sim.step(17, [], 1)
    expect(anyPositive(sim.density())).toBe(true)
  })
})

describe('FogSim — settlePopulation (the reduced-motion population snap)', () => {
  it('snaps to EMPTY at scale 0 immediately (grid zeroed — a static drained sample)', () => {
    const sim = createFogSim({ width: 90, height: 60, random: mulberry32(41) })
    for (let i = 0; i < 40; i++) sim.step(17, [], 1)
    expect(anyPositive(sim.density())).toBe(true)
    sim.settlePopulation(0)
    expect(anyPositive(sim.density())).toBe(false)
    // …and the follow-up settle steps stay empty (the dormant fast-path).
    for (let i = 0; i < 30; i++) sim.step(17, [], 0)
    expect(anyPositive(sim.density())).toBe(false)
  })

  it('revives FIELD-WIDE when snapped back up (a static sample, not an edge trickle)', () => {
    const sim = createFogSim({ width: 300, height: 200, random: mulberry32(43) })
    sim.settlePopulation(0)
    sim.settlePopulation(1)
    // A short settle must already populate the FAR interior — field-wide placement;
    // edge-spawned revives could not reach mid-field in 30 sub-steps.
    for (let i = 0; i < 30; i++) sim.step(17, [], 1)
    const d = sim.density()
    expect(windowAvg(d, sim.gw, sim.gh, 150, 100, 3)).toBeGreaterThan(0)
  })

  it('a mid-scale snap converges the settle to a thinner field than a full one', () => {
    const sum = (d: Float32Array): number => {
      let total = 0
      for (const v of d) total += v
      return total
    }
    const settle = (scale: number): number => {
      const sim = createFogSim({ width: 90, height: 60, random: mulberry32(47) })
      sim.settlePopulation(scale)
      for (let i = 0; i < 120; i++) sim.step(17, [], scale)
      return sum(sim.density())
    }
    const full = settle(1)
    const third = settle(1 / 3)
    expect(third).toBeGreaterThan(0)
    expect(third).toBeLessThan(0.7 * full)
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

describe('FogSim — setSize (the responsive pane resize, MYT-89)', () => {
  it('re-derives the grid dims (and the live gw/gh reads follow)', () => {
    const sim = createFogSim({ width: 300, height: 120, random: mulberry32(7) })
    expect(sim.gw).toBe(Math.ceil(300 / CELL_PX))
    expect(sim.gh).toBe(Math.ceil(120 / CELL_PX))
    sim.setSize(450, 240)
    expect(sim.gw).toBe(Math.ceil(450 / CELL_PX))
    expect(sim.gh).toBe(Math.ceil(240 / CELL_PX))
    expect(sim.density().length).toBe(sim.gw * sim.gh)
  })

  it('preserves the overlapping smoothed density on GROW (no fade-to-black flash)', () => {
    const sim = createFogSim({ width: 180, height: 120, random: mulberry32(11) })
    for (let i = 0; i < 120; i++) sim.step(17, [], 1)
    const gwBefore = sim.gw
    const before = sim.density().slice()
    sim.setSize(300, 240)
    const after = sim.density()
    // Every cell of the OLD grid keeps its exact smoothed value at its (gx, gy) in
    // the new (wider-strided) grid; the new cells start empty and blend in.
    for (let gy = 0; gy < Math.ceil(120 / CELL_PX); gy++) {
      for (let gx = 0; gx < gwBefore; gx++) {
        expect(after[gy * sim.gw + gx]).toBe(before[gy * gwBefore + gx])
      }
    }
  })

  it('preserves the overlapping smoothed density on SHRINK (bounded copy)', () => {
    const sim = createFogSim({ width: 300, height: 240, random: mulberry32(13) })
    for (let i = 0; i < 120; i++) sim.step(17, [], 1)
    const gwBefore = sim.gw
    const before = sim.density().slice()
    sim.setSize(180, 120)
    const after = sim.density()
    for (let gy = 0; gy < sim.gh; gy++) {
      for (let gx = 0; gx < sim.gw; gx++) {
        expect(after[gy * sim.gw + gx]).toBe(before[gy * gwBefore + gx])
      }
    }
  })

  it('keeps stepping after a resize — the field stays populated + finite at the new size', () => {
    const sim = createFogSim({ width: 90, height: 60, random: mulberry32(17) })
    for (let i = 0; i < 60; i++) sim.step(17, [], 1)
    sim.setSize(240, 180) // grow: surviving particles keep flowing, new slots warm-start
    for (let i = 0; i < 120; i++) sim.step(17, [], 1)
    const d = sim.density()
    expect(d.length).toBe(sim.gw * sim.gh)
    expect(anyPositive(d)).toBe(true)
    for (const v of d) expect(Number.isFinite(v)).toBe(true)
    // …and the far (new) half of the grid actually receives fog (the warm-start
    // seeded the grown field, not just the old corner).
    const right = windowAvg(d, sim.gw, sim.gh, 200, 90, 2)
    expect(right).toBeGreaterThan(0)
  })

  it('is a no-op for the same dims (state object untouched)', () => {
    const sim = createFogSim({ width: 180, height: 120, random: mulberry32(19) })
    for (let i = 0; i < 30; i++) sim.step(17, [], 1)
    const before = sim.density() // by-reference read
    sim.setSize(180, 120)
    expect(sim.density()).toBe(before) // same Float32Array — nothing was realloc'd
  })

  it('stays deterministic across a resize for the same seed + call sequence', () => {
    const run = (): Float32Array => {
      const sim = createFogSim({ width: 120, height: 90, random: mulberry32(23) })
      for (let i = 0; i < 40; i++) sim.step(17, [], 1)
      sim.setSize(200, 90)
      for (let i = 0; i < 40; i++) sim.step(17, [], 1)
      return sim.density().slice()
    }
    expect(maxAbsDiff(run(), run())).toBe(0)
  })
})
