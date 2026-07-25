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
// helper renders it: the CLOUD mask, the `/COVERAGE_DIVISOR` coverage, the base-density
// multiply, and the LOCKED ordered-Bayer threshold that turns coverage into CRISP fog
// quads. None of this lives in FogSim (the C2/C3 split); the algorithm is ported
// VERBATIM from the reference `<script>` (its numbers live in `fog-params.ts`).
//
// The paint does NOT fade (MYT-89 spawn-drain redesign): the old stage-derived
// `effectiveDensity` fade is gone — the fog CLEARS upstream, in the sim, by spawning
// fewer particles as entities arrive (FogSim's `spawnScale`). The draw just paints
// whatever density remains at the constant base thickness, so a thinning field reads
// as fog BLOWING OFF the pane, never as a dimming layer.
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
  /** The BASE fog density (the reference `density` slider / `FOG_PARAMS.density`) —
   *  a constant paint thickness. The clear is NOT here (no fade multiply): the sim
   *  drains the particle field itself (spawn-scale), and this paints what remains. */
  density: number
  /** The fog fill colour (`FOG_PARAMS.fogColor`). */
  fogColor: string
  /** The fixed fog quad alpha (`FOG_PARAMS.fogAlpha`) — the SAME for every cell. */
  fogAlpha: number
  /** The world's STATIC LAND coverage at a cell centre, in virtual px (ux-run3 —
   *  `terrain-field.ts`'s `terrainLandAt`). Where the fog is WEATHER (advected,
   *  draining), this is GROUND: a seeded landmass whose coverage is combined with the
   *  fog's by `max`, so land keeps its cells after the fog has blown off and the field
   *  reads as a coastline instead of a diagonal spray. Under a label the box-clear
   *  still wins (`clearedAt`) — the paper knockout is the same on land as at sea.
   *  Omitted → the pre-run3 weather-only field, unchanged to the cell. */
  land?: ((px: number, py: number) => number) | undefined
  /** TRUE inside a label's clear box, in virtual px — the knockout the fog gets for
   *  free from FogSim's box-cleared density (`pd <= 0`) but LAND does not, since land
   *  is painted from a static field the sim never sees. Only consulted for cells land
   *  alone would fill. Omitted (or no `land`) → no knockout. */
  clearedAt?: ((px: number, py: number) => boolean) | undefined
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
 * `cov = (pd / COVERAGE_DIVISOR) · cloud(centre) · density`; fill a SOLID `CELL_PX`
 * quad at the fog colour + fixed alpha IFF `cov > thresholdAt(gx, gy)`. Cells with
 * `pd <= 0` (FogSim's box-clear zeroes them under labels; a DRAINED sim zeroes the
 * whole grid, so the fully-cleared steady state walks the grid in pure skips) are
 * skipped, so fog never covers a label. The alpha is set ONCE — every painted quad is
 * identical (crisp), never a per-cell gradient — and restored to 1 so the next canvas
 * layer starts clean.
 *
 * Two decision-identical fast paths (MYT-89 framerate fix):
 * - `density ≤ 0` (a zeroed base thickness): `cov` is 0 for every cell and no
 *   non-negative threshold can be cleared, so the grid walk is skipped entirely and
 *   the ctx is left untouched;
 * - per cell, when even a MAXIMAL cloud could not clear the threshold
 *   (`covBound ≤ thr`, see `CLOUD_MAX`), the three-octave `cloud()` eval is skipped —
 *   the dominant paint-side JS cost on faint fog. Neither path can change which cells
 *   paint; `cov`'s own expression (and float-op order) is untouched.
 *
 * With `opts.land` (ux-run3) a SECOND, static coverage joins the decision: the world's
 * own landmass (`terrain-field.ts`), combined by `cov > thr || landCov > thr`. Land
 * outlives the weather — a drained sim zeroes `pd` but the ground stays — so the
 * `pd ≤ 0` skip becomes a land-only test rather than a `continue`, and the label
 * knockout land needs (`clearedAt`) is consulted only for cells the fog itself did not
 * already fill. Both fast paths above are preserved verbatim when `land` is absent.
 */
export function paintFog(
  ctx: FogPaintTarget,
  density: Float32Array,
  gw: number,
  gh: number,
  opts: PaintFogOptions,
): void {
  const land = opts.land
  // With no land the weather is the whole field, so a zeroed base thickness paints
  // nothing — the verbatim pre-run3 bail. Land does NOT scale with fog thickness, so
  // with a land field the grid still has ground to draw.
  if (opts.density <= 0 && land === undefined) return
  ctx.fillStyle = opts.fogColor
  ctx.globalAlpha = opts.fogAlpha
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const pd = density[gy * gw + gx] ?? 0
      if (pd <= 0 && land === undefined) continue
      const thr = thresholdAt(gx, gy)
      const px = gx * CELL_PX + CELL_CENTER_PX
      const py = gy * CELL_PX + CELL_CENTER_PX
      if (fogFills(pd, thr, px, py, opts) || landFills(land, thr, px, py, opts)) {
        ctx.fillRect(gx * CELL_PX, gy * CELL_PX, CELL_PX, CELL_PX)
      }
    }
  }
  ctx.globalAlpha = 1
}

/** Does the WEATHER fill this cell? The verbatim pre-run3 decision (coverage, cloud
 *  mask, base density, Bayer threshold) plus its bound-skip, extracted so the land
 *  branch can sit beside it without disturbing the float-op order. */
function fogFills(pd: number, thr: number, px: number, py: number, opts: PaintFogOptions): boolean {
  if (pd <= 0 || opts.density <= 0) return false
  const pdNorm = pd / COVERAGE_DIVISOR
  // Bound-skip: float multiplication is monotone in each non-negative operand and this
  // bound has the same association shape as `cov` below, so `cov ≤ covBound` always —
  // a skipped cell could never have painted.
  if (pdNorm * CLOUD_MAX * opts.density <= thr) return false
  return pdNorm * cloud(px, py, opts.wx, opts.wy, opts.t) * opts.density > thr
}

/** Does the LAND fill this cell (ux-run3)? The static field's coverage against the same
 *  Bayer threshold — so ground and weather are drawn in one material — knocked out
 *  under a label box, which the fog gets for free from the sim's box-clear. */
function landFills(
  land: ((px: number, py: number) => number) | undefined,
  thr: number,
  px: number,
  py: number,
  opts: PaintFogOptions,
): boolean {
  if (land === undefined || land(px, py) <= thr) return false
  return opts.clearedAt?.(px, py) !== true
}
