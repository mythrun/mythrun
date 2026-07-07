import {
  CELL_CENTER_PX,
  CELL_PX,
  CLOUD_CONTRAST_BASE,
  CLOUD_CONTRAST_GAIN,
  CLOUD_NORM_DIVISOR,
  CLOUD_OCTAVES,
  CLOUD_WIND_SCROLL,
  COVERAGE_DIVISOR,
} from '@mythrun/client-core/worldgen'
import { thresholdAt } from '../Dither/bayer.ts'

// The world-gen fog PAINT (MYT-89 Phase C, C3). FogSim (client-core) is the density
// brain — `density()` returns the raw smoothed, box-cleared particle grid (`dsm`). This
// helper renders it: the CLOUD mask, the `/COVERAGE_DIVISOR` coverage, the fade multiply,
// and the LOCKED ordered-Bayer threshold that turns coverage into CRISP fog quads. None
// of this lives in FogSim (the C2/C3 split); the algorithm is ported VERBATIM from the
// reference `<script>` (its numbers live in `fog-params.ts`).
//
// CRISP means: a cell is either a SOLID quad at the fixed fog alpha, or nothing — never
// a per-cell fractional alpha (a gradient). The dither IS the gradient (the brand's
// 1-bit register); the Bayer threshold decides which cells are solid, so the fog reads
// as grain, not a soft blur. It REUSES @mythrun/ui's `Dither/bayer.ts` `thresholdAt`
// (the brand's locked dither math) rather than re-deriving it here.

/** The minimal Canvas-2D surface `paintFog` touches. Narrow (not the full
 *  `CanvasRenderingContext2D`) so the helper is trivially testable with a recording
 *  stub — and a real 2D context is structurally assignable to it. */
export interface FogPaintTarget {
  fillStyle: string | CanvasGradient | CanvasPattern
  globalAlpha: number
  fillRect(x: number, y: number, w: number, h: number): void
}

/** The runtime inputs a single fog repaint needs (the fixed constants are imported). */
export interface PaintFogOptions {
  /** Scaled wind x (`WIND_BASE[0] * FOG_PARAMS.wind`) — advects the cloud field. */
  wx: number
  /** Scaled wind y (`WIND_BASE[1] * FOG_PARAMS.wind`). */
  wy: number
  /** Clock (seconds) — the cloud field scrolls with `wind * CLOUD_WIND_SCROLL * t`. */
  t: number
  /** The fade-applied base density (`EFF`) — the fog thins toward 0 as the graph fills.
   *  Applied here (the fade is a RENDER concern), not inside FogSim. */
  effectiveDensity: number
  /** The fog fill colour (`FOG_PARAMS.fogColor`). */
  fogColor: string
  /** The fixed fog quad alpha (`FOG_PARAMS.fogAlpha`) — the SAME for every cell. */
  fogAlpha: number
}

/**
 * The multi-octave, wind-scrolled cloud modulation at (px, py) — the "rolling clouds"
 * that make some regions of the fog thicker than others and drift over time. Ported
 * VERBATIM from the reference `cloud()`: the field is sampled on wind-scrolled coords,
 * summed over `CLOUD_OCTAVES`, run through the contrast curve, and floored at 0.
 */
export function cloud(px: number, py: number, wx: number, wy: number, t: number): number {
  const sx = px - wx * CLOUD_WIND_SCROLL * t
  const sy = py - wy * CLOUD_WIND_SCROLL * t
  let n = 0
  for (const octave of CLOUD_OCTAVES) {
    n += octave.amp * Math.sin(sx * octave.fx + sy * octave.fy + octave.phase + t * octave.timeFreq)
  }
  return Math.max(0, CLOUD_CONTRAST_BASE + CLOUD_CONTRAST_GAIN * (n / CLOUD_NORM_DIVISOR))
}

/** A strict upper bound on `cloud()` (MYT-89 framerate fix): the octave sum `n` is at
 *  most Σ|amp| (each `sin` ≤ 1), so `cloud ≤ base + gain·(Σamp / normDivisor)`; the tiny
 *  epsilon absorbs float-summation round-up. Used ONLY to SKIP evaluating the three
 *  `sin` octaves for cells that provably cannot clear their threshold even under a
 *  maximal cloud — the paint decision for every non-skipped cell is the untouched
 *  verbatim formula, so the painted set is bit-identical (the IFF test pins this). */
const CLOUD_MAX =
  CLOUD_CONTRAST_BASE +
  CLOUD_CONTRAST_GAIN *
    (CLOUD_OCTAVES.reduce((sum, octave) => sum + octave.amp, 0) / CLOUD_NORM_DIVISOR) +
  1e-6

/**
 * Paint the density grid as crisp fog quads. For each cell: coverage
 * `cov = (pd / COVERAGE_DIVISOR) · cloud(centre) · effectiveDensity`; fill a SOLID
 * `CELL_PX` quad at the fog colour + fixed alpha IFF `cov > thresholdAt(gx, gy)`. Cells
 * with `pd <= 0` (FogSim's box-clear zeroes them under labels) are skipped, so fog never
 * covers a label. The alpha is set ONCE — every painted quad is identical (crisp), never
 * a per-cell gradient — and restored to 1 so the next canvas layer starts clean.
 *
 * Two decision-identical fast paths (MYT-89 framerate fix):
 * - `effectiveDensity ≤ 0` (the fade has run the fog to nothing — the whole post-gen
 *   tail): `cov` is 0 for every cell and no non-negative threshold can be cleared, so
 *   the grid walk is skipped entirely and the ctx is left untouched;
 * - per cell, when even a MAXIMAL cloud could not clear the threshold
 *   (`covBound ≤ thr`, see `CLOUD_MAX`), the three-octave `cloud()` eval is skipped —
 *   the dominant paint-side JS cost on faint fog. Neither path can change which cells
 *   paint; `cov`'s own expression (and float-op order) is untouched.
 */
export function paintFog(
  ctx: FogPaintTarget,
  density: Float32Array,
  gw: number,
  gh: number,
  opts: PaintFogOptions,
): void {
  if (opts.effectiveDensity <= 0) return
  ctx.fillStyle = opts.fogColor
  ctx.globalAlpha = opts.fogAlpha
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const pd = density[gy * gw + gx] ?? 0
      if (pd <= 0) continue
      const thr = thresholdAt(gx, gy)
      const pdNorm = pd / COVERAGE_DIVISOR
      // Bound-skip: float multiplication is monotone in each non-negative operand and
      // this bound has the same association shape as `cov` below, so
      // `cov ≤ covBound` always — a skipped cell could never have painted.
      const covBound = pdNorm * CLOUD_MAX * opts.effectiveDensity
      if (covBound <= thr) continue
      const px = gx * CELL_PX + CELL_CENTER_PX
      const py = gy * CELL_PX + CELL_CENTER_PX
      const cov = pdNorm * cloud(px, py, opts.wx, opts.wy, opts.t) * opts.effectiveDensity
      if (cov > thr) ctx.fillRect(gx * CELL_PX, gy * CELL_PX, CELL_PX, CELL_PX)
    }
  }
  ctx.globalAlpha = 1
}
