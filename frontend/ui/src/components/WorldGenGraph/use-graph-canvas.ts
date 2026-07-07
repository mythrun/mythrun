import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  createForceSim,
  VIRTUAL_HEIGHT,
  VIRTUAL_WIDTH,
  type ForceParams,
  type ForceSim,
  type NodeBox,
} from '@mythrun/client-core/worldgen'
import type { FogFieldEntity, GraphEdge, GraphNode } from '@mythrun/client-core/contract'
import { labelBoxExtents } from '../WorldGenFog/fog-obstacles.ts'
import {
  drawEdges,
  drawNodes,
  edgeDrawProgress,
  fogEntitiesFrom,
  type Point,
} from './canvas-draw.ts'
import {
  hasFinePointer,
  nearestKey,
  pointerToLocal,
  resolveInk,
  resolveLabelFont,
  sizeCanvasForDpr,
} from './canvas-util.ts'

// The imperative Canvas controller for WorldGenGraph (MYT-89 C5). Owns the physics
// (a persistent ForceSim in the 900×470 VIRTUAL space — the coordinate space the fog also
// renders in, so a node's glyph and its fog-hole land on one coordinate; the RESOLUTION is
// the pane's full pixels — audit #2), the buoy-bob clock, the rAF render loop, full-res
// sizing, the cached theme ink, and fine-pointer hover/drag (live during generation too —
// audit #5; only tap-to-select is reveal-gated). Everything is guarded on a live 2D
// context, so under jsdom (getContext → null) NOTHING here runs — the a11y entity list is
// the whole testable + accessible surface. The FOLD never runs here: nodes/edges arrive as
// props (the parent folds per SSE event); a change re-syncs.
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
  /** Reveal phase (§3.4): gates ONLY Canvas tap-to-select (`onSelect`). Fine-pointer
   *  hover + drag-to-pin are LIVE regardless (MYT-89 audit #5) — dragging a node through
   *  the fog is the toy, available during generation; only click-to-reveal-info is
   *  reveal-only. */
  interactive: boolean
  /** Draw the node NAME beside each glyph (MYT-89 audit #3). Decoupled from `interactive`
   *  so names show DURING generation too — the fog already reserves a label-sized keep-out
   *  per node, so drawing the name closes that visible mismatch. Type stays shape-only. */
  showLabels: boolean
  /** OVERRIDE the force-sim params — the spread knobs (MYT-89 audit #4) plus the link
   *  clustering knobs (MYT-89 untangle) — merged over `FORCE_PARAMS`. The Storybook
   *  spread-tuning harness passes live slider values; a change RE-SEEDS the sim (fresh
   *  spread). `undefined` in production → the locked defaults. Required-with-
   *  `undefined` (not optional) to match the `selectedKey` idiom under
   *  `exactOptionalPropertyTypes` — WorldGenGraph forwards the prop unconditionally. */
  forceParams: Partial<ForceParams> | undefined
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

/** Create a fresh force-sim in the fog's VIRTUAL space with the given spread overrides
 *  (merged over `FORCE_PARAMS` inside `createForceSim`). Module-scoped so the hook's
 *  `getSim` stays a one-liner. */
function makeSim(params: Partial<ForceParams>): ForceSim {
  return createForceSim({ width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT, params })
}

/** Measure each node's icon+label collision box (keyed by `displayId` for
 *  `ForceSim.setBoxes`). The text width is measured at the resolved DESIGN-SYSTEM label font
 *  (`labelFont` — the SAME string the fog measures and the label is drawn in) and memoized by
 *  name (stable per name+font, matching the fog's own width cache) so `measureText` runs once
 *  per distinct name; the box itself is the fog's shared `labelBoxExtents`, so the graph
 *  collides on the EXACT box the fog reserves. Module-scoped so the hook stays lean. */
function measureBoxes(
  ctx: CanvasRenderingContext2D,
  nodes: readonly GraphNode[],
  widthCache: Map<string, number>,
  labelFont: string,
): Map<string, NodeBox> {
  ctx.font = labelFont
  const out = new Map<string, NodeBox>()
  for (const node of nodes) {
    let width = widthCache.get(node.name)
    if (width === undefined) {
      width = ctx.measureText(node.name).width
      widthCache.set(node.name, width)
    }
    out.set(node.displayId, labelBoxExtents(node.kind, width))
  }
  return out
}

export function useGraphCanvas(params: GraphCanvasParams): GraphCanvas {
  const { canvasRef, nodes, edges, selectedKey, onSelect, reducedMotion, interactive, showLabels } =
    params

  // Latest props/state the imperative closures read (the useLatest idiom): refs so
  // the rAF loop + pointer listeners always see current values without re-binding.
  const simRef = useRef<ForceSim | null>(null)
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const selectedRef = useRef(selectedKey)
  const onSelectRef = useRef(onSelect)
  const reducedRef = useRef(reducedMotion)
  const interactiveRef = useRef(interactive)
  const showLabelsRef = useRef(showLabels)
  const hoverRef = useRef<string | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const sizeRef = useRef({ cssW: 0, cssH: 0 })
  // Memoized label widths (name → measured px at the resolved DS label font) for the collision
  // boxes, mirroring the fog's own width cache so the graph's box and the fog's obstacle derive
  // identical geometry (same font, same widths, one shared `labelBoxExtents`).
  const boxWidthCacheRef = useRef<Map<string, number>>(new Map())
  const inkRef = useRef('') // resolved theme ink, cached (refreshed on mount + theme flip).
  // Resolved DS label font ("`${px}px ${family}`" from `--font-body`/`--text-sm`), cached on
  // first use (family/size don't animate or flip with the theme). The draw, the collision-box
  // measure, and the fog all key off this ONE string, so the reserved box bounds the drawn label.
  const labelFontRef = useRef('')
  const clockRef = useRef(0) // buoy-bob clock (seconds); 0 until the loop runs.
  // C6 Act-2 penstroke state: the ms clock + each edge's first-seen ms (synthKey →
  // appear-time), the draw-in lerps from. Advanced/stamped per frame in the motion loop.
  const edgeDrawRef = useRef<EdgeDrawState>({ clockMs: 0, appear: new Map() })
  const settledRef = useRef(false) // reduced-motion: has the current graph been settled?
  // Latest spread-tuner overrides, normalised to `{}` (never undefined) so `getSim`
  // passes them to `createForceSim` unconditionally under exactOptionalPropertyTypes.
  const forceParamsRef = useRef<Partial<ForceParams>>(params.forceParams ?? {})
  nodesRef.current = nodes
  edgesRef.current = edges
  selectedRef.current = selectedKey
  onSelectRef.current = onSelect
  reducedRef.current = reducedMotion
  interactiveRef.current = interactive
  showLabelsRef.current = showLabels
  forceParamsRef.current = params.forceParams ?? {}

  // The sim lives in the fog's VIRTUAL space (C5 §3.6) — created lazily on first sync
  // with the latest force params. B2's containment (boundary force + distanceMax + per-
  // tick clamp) uses the real virtual dims, so no node draws outside the pane (BUG 2.2).
  const getSim = useCallback((): ForceSim => {
    simRef.current ??= makeSim(forceParamsRef.current)
    return simRef.current
  }, [])

  // Measure every node's icon+label box (the SAME box the fog reserves — `measureBoxes` →
  // `labelBoxExtents`) and hand it to the sim's rectangular collide. A no-op under jsdom (no
  // 2D context → nothing renders, nothing to collide); re-measured on every sync (memoized).
  const applyBoxes = useCallback((): void => {
    const sim = simRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (sim === null || canvas === null || ctx === null) return
    // Lazily resolve-and-cache the DS label font: this LAYOUT effect can run before
    // `applySize`'s passive effect fills the ref, and the box must be measured at the exact
    // font the label is drawn in. Idempotent — whoever runs first caches it.
    labelFontRef.current ||= resolveLabelFont(canvas)
    sim.setBoxes(measureBoxes(ctx, nodesRef.current, boxWidthCacheRef.current, labelFontRef.current))
  }, [canvasRef])

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

  // Size the backing store to the pane AND cache the theme ink — the once-per-mount/resize
  // canvas prep the draw paths share. `resolveInk` reads `getComputedStyle`, which the
  // motion loop used to call EVERY frame (MYT-89 audit #2); caching it here (+ on a theme
  // flip, via the observer below) lets the loop read the ref instead.
  const applySize = useCallback(
    (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void => {
      sizeRef.current = sizeCanvasForDpr(canvas, ctx)
      inkRef.current = resolveInk(canvas)
      labelFontRef.current = resolveLabelFont(canvas)
    },
    [],
  )

  // Draw one frame of the graph (edges + glyphs) in the VIRTUAL space, in the resolved
  // ink. `t` is the bob clock (null under reduced motion → no bob); `showLabels` draws the
  // node name beside each glyph (ON during generation too — MYT-89 audit #3, decoupled
  // from `interactive`).
  const paintFrame = useCallback(
    (ctx: CanvasRenderingContext2D, ink: string): void => {
      ctx.clearRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT)
      ctx.save()
      ctx.translate(VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2)
      ctx.strokeStyle = ink
      ctx.fillStyle = ink
      const positions = getSim().positions()
      paintEdges(ctx, edgesRef.current, positions, edgeDrawRef.current, reducedRef.current)
      drawNodes(ctx, nodesRef.current, positions, {
        selectedKey: selectedRef.current,
        hoverKey: hoverRef.current,
        t: reducedRef.current ? null : clockRef.current,
        showLabels: showLabelsRef.current,
        labelFont: labelFontRef.current,
      })
      ctx.restore()
    },
    [getSim],
  )

  // A single static repaint of the current state (reduced motion + on resize): size
  // the canvas, resolve ink, settle if needed, draw once. No churn, no loop.
  const staticPaint = useCallback((): void => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || ctx === null) return
    applySize(canvas, ctx)
    ensureSettled()
    paintFrame(ctx, inkRef.current)
  }, [canvasRef, applySize, ensureSettled, paintFrame])

  // Spread-tuner re-seed (MYT-89 audit #4): a force-param change RE-SEEDS the sim (fresh
  // spread) rather than merging (which would keep the old settled positions). Keyed on the
  // serialised params; the body is module-scoped (mirrors observeResize/observeThemeInk).
  const forceKey = JSON.stringify(forceParamsRef.current)
  useLayoutEffect(() => {
    reseedOnForceChange({ simRef, getSim, nodesRef, edgesRef, settledRef })
    applyBoxes() // re-attach the measured boxes to the freshly-rebuilt sim.
  }, [forceKey, getSim, applyBoxes])

  // Re-sync the physics whenever the folded graph changes. In a LAYOUT effect (runs
  // before the fog child's effects) so a reduced-motion fog settle reads an already-
  // synced sim; the settle itself is deferred to `ensureSettled` (idempotent).
  useLayoutEffect(() => {
    getSim().sync(nodes, edges)
    applyBoxes()
    settledRef.current = false
  }, [nodes, edges, getSim, applyBoxes])

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
    return startMotionLoop(ctx, { getSim, paintFrame, clockRef, edgesRef, edgeDrawRef, inkRef })
  }, [reducedMotion, canvasRef, applySize, paintFrame, getSim])

  // Fine-pointer interaction: hover-raise + drag-to-pin are LIVE whenever motion is on +
  // a live context + a FINE pointer (MYT-89 audit #5 — dragging a node through the fog is
  // the toy, available DURING generation). Only the tap-to-select `onSelect` call is gated
  // on `interactive` (reveal-only), inside `attachPointerHandlers`. Body at module scope.
  useEffect(() => {
    const deps: PointerDeps = { getSim, sizeRef, hoverRef, dragRef, onSelectRef, interactiveRef }
    return setupPointerHandlers(canvasRef.current, reducedMotion, deps)
  }, [reducedMotion, canvasRef, getSim])

  // Repaint on container resize, honouring the current mode (static vs let-the-loop-
  // handle-it). Mount-only; reads the latest mode via ref. jsdom's ResizeObserver is
  // a no-op shim, so this is inert there.
  useEffect(
    () => observeResize(canvasRef.current, { reducedRef, staticPaint, applySize }),
    [canvasRef, applySize, staticPaint],
  )

  // Re-resolve the cached ink on a light/dark flip (MYT-89 audit #2). Body at module scope.
  useEffect(
    () => observeThemeInk({ canvasRef, inkRef, reducedRef, staticPaint }),
    [canvasRef, staticPaint],
  )

  return { getFogEntities }
}

interface ReseedDeps {
  simRef: React.RefObject<ForceSim | null>
  getSim: () => ForceSim
  nodesRef: React.RefObject<GraphNode[]>
  edgesRef: React.RefObject<GraphEdge[]>
  settledRef: React.RefObject<boolean>
}

/** Spread-tuner re-seed (MYT-89 audit #4): DISPOSE the sim (null the ref) then rebuild it
 *  via `getSim` with the latest force params, re-syncing the current graph — a FRESH spread,
 *  not a merge (which would keep the old settled positions and hide the change). A NO-OP on
 *  mount (`simRef` still null — the graph sync effect does the initial create with these same
 *  params); production never changes forceParams, so this runs once and does nothing. Module-
 *  scoped so the hook body stays lean (mirrors observeResize/observeThemeInk). */
function reseedOnForceChange(deps: ReseedDeps): void {
  const { simRef, getSim, nodesRef, edgesRef, settledRef } = deps
  if (simRef.current === null) return
  simRef.current = null
  getSim().sync(nodesRef.current, edgesRef.current)
  settledRef.current = false
}

interface ThemeInkDeps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  inkRef: React.RefObject<string>
  reducedRef: React.RefObject<boolean>
  staticPaint: () => void
}

/** Re-resolve the cached ink into `inkRef` when the theme flips (the `.dark` class toggling
 *  on `<html>`). The motion loop reads `inkRef` each frame, so it repaints in the new ink on
 *  the next frame; a static (reduced-motion) graph needs an explicit repaint. Returns the
 *  disconnect teardown (or undefined where MutationObserver is absent — jsdom without a
 *  shim). This deterministic signal is what lets the loop CACHE the ink instead of re-reading
 *  `getComputedStyle` every frame (MYT-89 audit #2). Module-scoped so the hook stays lean. */
function observeThemeInk(deps: ThemeInkDeps): (() => void) | undefined {
  const { canvasRef, inkRef, reducedRef, staticPaint } = deps
  if (typeof MutationObserver === 'undefined') return undefined
  const observer = new MutationObserver(() => {
    const canvas = canvasRef.current
    if (canvas !== null) inkRef.current = resolveInk(canvas)
    if (reducedRef.current) staticPaint()
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => {
    observer.disconnect()
  }
}

interface ResizeDeps {
  reducedRef: React.RefObject<boolean>
  staticPaint: () => void
  applySize: (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => void
}

/** Observe container resize and repaint in the current mode (static settle vs re-size-
 *  and-let-the-loop-handle-it). Returns the disconnect teardown (or undefined when
 *  there's no canvas / no ResizeObserver — jsdom). Module-scoped so the hook stays lean. */
function observeResize(
  canvas: HTMLCanvasElement | null,
  deps: ResizeDeps,
): (() => void) | undefined {
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

/** The C6 Act-2 penstroke clock: the ms elapsed since the motion loop started, plus each
 *  edge's first-seen ms (synthKey → appear-time) its draw-in lerps from. One mutable ref. */
interface EdgeDrawState {
  clockMs: number
  appear: Map<string, number>
}

interface MotionLoopDeps {
  getSim: () => ForceSim
  paintFrame: (ctx: CanvasRenderingContext2D, ink: string) => void
  clockRef: React.RefObject<number>
  edgesRef: React.RefObject<GraphEdge[]>
  edgeDrawRef: React.RefObject<EdgeDrawState>
  inkRef: React.RefObject<string>
}

/** Paint the edge layer with the C6 draw-in: each edge reveals as a source→target penstroke
 *  over its stage duration, keyed on its first-seen clock (`state.appear`); reduced motion
 *  and seed edges (`arrivalIndex -1`) resolve to a full line inside `edgeDrawProgress`. */
function paintEdges(
  ctx: CanvasRenderingContext2D,
  edges: readonly GraphEdge[],
  positions: ReadonlyMap<string, Point>,
  state: EdgeDrawState,
  reduced: boolean,
): void {
  drawEdges(ctx, edges, positions, (edge) =>
    edgeDrawProgress(edge, state.appear.get(edge.synthKey), state.clockMs, reduced),
  )
}

/** Stamp each newly-arrived edge's appear-time (C6): the first frame a non-seed edge's
 *  synthKey shows up in the edges array, record the current ms clock so its penstroke
 *  starts here. Because edges arrive incrementally over the SSE stream they self-stagger;
 *  the coherence_pass batch arrives together and snaps together. Seed edges (arrivalIndex
 *  -1) are skipped — they render full immediately, never a draw-in. */
function recordEdgeAppearances(
  edges: readonly GraphEdge[],
  appear: Map<string, number>,
  nowMs: number,
): void {
  for (const edge of edges) {
    if (edge.arrivalIndex < 0) continue
    if (!appear.has(edge.synthKey)) appear.set(edge.synthKey, nowMs)
  }
}

/** Run the rAF loop: each frame advance the clocks, stamp new edges' appear-times, tick
 *  the sim, and repaint the graph (edges drawing in + mono-ink glyphs with the render-only
 *  buoy bob). Returns the cancel teardown. Module-scoped so the hook body stays lean.
 *
 *  The theme ink is read from `inkRef` (cached), NOT re-resolved via `getComputedStyle`
 *  every frame (MYT-89 audit #2 — that per-frame style read was pure waste). The hook's
 *  MutationObserver refreshes the ref on a light/dark flip, so the very next frame
 *  repaints in the new ink — the Canvas (the one surface Tailwind can't reach) still
 *  tracks the theme, without the per-frame cost. */
function startMotionLoop(ctx: CanvasRenderingContext2D, deps: MotionLoopDeps): () => void {
  const { getSim, paintFrame, clockRef, edgesRef, edgeDrawRef, inkRef } = deps
  let raf = 0
  const start = performance.now()
  const frame = (now: number): void => {
    const elapsedMs = now - start
    clockRef.current = elapsedMs / 1000
    edgeDrawRef.current.clockMs = elapsedMs
    recordEdgeAppearances(edgesRef.current, edgeDrawRef.current.appear, elapsedMs)
    getSim().tick()
    paintFrame(ctx, inkRef.current)
    raf = window.requestAnimationFrame(frame)
  }
  raf = window.requestAnimationFrame(frame)
  return () => {
    window.cancelAnimationFrame(raf)
  }
}

export interface PointerDeps {
  getSim: () => ForceSim
  sizeRef: React.RefObject<{ cssW: number; cssH: number }>
  hoverRef: React.RefObject<string | null>
  dragRef: React.RefObject<DragState | null>
  onSelectRef: React.RefObject<(displayId: string) => void>
  /** Gates ONLY tap-to-select (MYT-89 audit #5): a click fires `onSelect` in the reveal
   *  (`true`), but is inert during generation (`false`). Drag-to-pin is live either way. */
  interactiveRef: React.RefObject<boolean>
}

/** Attach the fine-pointer handlers when motion is on, a FINE pointer is present, and the
 *  canvas has a live 2D context; otherwise a no-op (a coarse/touch pointer, reduced motion,
 *  or jsdom → the entity list is the selection surface). Returns the teardown (or undefined).
 *  Module-scoped so the hook body stays lean (mirrors `observeResize`). NOT gated on
 *  `interactive` — drag is live during generation; only `onSelect` is reveal-gated (#5). */
function setupPointerHandlers(
  canvas: HTMLCanvasElement | null,
  reducedMotion: boolean,
  deps: PointerDeps,
): (() => void) | undefined {
  if (reducedMotion || !hasFinePointer() || canvas === null) return undefined
  if (canvas.getContext('2d') === null) return undefined
  return attachPointerHandlers(canvas, deps)
}

/** Wire pointermove/down/up/leave on the canvas; returns the teardown. Split out of
 *  the hook so the effect body stays small and this stays independently readable.
 *  Exported for unit test (jsdom can't drive real pointer capture through the effect). */
export function attachPointerHandlers(canvas: HTMLCanvasElement, deps: PointerDeps): () => void {
  const { getSim, sizeRef, hoverRef, dragRef, onSelectRef, interactiveRef } = deps
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
    if (
      !drag.moved &&
      Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) > DRAG_THRESHOLD
    ) {
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
      getSim().unpin(drag.key) // a tap (not a drag) releases any prior pin, always
      if (interactiveRef.current) onSelectRef.current(drag.key) // …but only selects in the reveal
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
