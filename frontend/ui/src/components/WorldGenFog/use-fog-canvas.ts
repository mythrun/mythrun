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

/** Size the backing store to the 900×470 VIRTUAL space × DPR and scale the context so 1
 *  unit == 1 virtual px. The canvas ELEMENT is CSS-sized to the pane, so the fixed
 *  virtual render is uniformly CSS-scaled — the fog never overhangs (BUG 2.2 in pixels:
 *  everything is drawn in virtual units, the scale is applied by CSS, not baked in). */
function sizeFogCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1)
  canvas.width = Math.round(VIRTUAL_WIDTH * dpr)
  canvas.height = Math.round(VIRTUAL_HEIGHT * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

interface Pos {
  x: number
  y: number
}

/** Build one FogObstacle per entity: measure the label at the locked font, then the
 *  capsule-anchored box (fog-obstacles). `vx`/`vy` is the label's PER-SUB-STEP
 *  displacement — the per-frame delta scaled by `SUBSTEP_MS / dt` so the wake-drag is
 *  frame-rate-independent (a node dragged Δ over a frame drags its wake by Δ total,
 *  however many sub-steps that frame runs). `prev` is mutated to this frame's positions. */
function buildObstacles(
  ctx: CanvasRenderingContext2D,
  entities: readonly FogFieldEntity[],
  prev: Map<number, Pos>,
  dtMs: number,
): FogObstacle[] {
  ctx.font = LABEL_FONT
  const perSubStep = SUBSTEP_MS / Math.max(dtMs, MIN_DT_MS)
  const out: FogObstacle[] = []
  const next = new Map<number, Pos>()
  entities.forEach((entity, i) => {
    const p = prev.get(i)
    const vx = p ? (entity.x - p.x) * perSubStep : 0
    const vy = p ? (entity.y - p.y) * perSubStep : 0
    out.push(entityObstacle(entity, ctx.measureText(entity.name).width, vx, vy))
    next.set(i, { x: entity.x, y: entity.y })
  })
  prev.clear()
  for (const [i, p] of next) prev.set(i, p)
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
  entities: FogFieldEntity[]
  shownEntities: number
  totalEntities: number
  density: number
  reducedMotion: boolean
}

export function useFogCanvas(params: FogCanvasParams): void {
  const { canvasRef, entities, shownEntities, totalEntities, density, reducedMotion } = params

  // Latest props the imperative closures read (useLatest idiom): refs so the rAF loop
  // always sees current values without re-binding every render.
  const simRef = useRef<FogSim | null>(null)
  const entitiesRef = useRef(entities)
  const shownRef = useRef(shownEntities)
  const totalRef = useRef(totalEntities)
  const densityRef = useRef(density)
  const prevPosRef = useRef<Map<number, Pos>>(new Map())
  const simTimeRef = useRef(0)
  entitiesRef.current = entities
  shownRef.current = shownEntities
  totalRef.current = totalEntities
  densityRef.current = density

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
    const obstacles = buildObstacles(ctx, entitiesRef.current, prevPosRef.current, SUBSTEP_MS)
    for (let i = 0; i < SETTLE_STEPS; i++) {
      sim.step(SUBSTEP_MS, obstacles, eff)
      simTimeRef.current += SUBSTEP_MS / 1000
    }
    repaint(ctx, sim, simTimeRef.current, eff)
  }, [canvasRef, getSim])

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
    return startFogLoop(ctx, getSim(), { entitiesRef, shownRef, totalRef, densityRef, prevPosRef })
  }, [reducedMotion, canvasRef, getSim])
}

interface FogLoopDeps {
  entitiesRef: React.RefObject<FogFieldEntity[]>
  shownRef: React.RefObject<number>
  totalRef: React.RefObject<number>
  densityRef: React.RefObject<number>
  prevPosRef: React.RefObject<Map<number, Pos>>
}

/** Run the fixed-timestep rAF loop: each frame, compute the real dt + clock, build the
 *  obstacles, advance the sim by dt (FogSim sub-steps internally), and repaint. The clock
 *  is REAL elapsed time (like the reference) so the cloud scrolls at wall-clock speed.
 *  Returns the cancel teardown. Module-scoped so the hook body stays lean. */
function startFogLoop(ctx: CanvasRenderingContext2D, sim: FogSim, deps: FogLoopDeps): () => void {
  const { entitiesRef, shownRef, totalRef, densityRef, prevPosRef } = deps
  let raf = 0
  let last = 0
  const start = performance.now()
  const frame = (now: number): void => {
    const dtMs = last === 0 ? SUBSTEP_MS : now - last
    last = now
    const eff = effectiveDensity(shownRef.current, totalRef.current, densityRef.current)
    const obstacles = buildObstacles(ctx, entitiesRef.current, prevPosRef.current, dtMs)
    sim.step(dtMs, obstacles, eff)
    repaint(ctx, sim, (now - start) / 1000, eff)
    raf = window.requestAnimationFrame(frame)
  }
  raf = window.requestAnimationFrame(frame)
  return () => {
    window.cancelAnimationFrame(raf)
  }
}
