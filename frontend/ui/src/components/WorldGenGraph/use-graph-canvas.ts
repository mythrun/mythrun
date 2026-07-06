import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  createForceSim,
  VIRTUAL_HEIGHT,
  VIRTUAL_WIDTH,
  type ForceSim,
} from '@mythrun/client-core/worldgen'
import type { FogFieldEntity, GraphEdge, GraphNode } from '@mythrun/client-core/contract'
import { drawEdges, drawNodes, fogEntitiesFrom, type Point } from './canvas-draw.ts'
import {
  hasFinePointer,
  nearestKey,
  pointerToLocal,
  resolveInk,
  sizeCanvasForDpr,
} from './canvas-util.ts'

// The imperative Canvas controller for WorldGenGraph (MYT-89 C5). Owns the physics
// (a persistent ForceSim in the 900×470 VIRTUAL space — the SAME space the fog renders
// in, so a node's glyph and its fog-hole land on one coordinate), the buoy-bob clock,
// the rAF render loop, DPR sizing, and — only in the interactive (reveal) phase —
// fine-pointer hover/drag/select. Everything is guarded on a live 2D context, so under
// jsdom (getContext → null) NOTHING here runs — the a11y entity list is the whole
// testable + accessible surface. The FOLD never runs here: nodes/edges arrive as props
// (the parent folds per SSE event); a change re-syncs.
//
// It ALSO exposes `getFogEntities()` — the live node positions (+ the render-only bob),
// mapped into the fog's VIRTUAL space — which WorldGenGraph feeds to the fog layer each
// frame (C5 decision 3). One force-sim, one bob clock: the obstacles the fog parts
// around are derived from the identical positions the glyphs are drawn at.

/** px radius (VIRTUAL units) a pointer must fall within to hit a node glyph. */
const HIT_RADIUS = 16
/** px (client) a pointer must travel before a press becomes a drag (vs a select tap). */
const DRAG_THRESHOLD = 4
/** Bounded tick count to settle the layout for a static (reduced-motion) redraw. */
const SETTLE_TICKS = 400

interface DragState {
  /** The dragged node's `displayId` (the render/selection id-space). */
  key: string
  moved: boolean
  downX: number
  downY: number
}

export interface GraphCanvasParams {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** The selected node's `displayId`, if any (matches `positions()` / node ids). */
  selectedKey: string | undefined
  onSelect: (displayId: string) => void
  reducedMotion: boolean
  /** Reveal phase (§3.4): shows node labels + attaches fine-pointer selection. During
   *  generation (default `false`) the graph is inert — mono-ink glyphs, no labels, no
   *  Canvas selection (selection belongs to the reveal). */
  interactive: boolean
}

export interface GraphCanvas {
  /** Live node positions (+ the render-only bob) mapped into the fog's VIRTUAL space —
   *  the fog layer's per-frame obstacle source (C5 decision 3). Stable identity. */
  getFogEntities: () => FogFieldEntity[]
}

/** Tick the layout to convergence — a bounded loop (d3's alpha decays), never an
 *  open-ended run; used for the reduced-motion static redraw. */
function settle(sim: ForceSim): void {
  for (let i = 0; i < SETTLE_TICKS; i++) sim.tick()
}

export function useGraphCanvas(params: GraphCanvasParams): GraphCanvas {
  const { canvasRef, nodes, edges, selectedKey, onSelect, reducedMotion, interactive } = params

  // Latest props/state the imperative closures read (the useLatest idiom): refs so
  // the rAF loop + pointer listeners always see current values without re-binding.
  const simRef = useRef<ForceSim | null>(null)
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const selectedRef = useRef(selectedKey)
  const onSelectRef = useRef(onSelect)
  const reducedRef = useRef(reducedMotion)
  const interactiveRef = useRef(interactive)
  const hoverRef = useRef<string | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const sizeRef = useRef({ cssW: 0, cssH: 0 })
  const clockRef = useRef(0) // buoy-bob clock (seconds); 0 until the loop runs.
  const settledRef = useRef(false) // reduced-motion: has the current graph been settled?
  nodesRef.current = nodes
  edgesRef.current = edges
  selectedRef.current = selectedKey
  onSelectRef.current = onSelect
  reducedRef.current = reducedMotion
  interactiveRef.current = interactive

  // The sim lives in the fog's VIRTUAL space (C5 §3.6) — created lazily on first sync.
  // B2's containment (boundary force + distanceMax + per-tick clamp) now uses the real
  // virtual dims, so no node draws outside the CSS-scaled pane (BUG 2.2 in pixels).
  const getSim = useCallback((): ForceSim => {
    simRef.current ??= createForceSim({ width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT })
    return simRef.current
  }, [])

  // Reduced motion: settle the sim to convergence ONCE per graph change, idempotently —
  // whoever reads first (the fog's static settle via getFogEntities, or the graph's own
  // static paint) triggers it; the flag makes the other a no-op, so cross-hook effect
  // ordering doesn't matter. Under motion this never runs (the rAF loop drives tick()).
  const ensureSettled = useCallback((): void => {
    const sim = simRef.current
    if (sim === null || !reducedRef.current || settledRef.current) return
    settle(sim)
    settledRef.current = true
  }, [])

  // Live fog obstacles (C5 decision 3): the current node positions (+ render-only bob,
  // disabled under reduced motion) in the fog's VIRTUAL space — the SAME positions the
  // glyphs are drawn at. Stable identity so the fog effect never re-binds on it.
  const getFogEntities = useCallback((): FogFieldEntity[] => {
    const sim = simRef.current
    if (sim === null) return []
    if (reducedRef.current) ensureSettled()
    const t = reducedRef.current ? null : clockRef.current
    return fogEntitiesFrom(nodesRef.current, sim.positions(), t)
  }, [ensureSettled])

  const applySize = useCallback((canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void => {
    sizeRef.current = sizeCanvasForDpr(canvas, ctx)
  }, [])

  // Draw one frame of the graph (edges + glyphs) in the VIRTUAL space, in the resolved
  // ink. `t` is the bob clock (null under reduced motion → no bob); `interactive`
  // enables the reveal's name labels (OFF during generation — §3.4).
  const paintFrame = useCallback((ctx: CanvasRenderingContext2D, ink: string): void => {
    ctx.clearRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT)
    ctx.save()
    ctx.translate(VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2)
    ctx.strokeStyle = ink
    ctx.fillStyle = ink
    const positions = getSim().positions()
    drawEdges(ctx, edgesRef.current, positions)
    drawNodes(ctx, nodesRef.current, positions, {
      selectedKey: selectedRef.current,
      hoverKey: hoverRef.current,
      t: reducedRef.current ? null : clockRef.current,
      showLabels: interactiveRef.current,
    })
    ctx.restore()
  }, [getSim])

  // A single static repaint of the current state (reduced motion + on resize): size
  // the canvas, resolve ink, settle if needed, draw once. No churn, no loop.
  const staticPaint = useCallback((): void => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || ctx === null) return
    applySize(canvas, ctx)
    ensureSettled()
    paintFrame(ctx, resolveInk(canvas))
  }, [canvasRef, applySize, ensureSettled, paintFrame])

  // Re-sync the physics whenever the folded graph changes. In a LAYOUT effect (runs
  // before the fog child's effects) so a reduced-motion fog settle reads an already-
  // synced sim; the settle itself is deferred to `ensureSettled` (idempotent).
  useLayoutEffect(() => {
    getSim().sync(nodes, edges)
    settledRef.current = false
  }, [nodes, edges, getSim])

  // Reduced-motion static redraw: settle (once) + paint on any graph change. The motion
  // loop that would otherwise pick a change up is off in this mode.
  useEffect(() => {
    if (!reducedMotion) return
    staticPaint()
  }, [nodes, edges, reducedMotion, staticPaint])

  // The motion render loop. Off entirely under reduced motion (and when there's no
  // 2D context — jsdom). The loop body lives in startMotionLoop (module scope).
  useEffect(() => {
    if (reducedMotion) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || ctx === null) return
    applySize(canvas, ctx)
    return startMotionLoop(ctx, canvas, { getSim, paintFrame, clockRef })
  }, [reducedMotion, canvasRef, applySize, paintFrame, getSim])

  // Fine-pointer interaction (reveal only): hover-raise, drag-to-pin, tap-to-select.
  // Attached only when INTERACTIVE + a live context + a FINE pointer + motion on — a
  // coarse (touch) pointer and reduced motion both select via the list. During
  // generation (interactive === false) the Canvas is inert (§3.4 gate).
  useEffect(() => {
    if (!interactive || reducedMotion || !hasFinePointer()) return
    const canvas = canvasRef.current
    if (canvas === null) return
    if (canvas.getContext('2d') === null) return
    return attachPointerHandlers(canvas, {
      getSim,
      sizeRef,
      hoverRef,
      dragRef,
      onSelectRef,
    })
  }, [interactive, reducedMotion, canvasRef, getSim])

  // Repaint on container resize, honouring the current mode (static vs let-the-loop-
  // handle-it). Mount-only; reads the latest mode via ref. jsdom's ResizeObserver is
  // a no-op shim, so this is inert there.
  useEffect(
    () => observeResize(canvasRef.current, { reducedRef, staticPaint, applySize }),
    [canvasRef, applySize, staticPaint],
  )

  return { getFogEntities }
}

interface ResizeDeps {
  reducedRef: React.RefObject<boolean>
  staticPaint: () => void
  applySize: (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => void
}

/** Observe container resize and repaint in the current mode (static settle vs re-size-
 *  and-let-the-loop-handle-it). Returns the disconnect teardown (or undefined when
 *  there's no canvas / no ResizeObserver — jsdom). Module-scoped so the hook stays lean. */
function observeResize(canvas: HTMLCanvasElement | null, deps: ResizeDeps): (() => void) | undefined {
  const { reducedRef, staticPaint, applySize } = deps
  if (canvas === null || typeof ResizeObserver === 'undefined') return undefined
  const observer = new ResizeObserver(() => {
    if (reducedRef.current) {
      staticPaint()
      return
    }
    const ctx = canvas.getContext('2d')
    if (ctx !== null) applySize(canvas, ctx)
  })
  observer.observe(canvas)
  return () => {
    observer.disconnect()
  }
}

interface MotionLoopDeps {
  getSim: () => ForceSim
  paintFrame: (ctx: CanvasRenderingContext2D, ink: string) => void
  clockRef: React.RefObject<number>
}

/** Run the rAF loop: each frame advance the bob clock, tick the sim, and repaint the
 *  graph (edges + mono-ink glyphs with the render-only buoy bob). Returns the cancel
 *  teardown. Module-scoped so the hook body stays lean.
 *
 *  The theme ink is re-resolved EACH frame (not captured once) so a light/dark toggle
 *  mid-generation repaints the Canvas immediately — the Canvas is the one surface
 *  Tailwind can't reach, and a captured ink would stay stale until remount. A single
 *  computed-style read per frame is the accepted cost (C4 review). */
function startMotionLoop(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  deps: MotionLoopDeps,
): () => void {
  const { getSim, paintFrame, clockRef } = deps
  let raf = 0
  const start = performance.now()
  const frame = (now: number): void => {
    clockRef.current = (now - start) / 1000
    getSim().tick()
    paintFrame(ctx, resolveInk(canvas))
    raf = window.requestAnimationFrame(frame)
  }
  raf = window.requestAnimationFrame(frame)
  return () => {
    window.cancelAnimationFrame(raf)
  }
}

interface PointerDeps {
  getSim: () => ForceSim
  sizeRef: React.RefObject<{ cssW: number; cssH: number }>
  hoverRef: React.RefObject<string | null>
  dragRef: React.RefObject<DragState | null>
  onSelectRef: React.RefObject<(displayId: string) => void>
}

/** Wire pointermove/down/up/leave on the canvas; returns the teardown. Split out of
 *  the hook so the effect body stays small and this stays independently readable. */
function attachPointerHandlers(canvas: HTMLCanvasElement, deps: PointerDeps): () => void {
  const { getSim, sizeRef, hoverRef, dragRef, onSelectRef } = deps
  const localOf = (e: PointerEvent): Point =>
    pointerToLocal(e, canvas, sizeRef.current.cssW, sizeRef.current.cssH)

  const onDown = (e: PointerEvent): void => {
    const key = nearestKey(getSim().positions(), localOf(e), HIT_RADIUS)
    if (key === null) return
    dragRef.current = { key, moved: false, downX: e.clientX, downY: e.clientY }
    canvas.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent): void => {
    const drag = dragRef.current
    if (drag === null) {
      hoverRef.current = nearestKey(getSim().positions(), localOf(e), HIT_RADIUS)
      return
    }
    if (!drag.moved && Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) > DRAG_THRESHOLD) {
      drag.moved = true
    }
    if (drag.moved) {
      const local = localOf(e)
      getSim().pin(drag.key, local.x, local.y)
    }
  }
  const onUp = (): void => {
    const drag = dragRef.current
    if (drag === null) return
    if (!drag.moved) {
      getSim().unpin(drag.key) // a tap (not a drag) selects + releases any prior pin
      onSelectRef.current(drag.key)
    }
    dragRef.current = null
  }
  const onLeave = (): void => {
    hoverRef.current = null
  }

  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointerleave', onLeave)
  return () => {
    canvas.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('pointerup', onUp)
    canvas.removeEventListener('pointerleave', onLeave)
  }
}
