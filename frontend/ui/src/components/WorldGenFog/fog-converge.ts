import type { FogObstacle, FogSim } from '@mythrun/client-core/worldgen'

// The reduced-motion BACKGROUND convergence for the world-gen fog (myth-9w7mw).
//
// The old static settle ran its 120 sub-steps synchronously — a ~340ms main-thread
// block per entity-count change, re-triggered per arrival on a streaming generation.
// The replacement splits the settle in two: the hook paints an INSTANT frame (a couple
// of sync sub-steps + FogSim's `settleDensity` dsm=dens seed — drain level and label
// carve-outs correct immediately), and THIS worker matures the rest of the settle as
// chunked macrotasks off the paint path. The chunks run the sim's own `step()` — real
// advection, real temporal low-pass — so when the budget completes, the field IS the
// converged one the old blocking settle produced (the eye-tuned streaky structure the
// instantaneous seed cannot fake: probe-measured, the converged field's per-cell
// structure needs ~hundreds of real sub-steps of turbulence to develop). `onDone` then
// repaints once: every RESTING reduced-motion frame is the genuinely settled field,
// with only the short-lived transitional frame approximated by the seed.
//
// Scheduling is plain `setTimeout(0)` (macrotasks): universally available, cancellable,
// and its nested-call clamping (~4ms) spreads the burn politely across ~a quarter
// second instead of monopolizing the loop — each chunk is ~2 sub-steps (≈3ms at
// reference dims on desktop), so no single task approaches a frame budget. A new
// `request` SUPERSEDES a mid-flight one (fresh budget, new obstacles — exactly like
// each old settle running its own full 120), and `cancel` stops the worker cold (the
// hook cancels on unmount and on a reduced-motion → motion flip, where the rAF loop's
// real stepping takes over).

/** One settle's background-maturation order. */
export interface ConvergeRequest {
  /** The live sim (only `step` is needed — narrow for the unit tests). */
  sim: Pick<FogSim, 'step'>
  /** The obstacle set of the settle that placed this order (positions are static
   *  under reduced motion, so they are built once and reused across every chunk). */
  obstacles: readonly FogObstacle[]
  /** The CURRENT spawn scale, read live at every sub-step — an arrival that lands
   *  mid-budget re-settles anyway, but the in-flight chunks stay drain-correct. */
  scale: () => number
  /** Fires once per executed sub-step — the hook advances its sim clock here, so the
   *  cloud-mask phase tracks the settle exactly as the synchronous loop's did. */
  onSubStep: () => void
  /** Fires once when the budget completes — the completion repaint. Never fires for
   *  a superseded or cancelled request. */
  onDone: () => void
}

export interface FogConvergence {
  /** Arm (or re-arm) the worker with a fresh full budget for a new settle. */
  request(req: ConvergeRequest): void
  /** Stop cold: no further sub-steps, no completion callback. */
  cancel(): void
}

export function createFogConvergence(cfg: {
  /** The fixed sub-step (ms) each chunked `sim.step` advances — the hook's SUBSTEP_MS. */
  stepMs: number
  /** Total background sub-steps per settle (the old settle's count minus the sync few). */
  budget: number
  /** Sub-steps per macrotask — sized so a chunk stays well under a frame budget. */
  chunkSteps: number
}): FogConvergence {
  const { stepMs, budget, chunkSteps } = cfg
  let current: ConvergeRequest | null = null
  let pending = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const tick = (): void => {
    timer = null
    if (current === null) return
    const req = current
    const take = Math.min(chunkSteps, pending)
    for (let i = 0; i < take; i++) {
      req.sim.step(stepMs, req.obstacles, req.scale())
      req.onSubStep()
    }
    pending -= take
    if (pending > 0) {
      timer = setTimeout(tick, 0)
      return
    }
    current = null
    req.onDone()
  }

  return {
    request(req: ConvergeRequest): void {
      current = req
      pending = budget
      timer ??= setTimeout(tick, 0)
    },
    cancel(): void {
      if (timer !== null) clearTimeout(timer)
      timer = null
      current = null
      pending = 0
    },
  }
}
