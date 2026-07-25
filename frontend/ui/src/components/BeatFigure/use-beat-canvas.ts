import { useEffect, useRef } from 'react'
import {
  CELL_PX,
  FRONT_BAND,
  IDLE_PULSE_MS,
  SHIMMER_MS,
  STEP_MS,
  BREATHE_MS,
  advanceSchedule,
  frontColFor,
  litAt,
  litBreatheAt,
  litIdleAt,
} from './develop.ts'

// The imperative Canvas controller for BeatFigure — the loading-beat family's full-width
// quantized dither meter / breathing field. Mirrors the WorldGenFog canvas idiom: a single
// decorative canvas, measured with a ResizeObserver, driven by one rAF loop, its ink color
// resolved from the token layer via getComputedStyle, and EVERYTHING guarded on a live 2D
// context — under jsdom (`getContext` → null) nothing here runs, so the component is an inert
// aria-hidden layer and its tests stay light (no animated DOM). The pure wave/threshold math
// lives in develop.ts (unit-tested); this hook is the glue: sizing, timing, and the two
// honest channels (position advances in quantized frames; the front band shimmers in place).

/** Device-pixel-ratio cap — a full-width dither band needs no more than 3× sampling, and it
 *  bounds the backing store on absurd-DPR displays. */
const DPR_CAP = 3

/** How much to jitter the per-frame dwell around STEP_MS (±ms) so the advance doesn't tick
 *  metronomically (grammar: ~90–110ms). */
const STEP_JITTER_MS = 12

/** Breathing repaint cadence (ms) — the density sweeps slowly, so ~30fps is smooth and calm
 *  (and cheap). The idle shimmer shares it. */
const BREATHE_FRAME_MS = 33

/** `idle` (ux-run3 myth-c96rf) is the nearly blank zero-state for ACCRETING surfaces — a
 *  faint pulse at the fill's origin, cell-wise emptier than any accretion state, so the
 *  idle→fill handoff reads as a beginning. `breathe` remains the no-progress ambient hold. */
export type BeatMode = 'fill' | 'breathe' | 'idle'

export interface BeatCanvasParams {
  /** The measured wrapper (the canvas's box); its client width drives the column count. */
  wrapRef: React.RefObject<HTMLDivElement | null>
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  mode: BeatMode
  /** Fill mode only: the 0..1 target progress. Ignored in breathe mode. */
  level: number
  /** Meter height in cells. */
  rows: number
  reducedMotion: boolean
  /** CSS custom-property name for the lit-cell (ink) color — resolved against the token
   *  layer each (re)paint so a theme flip / tokened variant is picked up. */
  inkVar: string
}

/** Resolve the ink color from the token layer (frozen `--color-paper-900` by default, or a
 *  theme-flipping `--ink` for the tokened variant). Empty string under jsdom → caller skips. */
function resolveInk(el: Element, inkVar: string): string {
  return getComputedStyle(el).getPropertyValue(inkVar).trim()
}

/** Size state: the column count and the whole-device-pixel cell edge, derived from the
 *  wrapper's client width and the DPR. */
interface Sizing {
  cols: number
  deviceCell: number
}

/** Measure the wrapper → columns (ceil, so the band reaches the right edge; the overflow of
 *  the last partial cell is clipped by the wrapper) + a whole-device-pixel cell, and size the
 *  canvas backing store (device px) and CSS box (cols·CELL_PX, so backing maps ~1:1×DPR and
 *  the cells stay crisp). Returns the sizing, or null when unmeasurable (zero width). */
function sizeCanvas(wrap: HTMLElement, canvas: HTMLCanvasElement, rows: number): Sizing | null {
  const cssW = wrap.clientWidth
  if (cssW <= 0) return null
  const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1)
  const deviceCell = Math.max(1, Math.round(CELL_PX * dpr))
  const cols = Math.ceil(cssW / CELL_PX)
  canvas.width = cols * deviceCell
  canvas.height = rows * deviceCell
  canvas.style.width = `${String(cols * CELL_PX)}px`
  canvas.style.height = `${String(rows * CELL_PX)}px`
  return { cols, deviceCell }
}

/** Paint the fill meter: solid locked ink behind the front, a shimmering dithered band at the
 *  front (`seed`), paper ahead. Clears first; one fillRect per lit cell. */
function paintFill(
  ctx: CanvasRenderingContext2D,
  size: Sizing,
  rows: number,
  frontX: number,
  seed: number,
  ink: string,
): void {
  const { cols, deviceCell } = size
  ctx.clearRect(0, 0, cols * deviceCell, rows * deviceCell)
  ctx.fillStyle = ink
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (litAt(x, y, frontX, seed)) ctx.fillRect(x * deviceCell, y * deviceCell, deviceCell, deviceCell)
    }
  }
}

/** Paint the breathing field at normalized time `T`: per-cell density from the traveling
 *  envelope, grain stable within a breath and re-seeded per cycle. */
function paintBreathe(ctx: CanvasRenderingContext2D, size: Sizing, rows: number, T: number, ink: string): void {
  const { cols, deviceCell } = size
  ctx.clearRect(0, 0, cols * deviceCell, rows * deviceCell)
  ctx.fillStyle = ink
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (litBreatheAt(x, y, cols, rows, T)) ctx.fillRect(x * deviceCell, y * deviceCell, deviceCell, deviceCell)
    }
  }
}

/** Paint the idle zero-state at normalized time `T`: the faint pulsing shimmer at the fill's
 *  origin — the seat columns only; everything else stays paper. */
function paintIdle(ctx: CanvasRenderingContext2D, size: Sizing, rows: number, T: number, ink: string): void {
  const { cols, deviceCell } = size
  ctx.clearRect(0, 0, cols * deviceCell, rows * deviceCell)
  ctx.fillStyle = ink
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (litIdleAt(x, y, T)) ctx.fillRect(x * deviceCell, y * deviceCell, deviceCell, deviceCell)
    }
  }
}

/** The mutable driver state the rAF loop threads across frames (no React setState per frame). */
interface FillDriver {
  front: number
  queue: number[]
  lastStepAt: number
  stepMs: number
  lastShimmerAt: number
  seed: number
}

/** Advance the fill driver one frame at time `now`: schedule a decelerating advance when the
 *  target front has moved (never backward — a fill can't regress; a level-1 landing appends a
 *  one-frame solid OVERSHOOT then settles to the textured edge), consume the schedule on the
 *  dwell cadence, and otherwise re-seed the front band on the shimmer cadence. Returns whether
 *  a repaint is needed this frame. */
function stepFill(d: FillDriver, target: number, cols: number, now: number): boolean {
  if (d.queue.length === 0 && Math.abs(target - d.front) > 1e-3) {
    if (target < d.front) {
      d.front = target
      return true
    }
    d.queue = advanceSchedule(d.front, target)
    // Grammar: a fill that lands at 100% gets ONE overshoot-and-settle frame — solidify the
    // whole band edge-to-edge, then relax back to the soft dithered finish.
    if (target >= cols - 1e-3) d.queue.push(cols + FRONT_BAND, cols)
  }
  if (d.queue.length > 0) {
    if (now - d.lastStepAt >= d.stepMs) {
      d.front = d.queue.shift() ?? d.front
      d.lastStepAt = now
      d.lastShimmerAt = now
      d.stepMs = STEP_MS + (Math.random() * 2 - 1) * STEP_JITTER_MS
      return true
    }
    return false
  }
  if (now - d.lastShimmerAt >= SHIMMER_MS) {
    d.seed = (d.seed + 1) >>> 0
    d.lastShimmerAt = now
    return true
  }
  return false
}

export function useBeatCanvas(params: BeatCanvasParams): void {
  const { wrapRef, canvasRef, mode, level, rows, reducedMotion, inkVar } = params

  // Latest props the imperative loop reads (useLatest idiom) so a level/theme change needs no
  // loop re-bind.
  const levelRef = useRef(level)
  const inkVarRef = useRef(inkVar)
  const sizeRef = useRef<Sizing | null>(null)
  const driverRef = useRef<FillDriver>({ front: 0, queue: [], lastStepAt: 0, stepMs: STEP_MS, lastShimmerAt: 0, seed: 0 })
  levelRef.current = level
  inkVarRef.current = inkVar

  // Paint the current static frame (reduced motion, or the pre-loop first frame): the fill at
  // its exact level with a frozen front-band seed, or the breath frozen at a mid-swell.
  function paintStatic(): void {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || wrap === null || ctx === null) return
    const size = sizeCanvas(wrap, canvas, rows)
    sizeRef.current = size
    if (size === null) return
    const ink = resolveInk(canvas, inkVarRef.current)
    if (ink === '') return
    if (mode === 'breathe') {
      paintBreathe(ctx, size, rows, 0.4, ink)
    } else if (mode === 'idle') {
      // Frozen at the pulse crest — the legible (still nearly blank) idle frame.
      paintIdle(ctx, size, rows, 0.5, ink)
    } else {
      const front = frontColFor(levelRef.current, size.cols)
      driverRef.current.front = front
      paintFill(ctx, size, rows, front, 0, ink)
    }
  }

  // Re-measure + repaint on container resize (and the initial measure). Inert under jsdom (no
  // ctx / the ResizeObserver shim never fires with a real size). Under motion the running loop
  // reads the new sizing next frame; under reduced motion we repaint the static frame here.
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || wrap === null || ctx === null) return
    const remeasure = (): void => {
      const size = sizeCanvas(wrap, canvas, rows)
      sizeRef.current = size
      if (reducedMotion) paintStatic()
    }
    remeasure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(remeasure)
    observer.observe(wrap)
    return () => {
      observer.disconnect()
    }
    // paintStatic closes over the current mode/rows/level (level via levelRef); re-bind when the
    // structural inputs change. (exhaustive-deps is not enforced in this package's config.)
  }, [canvasRef, wrapRef, rows, mode, reducedMotion])

  // Reduced motion: no loop — paint one legible static frame (and repaint on any level/theme
  // change). Position lands instantly; the front band is frozen at its density.
  useEffect(() => {
    if (!reducedMotion) return
    paintStatic()
  }, [reducedMotion, mode, level, rows, inkVar])

  // The motion loop: one rAF that either drives the quantized fill (advance + shimmer) or the
  // breathing sweep. Off under reduced motion and with no 2D context (jsdom).
  useEffect(() => {
    if (reducedMotion) return
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || wrap === null || ctx === null) return

    // Ensure a sizing exists before the first frame (the resize effect may not have run yet).
    sizeRef.current ??= sizeCanvas(wrap, canvas, rows)
    const d = driverRef.current
    // Never jump AHEAD on a (re)bind: keep the driver at (or below) the target so the fill
    // ANIMATES in from where it stood — the idle→fill handoff advances from the empty track
    // (a beginning), and a remount replays a quick catch-up accrete instead of snapping
    // (ux-run3 myth-c96rf).
    d.front = Math.min(d.front, frontColFor(levelRef.current, sizeRef.current?.cols ?? 0))
    d.queue = []

    let raf = 0
    let start: number | null = null
    let lastBreatheAt = 0
    const tick = (now: number): void => {
      start ??= now
      const size = sizeRef.current
      const ink = resolveInk(canvas, inkVarRef.current)
      if (size !== null && ink !== '') {
        if (mode === 'breathe') {
          if (now - lastBreatheAt >= BREATHE_FRAME_MS) {
            lastBreatheAt = now
            paintBreathe(ctx, size, rows, (now - start) / BREATHE_MS, ink)
          }
        } else if (mode === 'idle') {
          if (now - lastBreatheAt >= BREATHE_FRAME_MS) {
            lastBreatheAt = now
            paintIdle(ctx, size, rows, (now - start) / IDLE_PULSE_MS, ink)
          }
        } else {
          const target = frontColFor(levelRef.current, size.cols)
          if (stepFill(d, target, size.cols, now)) paintFill(ctx, size, rows, d.front, d.seed, ink)
        }
      }
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(raf)
    }
    // level/inkVar are read live via refs, so they are intentionally not deps (the loop needn't
    // re-bind when they change). (exhaustive-deps is not enforced in this package's config.)
  }, [reducedMotion, mode, rows, canvasRef, wrapRef])
}
