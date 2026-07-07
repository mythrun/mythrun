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
//      doublets into a uniform grid, evaluate only the local neighbourhood, and
//      cull isotropically at the SAME 12·RD cutoff the bucket grid encodes —
//      fidelity-preserving (far-field ≲1% of |wind|, see BUCKET_SIZE), and a real
//      speedup as the canvas (and doublet count) grows. The candidate query runs
//      once per occupied bucket CELL, not once per particle (every particle in a
//      cell sees the identical 3×3 neighbourhood), and the hard capsule keep-out
//      pre-rejects on the capsule's EXR-padded AABB before paying for a distance
//      (MYT-89 framerate fix — advection dominated the profile at real-world
//      obstacle counts; all three changes leave the per-particle math untouched).
//   4. SPAWN-SCALE DRAIN (MYT-89 fog clear redesign): the fog CLEARS by spawning
//      fewer particles, never by dimming the paint. `step(dt, obstacles, spawnScale)`
//      takes a [0, 1] scale on the RESPAWN population target (`round(N·spawnScale)`):
//      a particle that drifts off-band respawns only while the alive population is
//      at/under the target and RETIRES otherwise, so lowering the scale drains the
//      field through the wind — at 0 nothing respawns and the wind carries the last
//      of the fog off the edge. Retired particles cost nothing (advection + splat
//      skip them), and once the field is fully drained (no particles, residual
//      density decayed below visibility) the sim goes DORMANT: the whole `step()` is
//      a no-op until the scale rises. The tuned physics are untouched — the scale
//      gates WHO respawns, never how anything moves or paints.
//
// The RNG is injectable (`opts.random`, default `Math.random`) so tests are
// deterministic. `Math.random` is fine in the client-core runtime — this is UI
// jitter, not game mechanics (the ZFC/no-random rule governs dice, not fog).

import {
  CELL_PX,
  DOUBLET_MIN_POINTS,
  DOUBLET_SPACING_PX,
  FOG_PARAMS,
  FORCEFIELD_BASE_PX,
  LABEL_CLEAR_PAD,
  PARTICLE_COUNT,
  PARTICLE_STRIDE,
  VIRTUAL_HEIGHT,
  VIRTUAL_WIDTH,
  WIND_BASE,
} from './fog-params.ts'
import {
  BUCKET_SIZE,
  fieldVelocity,
  isOffBand,
  inGrid,
  pickSpawn,
  segd,
  splatWeight,
  type Doublet,
  type Wind,
} from './fog-field.ts'

// The pure flow-field math lives in fog-field.ts (stateless, split for the module-size
// rail); re-exported here so consumers + the unit tests keep one import surface.
export { fieldVelocity, isOffBand, inGrid, pickSpawn, segd, splatWeight } from './fog-field.ts'
export type { Doublet, Wind } from './fog-field.ts'

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
   *  `spawnScale` ∈ [0, 1] scales the RESPAWN population target (`round(N·spawnScale)`,
   *  the §4 drain): the warm-start population is untouched; a particle that drifts
   *  off-band respawns only while the alive population is at/under the target and
   *  retires otherwise. At 0 nothing respawns — the wind drains the field empty, then
   *  the sim goes dormant (a no-op step) until the scale rises again. */
  step(dtMs: number, obstacles: readonly FogObstacle[], spawnScale: number): void
  /** Snap the alive population to `round(N·spawnScale)` NOW — the REDUCED-MOTION
   *  enforcement (a static settle has no wind-time to drain/refill through). Excess
   *  slots retire from the top index down (survivors keep their warm-start-uniform
   *  spread); deficits revive FIELD-WIDE (warm-start placement — an edge spawn would
   *  leave a static sample mostly empty). At target 0 the density grids are zeroed
   *  too: the converged steady state of an empty population IS the empty field, and
   *  a static sample wants that state immediately (no residual low-pass ghost). The
   *  motion loop never calls this — it drains/refills through the respawn gate. */
  settlePopulation(spawnScale: number): void
  /** Re-derive the sim for a new virtual size (the RESPONSIVE pane resize, MYT-89):
   *  grid dims + area-scaled particle count are recomputed, surviving particles keep
   *  flowing (grown slots warm-start across the new field; out-of-bound ones respawn
   *  naturally via the off-band check), and the overlapping region of the smoothed
   *  density is PRESERVED so a resize never flashes the fog to nothing. No-op when
   *  the dims are unchanged. */
  setSize(width: number, height: number): void
  /** The live GW×GH smoothed, box-cleared particle-density grid (`dsm`). Returned
   *  by reference for zero-alloc reads — treat it as read-only; it is overwritten
   *  in place each `step()`. */
  density(): Float32Array
  readonly gw: number
  readonly gh: number
}

// ──────────────────────────────────────────────────────────────────────────
// Derived module constants (from the LOCKED fog params — everything the C2
// `step()` signature does NOT surface as a runtime input is fixed here).
// ──────────────────────────────────────────────────────────────────────────

const SPEED = FOG_PARAMS.wind
const STEADY = FOG_PARAMS.steady
/** ref: `EXR=12+MARGIN`. Hard keep-out radius around a capsule. */
const EXR = FORCEFIELD_BASE_PX + FOG_PARAMS.margin

/** Fixed simulation sub-step (ms). The prototype's per-rAF-frame advance ≈ 60Hz,
 *  so one sub-step reproduces exactly one reference frame; the accumulator makes
 *  the sim frame-rate-independent. */
const FIXED_DT_MS = 1000 / 60
const FIXED_DT_S = FIXED_DT_MS / 1000
/** Cap on sub-steps per `step()` — a stall drops the backlog rather than spiralling
 *  into a catch-up loop. The cap is deliberately LOW (2, not the former 5): catch-up
 *  sub-steps multiply per-frame cost exactly when the machine is already over budget,
 *  which is an amplifier, not a recovery — a profiled 4×-throttled retina pane fell to
 *  ~10 FPS at 11 obstacles because every frame ground through 5 sub-steps (MYT-89
 *  framerate fix). At 2 the sim holds real-time pacing whenever the frame rate is
 *  ≥ ~30 FPS and time-dilates gracefully below that; healthy 60/120Hz frames run
 *  1 sub-step (or none) and never feel the cap. This is a production-port resilience
 *  knob, not a reference-tuned constant (the prototype had no fixed timestep). */
const MAX_STEPS_PER_FRAME = 2
/** Drain-complete ceiling on the smoothed density: once the population is empty and
 *  every `dsm` cell is at/under this, the residual is invisible — the worst-case cell
 *  coverage is `(DRAIN_EPS / COVERAGE_DIVISOR) · cloudMax · density ≈ 0.003`, under
 *  every real dither threshold — so the grid is zeroed ONCE (exact zeros are what the
 *  paint's `pd <= 0` skip and the dormant fast-path key off; the low-pass alone only
 *  decays asymptotically) and the sim goes dormant. */
const DRAIN_EPS = 5e-4

/** Numeric bucket-key packing: offset absorbs negative (off-band) bucket indices,
 *  the stride keeps the two coordinates disjoint for any real canvas size. */
const BUCKET_KEY_OFFSET = 4096
const BUCKET_KEY_STRIDE = 100000

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
  /** Per-slot alive flag (1/0) — the §4 spawn-scale drain. A retired (0) slot is
   *  skipped by advection AND the splat, so a drained particle costs nothing. */
  alive: Uint8Array
  /** Count of alive slots — compared against `round(n·spawnScale)` at each despawn. */
  aliveCount: number
  /** Stack of retired slot indices (retire pushes, revive pops) — O(1) slot reuse,
   *  no scan. Invariant: `dead.length === n - aliveCount`. */
  dead: number[]
  /** Max smoothed-density cell after the last `smooth()` — the drain detector. */
  dsmMax: number
  /** Fully drained (no particles, grid zeroed): `step()` is a no-op while the
   *  spawn target stays 0. */
  drained: boolean
}

function computeWind(): Wind {
  const wx = WIND_BASE[0] * SPEED
  const wy = WIND_BASE[1] * SPEED
  const U = Math.hypot(wx, wy)
  return { wx, wy, U, wxu: wx / U, wyu: wy / U }
}

/** Place one slot uniformly across the WHOLE field — the warm-start placement (vs the
 *  inflow-edge `spawn`). Shared by the initial warm start, resize-grown slots, and the
 *  static (reduced-motion) revive. */
function warmStartSlot(s: FogState, i: number): void {
  s.P[i * PARTICLE_STRIDE] = s.random() * s.width
  s.P[i * PARTICLE_STRIDE + 1] = s.random() * s.height
}

/** Warm-start: seed particles across the WHOLE field (not just the inflow edges) so
 *  the first frame is already full of fog. Ported from `reset()`. */
function warmStart(s: FogState): void {
  for (let i = 0; i < s.n; i++) warmStartSlot(s, i)
}

function spawn(s: FogState, i: number): void {
  const [x, y] = pickSpawn(s.random, s.width, s.height, s.topW, s.rightW)
  s.P[i * PARTICLE_STRIDE] = x
  s.P[i * PARTICLE_STRIDE + 1] = y
}

/** Area-scaled particle count for a canvas size (§3.6): density constant across sizes
 *  (the prototype hard-coded N at the 900×470 virtual space). */
function particleCount(width: number, height: number): number {
  return Math.max(
    0,
    Math.round(PARTICLE_COUNT * ((width * height) / (VIRTUAL_WIDTH * VIRTUAL_HEIGHT))),
  )
}

function createState(opts: { width: number; height: number; random?: () => number }): FogState {
  const { width, height } = opts
  const gw = Math.ceil(width / CELL_PX)
  const gh = Math.ceil(height / CELL_PX)
  const n = particleCount(width, height)
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
    alive: new Uint8Array(n).fill(1),
    aliveCount: n,
    dead: [],
    dsmMax: 0,
    drained: false,
  }
  warmStart(s)
  return s
}

// ──────────────────────────────────────────────────────────────────────────
// Spawn-scale drain (§4): the target-population respawn gate.
//
// MECHANISM CHOICE — a deterministic population TARGET, not probability gating:
// on despawn the particle retires iff the alive population exceeds
// `round(n·spawnScale)`, else it respawns exactly as before. Under a seeded RNG
// this is fully deterministic AND exact (the population converges to precisely the
// target, which the tests pin); probability-gated respawn (`random() < spawnScale`)
// would consume an extra RNG draw per exit (perturbing every later spawn position)
// and only converge in expectation. A retire consumes no RNG draw and a respawn
// draws exactly what it always did, so at spawnScale 1 the sim is bit-identical to
// the pre-drain behaviour.
// ──────────────────────────────────────────────────────────────────────────

/** The alive-population target for a spawn scale (clamped to [0, 1]). */
function targetAlive(s: FogState, spawnScale: number): number {
  return Math.round(s.n * Math.min(1, Math.max(0, spawnScale)))
}

function retire(s: FogState, i: number): void {
  s.alive[i] = 0
  s.aliveCount -= 1
  s.dead.push(i)
}

/** Pop the top of the dead-slot stack. In-bounds by construction (callers bound
 *  their pops by `dead.length`); `Number()` collapses the noUncheckedIndexedAccess
 *  widening like `cell()` does — an unreachable `?? 0` branch would sink the
 *  branch-coverage gate and a non-null assertion is barred. */
function popDead(s: FogState): number {
  const i = Number(s.dead[s.dead.length - 1])
  s.dead.pop()
  return i
}

/** Raise the alive population toward `target` by re-arming retired slots, placed by
 *  `place` — `spawn` under motion (new fog BLOWS IN from the wind edges rather than
 *  popping into place) or `warmStartSlot` for the static settle. No-op when the
 *  population is already at/over target. Production only ever LOWERS the scale
 *  during a generation; this is the tuning-slider / re-arm path. */
function reviveTo(s: FogState, target: number, place: (s: FogState, i: number) => void): void {
  const take = Math.min(target - s.aliveCount, s.dead.length)
  for (let k = 0; k < take; k++) {
    const i = popDead(s)
    s.alive[i] = 1
    s.aliveCount += 1
    place(s, i)
  }
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

/** Collect the doublets in the 3×3 bucket neighbourhood of bucket cell (bx,by) into a
 *  fresh array. Bucket size = cutoff, so the neighbourhood is a superset of every
 *  doublet within the cutoff of ANY point in the cell (`fieldVelocity` then culls at
 *  the exact radius). Runs once per occupied cell per sub-step (see `advect`). */
function queryBuckets(buckets: Map<number, Doublet[]>, bx: number, by: number): Doublet[] {
  const out: Doublet[] = []
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const bucket = buckets.get(bucketKey(bx + ox, by + oy))
      if (bucket) for (const d of bucket) out.push(d)
    }
  }
  return out
}

/** Advect every ALIVE particle one sub-step: field velocity → move → project out of
 *  each capsule (EXR keep-out) → despawn if off-band (respawn while the population is
 *  at/under `target`, retire above it — the §4 spawn-scale drain; a retired slot is
 *  skipped entirely, so drained particles cost nothing).
 *
 *  Two structural perf moves (MYT-89 framerate fix), both math-preserving:
 *  - the doublet-candidate query is memoised per bucket CELL: every particle in a
 *    cell sees the identical 3×3 neighbourhood, so the query runs once per occupied
 *    cell (a few dozen) instead of once per particle (thousands) — same arrays, same
 *    order, same field;
 *  - the capsule keep-out pre-rejects on the capsule's EXR-padded AABB: the EXR
 *    stadium around the midline segment lies inside that box, so a particle outside
 *    it has d ≥ EXR and `segd` would be a no-op — skipping it never skips a
 *    projection that would have fired. */
function advect(
  s: FogState,
  obstacles: readonly FogObstacle[],
  buckets: Map<number, Doublet[]>,
  target: number,
): void {
  const { P } = s
  const cellCandidates = new Map<number, Doublet[]>()
  for (let i = 0; i < s.n; i++) {
    if (s.alive[i] === 0) continue
    const base = i * PARTICLE_STRIDE
    let X = cell(P, base)
    let Y = cell(P, base + 1)
    const bx = Math.floor(X / BUCKET_SIZE)
    const by = Math.floor(Y / BUCKET_SIZE)
    const key = bucketKey(bx, by)
    let candidates = cellCandidates.get(key)
    if (candidates === undefined) {
      candidates = queryBuckets(buckets, bx, by)
      cellCandidates.set(key, candidates)
    }
    const [vx, vy] = fieldVelocity(X, Y, s.clock, candidates, s.wind)
    X += vx
    Y += vy
    for (const ob of obstacles) {
      const midY = ob.y + ob.h / 2
      if (X < ob.x - EXR || X > ob.x + ob.w + EXR || Y < midY - EXR || Y > midY + EXR) continue
      const [d, nx, ny] = segd(X, Y, ob.x, midY, ob.x + ob.w, midY)
      if (d < EXR) {
        X += nx * (EXR - d)
        Y += ny * (EXR - d)
      }
    }
    if (isOffBand(X, Y, s.width, s.height)) {
      // The §4 respawn gate: at/under the target the recycle is exactly the
      // reference behaviour; above it the slot retires and nothing replaces it.
      if (s.aliveCount > target) retire(s, i)
      else spawn(s, i)
    } else {
      P[base] = X
      P[base + 1] = Y
    }
  }
}

/** Splat every ALIVE particle into `dens` with the 3×3 kernel (a fresh density field). */
function splat(s: FogState): void {
  const { P, dens, gw, gh } = s
  dens.fill(0)
  for (let i = 0; i < s.n; i++) {
    if (s.alive[i] === 0) continue
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

/** Temporal low-pass toward the fresh density (steady-state smoothing). Tracks the
 *  max smoothed cell as it goes (`dsmMax`, the §4 drain detector — one compare per
 *  cell inside the loop that already touches every cell). */
function smooth(s: FogState): void {
  const { dens, dsm } = s
  let max = 0
  for (let k = 0; k < dsm.length; k++) {
    const cur = cell(dsm, k)
    const next = cur + (cell(dens, k) - cur) * STEADY
    dsm[k] = next
    if (next > max) max = next
  }
  s.dsmMax = max
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

/** Re-derive the state for a new virtual size (the RESPONSIVE pane resize, MYT-89).
 *  Grid dims + area-scaled N recompute exactly as `createState` would; the surviving
 *  particle slots are KEPT (a particle now outside the new bounds respawns naturally
 *  via `isOffBand` on its next advect) and grown slots warm-start across the NEW
 *  field; the overlapping (gx, gy) region of the smoothed density `dsm` is copied
 *  over so a resize never flashes the fog to nothing — the temporal low-pass blends
 *  the new cells in from empty. No-op when the dims are unchanged. */
function resizeState(s: FogState, width: number, height: number): void {
  if (width === s.width && height === s.height) return
  const gw = Math.ceil(width / CELL_PX)
  const gh = Math.ceil(height / CELL_PX)
  const n = particleCount(width, height)
  const P = new Float32Array(n * PARTICLE_STRIDE)
  P.set(s.P.subarray(0, Math.min(n, s.n) * PARTICLE_STRIDE))
  const dsm = new Float32Array(gw * gh)
  const gwMin = Math.min(gw, s.gw)
  const ghMin = Math.min(gh, s.gh)
  for (let gy = 0; gy < ghMin; gy++) {
    for (let gx = 0; gx < gwMin; gx++) dsm[gy * gw + gx] = cell(s.dsm, gy * s.gw + gx)
  }
  const prevN = s.n
  s.width = width
  s.height = height
  s.gw = gw
  s.gh = gh
  s.n = n
  s.P = P
  s.dens = new Float32Array(gw * gh)
  s.dsm = dsm
  s.topW = Math.abs(WIND_BASE[1]) * width
  s.rightW = Math.abs(WIND_BASE[0]) * height
  // Alive flags follow the surviving slots; GROWN slots warm-start alive (a resize
  // that reveals new area gets fog there — if the current spawn target is lower, the
  // excess drains naturally through the §4 gate). Count + dead-stack rebuild below.
  const alive = new Uint8Array(n)
  alive.set(s.alive.subarray(0, Math.min(n, prevN)))
  // Warm-start ONLY the grown slots (survivors keep their positions/flow).
  for (let i = prevN; i < n; i++) {
    alive[i] = 1
    warmStartSlot(s, i)
  }
  s.alive = alive
  s.aliveCount = 0
  s.dead = []
  for (let i = 0; i < n; i++) {
    if (alive[i] === 1) s.aliveCount += 1
    else s.dead.push(i)
  }
  // A drained sim stays dormant only if the resize added no particles (its zeroed
  // density region copies over as zeros, so the grid invariant holds either way).
  s.drained = s.drained && s.aliveCount === 0
}

function subStep(s: FogState, obstacles: readonly FogObstacle[], target: number): void {
  reviveTo(s, target, spawn)
  // With nothing alive there is nothing to advect (and no doublet field to build) —
  // the tail of a drain only needs the splat (all-zero) + low-pass decay + box-clear.
  if (s.aliveCount > 0) {
    const doublets = buildDoublets(obstacles)
    const buckets = buildBuckets(doublets)
    advect(s, obstacles, buckets, target)
  }
  splat(s)
  smooth(s)
  boxClear(s, obstacles)
  s.clock += FIXED_DT_S
}

/** One `FogSim.step` (module-scoped so the factory stays lean): the dormant fast-path,
 *  the fixed-timestep accumulator loop, and the drain-complete transition. */
function stepSim(
  s: FogState,
  dtMs: number,
  obstacles: readonly FogObstacle[],
  spawnScale: number,
): void {
  const target = targetAlive(s, spawnScale)
  // DORMANT: fully drained and nothing to spawn — the whole call is a no-op (the §4
  // "costs ~nothing" steady state; the paint side skips on the zeroed grid).
  if (s.drained && target === 0) {
    s.acc = 0
    return
  }
  s.drained = false
  s.acc += dtMs
  let steps = 0
  while (s.acc >= FIXED_DT_MS && steps < MAX_STEPS_PER_FRAME) {
    subStep(s, obstacles, target)
    s.acc -= FIXED_DT_MS
    steps += 1
  }
  // Exiting AT the cap means overload — drop the ENTIRE remaining backlog
  // (fractional included: float subtraction can leave it a hair under one
  // sub-step, which the old `acc >= FIXED_DT_MS` check leaked into the next
  // frame) to avoid a catch-up spiral. A healthy frame (steps < cap) keeps its
  // sub-step remainder, so normal pacing still accumulates exactly.
  if (steps === MAX_STEPS_PER_FRAME) s.acc = 0
  // DRAIN-COMPLETE: population empty and the residual low-pass has decayed below
  // visibility → zero the grid once (exact zeros for the paint/dormant skips) and
  // go dormant until the spawn target rises.
  if (target === 0 && s.aliveCount === 0 && s.dsmMax <= DRAIN_EPS) {
    s.dsm.fill(0)
    s.dens.fill(0)
    s.dsmMax = 0
    s.drained = true
  }
}

/** `FogSim.settlePopulation` (module-scoped): the reduced-motion population snap —
 *  see the interface doc. */
function snapPopulation(s: FogState, spawnScale: number): void {
  const target = targetAlive(s, spawnScale)
  // Retire from the TOP slot down: the surviving prefix keeps its uniform spread.
  for (let i = s.n - 1; i >= 0 && s.aliveCount > target; i--) {
    if (s.alive[i] === 1) retire(s, i)
  }
  reviveTo(s, target, warmStartSlot)
  if (target === 0) {
    s.dsm.fill(0)
    s.dens.fill(0)
    s.dsmMax = 0
    s.drained = true
  } else {
    s.drained = false
  }
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
  return {
    step(dtMs: number, obstacles: readonly FogObstacle[], spawnScale: number): void {
      stepSim(s, dtMs, obstacles, spawnScale)
    },
    settlePopulation(spawnScale: number): void {
      snapPopulation(s, spawnScale)
    },
    setSize(width: number, height: number): void {
      resizeState(s, width, height)
    },
    density: () => s.dsm,
    // Live getters (not captured values): a `setSize` re-derives the grid and the
    // consumer's per-frame `sim.gw`/`sim.gh` reads must follow it.
    get gw() {
      return s.gw
    },
    get gh() {
      return s.gh
    },
  }
}
