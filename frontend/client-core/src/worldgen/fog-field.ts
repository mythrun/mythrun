// The world-gen fog's PURE flow field (MYT-89 C2, split from fog-sim.ts to keep both
// modules under the size rail). Everything here is STATELESS math ported VERBATIM from
// the fog-reference prototype (docs/superpowers/specs/assets/2026-07-05-worldgen-fog-
// reference.html): the capsule distance/normal, the turbulence curl, the doublet
// potential-flow field with its wake-close/wake-drag gates, and the small grid/spawn
// predicates. `fog-sim.ts` owns the state + the sub-step pipeline and re-exports these
// names, so consumers (and the existing unit tests) keep importing from fog-sim.

import {
  DOUBLET_RADIUS_PX,
  DOUBLET_VP_COEFF,
  FOG_PARAMS,
  SPAWN_BOUND_PX,
  SPLAT_KERNEL,
  TURBULENCE,
  WAKE_CLOSE,
  WAKE_DRAG,
} from './fog-params.ts'

/** One doublet (dipole) point along a label capsule, carrying the label's motion
 *  (`vx`/`vy`) for the wake-drag term. Exported for direct field unit tests. */
export interface Doublet {
  x: number
  y: number
  vx: number
  vy: number
}

/** The slider-scaled wind, precomputed once: raw vector, magnitude `U`, and the
 *  unit vector (`wxu`/`wyu`) the doublet field rotates into/out of. */
export interface Wind {
  wx: number
  wy: number
  U: number
  wxu: number
  wyu: number
}

const CLOSE = FOG_PARAMS.close
const RD = DOUBLET_RADIUS_PX
const RD2 = RD * RD

/** Doublet bucket size (px) = spatial cutoff. At 12·RD the far-field a particle
 *  ignores contributes ≲1% of |wind| (doublet ~U/12² and the wake-close, at the
 *  LOCKED close=0.1, is exp(-2)-small), so bucketing is fidelity-preserving. */
export const BUCKET_SIZE = 12 * RD
/** The cutoff squared — `fieldVelocity` culls candidates isotropically at exactly
 *  the 12·RD radius the bucket grid encodes. The 3×3 bucket window GUARANTEES every
 *  doublet within the cutoff is a candidate, but (being a coarse window) also admits
 *  extras up to ~3× the cutoff away depending on grid alignment; evaluating those
 *  was pure cost inside the same ≲1% far-field bound the bucketing already accepts
 *  (and grid-alignment-dependent — the cull is MORE uniform than the window it
 *  replaces). MYT-89 framerate fix: at real-world obstacle counts this cuts the
 *  per-particle candidate set ~2–3×. */
const DOUBLET_CUTOFF2 = BUCKET_SIZE * BUCKET_SIZE

// Precomputed wake/drag gate terms (loop-invariant products of LOCKED constants —
// hoisted out of the per-candidate hot path; bit-identical arithmetic).
const WAKE_GATE_A = WAKE_CLOSE.gateRdMul * RD
const WAKE_DECAY_A = WAKE_CLOSE.decayA_RdMul * RD
const WAKE_DECAY_B = WAKE_CLOSE.decayB_Rd2Mul * RD2
const WAKE_PERP = WAKE_CLOSE.perpRdMul * RD
const DRAG_R2 = WAKE_DRAG.radiusRd2Mul * RD2
const DRAG_FALLOFF = WAKE_DRAG.falloffRdMul * RD

/** Distance from point (px,py) to the segment (ax,ay)-(bx,by), plus the OUTWARD
 *  unit normal — the capsule keep-out direction. Ported VERBATIM, including the
 *  `d>0.001` epsilon guard: a point sitting exactly on the segment gets pushed
 *  straight up (nx=0, ny=-1) rather than dividing by zero. */
export function segd(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): readonly [number, number, number] {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = ax + t * dx
  const cy = ay + t * dy
  const ex = px - cx
  const ey = py - cy
  const d = Math.hypot(ex, ey)
  return [d, d > 0.001 ? ex / d : 0, d > 0.001 ? ey / d : -1]
}

/** Base turbulence perturbation (a small time-animated sinus curl). Ported verbatim
 *  from `turb`. */
function turbulence(px: number, py: number, t: number): readonly [number, number] {
  const a = TURBULENCE.k * px
  const b = TURBULENCE.k * py
  return [
    Math.sin(a + t * TURBULENCE.x.timeFreqA) *
      Math.cos(b * TURBULENCE.x.spatialMulB - t * TURBULENCE.x.timeFreqB) *
      TURBULENCE.amp,
    Math.cos(a * TURBULENCE.y.spatialMulA - t * TURBULENCE.y.timeFreqA) *
      Math.sin(b + t * TURBULENCE.y.timeFreqB) *
      TURBULENCE.amp,
  ]
}

/** The flow velocity at (px,py): uniform wind + turbulence + each nearby doublet's
 *  potential-flow term + gated wake-close + wake-drag. Ported VERBATIM from `field`,
 *  incl. the `up = -c·(a²-b²)` / `vp = -2·c·a·b` expressions (the leading `-1` on
 *  `up`). The reference's `CLOSE>0` guard is dropped — CLOSE is the LOCKED 0.1 > 0,
 *  so the `a > 1.6·RD` downstream gate alone decides the wake-close. `doublets` is
 *  the bucket-filtered candidate set (a superset of those within the cutoff);
 *  candidates past `DOUBLET_CUTOFF2` are culled here, so the evaluated set is
 *  exactly "everything within 12·RD" regardless of bucket-grid alignment. */
export function fieldVelocity(
  px: number,
  py: number,
  t: number,
  doublets: readonly Doublet[],
  wind: Wind,
): readonly [number, number] {
  let vx = wind.wx
  let vy = wind.wy
  const [tx, ty] = turbulence(px, py, t)
  vx += tx
  vy += ty
  for (const d of doublets) {
    const dx = px - d.x
    const dy = py - d.y
    let r2 = dx * dx + dy * dy
    if (r2 > DOUBLET_CUTOFF2) continue // past the 12·RD cutoff (≲1% far-field) — see DOUBLET_CUTOFF2
    if (r2 < RD2) r2 = RD2
    const a = dx * wind.wxu + dy * wind.wyu
    const b = -dx * wind.wyu + dy * wind.wxu
    const c = (wind.U * RD2) / (r2 * r2)
    const up = -c * (a * a - b * b)
    const vp = -DOUBLET_VP_COEFF * c * a * b
    vx += up * wind.wxu - vp * wind.wyu
    vy += up * wind.wyu + vp * wind.wxu
    if (a > WAKE_GATE_A) {
      const g = CLOSE * wind.U * Math.exp(-a / WAKE_DECAY_A) * Math.exp((-b * b) / WAKE_DECAY_B)
      const perp = -(b / WAKE_PERP) * g
      vx += perp * -wind.wyu
      vy += perp * wind.wxu
    }
    if (r2 < DRAG_R2) {
      const w = 1 - Math.sqrt(r2) / DRAG_FALLOFF
      vx += d.vx * w * WAKE_DRAG.coeff
      vy += d.vy * w * WAKE_DRAG.coeff
    }
  }
  return [vx, vy]
}

/** Numeric bucket-key packing: offset absorbs negative (off-band) bucket indices,
 *  the stride keeps the two coordinates disjoint for any real canvas size. */
const BUCKET_KEY_OFFSET = 4096
const BUCKET_KEY_STRIDE = 100000

export function bucketKey(bx: number, by: number): number {
  return (bx + BUCKET_KEY_OFFSET) * BUCKET_KEY_STRIDE + (by + BUCKET_KEY_OFFSET)
}

/** Bucket the doublets into the uniform `BUCKET_SIZE` grid (§3.7 spatial bucketing —
 *  stateless, moved here from fog-sim for the module-size rail). */
export function buildBuckets(doublets: readonly Doublet[]): Map<number, Doublet[]> {
  const m = new Map<number, Doublet[]>()
  for (const d of doublets) {
    const key = bucketKey(Math.floor(d.x / BUCKET_SIZE), Math.floor(d.y / BUCKET_SIZE))
    const bucket = m.get(key)
    if (bucket) bucket.push(d)
    else m.set(key, [d])
  }
  return m
}

/** Collect the doublets in the 3×3 bucket neighbourhood of bucket cell (bx,by) into a
 *  fresh array. Bucket size = cutoff, so the neighbourhood is a superset of every
 *  doublet within the cutoff of ANY point in the cell (`fieldVelocity` then culls at
 *  the exact radius). Runs once per occupied cell per sub-step (see fog-sim's
 *  `advect`). */
export function queryBuckets(buckets: Map<number, Doublet[]>, bx: number, by: number): Doublet[] {
  const out: Doublet[] = []
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const bucket = buckets.get(bucketKey(bx + ox, by + oy))
      if (bucket) for (const d of bucket) out.push(d)
    }
  }
  return out
}

/** True when a particle has drifted past the off-canvas spawn band (any edge). */
export function isOffBand(x: number, y: number, width: number, height: number): boolean {
  return (
    x < -SPAWN_BOUND_PX ||
    x > width + SPAWN_BOUND_PX ||
    y < -SPAWN_BOUND_PX ||
    y > height + SPAWN_BOUND_PX
  )
}

/** True when a grid cell is inside the density grid. */
export function inGrid(gx: number, gy: number, gw: number, gh: number): boolean {
  return gx >= 0 && gy >= 0 && gx < gw && gy < gh
}

/** The 3×3 splat kernel weight for a neighbour offset: centre / edge / corner. */
export function splatWeight(ox: number, oy: number): number {
  if (ox === 0 && oy === 0) return SPLAT_KERNEL.center
  if (ox !== 0 && oy !== 0) return SPLAT_KERNEL.corner
  return SPLAT_KERNEL.edge
}

/** Flux-weighted spawn position on the top OR right edge (the two inflow edges for
 *  the down-and-left wind), just outside the band. Ported verbatim from `spawn`;
 *  the split ratio uses the BASE wind, which is scale-independent. */
export function pickSpawn(
  random: () => number,
  width: number,
  height: number,
  topW: number,
  rightW: number,
): readonly [number, number] {
  if (random() * (topW + rightW) < topW) return [random() * width, -SPAWN_BOUND_PX]
  return [width + SPAWN_BOUND_PX, random() * height]
}
