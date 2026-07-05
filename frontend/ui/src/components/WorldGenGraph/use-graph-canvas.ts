import { useCallback, useEffect, useRef } from 'react'
import { createForceSim, type ForceSim } from '@mythrun/client-core/worldgen'
import type { GraphEdge, GraphNode } from '@mythrun/client-core/contract'
import { GhostBloomField } from './GhostBloomField.ts'
import { drawEdges, drawNodes, type Point } from './canvas-draw.ts'
import {
  hasFinePointer,
  nearestKey,
  pointerToLocal,
  resolveInk,
  sizeCanvasForDpr,
} from './canvas-util.ts'

// The imperative Canvas controller for WorldGenGraph (MYT-89 C4). Owns the physics
// (a persistent ForceSim), the ambient churn (a GhostBloomField), the rAF render
// loop, DPR sizing, and fine-pointer hover/drag/select. Everything is guarded on a
// live 2D context, so under jsdom (getContext → null) NOTHING here runs — the a11y
// entity list is the whole testable + accessible surface. The FOLD never runs here:
// nodes/edges arrive as props (the parent folds per SSE event); a change re-syncs.

/** px radius a pointer must fall within to hit a node glyph. */
const HIT_RADIUS = 16
/** px a pointer must travel before a press becomes a drag (vs a select tap). */
const DRAG_THRESHOLD = 4
/** Bounded tick count to settle the layout for a static (reduced-motion) redraw. */
const SETTLE_TICKS = 400

interface DragState {
  key: string
  moved: boolean
  downX: number
  downY: number
}

export interface GraphCanvasParams {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  nodes: GraphNode[]
  edges: GraphEdge[]
  selectedKey: string | undefined
  onSelect: (synthKey: string) => void
  reducedMotion: boolean
}

/** Tick the layout to convergence — a bounded loop (d3's alpha decays), never an
 *  open-ended run; used for the reduced-motion static redraw. */
function settle(sim: ForceSim): void {
  for (let i = 0; i < SETTLE_TICKS; i++) sim.tick()
}

export function useGraphCanvas(params: GraphCanvasParams): void {
  const { canvasRef, nodes, edges, selectedKey, onSelect, reducedMotion } = params

  // Latest props/state the imperative closures read (the useLatest idiom): refs so
  // the rAF loop + pointer listeners always see current values without re-binding.
  const simRef = useRef<ForceSim | null>(null)
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const selectedRef = useRef(selectedKey)
  const onSelectRef = useRef(onSelect)
  const reducedRef = useRef(reducedMotion)
  const hoverRef = useRef<string | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const sizeRef = useRef({ cssW: 0, cssH: 0 })
  nodesRef.current = nodes
  edgesRef.current = edges
  selectedRef.current = selectedKey
  onSelectRef.current = onSelect
  reducedRef.current = reducedMotion

  const getSim = useCallback((): ForceSim => {
    simRef.current ??= createForceSim()
    return simRef.current
  }, [])

  const applySize = useCallback((canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void => {
    sizeRef.current = sizeCanvasForDpr(canvas, ctx)
  }, [])

  // Draw one frame of the graph (edges + glyphs), centred, in the resolved ink.
  // Returns the node anchor points so the caller can cluster ghost churn near them.
  const paintFrame = useCallback((ctx: CanvasRenderingContext2D, ink: string): Point[] => {
    const { cssW, cssH } = sizeRef.current
    ctx.clearRect(0, 0, cssW, cssH)
    ctx.save()
    ctx.translate(cssW / 2, cssH / 2)
    ctx.strokeStyle = ink
    ctx.fillStyle = ink
    const positions = getSim().positions()
    drawEdges(ctx, edgesRef.current, positions)
    const points = drawNodes(ctx, nodesRef.current, positions, {
      selectedKey: selectedRef.current,
      hoverKey: hoverRef.current,
    })
    ctx.restore()
    return points
  }, [getSim])

  // A single static repaint of the current state (reduced motion + on resize): size
  // the canvas, resolve ink, draw once. No ghost churn, no loop.
  const staticPaint = useCallback((): void => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || ctx === null) return
    applySize(canvas, ctx)
    paintFrame(ctx, resolveInk(canvas))
  }, [canvasRef, applySize, paintFrame])

  // Re-sync the physics whenever the folded graph changes; in reduced motion also
  // settle + repaint statically (the loop that would otherwise pick it up is off).
  useEffect(() => {
    const sim = getSim()
    sim.sync(nodes, edges)
    if (!reducedMotion) return
    settle(sim)
    staticPaint()
  }, [nodes, edges, reducedMotion, getSim, staticPaint])

  // The motion render loop. Off entirely under reduced motion (and when there's no
  // 2D context — jsdom). The loop body lives in startMotionLoop (module scope).
  useEffect(() => {
    if (reducedMotion) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || ctx === null) return
    applySize(canvas, ctx)
    return startMotionLoop(ctx, resolveInk(canvas), { getSim, paintFrame, sizeRef })
  }, [reducedMotion, canvasRef, applySize, paintFrame, getSim])

  // Fine-pointer interaction: hover-raise, drag-to-pin, tap-to-select. Attached only
  // with a live context + a FINE pointer + motion on — a coarse (touch) pointer and
  // reduced motion both select via the list, never the Canvas.
  useEffect(() => {
    if (reducedMotion || !hasFinePointer()) return
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
  }, [reducedMotion, canvasRef, getSim])

  // Repaint on container resize, honouring the current mode (static vs let-the-loop-
  // handle-it). Mount-only; reads the latest mode via ref. jsdom's ResizeObserver is
  // a no-op shim, so this is inert there.
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || typeof ResizeObserver === 'undefined') return
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
  }, [canvasRef, applySize, staticPaint])
}

interface MotionLoopDeps {
  getSim: () => ForceSim
  paintFrame: (ctx: CanvasRenderingContext2D, ink: string) => Point[]
  sizeRef: React.RefObject<{ cssW: number; cssH: number }>
}

/** Run the rAF churn loop: each frame tick the sim, repaint the graph, then spawn +
 *  render ambient ghost blooms near the node points. Returns the cancel teardown.
 *  Module-scoped so the hook body stays lean. */
function startMotionLoop(
  ctx: CanvasRenderingContext2D,
  ink: string,
  deps: MotionLoopDeps,
): () => void {
  const { getSim, paintFrame, sizeRef } = deps
  const ghost = new GhostBloomField()
  let raf = 0
  let last = 0
  const frame = (now: number): void => {
    getSim().tick()
    const points = paintFrame(ctx, ink)
    const dt = last === 0 ? 16 : now - last
    last = now
    const { cssW, cssH } = sizeRef.current
    ctx.save()
    ctx.translate(cssW / 2, cssH / 2)
    ctx.fillStyle = ink
    ghost.spawn(dt, points)
    ghost.update(now)
    ghost.render(ctx)
    ctx.restore()
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
  onSelectRef: React.RefObject<(synthKey: string) => void>
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
