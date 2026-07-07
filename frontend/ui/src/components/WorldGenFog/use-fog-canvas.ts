import { useCallback, useEffect, useRef } from 'react'
import {
  cameraWorldDims,
  createFogSim,
  DPR_CAP,
  FADE_EXPONENT,
  FOG_PARAMS,
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
import { entityObstacle } from './fog-obstacles.ts'
import { paintFog } from './fog-draw.ts'

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

/** Sub-steps to settle the density for a static (reduced-motion) redraw. The warm-start
 *  seeds particles field-wide, so the raw splat is populated from step 1 and the obstacle
 *  carve-outs settle in the particle distribution within ~40 steps; the temporal low-pass
 *  (`STEADY` 0.03/step) then tops the amplitude up to `(1 - 0.03)^120 ≈ 2.6%` residual by
 *  120 — the VISIBLE structure is fully converged and the last few % of a 0.5-alpha layer
 *  is imperceptible. Bounded (never open-ended). NOTE: this is a SYNCHRONOUS ~350ms block
 *  per entity-count change (each sub-step ≈ 2.8ms × 4800 particles); see the C3 report —
 *  a chunked / dsm-seeded settle is the production follow-up if that block is felt. */
const SETTLE_STEPS = 120

/** Floor on the frame dt (ms) so the per-sub-step velocity scale can't divide by ~0. */
const MIN_DT_MS = 1

/** The fade-applied base density (`EFF`): the fog thins toward 0 as the graph fills. The
 *  fade is a RENDER concern (not FogSim's), and is used for BOTH the sim's fade-skip and
 *  the paint. `remaining` is clamped to [0, 1] so an over-full count can't produce a NaN
 *  (`Math.pow(negative, 0.85)`). */
/** The LOCKED fade toggle, read through a `boolean`-typed accessor so the branch below
 *  reads as a real config check (honoured if the locked param is ever flipped) rather
 *  than a statically-dead `!true` — a `const` initialised from the literal would narrow
 *  back to `true` and trip `no-unnecessary-condition`. */
function fadeEnabled(): boolean {
  return FOG_PARAMS.fadeAsGraphFills
}

function effectiveDensity(shown: number, total: number, base: number): number {
  if (!fadeEnabled() || total <= 0) return base
  const remaining = Math.max(0, Math.min(1, 1 - shown / total))
  return base * Math.pow(remaining, FADE_EXPONENT)
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
  eff: number,
  virtual: VirtualDims,
  camera: CameraPoint,
): void {
  ctx.save()
  ctx.translate(-camera.x, -camera.y)
  ctx.clearRect(0, 0, virtual.width, virtual.height)
  paintFog(ctx, sim.density(), sim.gw, sim.gh, {
    wx: WIND.wx,
    wy: WIND.wy,
    t,
    effectiveDensity: eff,
    fogColor: FOG_PARAMS.fogColor,
    fogAlpha: FOG_PARAMS.fogAlpha,
  })
  ctx.restore()
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
}

export function useFogCanvas(params: FogCanvasParams): void {
  const { canvasRef, entities, entitiesSource, shownEntities, totalEntities, density, reducedMotion, growth, seat, camera } = params

  // Latest props the imperative closures read (useLatest idiom): refs so the rAF loop
  // always sees current values without re-binding every render.
  const simRef = useRef<FogSim | null>(null)
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
  entitiesRef.current = entities
  entitiesSourceRef.current = entitiesSource
  shownRef.current = shownEntities
  totalRef.current = totalEntities
  densityRef.current = density
  growthRef.current = growth
  seatRef.current = seat
  cameraRef.current = camera

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
    },
    [syncFogDims],
  )

  const getSim = useCallback((): FogSim => {
    simRef.current ??= createFogSim({
      width: virtualRef.current.width,
      height: virtualRef.current.height,
    })
    return simRef.current
  }, [])

  // Reduced motion: step the sim to convergence once against the current obstacles, then
  // paint a single static frame. Re-runs on any entity-count / fade / density change (the
  // effect deps), so the fade-with-entities PROGRESS signal is preserved — a static
  // sample, not a blanket freeze.
  const settleStatic = useCallback((): void => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || ctx === null) return
    applyFogSize(canvas, ctx)
    labelFontRef.current ||= resolveLabelFont(canvas)
    const sim = getSim()
    const eff = effectiveDensity(shownRef.current, totalRef.current, densityRef.current)
    // Positions are static during a settle, so the obstacles (vx/vy = 0) are built ONCE
    // and reused across every sub-step — no per-step re-measure.
    const obstacles = buildObstacles(ctx, currentEntities(), prevPosRef.current, SUBSTEP_MS, widthCacheRef.current, labelFontRef.current)
    for (let i = 0; i < SETTLE_STEPS; i++) {
      sim.step(SUBSTEP_MS, obstacles, eff)
      simTimeRef.current += SUBSTEP_MS / 1000
    }
    repaint(ctx, sim, simTimeRef.current, eff, virtualRef.current, cameraAt(performance.now()))
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
    const eff = effectiveDensity(shownRef.current, totalRef.current, densityRef.current)
    repaint(ctx, sim, simTimeRef.current, eff, virtualRef.current, cameraAt(performance.now()))
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
    return startFogLoop(ctx, getSim(), {
      getEntities: currentEntities,
      shownRef,
      totalRef,
      densityRef,
      prevPosRef,
      widthCacheRef,
      labelFontRef,
      virtualRef,
      cameraAt,
    })
  }, [reducedMotion, canvasRef, applyFogSize, getSim, currentEntities, cameraAt])

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
  /** The shared camera at a frame timestamp (identity when standalone — T1b). */
  cameraAt: (frameMs: number) => CameraPoint
}

/** Run the fixed-timestep rAF loop: each frame, compute the real dt + clock, build the
 *  obstacles, advance the sim by dt (FogSim sub-steps internally), and repaint. The clock
 *  is REAL elapsed time (like the reference) so the cloud scrolls at wall-clock speed.
 *  Returns the cancel teardown. Module-scoped so the hook body stays lean. */
function startFogLoop(ctx: CanvasRenderingContext2D, sim: FogSim, deps: FogLoopDeps): () => void {
  const { getEntities, shownRef, totalRef, densityRef, prevPosRef, widthCacheRef, labelFontRef, virtualRef, cameraAt } = deps
  let raf = 0
  let last = 0
  const start = performance.now()
  const frame = (now: number): void => {
    const dtMs = last === 0 ? SUBSTEP_MS : now - last
    last = now
    const eff = effectiveDensity(shownRef.current, totalRef.current, densityRef.current)
    const obstacles = buildObstacles(ctx, getEntities(), prevPosRef.current, dtMs, widthCacheRef.current, labelFontRef.current)
    sim.step(dtMs, obstacles, eff)
    // The shared camera at THIS rAF timestamp — the graph loop reads the same source
    // with the same time, so both layers translate identically this frame (C5).
    repaint(ctx, sim, (now - start) / 1000, eff, virtualRef.current, cameraAt(now))
    raf = window.requestAnimationFrame(frame)
  }
  raf = window.requestAnimationFrame(frame)
  return () => {
    window.cancelAnimationFrame(raf)
  }
}
