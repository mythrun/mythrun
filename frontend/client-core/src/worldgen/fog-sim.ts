// FogSim — the DOM-free fluid core of the world-gen fog (MYT-89 Phase C, Task C2).
//
// A pure-numerics port of the "fog + entities" prototype's particle physics
// (docs/superpowers/specs/assets/2026-07-05-worldgen-fog-reference.html). The
// reference `<script>` is the ALGORITHM authority; every tuned constant lives in
// `fog-params.ts` (C1). This module owns ONLY the fluid brain: particle advection
// through a potential-flow field + the density grid (splat → temporal low-pass →
// box-clear under labels). `density()` returns the raw smoothed, box-cleared
// particle-density grid (`dsm` in the reference). The CLOUD mask, the Bayer dither
// threshold, the `/0.30` coverage divisor and all Canvas drawing are C3's draw
// helper — NONE of that lives here.
//
// Four things make this a production port rather than a 1:1 of the toy:
//   1. FIXED-TIMESTEP (§3.2): the prototype advanced once per rAF frame, so its
//      speed rode the display's refresh rate. Here `step(dtMs, …)` accumulates
//      real time and advances in fixed FIXED_DT_MS increments — `step(32)` does
//      the same work as two `step(16)`, and 120Hz looks identical to 60Hz.
//   2. AREA-SCALED N (§3.6): particle count scales with canvas area so density is
//      constant across sizes (the prototype hard-coded N at the 900×470 virtual
//      space).
//   3. DOUBLET SPATIAL-BUCKETING (§3.7): the doublet field decays ~1/r⁴, so a
//      particle only feels the handful of doublets within a few RD. We bucket the
//      doublets into a uniform grid and evaluate only the local neighbourhood —
//      fidelity-preserving, and a real speedup as the canvas (and doublet count)
//      grows.
//   4. FADE-SKIP (§3.7): when the caller's `effectiveDensity` is ~0 (the fade has
//      run the fog to nothing as the graph fills) the whole `step()` is skipped —
//      no advection, the grid is left as-is. `effectiveDensity` is used for that
//      perf skip ONLY; the fade math itself is a render concern (C3).
//
// The RNG is injectable (`opts.random`, default `Math.random`) so tests are
// deterministic. `Math.random` is fine in the client-core runtime — this is UI
// jitter, not game mechanics (the ZFC/no-random rule governs dice, not fog).

import {
  CELL_PX,
  DOUBLET_MIN_POINTS,
  DOUBLET_RADIUS_PX,
  DOUBLET_SPACING_PX,
  DOUBLET_VP_COEFF,
  FOG_PARAMS,
  FORCEFIELD_BASE_PX,
  LABEL_CLEAR_PAD,
  PARTICLE_COUNT,
  PARTICLE_STRIDE,
  SPAWN_BOUND_PX,
  SPLAT_KERNEL,
  TURBULENCE,
  VIRTUAL_HEIGHT,
  VIRTUAL_WIDTH,
  WAKE_CLOSE,
  WAKE_DRAG,
  WIND_BASE,
} from './fog-params.ts'

// ──────────────────────────────────────────────────────────────────────────
// Public surface
// ──────────────────────────────────────────────────────────────────────────

/** A label "capsule" the fog streams around — the box (marker + text) a node
 *  occupies, in the 900×470 virtual coordinate space. The shell (C3) measures a
 *  rendered label into this box; the doublet line + hard exclusion run along the
 *  box's horizontal midline, and the density is force-cleared under the whole box.
 *  `vx`/`vy` are the box's per-step motion (bob / drag) — a moving label drags its
 *  wake with it (WAKE_DRAG). */
export interface FogObstacle {
  x: number
  y: number
  w: number
  h: number
  vx: number
  vy: number
}

export interface FogSim {
  /** Advance the fog by `dtMs` of real time against the current `obstacles`.
   *  `effectiveDensity` gates the perf fade-skip only (≈0 → no work this call). */
  step(dtMs: number, obstacles: readonly FogObstacle[], effectiveDensity: number): void
  /** The live GW×GH smoothed, box-cleared particle-density grid (`dsm`). Returned
   *  by reference for zero-alloc reads — treat it as read-only; it is overwritten
   *  in place each `step()`. */
  density(): Float32Array
  readonly gw: number
  readonly gh: number
}

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

// ──────────────────────────────────────────────────────────────────────────
// Derived module constants (from the LOCKED fog params — everything the C2
// `step()` signature does NOT surface as a runtime input is fixed here).
// ──────────────────────────────────────────────────────────────────────────

const SPEED = FOG_PARAMS.wind
const CLOSE = FOG_PARAMS.close
const STEADY = FOG_PARAMS.steady
const RD = DOUBLET_RADIUS_PX
const RD2 = RD * RD
/** ref: `EXR=12+MARGIN`. Hard keep-out radius around a capsule. */
const EXR = FORCEFIELD_BASE_PX + FOG_PARAMS.margin

/** Fixed simulation sub-step (ms). The prototype's per-rAF-frame advance ≈ 60Hz,
 *  so one sub-step reproduces exactly one reference frame; the accumulator makes
 *  the sim frame-rate-independent. */
const FIXED_DT_MS = 1000 / 60
const FIXED_DT_S = FIXED_DT_MS / 1000
/** Cap on sub-steps per `step()` — a long stall (backgrounded tab) drops the
 *  backlog rather than spiralling into an unbounded catch-up loop. */
const MAX_STEPS_PER_FRAME = 5
/** Below this `effectiveDensity` the fog is effectively gone → skip the step. */
const FADE_EPS = 1e-6

/** Doublet bucket size (px) = spatial cutoff. At 12·RD the far-field a particle
 *  ignores contributes ≲1% of |wind| (doublet ~U/12² and the wake-close, at the
 *  LOCKED close=0.1, is exp(-2)-small), so bucketing is fidelity-preserving. */
const BUCKET_SIZE = 12 * RD
/** Numeric bucket-key packing: offset absorbs negative (off-band) bucket indices,
 *  the stride keeps the two coordinates disjoint for any real canvas size. */
const BUCKET_KEY_OFFSET = 4096
const BUCKET_KEY_STRIDE = 100000

// ──────────────────────────────────────────────────────────────────────────
// Pure field helpers (no state) — exported for direct unit tests of the exact
// epsilon/gate branches the integration path can only reach probabilistically.
// ──────────────────────────────────────────────────────────────────────────

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
 *  the bucket-filtered candidate set (a superset of those within the cutoff). */
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
    if (r2 < RD2) r2 = RD2
    const a = dx * wind.wxu + dy * wind.wyu
    const b = -dx * wind.wyu + dy * wind.wxu
    const c = (wind.U * RD2) / (r2 * r2)
    const up = -c * (a * a - b * b)
    const vp = -DOUBLET_VP_COEFF * c * a * b
    vx += up * wind.wxu - vp * wind.wyu
    vy += up * wind.wyu + vp * wind.wxu
    if (a > WAKE_CLOSE.gateRdMul * RD) {
      const g =
        CLOSE *
        wind.U *
        Math.exp(-a / (WAKE_CLOSE.decayA_RdMul * RD)) *
        Math.exp((-b * b) / (WAKE_CLOSE.decayB_Rd2Mul * RD2))
      const perp = -(b / (WAKE_CLOSE.perpRdMul * RD)) * g
      vx += perp * -wind.wyu
      vy += perp * wind.wxu
    }
    if (r2 < WAKE_DRAG.radiusRd2Mul * RD2) {
      const w = 1 - Math.sqrt(r2) / (WAKE_DRAG.falloffRdMul * RD)
      vx += d.vx * w * WAKE_DRAG.coeff
      vy += d.vy * w * WAKE_DRAG.coeff
    }
  }
  return [vx, vy]
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

function bucketKey(bx: number, by: number): number {
  return (bx + BUCKET_KEY_OFFSET) * BUCKET_KEY_STRIDE + (by + BUCKET_KEY_OFFSET)
}

/** Read a Float32Array element as a plain `number`. Under `noUncheckedIndexedAccess`
 *  every element read widens to `number | undefined`, but every index here is
 *  in-bounds by construction (particle slots, grid cells). `Number()` collapses the
 *  widening with no runtime branch — a `?? 0` / `|| 0` fallback that can never run
 *  would sink the package's 100% branch-coverage gate, and an `as number` / `!`
 *  assertion is barred (the repo bans non-null assertions). */
function cell(a: Float32Array, i: number): number {
  return Number(a[i])
}

// ──────────────────────────────────────────────────────────────────────────
// Simulation state + the sub-step pipeline
// ──────────────────────────────────────────────────────────────────────────

interface FogState {
  width: number
  height: number
  gw: number
  gh: number
  n: number
  /** Particles as `[x, y, vx, vy]` (stride 4, per the reference layout); vx/vy are
   *  unused — the velocity is recomputed from the field each sub-step. */
  P: Float32Array
  dens: Float32Array
  dsm: Float32Array
  wind: Wind
  topW: number
  rightW: number
  random: () => number
  clock: number
  acc: number
}

function computeWind(): Wind {
  const wx = WIND_BASE[0] * SPEED
  const wy = WIND_BASE[1] * SPEED
  const U = Math.hypot(wx, wy)
  return { wx, wy, U, wxu: wx / U, wyu: wy / U }
}

/** Warm-start: seed particles across the WHOLE field (not just the inflow edges) so
 *  the first frame is already full of fog. Ported from `reset()`. */
function warmStart(s: FogState): void {
  for (let i = 0; i < s.n; i++) {
    s.P[i * PARTICLE_STRIDE] = s.random() * s.width
    s.P[i * PARTICLE_STRIDE + 1] = s.random() * s.height
  }
}

function spawn(s: FogState, i: number): void {
  const [x, y] = pickSpawn(s.random, s.width, s.height, s.topW, s.rightW)
  s.P[i * PARTICLE_STRIDE] = x
  s.P[i * PARTICLE_STRIDE + 1] = y
}

function createState(opts: { width: number; height: number; random?: () => number }): FogState {
  const { width, height } = opts
  const gw = Math.ceil(width / CELL_PX)
  const gh = Math.ceil(height / CELL_PX)
  const n = Math.max(
    0,
    Math.round(PARTICLE_COUNT * ((width * height) / (VIRTUAL_WIDTH * VIRTUAL_HEIGHT))),
  )
  const s: FogState = {
    width,
    height,
    gw,
    gh,
    n,
    P: new Float32Array(n * PARTICLE_STRIDE),
    dens: new Float32Array(gw * gh),
    dsm: new Float32Array(gw * gh),
    wind: computeWind(),
    topW: Math.abs(WIND_BASE[1]) * width,
    rightW: Math.abs(WIND_BASE[0]) * height,
    random: opts.random ?? Math.random,
    clock: 0,
    acc: 0,
  }
  warmStart(s)
  return s
}

/** Build the doublet line for each obstacle along the box's horizontal midline
 *  (K points spaced ~every DOUBLET_SPACING_PX, min DOUBLET_MIN_POINTS). Ported from
 *  `buildDub`; the reference's `K>1?…:0` guard is vacuous here (K≥2 always). */
function buildDoublets(obstacles: readonly FogObstacle[]): Doublet[] {
  const out: Doublet[] = []
  for (const ob of obstacles) {
    const ax = ob.x
    const ay = ob.y + ob.h / 2
    const bx = ob.x + ob.w
    const by = ob.y + ob.h / 2
    const len = Math.hypot(bx - ax, by - ay)
    const k = Math.max(DOUBLET_MIN_POINTS, Math.round(len / DOUBLET_SPACING_PX))
    for (let j = 0; j < k; j++) {
      const tt = j / (k - 1)
      out.push({ x: ax + (bx - ax) * tt, y: ay + (by - ay) * tt, vx: ob.vx, vy: ob.vy })
    }
  }
  return out
}

function buildBuckets(doublets: readonly Doublet[]): Map<number, Doublet[]> {
  const m = new Map<number, Doublet[]>()
  for (const d of doublets) {
    const key = bucketKey(Math.floor(d.x / BUCKET_SIZE), Math.floor(d.y / BUCKET_SIZE))
    const bucket = m.get(key)
    if (bucket) bucket.push(d)
    else m.set(key, [d])
  }
  return m
}

/** Collect the doublets in the 3×3 bucket neighbourhood of (x,y) into `out` (reused
 *  scratch). Bucket size = cutoff, so the neighbourhood is a superset of every
 *  doublet within the cutoff and skips only strictly-farther ones. */
function queryBuckets(buckets: Map<number, Doublet[]>, out: Doublet[], x: number, y: number): void {
  out.length = 0
  const bx = Math.floor(x / BUCKET_SIZE)
  const by = Math.floor(y / BUCKET_SIZE)
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const bucket = buckets.get(bucketKey(bx + ox, by + oy))
      if (bucket) for (const d of bucket) out.push(d)
    }
  }
}

/** Advect every particle one sub-step: field velocity → move → project out of each
 *  capsule (EXR keep-out) → respawn if off-band. */
function advect(
  s: FogState,
  obstacles: readonly FogObstacle[],
  buckets: Map<number, Doublet[]>,
  scratch: Doublet[],
): void {
  const { P } = s
  for (let i = 0; i < s.n; i++) {
    const base = i * PARTICLE_STRIDE
    let X = cell(P, base)
    let Y = cell(P, base + 1)
    queryBuckets(buckets, scratch, X, Y)
    const [vx, vy] = fieldVelocity(X, Y, s.clock, scratch, s.wind)
    X += vx
    Y += vy
    for (const ob of obstacles) {
      const [d, nx, ny] = segd(X, Y, ob.x, ob.y + ob.h / 2, ob.x + ob.w, ob.y + ob.h / 2)
      if (d < EXR) {
        X += nx * (EXR - d)
        Y += ny * (EXR - d)
      }
    }
    if (isOffBand(X, Y, s.width, s.height)) {
      spawn(s, i)
    } else {
      P[base] = X
      P[base + 1] = Y
    }
  }
}

/** Splat every particle into `dens` with the 3×3 kernel (a fresh density field). */
function splat(s: FogState): void {
  const { P, dens, gw, gh } = s
  dens.fill(0)
  for (let i = 0; i < s.n; i++) {
    const cx = Math.trunc(cell(P, i * PARTICLE_STRIDE) / CELL_PX)
    const cy = Math.trunc(cell(P, i * PARTICLE_STRIDE + 1) / CELL_PX)
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const gx = cx + ox
        const gy = cy + oy
        if (!inGrid(gx, gy, gw, gh)) continue
        const idx = gy * gw + gx
        dens[idx] = cell(dens, idx) + splatWeight(ox, oy)
      }
    }
  }
}

/** Temporal low-pass toward the fresh density (steady-state smoothing). */
function smooth(s: FogState): void {
  const { dens, dsm } = s
  for (let k = 0; k < dsm.length; k++) {
    const cur = cell(dsm, k)
    dsm[k] = cur + (cell(dens, k) - cur) * STEADY
  }
}

/** Force the smoothed density to 0 under each label box (padded for the bob), so
 *  fog never covers a label. Ported from the box-clear loop. */
function boxClear(s: FogState, obstacles: readonly FogObstacle[]): void {
  const { dsm, gw, gh } = s
  for (const ob of obstacles) {
    const gx0 = Math.max(0, Math.trunc((ob.x - LABEL_CLEAR_PAD.x) / CELL_PX))
    const gx1 = Math.min(gw - 1, Math.trunc((ob.x + ob.w + LABEL_CLEAR_PAD.x) / CELL_PX))
    const gy0 = Math.max(0, Math.trunc(ob.y / CELL_PX))
    const gy1 = Math.min(gh - 1, Math.trunc((ob.y + ob.h) / CELL_PX))
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) dsm[gy * gw + gx] = 0
    }
  }
}

function subStep(s: FogState, obstacles: readonly FogObstacle[], scratch: Doublet[]): void {
  const doublets = buildDoublets(obstacles)
  const buckets = buildBuckets(doublets)
  advect(s, obstacles, buckets, scratch)
  splat(s)
  smooth(s)
  boxClear(s, obstacles)
  s.clock += FIXED_DT_S
}

// ──────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────

export function createFogSim(opts: {
  width: number
  height: number
  random?: () => number
}): FogSim {
  const s = createState(opts)
  // One scratch buffer reused across every particle/sub-step (allocation-free).
  const scratch: Doublet[] = []
  return {
    step(dtMs: number, obstacles: readonly FogObstacle[], effectiveDensity: number): void {
      if (effectiveDensity <= FADE_EPS) {
        s.acc = 0
        return
      }
      s.acc += dtMs
      let steps = 0
      while (s.acc >= FIXED_DT_MS && steps < MAX_STEPS_PER_FRAME) {
        subStep(s, obstacles, scratch)
        s.acc -= FIXED_DT_MS
        steps += 1
      }
      // Backlog past the cap (a long stall) is dropped to avoid a catch-up spiral.
      if (s.acc >= FIXED_DT_MS) s.acc = 0
    },
    density: () => s.dsm,
    gw: s.gw,
    gh: s.gh,
  }
}
