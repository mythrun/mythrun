import { useCallback, useEffect, useRef } from 'react'
import {
  cameraWorldDims,
  CELL_PX,
  createFogSim,
  DPR_CAP,
  FOG_PARAMS,
  mulberry32,
  VIRTUAL_HEIGHT,
  VIRTUAL_WIDTH,
  WIND_BASE,
  type CameraPoint,
  type FogObstacle,
  type FogSim,
  type VirtualDims,
  type VirtualGrowth,
  type WorldSeat,
} from '@mythrun/client-core/worldgen'
import type { FogFieldEntity, WorldGenCameraSource } from '@mythrun/client-core/contract'
import { resolveLabelFont } from '../WorldGenGraph/canvas-util.ts'
import { clearedCellMask, entityObstacle } from './fog-obstacles.ts'
import { createFogConvergence, type FogConvergence } from './fog-converge.ts'
import { paintFog } from './fog-draw.ts'
import { resolveTerrainInk, TERRAIN_ALPHA } from './terrain-ink.ts'
import { terrainLandAt } from './terrain-field.ts'

// The imperative Canvas controller for WorldGenFogField (MYT-89 C3). Owns the fluid sim
// (a persistent FogSim in the shared PANE-ADAPTIVE virtual space — `virtualDims`, the
// MYT-89 responsive fix: 1:1 with CSS px on narrow panes, the reference width upscaled
// on wide ones, the height always following the pane's own aspect), the fixed-timestep
// rAF loop, the per-frame obstacle construction (measure the label → build the
// FogObstacle box), and the reduced-motion static settle. Everything is guarded on a
// live 2D context, so under jsdom (getContext → null) NOTHING here runs — the decorative
// canvas is inert and the component is just an aria-hidden layer. FogSim is the density
// brain; fog-draw is the crisp Bayer paint; this hook is the glue + the DOM (sizing,
// measuring, timing).
//
// The FOG under a VARIABLE aspect stays eye-tuned-correct by construction: every fog
// constant is per-virtual-px (wind, turbulence + cloud spatial frequencies, doublet
// radius, cell size), the particle count AREA-SCALES (constant density — FogSim §3.6),
// and the spawn flux weights derive from width/height. Scale-1 panes render the exact
// grain the 900×470 reference was tuned at; wider panes CSS-upscale uniformly (the
// pre-existing eye-approved desktop look).

/** The LOCKED, scaled wind — constant (no runtime wind slider). Drives the cloud scroll,
 *  and mirrors FogSim's own internal `computeWind` so the clouds advect WITH the
 *  particles. */
const WIND = { wx: WIND_BASE[0] * FOG_PARAMS.wind, wy: WIND_BASE[1] * FOG_PARAMS.wind }

/** FogSim's fixed sub-step (ms). Mirrors fog-sim's internal `FIXED_DT_MS` (1000/60): one
 *  `step(SUBSTEP_MS)` advances exactly one sub-step, so the reduced-motion settle is a
 *  clean N-sub-step loop, and the per-sub-step velocity scale below is exact at 60Hz. */
const SUBSTEP_MS = 1000 / 60

/** TOTAL sub-steps one static (reduced-motion) settle converges over — the same 120 the
 *  old synchronous settle ran (`STEADY` 0.03/step → ~2.6% residual), and the same count
 *  the animated path effectively integrates. The myth-9w7mw fix changes WHERE they run,
 *  not how many: `SETTLE_STEPS` of them stay synchronous (below), the rest mature in the
 *  background (`fog-converge`), so the per-event main-thread block collapses from ~340ms
 *  to ~a frame while the RESTING frame stays the genuinely converged field. */
const SETTLE_BUDGET = 120

/** SYNCHRONOUS sub-steps per static settle, run before `settleDensity` (the dsm=dens
 *  seed) snaps the temporal low-pass to converged amplitude for the INSTANT frame. The
 *  population snap already places particles in the steady band-wide spread
 *  (`settlePopulation`), so all the instant frame still needs real steps for is the
 *  OBSTACLE keep-out: the first advect projects every particle out of the EXR capsules
 *  (probe-measured: the projected rim then matches the settled flow's own stagnation
 *  bulge), and the second is margin that lets that rim relax before the sample is
 *  taken. ~3ms at reference dims. The remaining `SETTLE_BUDGET - SETTLE_STEPS` run
 *  chunked off the paint path — the converged STRUCTURE (the turbulence-organized
 *  streaks, the inflow→outflow gradient) only develops through real advection, which
 *  no instantaneous seed can fake. */
const SETTLE_STEPS = 2

/** Background sub-steps per convergence macrotask (`fog-converge`): 2 ≈ 3ms at
 *  reference dims on desktop — each chunk stays well under a frame budget even on a
 *  several-fold-slower phone. */
const CONVERGE_CHUNK_STEPS = 2

/** Floor on the frame dt (ms) so the per-sub-step velocity scale can't divide by ~0. */
const MIN_DT_MS = 1

/** The sim's RESPAWN scale (MYT-89 spawn-drain — this REPLACES the old stage-derived
 *  `effectiveDensity` fade): the fog clears in proportion to how many entities have
 *  arrived — `1 − shown/total`, clamped to [0, 1] — by spawning FEWER particles, never
 *  by dimming the paint (the draw stays pinned at the base density). Production feeds
 *  `nodes.length / MIN_EXPECTED_ENTITIES`, so the respawn flux hits zero by the time a
 *  real generation's minimum entity count has streamed in and the wind carries the
 *  last of the fog off the pane. `total ≤ 0` (a standalone fog with no denominator) →
 *  full spawn — the fog holds. Pure — exported for unit test. */
export function fogSpawnScale(shown: number, total: number): number {
  if (total <= 0) return 1
  return Math.max(0, Math.min(1, 1 - shown / total))
}

/** The fog layer's maximum render scale (device px per VIRTUAL px) — the reference
 *  prototype's own envelope: its 900×470 canvas at its DPR cap of 2 (1800×940), the
 *  resolution the fog's look was eye-tuned at. Numerically equal to DPR_CAP but a
 *  distinct concept: DPR_CAP caps the DISPLAY ratio; this caps virtual→device blow-up. */
const FOG_MAX_RENDER_SCALE = DPR_CAP

/** The fog canvas's backing-store size + virtual→device scale (MYT-89 framerate fix).
 *
 *  The pane-resolution sizing (audit #2, the graph-blur fix) sized BOTH canvases to the
 *  real pane pixels × dpr — which on a wide retina pane blew the fog's per-frame painted
 *  area up ~2.6× (e.g. 2880×1504 vs the former 1800×940) for zero visible gain: the fog
 *  is LOW-FREQUENCY dithered cloud quads whose canonical look was tuned at ≤ 2× the
 *  900×470 virtual space, and it reads soft under CSS upscale BY DESIGN. So the fog layer
 *  caps its render scale at `FOG_MAX_RENDER_SCALE` and lets CSS stretch that ONE layer to
 *  the pane; at or under the envelope this is bit-identical to the full-res sizing. The
 *  GRAPH canvas is deliberately NOT capped — full pane resolution is what keeps its
 *  lines/labels crisp (the reason for the audit #2 change).
 *
 *  Alignment (BUG 2.2) survives the cap: both canvases fill the SAME CSS box and both
 *  draw in the SAME 900×470 virtual space, so a virtual coordinate lands on the same
 *  on-screen point in each layer — the cap only lowers the fog's device sampling of that
 *  shared space (obstacle geometry, box-clear, and collision are all virtual-space math
 *  and untouched). Pure — exported for unit test. */
export function fogBackingStore(
  cssW: number,
  cssH: number,
  dpr: number,
  virtualW: number,
): { width: number; height: number; scale: number } {
  const paneScale = (cssW / virtualW) * dpr
  const scale = Math.min(paneScale, FOG_MAX_RENDER_SCALE)
  const shrink = scale / paneScale // 1 when uncapped → cssW×dpr exactly, as before
  return {
    width: Math.round(cssW * dpr * shrink),
    height: Math.round(cssH * dpr * shrink),
    scale,
  }
}

/** Size the backing store to the ELEMENT's client pixels × DPR, CAPPED at the fog's
 *  canonical 2×-virtual envelope (`fogBackingStore` — the MYT-89 framerate fix). The
 *  context is scaled so draw code stays in the shared VIRTUAL space; `view` is the
 *  dims the PANE maps to — the camera's window under the T1b pannable camera (the
 *  world pans behind it via the per-paint camera translate), which with the camera
 *  disengaged is exactly the whole pane-adaptive space. The graph's `sizeCanvasForDpr`
 *  sizes off the same element with the same view (at full pane resolution — the cap is
 *  fog-only), so the two layered canvases stay aligned — the fog-holes track the
 *  glyphs (BUG 2.2 stays closed: drawn in virtual units, the resolution is an
 *  implementation detail of each layer). */
function sizeFogCanvas(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  view: VirtualDims,
): void {
  const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1)
  const rect = canvas.getBoundingClientRect()
  const cssW = Math.max(1, Math.round(rect.width))
  const cssH = Math.max(1, Math.round(rect.height))
  const store = fogBackingStore(cssW, cssH, dpr, view.width)
  canvas.width = store.width
  canvas.height = store.height
  ctx.setTransform(store.scale, 0, 0, store.scale, 0, 0)
}

interface Pos {
  x: number
  y: number
}

/** The measured width (px) of a label at the locked font, MEMOIZED by name (MYT-89 audit
 *  #2): a label's width is fixed for a given name + font, so it is measured ONCE and
 *  cached — not re-`measureText`'d every entity every frame. Names are stable and the set
 *  only grows over a session, so the cache never needs invalidation (bounded, no evict). */
function labelWidth(ctx: CanvasRenderingContext2D, name: string, cache: Map<string, number>): number {
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  const width = ctx.measureText(name).width
  cache.set(name, width)
  return width
}

/** Build one FogObstacle per entity: the memoized label width → the capsule-anchored box
 *  (fog-obstacles). `vx`/`vy` is the label's PER-SUB-STEP displacement — the per-frame
 *  delta scaled by `SUBSTEP_MS / dt` so the wake-drag is frame-rate-independent (a node
 *  dragged Δ over a frame drags its wake by Δ total, however many sub-steps that frame
 *  runs). `prev` position objects are mutated in place (no fresh Map per frame); stale
 *  indices (a shrunk entity set) are trimmed so an index can't carry a foreign position. */
function buildObstacles(
  ctx: CanvasRenderingContext2D,
  entities: readonly FogFieldEntity[],
  prev: Map<number, Pos>,
  dtMs: number,
  widthCache: Map<string, number>,
  labelFont: string,
): FogObstacle[] {
  ctx.font = labelFont
  const perSubStep = SUBSTEP_MS / Math.max(dtMs, MIN_DT_MS)
  const out: FogObstacle[] = []
  entities.forEach((entity, i) => {
    const p = prev.get(i)
    const vx = p ? (entity.x - p.x) * perSubStep : 0
    const vy = p ? (entity.y - p.y) * perSubStep : 0
    // An UNLABELED entity (label tiering) reserves only its icon box — no text measure.
    const textWidth = entity.labeled === false ? 0 : labelWidth(ctx, entity.name, widthCache)
    out.push(entityObstacle(entity, textWidth, vx, vy))
    if (p) {
      p.x = entity.x
      p.y = entity.y
    } else prev.set(i, { x: entity.x, y: entity.y })
  })
  let stale = entities.length
  while (prev.delete(stale)) stale++
  return out
}

/** The identity camera (no source / disengaged) — the pre-camera render, unchanged. */
const CAMERA_IDENTITY: CameraPoint = { x: 0, y: 0 }

/** Clear the canvas and paint the sim's current density as crisp fog quads at clock
 *  `t`, seen through the CAMERA (MYT-89 T1b): the whole paint translates by the
 *  camera offset — the same offset the graph canvas translates by this frame — so a
 *  fog-hole stays on its glyph at every camera position (one camera, both layers,
 *  C5). The world-rect clear covers the view at any clamped camera (camera ≥ 0 and
 *  world ≥ view on both axes). Identity camera → exactly the pre-camera paint. */
function repaint(
  ctx: CanvasRenderingContext2D,
  sim: FogSim,
  t: number,
  density: number,
  virtual: VirtualDims,
  camera: CameraPoint,
  terrainInk: string,
  ground: Ground,
): void {
  ctx.save()
  ctx.translate(-camera.x, -camera.y)
  ctx.clearRect(0, 0, virtual.width, virtual.height)
  paintFog(ctx, sim.density(), sim.gw, sim.gh, {
    wx: WIND.wx,
    wy: WIND.wy,
    t,
    // The BASE density, pinned (no fade multiply): the clear lives in the sim's
    // spawn drain — the paint draws whatever particle density remains, full-strength.
    density,
    // The terrain re-tune (ux-run2 myth-y7yki, re-measured in ux-run3 myth-llqj7):
    // themed ink at full alpha, so the dither field the player watches for minutes
    // clears the 3:1 non-text floor MEASURED OFF PIXELS (see terrain-ink.ts; the
    // reference FOG_PARAMS values stay the verbatim record).
    fogColor: terrainInk,
    fogAlpha: TERRAIN_ALPHA,
    // The world's LAND (ux-run3): static, seeded ground under the draining weather.
    ...ground,
  })
  ctx.restore()
}

/** The static-ground half of a repaint (ux-run3): the seeded land sampler and the
 *  label knockout it has to honour. Both absent on a seedless fog (the tuning stories)
 *  — the paint then draws the pre-run3 weather-only field. */
interface Ground {
  land?: ((px: number, py: number) => number) | undefined
  clearedAt?: ((px: number, py: number) => boolean) | undefined
}

/** Build this repaint's ground: the terrain sampler bound to the seed + current world
 *  dims, plus a cell-mask knockout under the current labels (the same clear FogSim
 *  gives the weather for free). No seed → no ground. */
function groundFor(
  seed: number | undefined,
  virtual: VirtualDims,
  obstacles: readonly FogObstacle[],
  gw: number,
  gh: number,
): Ground {
  if (seed === undefined) return {}
  const mask = clearedCellMask(obstacles, gw, gh)
  return {
    land: terrainLandAt(seed, virtual.width, virtual.height),
    clearedAt: (px, py) => {
      const gx = Math.trunc(px / CELL_PX)
      const gy = Math.trunc(py / CELL_PX)
      if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return false
      return mask[gy * gw + gx] === 1
    },
  }
}

export interface FogCanvasParams {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  entities: readonly FogFieldEntity[]
  /** A LIVE per-frame obstacle source. When set it supersedes `entities` and is read
   *  each frame — the C5 integration seam that lets the fog-holes track the graph's
   *  force-sim positions without a React re-render per frame. */
  entitiesSource?: (() => readonly FogFieldEntity[]) | undefined
  shownEntities: number
  totalEntities: number
  density: number
  reducedMotion: boolean
  /** Density-aware virtual-space growth (MYT-89 density redesign): the SAME growth
   *  input the composing graph feeds the dims derivation, so both layers derive
   *  identical dims from the shared pane box while the space grows with the node
   *  count (C5). `undefined` (standalone fog) → the fixed shipped space. */
  growth?: VirtualGrowth | undefined
  /** The camera-world SEAT input (T1b): the SAME `seatFrom` derivation the composing
   *  graph feeds `cameraWorldDims`, so both layers agree on when (and how far) the
   *  world outgrows the pane. `undefined` (standalone fog) → never engages. */
  seat?: WorldSeat | undefined
  /** The SHARED camera (T1b) — the graph hook's source. Read each frame under motion
   *  (same rAF timestamp → the identical position the graph painted); subscribed for
   *  static repaints under reduced motion (a manual pan / arrival snap has no loop).
   *  `undefined` (standalone fog) → the identity camera. */
  camera?: WorldGenCameraSource | undefined
  /** The world's TERRAIN SEED (ux-run3 myth-aftau + myth-rlbku). Seeds the particle
   *  sim's RNG AND the static landmass field, so one world is one ground for the life
   *  of the session — a remount replays the identical terrain instead of rolling a new
   *  continent under the same name. `undefined` → `Math.random` and no land: the
   *  pre-run3 weather-only field the tuning stories still exercise. */
  terrainSeed?: number | undefined
}

export function useFogCanvas(params: FogCanvasParams): void {
  const { canvasRef, entities, entitiesSource, shownEntities, totalEntities, density, reducedMotion, growth, seat, camera, terrainSeed } = params

  // Latest props the imperative closures read (useLatest idiom): refs so the rAF loop
  // always sees current values without re-binding every render.
  const simRef = useRef<FogSim | null>(null)
  // The reduced-motion background convergence worker (myth-9w7mw) — created on the
  // first static settle, cancelled on unmount / a flip back to motion.
  const convergenceRef = useRef<FogConvergence | null>(null)
  const entitiesRef = useRef(entities)
  const entitiesSourceRef = useRef(entitiesSource)
  const shownRef = useRef(shownEntities)
  const totalRef = useRef(totalEntities)
  const densityRef = useRef(density)
  const prevPosRef = useRef<Map<number, Pos>>(new Map())
  // Memoized label widths (name → measured px). Persists across frames so `measureText`
  // runs once per distinct name, not per entity per frame (MYT-89 audit #2).
  const widthCacheRef = useRef<Map<string, number>>(new Map())
  // Resolved DS label font ("`${px}px ${family}`" from `--font-body`/`--text-sm`), cached on
  // first use. MUST be the SAME string the graph resolves (both call `resolveLabelFont` on a
  // canvas in the same document) so the fog reserves the width the graph collides on + draws.
  const labelFontRef = useRef('')
  const simTimeRef = useRef(0)
  // The CURRENT WORLD dims (pane-adaptive, MYT-89 responsive fix; seat-grown under the
  // T1b camera). Derived from THIS canvas's box through the SAME `cameraWorldDims` the
  // graph hook uses — both canvases fill the same pane, so the two layers compute
  // identical dims and stay aligned (C5).
  const virtualRef = useRef<VirtualDims>({ width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT })
  // The camera VIEW dims (T1b) — what the pane's CSS box maps to (the backing-store
  // scale); equal to the world whenever the camera is disengaged.
  const viewRef = useRef<VirtualDims>({ width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT })
  // The density-aware growth + camera-seat inputs (undefined → the fixed space).
  const growthRef = useRef<VirtualGrowth | undefined>(growth)
  const seatRef = useRef<WorldSeat | undefined>(seat)
  // The shared camera source (undefined → the identity camera).
  const cameraRef = useRef<WorldGenCameraSource | undefined>(camera)
  // The resolved terrain ink (`--worldgen-terrain`, theme-aware — myth-y7yki).
  // Cached like the graph's inks (never a per-frame getComputedStyle): refreshed
  // by `applyFogSize` (mount / resize / settle) and the theme observer below.
  const terrainInkRef = useRef<string>(FOG_PARAMS.fogColor)
  // The world's terrain seed (myth-aftau): the land field's identity, and the sim's
  // RNG. Read through a ref like every other imperative input.
  const seedRef = useRef<number | undefined>(terrainSeed)
  // The obstacle set the LAST paint reserved — the static-repaint path (a camera move
  // under reduced motion) has no frame to rebuild them from, but the land knockout
  // still has to land under the same labels (ux-run3).
  const obstaclesRef = useRef<readonly FogObstacle[]>([])
  entitiesRef.current = entities
  entitiesSourceRef.current = entitiesSource
  shownRef.current = shownEntities
  totalRef.current = totalEntities
  densityRef.current = density
  growthRef.current = growth
  seatRef.current = seat
  cameraRef.current = camera
  seedRef.current = terrainSeed

  // The obstacle set for THIS frame: the live source (when composed into a graph) or
  // the static `entities` prop (standalone / the tuning story). Read fresh each frame.
  const currentEntities = useCallback(
    (): readonly FogFieldEntity[] =>
      entitiesSourceRef.current ? entitiesSourceRef.current() : entitiesRef.current,
    [],
  )

  // The camera for a render moment: the shared source (advancing its drift at most
  // once per rAF timestamp — the graph loop calls it with the same time and reads the
  // identical value, C5), or the identity when standalone.
  const cameraAt = useCallback(
    (frameMs: number): CameraPoint => cameraRef.current?.current(frameMs) ?? CAMERA_IDENTITY,
    [],
  )

  // Measure the pane → derive the shared WORLD + VIEW dims (with the density growth +
  // the camera seat — T1b) → on a dims CHANGE re-size the live sim (grid + area-scaled
  // particles re-derive, the overlapping density is preserved — no flash) + the
  // backing store (scaled by the VIEW: the pane maps to the camera's window; the world
  // pans behind it). Returns whether the dims changed. The graph hook runs the same
  // derivation off the same pane box with the same growth+seat, so the layers agree
  // at every size, density, and camera position.
  const syncFogDims = useCallback(
    (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): boolean => {
      const rect = canvas.getBoundingClientRect()
      const next = cameraWorldDims(
        Math.round(rect.width),
        Math.round(rect.height),
        growthRef.current,
        seatRef.current,
      )
      const world = virtualRef.current
      const view = viewRef.current
      if (
        next.world.width === world.width &&
        next.world.height === world.height &&
        next.view.width === view.width &&
        next.view.height === view.height
      ) {
        return false
      }
      virtualRef.current = next.world
      viewRef.current = next.view
      simRef.current?.setSize(next.world.width, next.world.height)
      sizeFogCanvas(canvas, ctx, next.view)
      return true
    },
    [],
  )

  // The mount/resize path: sync the dims AND (even when they're unchanged) re-size the
  // backing store — a pane resize can move the CSS box without moving the virtual dims,
  // and the store must track the element's real pixels.
  const applyFogSize = useCallback(
    (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void => {
      if (!syncFogDims(canvas, ctx)) sizeFogCanvas(canvas, ctx, viewRef.current)
      terrainInkRef.current = resolveTerrainInk(canvas)
    },
    [syncFogDims],
  )

  const getSim = useCallback((staticBirth: boolean): FogSim => {
    if (simRef.current === null) {
      simRef.current = createFogSim({
        width: virtualRef.current.width,
        height: virtualRef.current.height,
        // The world's own RNG (myth-aftau): with a seed the particle field is born
        // identically on every mount, so a re-entry replays the terrain the player
        // walked away from instead of rolling a fresh one. Seedless (the tuning
        // stories) falls back to fog-sim's `Math.random` default.
        ...(seedRef.current !== undefined ? { random: mulberry32(seedRef.current) } : {}),
      })
      // Born at the CURRENT scaled population: the warm start seeds the full field,
      // then the snap retires down to the mount-time target — so a LATE mount (a
      // player re-entering a well-underway generation, or the drained end state)
      // starts at the population the drain would have reached, not full fog that
      // then spends ~20s blowing off. A REDUCED-MOTION birth re-arms the WHOLE
      // population first (retire-all, so the snap below revives through fog-sim's
      // band-wide static placement): the on-canvas warm start over-concentrates the
      // in-grid mass by the spawn-band fraction vs the steady distribution — the
      // animated path relaxes that away over its first seconds; a static frame
      // can't (`bandStartSlot`). A sim that already exists (a mid-session reduced-
      // motion flip) is already steady-spread and is never re-armed.
      if (staticBirth) simRef.current.settlePopulation(0)
      simRef.current.settlePopulation(fogSpawnScale(shownRef.current, totalRef.current))
    }
    return simRef.current
  }, [])

  // Reduced motion: snap the population to the CURRENT spawn scale (a static settle
  // has no wind-time to drain through — `settlePopulation`), run the few sub-steps
  // the keep-out needs against the current obstacles, snap the smoothed density to
  // converged amplitude (`settleDensity`, the dsm=dens seed), and paint the INSTANT
  // frame — drain level + label carve-outs correct within ~a frame of the change.
  // The settle's remaining sub-steps then mature OFF the paint path (`fog-converge`,
  // real physics in background macrotasks) and the completion repaint swaps in the
  // genuinely converged field, so every RESTING frame matches what the old ~340ms
  // blocking settle produced. Re-runs on any entity-count / density change (the
  // effect deps) — each re-settle supersedes a mid-flight convergence with a fresh
  // budget, exactly as each old settle ran its own full 120 sub-steps.
  const settleStatic = useCallback((): void => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || ctx === null) return
    applyFogSize(canvas, ctx)
    labelFontRef.current ||= resolveLabelFont(canvas)
    const sim = getSim(true)
    const scale = fogSpawnScale(shownRef.current, totalRef.current)
    sim.settlePopulation(scale)
    // Positions are static during a settle, so the obstacles (vx/vy = 0) are built ONCE
    // and reused across every sub-step — no per-step re-measure.
    const obstacles = buildObstacles(ctx, currentEntities(), prevPosRef.current, SUBSTEP_MS, widthCacheRef.current, labelFontRef.current)
    obstaclesRef.current = obstacles
    for (let i = 0; i < SETTLE_STEPS; i++) {
      sim.step(SUBSTEP_MS, obstacles, scale)
      simTimeRef.current += SUBSTEP_MS / 1000
    }
    sim.settleDensity(obstacles)
    repaint(ctx, sim, simTimeRef.current, densityRef.current, virtualRef.current, cameraAt(performance.now()), terrainInkRef.current, groundFor(seedRef.current, virtualRef.current, obstacles, sim.gw, sim.gh))
    convergenceRef.current ??= createFogConvergence({
      stepMs: SUBSTEP_MS,
      budget: SETTLE_BUDGET - SETTLE_STEPS,
      chunkSteps: CONVERGE_CHUNK_STEPS,
    })
    convergenceRef.current.request({
      sim,
      obstacles,
      // Live scale: an arrival mid-budget re-settles (superseding this order), but
      // the in-flight chunks stay drain-correct against the current count anyway.
      scale: () => fogSpawnScale(shownRef.current, totalRef.current),
      onSubStep: () => {
        simTimeRef.current += SUBSTEP_MS / 1000
      },
      // The completion repaint: the REAL low-pass after the full budget — converged
      // texture, current camera/density. The ctx is captured from this settle; the
      // worker is cancelled on unmount, so a stale capture never paints.
      onDone: () => {
        repaint(ctx, sim, simTimeRef.current, densityRef.current, virtualRef.current, cameraAt(performance.now()), terrainInkRef.current, groundFor(seedRef.current, virtualRef.current, obstacles, sim.gw, sim.gh))
      },
    })
  }, [canvasRef, applyFogSize, getSim, currentEntities, cameraAt])

  // Repaint the CURRENT settled state at the current camera — the reduced-motion
  // camera-move path (T1b): a manual pan / arrival snap moved the camera but nothing
  // else (obstacles are world-space; the density needs no re-settle), so this is a
  // pure re-render. Falls back to a full settle when the sim hasn't run yet.
  const repaintStatic = useCallback((): void => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    const sim = simRef.current
    if (canvas === null || ctx === null) return
    if (sim === null) {
      settleStatic()
      return
    }
    repaint(ctx, sim, simTimeRef.current, densityRef.current, virtualRef.current, cameraAt(performance.now()), terrainInkRef.current, groundFor(seedRef.current, virtualRef.current, obstaclesRef.current, sim.gw, sim.gh))
  }, [canvasRef, settleStatic, cameraAt])

  // The dims key: a primitive fingerprint of the growth + seat inputs, so the effects
  // below re-run when the DERIVED dims may have moved (a node arrival past the start
  // count; the camera world growing with the seat), not on every render's fresh
  // object identity.
  const growthKey =
    growth === undefined ? '' : `${String(growth.nodeCount)}/${String(growth.startCount)}/${String(growth.perNode)}`
  const seatKey = seat === undefined ? '' : `${String(seat.nodeCount)}/${String(seat.areaPerLabel)}`
  const dimsKey = `${growthKey}|${seatKey}`

  useEffect(() => {
    if (!reducedMotion) return
    settleStatic()
  }, [reducedMotion, entities, shownEntities, totalEntities, density, dimsKey, settleStatic])

  // The background convergence's OWNER: stop it cold on unmount and on a reduced-
  // motion → motion flip (React runs cleanups before the next effects, so the rAF
  // loop — whose real stepping IS the convergence — never overlaps a live worker).
  useEffect(() => {
    if (!reducedMotion) return
    return () => {
      convergenceRef.current?.cancel()
    }
  }, [reducedMotion])

  // Reduced-motion camera moves (T1b): a manual pan / arrival snap has no rAF loop to
  // pick it up — subscribe to the shared camera's discrete mutations and re-render the
  // settled state at the new position (the graph's static painter does the same, so
  // the two layers move together).
  useEffect(() => {
    if (!reducedMotion || camera === undefined) return
    return camera.subscribe(repaintStatic)
  }, [reducedMotion, camera, repaintStatic])

  // Density growth under MOTION: when the node count moves the virtual space, re-derive
  // the dims + re-size the sim/backing store (guarded — a growth step that doesn't
  // change the dims touches nothing, so the running fog never flashes needlessly).
  useEffect(() => {
    if (reducedMotion) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || ctx === null) return
    syncFogDims(canvas, ctx)
  }, [reducedMotion, dimsKey, canvasRef, syncFogDims])

  // The motion loop: fixed-timestep step + crisp repaint each rAF frame. Off entirely
  // under reduced motion (and with no 2D context — jsdom). Loop body at module scope.
  useEffect(() => {
    if (reducedMotion) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || ctx === null) return
    applyFogSize(canvas, ctx)
    labelFontRef.current ||= resolveLabelFont(canvas)
    return startFogLoop(ctx, getSim(false), {
      getEntities: currentEntities,
      shownRef,
      totalRef,
      densityRef,
      prevPosRef,
      widthCacheRef,
      labelFontRef,
      virtualRef,
      terrainInkRef,
      cameraAt,
      seedRef,
      obstaclesRef,
    })
  }, [reducedMotion, canvasRef, applyFogSize, getSim, currentEntities, cameraAt])

  // Re-resolve the terrain ink on a light/dark flip (the `.dark` class toggling
  // on <html>) — mirrors the graph hook's theme observer. Under motion the loop
  // reads the refreshed ref next frame; a static (reduced-motion) field needs an
  // explicit repaint at the new ink.
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => {
      const canvas = canvasRef.current
      if (canvas !== null) terrainInkRef.current = resolveTerrainInk(canvas)
      if (reducedMotion) repaintStatic()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => {
      observer.disconnect()
    }
  }, [reducedMotion, canvasRef, repaintStatic])

  // WEB-FONT invalidation (mirrors the graph hook): widths memoized before the DS serif
  // loads are fallback-font widths — once fonts are ready, drop the memo so the next
  // frame's obstacles re-measure at the true label extents. Under reduced motion no
  // frame is coming — re-settle + repaint at the true widths now (T1 review fix #2:
  // the cleared cache alone left the stale fallback-width frame up).
  useEffect(() => {
    if (!('fonts' in document)) return // jsdom has no FontFaceSet
    let cancelled = false
    void document.fonts.ready.then(() => {
      if (cancelled) return
      widthCacheRef.current.clear()
      if (reducedMotion) settleStatic()
    })
    return () => {
      cancelled = true
    }
  }, [reducedMotion, settleStatic])

  // Re-size the backing store (and, via `applyFogSize`, the virtual dims + the sim) on
  // container resize — parity with the graph's `observeResize`; both size off the same
  // element and derive the same virtual space, so the layers stay aligned. Body at module
  // scope. Inert under jsdom (the ResizeObserver shim never fires).
  useEffect(
    () => observeFogResize(canvasRef.current, { reducedMotion, settleStatic, applyFogSize }),
    [canvasRef, reducedMotion, settleStatic, applyFogSize],
  )
}

interface FogResizeDeps {
  reducedMotion: boolean
  settleStatic: () => void
  applyFogSize: (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => void
}

/** Re-size the fog backing store (+ the pane-adaptive virtual dims + the sim) on
 *  container resize. Under reduced motion, re-settle + repaint (`settleStatic` sizes then
 *  paints once); under motion, just re-size (the running loop repaints into the new
 *  backing next frame). Returns the disconnect teardown (or undefined — no canvas / no
 *  ResizeObserver in jsdom). Module-scoped so the hook stays lean; mirrors the graph's
 *  `observeResize` so the two layers re-size together. */
function observeFogResize(canvas: HTMLCanvasElement | null, deps: FogResizeDeps): (() => void) | undefined {
  if (canvas === null || typeof ResizeObserver === 'undefined') return undefined
  const observer = new ResizeObserver(() => {
    if (deps.reducedMotion) {
      deps.settleStatic()
      return
    }
    const ctx = canvas.getContext('2d')
    if (ctx !== null) deps.applyFogSize(canvas, ctx)
  })
  observer.observe(canvas)
  return () => {
    observer.disconnect()
  }
}

interface FogLoopDeps {
  getEntities: () => readonly FogFieldEntity[]
  shownRef: React.RefObject<number>
  totalRef: React.RefObject<number>
  densityRef: React.RefObject<number>
  prevPosRef: React.RefObject<Map<number, Pos>>
  widthCacheRef: React.RefObject<Map<string, number>>
  labelFontRef: React.RefObject<string>
  /** The CURRENT world dims (the repaint's clear bounds). */
  virtualRef: React.RefObject<VirtualDims>
  /** The cached theme terrain ink (myth-y7yki) — refreshed by applyFogSize +
   *  the theme observer, read per frame (never a per-frame style resolve). */
  terrainInkRef: React.RefObject<string>
  /** The shared camera at a frame timestamp (identity when standalone — T1b). */
  cameraAt: (frameMs: number) => CameraPoint
  /** The world's terrain seed (ux-run3) — the land field's identity. */
  seedRef: React.RefObject<number | undefined>
  /** Where the loop publishes each frame's obstacles, so a static repaint outside the
   *  loop can knock the land out under the same labels. */
  obstaclesRef: React.RefObject<readonly FogObstacle[]>
}

/** Run the fixed-timestep rAF loop: each frame, compute the real dt + clock, build the
 *  obstacles, advance the sim by dt (FogSim sub-steps internally), and repaint. The clock
 *  is REAL elapsed time (like the reference) so the cloud scrolls at wall-clock speed.
 *  Returns the cancel teardown. Module-scoped so the hook body stays lean. */
function startFogLoop(ctx: CanvasRenderingContext2D, sim: FogSim, deps: FogLoopDeps): () => void {
  const { getEntities, shownRef, totalRef, densityRef, prevPosRef, widthCacheRef, labelFontRef, virtualRef, terrainInkRef, cameraAt, seedRef, obstaclesRef } = deps
  let raf = 0
  let last = 0
  const start = performance.now()
  const frame = (now: number): void => {
    const dtMs = last === 0 ? SUBSTEP_MS : now - last
    last = now
    // The spawn scale for THIS frame: as entities arrive the respawn target falls
    // and the field drains through the wind (a DRAINED sim makes step a no-op and
    // the zeroed grid makes the paint pure skips — the steady state costs ~nothing).
    const scale = fogSpawnScale(shownRef.current, totalRef.current)
    const obstacles = buildObstacles(ctx, getEntities(), prevPosRef.current, dtMs, widthCacheRef.current, labelFontRef.current)
    obstaclesRef.current = obstacles
    sim.step(dtMs, obstacles, scale)
    // The shared camera at THIS rAF timestamp — the graph loop reads the same source
    // with the same time, so both layers translate identically this frame (C5).
    repaint(ctx, sim, (now - start) / 1000, densityRef.current, virtualRef.current, cameraAt(now), terrainInkRef.current, groundFor(seedRef.current, virtualRef.current, obstacles, sim.gw, sim.gh))
    raf = window.requestAnimationFrame(frame)
  }
  raf = window.requestAnimationFrame(frame)
  return () => {
    window.cancelAnimationFrame(raf)
  }
}
