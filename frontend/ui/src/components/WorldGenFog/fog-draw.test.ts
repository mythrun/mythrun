import { describe, it, expect } from 'vitest'
import {
  BAYER,
  CELL_CENTER_PX,
  CELL_PX,
  COVERAGE_DIVISOR,
  DITHER_CHAOS_WEIGHT,
  DITHER_ORDERED_WEIGHT,
  FOG_PARAMS,
} from '@mythrun/client-core/worldgen'
import { BAYER_4X4, CHAOS, thresholdAt } from '../Dither/bayer.ts'
import { cloud, paintFog, type FogPaintTarget } from './fog-draw.ts'

// fog-draw is the CRISP Bayer paint (MYT-89 Phase C, C3): it turns FogSim's smoothed,
// box-cleared density grid into solid fog quads via the cloud mask + coverage divisor +
// the base density + the LOCKED ordered-Bayer threshold (no fade — the clear is the
// sim's spawn drain). These tests pin the two things that make
// it correct: (1) a cell is filled IFF `cov > thresholdAt(gx, gy)` (the reused ui Bayer
// helper), and (2) every fill is CRISP — the fixed fog alpha, never a per-cell gradient.
// Plus a Bayer-parity guard so the client-core physics copy and this render copy can't
// silently drift apart.

interface FillCall {
  x: number
  y: number
  w: number
  h: number
  alpha: number
  fill: string
}

/** The `x,y` grid-origin key of a fill (a string, so number-key sets compare cleanly). */
function key(x: number, y: number): string {
  return [x, y].join(',')
}

/** A recording paint target: absorbs fillStyle/globalAlpha writes and logs every
 *  fillRect WITH the alpha + fillStyle live at that call, so a per-cell alpha (a
 *  gradient) would show up as more than one distinct alpha across the fills. */
function recordingCtx(): { target: FogPaintTarget; fills: FillCall[]; finalAlpha: () => number } {
  const fills: FillCall[] = []
  let alpha = 1
  let fillStyle = ''
  const target: FogPaintTarget = {
    get globalAlpha() {
      return alpha
    },
    set globalAlpha(v: number) {
      alpha = v
    },
    get fillStyle() {
      return fillStyle
    },
    set fillStyle(v: string | CanvasGradient | CanvasPattern) {
      fillStyle = typeof v === 'string' ? v : ''
    },
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push({ x, y, w, h, alpha, fill: fillStyle })
    },
  }
  return { target, fills, finalAlpha: () => alpha }
}

/** A deterministic spread of density in [0, 0.6], with a scatter of exact-0 cells (so
 *  the `pd <= 0` skip is exercised) and a mix that lands both sides of the threshold. */
function seedDensity(gw: number, gh: number): Float32Array {
  const d = new Float32Array(gw * gh)
  for (let i = 0; i < d.length; i++) d[i] = ((i * 37) % 13) / 20
  return d
}

const GW = 10
const GH = 8
// No wind + t=0 → the cloud mask is a pure, deterministic spatial function (no scroll),
// so the predicted fill set is reproducible without simulating time.
const OPTS = {
  wx: 0,
  wy: 0,
  t: 0,
  density: 1,
  fogColor: FOG_PARAMS.fogColor,
  fogAlpha: FOG_PARAMS.fogAlpha,
}

/** Recompute the paint decision independently (the reference formula, with NO perf
 *  shortcuts — no cloud bound-skip) so the test asserts against the algorithm, not
 *  against paintFog's own output. */
function predictedFills(density: Float32Array, baseDensity = OPTS.density): Set<string> {
  const out = new Set<string>()
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      const pd = density[gy * GW + gx] ?? 0
      if (pd <= 0) continue
      const px = gx * CELL_PX + CELL_CENTER_PX
      const py = gy * CELL_PX + CELL_CENTER_PX
      const cov = (pd / COVERAGE_DIVISOR) * cloud(px, py, 0, 0, 0) * baseDensity
      if (cov > thresholdAt(gx, gy)) out.add(key(gx * CELL_PX, gy * CELL_PX))
    }
  }
  return out
}

describe('paintFog — the crisp Bayer coverage decision', () => {
  it('fills a cell IFF cov > thresholdAt(gx, gy) (matches the reference formula)', () => {
    const density = seedDensity(GW, GH)
    const { target, fills } = recordingCtx()
    paintFog(target, density, GW, GH, OPTS)

    const painted = new Set(fills.map((f) => key(f.x, f.y)))
    const predicted = predictedFills(density)
    expect(painted).toEqual(predicted)
  })

  it('discriminates: the decision produces BOTH filled and skipped cells (non-vacuous)', () => {
    const density = seedDensity(GW, GH)
    const predicted = predictedFills(density)
    expect(predicted.size).toBeGreaterThan(0)
    expect(predicted.size).toBeLessThan(GW * GH)
  })

  it('never paints a zero/negative-density cell (FogSim already cleared under labels)', () => {
    const density = new Float32Array(GW * GH) // all zero
    const { target, fills } = recordingCtx()
    paintFog(target, density, GW, GH, OPTS)
    expect(fills).toHaveLength(0)
  })

  it('a thin base density still matches the reference formula exactly', () => {
    // The perf bound-skip (skip cloud() when even a MAX cloud could not clear the
    // threshold) fires most on faint fog — this pins that it is decision-IDENTICAL,
    // never an approximation: painted set == the shortcut-free reference formula.
    const density = seedDensity(GW, GH)
    const { target, fills } = recordingCtx()
    paintFog(target, density, GW, GH, { ...OPTS, density: 0.12 })
    const painted = new Set(fills.map((f) => key(f.x, f.y)))
    expect(painted).toEqual(predictedFills(density, 0.12))
  })

  it('paints nothing and leaves the ctx untouched at density 0', () => {
    // density 0 → cov is 0 for every cell → no cell can clear a (non-negative)
    // threshold. The fast path must skip the whole grid walk WITHOUT touching canvas
    // state (a zeroed layer costs nothing).
    const density = seedDensity(GW, GH)
    const { target, fills, finalAlpha } = recordingCtx()
    paintFog(target, density, GW, GH, { ...OPTS, density: 0 })
    expect(fills).toHaveLength(0)
    expect(finalAlpha()).toBe(1) // never written (the recording ctx starts at 1)
    expect(target.fillStyle).toBe('') // never written
  })

  it('paints each cell as a full CELL_PX quad at the cell origin (no sub-cell geometry)', () => {
    const density = seedDensity(GW, GH)
    const { target, fills } = recordingCtx()
    paintFog(target, density, GW, GH, OPTS)
    for (const f of fills) {
      expect(f.w).toBe(CELL_PX)
      expect(f.h).toBe(CELL_PX)
      expect(f.x % CELL_PX).toBe(0)
      expect(f.y % CELL_PX).toBe(0)
    }
  })
})

describe('paintFog — CRISP, no gradient', () => {
  it('paints every quad at the SINGLE fixed fog alpha (no per-cell fractional alpha)', () => {
    const density = seedDensity(GW, GH)
    const { target, fills } = recordingCtx()
    paintFog(target, density, GW, GH, OPTS)
    const distinctAlphas = new Set(fills.map((f) => f.alpha))
    expect(distinctAlphas).toEqual(new Set([FOG_PARAMS.fogAlpha]))
  })

  it('paints every quad in the single fog color', () => {
    const density = seedDensity(GW, GH)
    const { target, fills } = recordingCtx()
    paintFog(target, density, GW, GH, OPTS)
    const distinctFills = new Set(fills.map((f) => f.fill))
    expect(distinctFills).toEqual(new Set([FOG_PARAMS.fogColor]))
  })

  it('restores globalAlpha to 1 after painting (leaves the ctx clean for the next layer)', () => {
    const density = seedDensity(GW, GH)
    const { target, finalAlpha } = recordingCtx()
    paintFog(target, density, GW, GH, OPTS)
    expect(finalAlpha()).toBe(1)
  })

  it('a higher base density never DROPS a painted cell (monotone threshold)', () => {
    // Raising the base density can only add cells: a crisp threshold is monotone in
    // cov, so the painted set grows.
    const density = seedDensity(GW, GH)
    const faint = recordingCtx()
    const thick = recordingCtx()
    paintFog(faint.target, density, GW, GH, { ...OPTS, density: 0.4 })
    paintFog(thick.target, density, GW, GH, { ...OPTS, density: 1.2 })
    const faintSet = new Set(faint.fills.map((f) => key(f.x, f.y)))
    const thickSet = new Set(thick.fills.map((f) => key(f.x, f.y)))
    for (const cell of faintSet) expect(thickSet.has(cell)).toBe(true)
  })
})

describe('Bayer parity — physics copy (fog-params) vs render copy (ui bayer.ts)', () => {
  // The fog threshold is `0.85·orderedBayer + 0.15·chaos`. FogSim's physics carry a
  // VERBATIM copy of the matrix (client-core can't import from @mythrun/ui — the dep
  // direction is ui→client-core); the render REUSES ui's `thresholdAt`. This guard
  // fails the moment the two matrices / blend weights drift apart.
  //
  // NOTE — the CHAOS HASH differs by design and is NOT asserted equal: fog-params
  // documents the reference's `fract(sin(...))` GLSL hash; ui's `chaosAt` is an
  // xorshift integer hash. Both are stable per-cell decorrelators in [0, 1); at the
  // locked 15% weight the exact speckle is not load-bearing (only the ORDERED grid is),
  // and the brief pins the render to reuse ui's `thresholdAt`.
  it('the fog-params Bayer matrix equals ui bayer.ts BAYER_4X4', () => {
    expect(BAYER).toEqual(BAYER_4X4)
  })

  it('the dither blend weights match (0.85 ordered / 0.15 chaos)', () => {
    expect(DITHER_ORDERED_WEIGHT).toBe(1 - CHAOS)
    expect(DITHER_CHAOS_WEIGHT).toBe(CHAOS)
  })
})

describe('cloud — the wind-scrolled multi-octave mask (ported verbatim)', () => {
  it('is floored at 0 (never a negative modulation)', () => {
    for (let px = 0; px < 900; px += 37) {
      for (let py = 0; py < 470; py += 41) {
        expect(cloud(px, py, -1.75, 0.9, 3.2)).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('scrolls with the wind over time (t advances the field)', () => {
    // With a non-zero wind, the sampled value at a fixed point changes as t advances —
    // the cloud advects. (A near-degenerate point could coincide; sample a few.)
    const moved = [0, 1, 2].some((k) => cloud(120, 90, -1.75, 0.9, 0) !== cloud(120, 90, -1.75, 0.9, 1 + k))
    expect(moved).toBe(true)
  })
})
