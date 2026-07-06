import { useCallback, useEffect, useRef } from 'react'
import {
  createFogSim,
  DPR_CAP,
  FADE_EXPONENT,
  FOG_PARAMS,
  LABEL_FONT,
  VIRTUAL_HEIGHT,
  VIRTUAL_WIDTH,
  WIND_BASE,
  type FogObstacle,
  type FogSim,
} from '@mythrun/client-core/worldgen'
import type { FogFieldEntity } from '@mythrun/client-core/contract'
import { entityObstacle } from './fog-obstacles.ts'
import { paintFog } from './fog-draw.ts'

// The imperative Canvas controller for WorldGenFogField (MYT-89 C3). Owns the fluid sim
// (a persistent FogSim in the 900×470 VIRTUAL space), the fixed-timestep rAF loop, the
// per-frame obstacle construction (measure the label → build the FogObstacle box), and
// the reduced-motion static settle. Everything is guarded on a live 2D context, so under
// jsdom (getContext → null) NOTHING here runs — the decorative canvas is inert and the
// component is just an aria-hidden layer. FogSim is the density brain; fog-draw is the
// crisp Bayer paint; this hook is the glue + the DOM (sizing, measuring, timing).

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

/** Size the backing store to the ELEMENT's real client pixels × DPR — full-pane
 *  resolution (MYT-89 audit #2), so the fog is crisp instead of an upscaled fixed
 *  900×470. The context is scaled by `(cssW / VIRTUAL_WIDTH) × dpr` so draw code stays in
 *  the 900×470 VIRTUAL space; the `aspect-[90/47]` box keeps the height in step, so one
 *  width-derived uniform scale fits both axes. Mirrors the graph's `sizeCanvasForDpr`
 *  exactly (same element dims + same scale) so the two layered canvases stay pixel-aligned
 *  — the fog-holes track the glyphs (BUG 2.2 stays closed: drawn in virtual units, the
 *  resolution is the pane's, not baked in). */
function sizeFogCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1)
  const rect = canvas.getBoundingClientRect()
  const cssW = Math.max(1, Math.round(rect.width))
  const cssH = Math.max(1, Math.round(rect.height))
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  const scale = (cssW / VIRTUAL_WIDTH) * dpr
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
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
): FogObstacle[] {
  ctx.font = LABEL_FONT
  const perSubStep = SUBSTEP_MS / Math.max(dtMs, MIN_DT_MS)
  const out: FogObstacle[] = []
  entities.forEach((entity, i) => {
    const p = prev.get(i)
    const vx = p ? (entity.x - p.x) * perSubStep : 0
    const vy = p ? (entity.y - p.y) * perSubStep : 0
    out.push(entityObstacle(entity, labelWidth(ctx, entity.name, widthCache), vx, vy))
    if (p) {
      p.x = entity.x
      p.y = entity.y
    } else prev.set(i, { x: entity.x, y: entity.y })
  })
  let stale = entities.length
  while (prev.delete(stale)) stale++
  return out
}

/** Clear the canvas and paint the sim's current density as crisp fog quads at clock `t`. */
function repaint(ctx: CanvasRenderingContext2D, sim: FogSim, t: number, eff: number): void {
  ctx.clearRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT)
  paintFog(ctx, sim.density(), sim.gw, sim.gh, {
    wx: WIND.wx,
    wy: WIND.wy,
    t,
    effectiveDensity: eff,
    fogColor: FOG_PARAMS.fogColor,
    fogAlpha: FOG_PARAMS.fogAlpha,
  })
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
}

export function useFogCanvas(params: FogCanvasParams): void {
  const { canvasRef, entities, entitiesSource, shownEntities, totalEntities, density, reducedMotion } = params

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
  const simTimeRef = useRef(0)
  entitiesRef.current = entities
  entitiesSourceRef.current = entitiesSource
  shownRef.current = shownEntities
  totalRef.current = totalEntities
  densityRef.current = density

  // The obstacle set for THIS frame: the live source (when composed into a graph) or
  // the static `entities` prop (standalone / the tuning story). Read fresh each frame.
  const currentEntities = useCallback(
    (): readonly FogFieldEntity[] =>
      entitiesSourceRef.current ? entitiesSourceRef.current() : entitiesRef.current,
    [],
  )

  const getSim = useCallback((): FogSim => {
    simRef.current ??= createFogSim({ width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT })
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
    sizeFogCanvas(canvas, ctx)
    const sim = getSim()
    const eff = effectiveDensity(shownRef.current, totalRef.current, densityRef.current)
    // Positions are static during a settle, so the obstacles (vx/vy = 0) are built ONCE
    // and reused across every sub-step — no per-step re-measure.
    const obstacles = buildObstacles(ctx, currentEntities(), prevPosRef.current, SUBSTEP_MS, widthCacheRef.current)
    for (let i = 0; i < SETTLE_STEPS; i++) {
      sim.step(SUBSTEP_MS, obstacles, eff)
      simTimeRef.current += SUBSTEP_MS / 1000
    }
    repaint(ctx, sim, simTimeRef.current, eff)
  }, [canvasRef, getSim, currentEntities])

  useEffect(() => {
    if (!reducedMotion) return
    settleStatic()
  }, [reducedMotion, entities, shownEntities, totalEntities, density, settleStatic])

  // The motion loop: fixed-timestep step + crisp repaint each rAF frame. Off entirely
  // under reduced motion (and with no 2D context — jsdom). Loop body at module scope.
  useEffect(() => {
    if (reducedMotion) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || ctx === null) return
    sizeFogCanvas(canvas, ctx)
    return startFogLoop(ctx, getSim(), {
      getEntities: currentEntities,
      shownRef,
      totalRef,
      densityRef,
      prevPosRef,
      widthCacheRef,
    })
  }, [reducedMotion, canvasRef, getSim, currentEntities])

  // Re-size the backing store to the pane on resize so the fog stays crisp after a layout
  // change (MYT-89 audit #2) — parity with the graph's `observeResize`; both size to the
  // same element, so they stay pixel-aligned. Body at module scope. Inert under jsdom (the
  // ResizeObserver shim never fires).
  useEffect(
    () => observeFogResize(canvasRef.current, { reducedMotion, settleStatic }),
    [canvasRef, reducedMotion, settleStatic],
  )
}

interface FogResizeDeps {
  reducedMotion: boolean
  settleStatic: () => void
}

/** Re-size the fog backing store to the pane on container resize. Under reduced motion,
 *  re-settle + repaint (`settleStatic` sizes then paints once); under motion, just re-size
 *  (the running loop repaints into the new backing next frame). Returns the disconnect
 *  teardown (or undefined — no canvas / no ResizeObserver in jsdom). Module-scoped so the
 *  hook stays lean; mirrors the graph's `observeResize` so the two layers re-size together. */
function observeFogResize(canvas: HTMLCanvasElement | null, deps: FogResizeDeps): (() => void) | undefined {
  if (canvas === null || typeof ResizeObserver === 'undefined') return undefined
  const observer = new ResizeObserver(() => {
    if (deps.reducedMotion) {
      deps.settleStatic()
      return
    }
    const ctx = canvas.getContext('2d')
    if (ctx !== null) sizeFogCanvas(canvas, ctx)
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
}

/** Run the fixed-timestep rAF loop: each frame, compute the real dt + clock, build the
 *  obstacles, advance the sim by dt (FogSim sub-steps internally), and repaint. The clock
 *  is REAL elapsed time (like the reference) so the cloud scrolls at wall-clock speed.
 *  Returns the cancel teardown. Module-scoped so the hook body stays lean. */
function startFogLoop(ctx: CanvasRenderingContext2D, sim: FogSim, deps: FogLoopDeps): () => void {
  const { getEntities, shownRef, totalRef, densityRef, prevPosRef, widthCacheRef } = deps
  let raf = 0
  let last = 0
  const start = performance.now()
  const frame = (now: number): void => {
    const dtMs = last === 0 ? SUBSTEP_MS : now - last
    last = now
    const eff = effectiveDensity(shownRef.current, totalRef.current, densityRef.current)
    const obstacles = buildObstacles(ctx, getEntities(), prevPosRef.current, dtMs, widthCacheRef.current)
    sim.step(dtMs, obstacles, eff)
    repaint(ctx, sim, (now - start) / 1000, eff)
    raf = window.requestAnimationFrame(frame)
  }
  raf = window.requestAnimationFrame(frame)
  return () => {
    window.cancelAnimationFrame(raf)
  }
}
