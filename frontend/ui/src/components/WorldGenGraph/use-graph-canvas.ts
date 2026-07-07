import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  createForceSim,
  growthFrom,
  virtualDims,
  VIRTUAL_HEIGHT,
  VIRTUAL_WIDTH,
  type DensityParams,
  type ForceParams,
  type ForceSim,
  type StaticKeepOut,
  type VirtualDims,
  type VirtualGrowth,
} from '@mythrun/client-core/worldgen'
import type { FogFieldEntity, GraphEdge, GraphNode } from '@mythrun/client-core/contract'
import {
  drawEdges,
  drawNodes,
  edgeDrawProgress,
  fogEntitiesFrom,
  type Point,
} from './canvas-draw.ts'
import {
  measureNodeBoxes,
  refreshLabeled,
  syncCardKeepOut,
  type LabelStateRefs,
} from './graph-label-state.ts'
import {
  resolveEdgeInk,
  resolveInk,
  resolveLabelFont,
  resolvePaper,
  sizeCanvasForDpr,
} from './canvas-util.ts'
import { setupPointerHandlers, type DragState, type PointerDeps } from './pointer-handlers.ts'

// The imperative Canvas controller for WorldGenGraph (MYT-89 C5). Owns the physics
// (a persistent ForceSim in the shared PANE-ADAPTIVE virtual space — `virtualDims`, the
// coordinate space the fog also renders in, so a node's glyph and its fog-hole land on
// one coordinate at every pane size; the RESOLUTION is the pane's full pixels — audit
// #2), the buoy-bob clock, the rAF render loop, full-res
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

/** Bounded tick count to settle the layout for a static (reduced-motion) redraw. */
const SETTLE_TICKS = 400

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
  /** OVERRIDE the density knobs (MYT-89 density redesign — label tiering + virtual-
   *  space growth), merged over `DENSITY_PARAMS`. The density-tuning story passes live
   *  slider values; `undefined` in production → the locked defaults. Same
   *  required-with-`undefined` idiom as `forceParams`. */
  densityParams: Partial<DensityParams> | undefined
  /** The status-card overlay's element (when the card is shown): its footprint becomes
   *  a STATIC keep-out rect in the sim, so nodes/names never spend the generation
   *  occluded under the card (on a phone it spans ~70% of the pane width). `null`/
   *  absent element → no keep-out (the reveal has no card). */
  keepOutRef: React.RefObject<HTMLElement | null> | undefined
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

/** Create a fresh force-sim in the shared VIRTUAL space at the CURRENT pane-adaptive
 *  dims, with the given spread overrides (merged over `FORCE_PARAMS` inside
 *  `createForceSim`). Module-scoped so the hook's `getSim` stays lean. */
function makeSim(params: Partial<ForceParams>, virtual: VirtualDims): ForceSim {
  return createForceSim({ width: virtual.width, height: virtual.height, params })
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
  // The sticky tap/click focus (MYT-89 density redesign): the focused node is drawn
  // raised and ALWAYS labeled — the coarse-pointer "show me this one's name" surface.
  const focusRef = useRef<string | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const sizeRef = useRef({ cssW: 0, cssH: 0 })
  // The CURRENT pane-adaptive virtual dims (MYT-89 responsive fix) — the shared space
  // the sim, the draw, the pointer mapping, and the fog-entity mapping all speak.
  // Starts at the reference dims (the jsdom/unmeasured fallback `virtualDims` also
  // returns) and follows the pane via `syncVirtual`.
  const virtualRef = useRef<VirtualDims>({ width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT })
  // Memoized label widths (name → measured px at the resolved DS label font) for the collision
  // boxes, mirroring the fog's own width cache so the graph's box and the fog's obstacle derive
  // identical geometry (same font, same widths, one shared `labelBoxExtents`).
  const boxWidthCacheRef = useRef<Map<string, number>>(new Map())
  const inkRef = useRef('') // resolved theme ink, cached (refreshed on mount + theme flip).
  // The lighter EDGE ink (`--ink-tertiary` — resolveEdgeInk): the connection strings
  // stroke a step LIGHTER than the label text so names read over crossing lines.
  const edgeInkRef = useRef('')
  // The PAPER colour (`--bg`) — the label text's cartographic halo ink (the name is
  // stroked in paper before its ink fill, so edge lines never strike through a name).
  const paperRef = useRef('')
  // Label tiering (MYT-89 density redesign): WHICH nodes wear their name right now —
  // anchors + the freshest arrivals within the area budget + the selection/focus pins.
  // Recomputed via `refreshLabels` whenever an input moves; read by the draw, the
  // collision measure, and the fog-entity mapping (one set, three surfaces).
  const labeledRef = useRef<ReadonlySet<string>>(new Set<string>())
  const densityRef = useRef<Partial<DensityParams>>(params.densityParams ?? {})
  // Density-aware growth for `virtualDims` (recomputed every render — cheap, pure):
  // the SAME derivation WorldGenGraph hands the fog, so the layers agree (C5).
  const growthRef = useRef<VirtualGrowth>(growthFrom(0))
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
  densityRef.current = params.densityParams ?? {}
  growthRef.current = growthFrom(nodes.length, densityRef.current)

  // Track the pane → virtual dims (MYT-89 responsive fix): measure the canvas box,
  // derive the shared virtual space via `virtualDims` (+ the density-aware growth —
  // the space widens with the node count), and on a CHANGE re-size the live sim (the
  // containment bounds follow) + drop the reduced-motion settle flag so a static graph
  // re-settles into the new space. The fog hook derives its dims from the SAME pane
  // box through the SAME function with the SAME growth, so the two layers agree (C5)
  // at any size and any density. Returns whether the dims changed (the caller re-sizes
  // the backing store). Body at module scope (`trackVirtualDims`).
  const syncVirtual = useCallback(
    (): boolean => trackVirtualDims({ canvasRef, virtualRef, simRef, settledRef, growthRef }),
    [canvasRef],
  )

  // The sim lives in the fog's VIRTUAL space (C5 §3.6 — pane-adaptive) — created lazily
  // on first sync with the latest force params AT the measured dims. B2's containment
  // (boundary force + distanceMax + per-tick clamp) uses the real virtual dims, so no
  // node draws outside the pane (BUG 2.2) at any pane size.
  const getSim = useCallback((): ForceSim => {
    if (simRef.current === null) {
      syncVirtual()
      simRef.current = makeSim(forceParamsRef.current, virtualRef.current)
    }
    return simRef.current
  }, [syncVirtual])

  // The last keep-out handed to the sim (sub-pixel-jitter guard: `setKeepOuts` reheats,
  // so it only runs when the card's measured box actually MOVES). Feeds the label
  // budget too (the card's area is reserved — no labels issued into it).
  const lastKeepOutRef = useRef<StaticKeepOut | null>(null)

  // Recompute WHICH nodes wear their name (label tiering — anchors + the freshest
  // arrivals within the area budget + the selection/focus pins). Stable identity; the
  // refs bundle lets the pointer callbacks re-run it imperatively (a tap focus).
  const labelRefs: LabelStateRefs = {
    nodesRef,
    virtualRef,
    selectedRef,
    focusRef,
    densityRef,
    keepOutRef: lastKeepOutRef,
    labeledRef,
  }
  const labelRefsRef = useRef(labelRefs)
  labelRefsRef.current = labelRefs
  const refreshLabels = useCallback((): void => {
    refreshLabeled(labelRefsRef.current)
  }, [])

  // The status-card keep-out (density redesign): measure the card into a sim keep-out
  // + reserve its area from the label budget. Body at module scope (graph-label-state's
  // `syncCardKeepOut`); re-run on graph syncs + sizes; a no-op when the box hasn't moved.
  const keepOutElRef = params.keepOutRef
  const syncKeepOuts = useCallback((): void => {
    syncCardKeepOut({
      canvas: canvasRef.current,
      sim: simRef.current,
      card: keepOutElRef?.current ?? null,
      virtual: virtualRef.current,
      labelRefs: labelRefsRef.current,
      settledRef,
    })
  }, [canvasRef, keepOutElRef])


  // Measure every node's CURRENT keep-out box (the SAME box the fog reserves —
  // `measureNodeBoxes` → `nodeBoxExtents`: icon+label when the name is worn, icon-only
  // when it isn't) and hand it to the sim's rectangular collide. A no-op under jsdom (no
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
    sim.setBoxes(
      measureNodeBoxes(ctx, nodesRef.current, labeledRef.current, boxWidthCacheRef.current, labelFontRef.current),
    )
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
    return fogEntitiesFrom(nodesRef.current, sim.positions(), t, virtualRef.current, labeledRef.current)
  }, [ensureSettled])

  // Size the backing store to the pane AND cache the theme ink — the once-per-mount/resize
  // canvas prep the draw paths share. `syncVirtual` FIRST: the virtual dims follow the
  // pane (the sim's containment re-derives on a change), then the backing-store transform
  // maps that fresh virtual space onto the pane pixels. `resolveInk` reads
  // `getComputedStyle`, which the motion loop used to call EVERY frame (MYT-89 audit #2);
  // caching it here (+ on a theme flip, via the observer below) lets the loop read the
  // ref instead.
  const applySize = useCallback(
    (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void => {
      syncVirtual()
      sizeRef.current = sizeCanvasForDpr(canvas, ctx, virtualRef.current)
      inkRef.current = resolveInk(canvas)
      edgeInkRef.current = resolveEdgeInk(canvas)
      paperRef.current = resolvePaper(canvas)
      labelFontRef.current = resolveLabelFont(canvas)
    },
    [syncVirtual],
  )

  // Draw one frame of the graph (edges + glyphs) in the VIRTUAL space. Edges stroke in
  // the LIGHTER edge ink (`--ink-tertiary`) so the connection strings sit under the
  // text; glyphs + labels in the full ink. `t` is the bob clock (null under reduced
  // motion → no bob); `showLabels` draws the node name beside each glyph (ON during
  // generation too — MYT-89 audit #3), gated per node by the label tier (`labeled`).
  const paintFrame = useCallback(
    (ctx: CanvasRenderingContext2D, ink: string): void => {
      const virtual = virtualRef.current
      ctx.clearRect(0, 0, virtual.width, virtual.height)
      ctx.save()
      ctx.translate(virtual.width / 2, virtual.height / 2)
      const positions = getSim().positions()
      ctx.strokeStyle = edgeInkRef.current || ink
      paintEdges(ctx, edgesRef.current, positions, edgeDrawRef.current, reducedRef.current)
      ctx.strokeStyle = ink
      ctx.fillStyle = ink
      drawNodes(ctx, nodesRef.current, positions, {
        selectedKey: selectedRef.current,
        hoverKey: hoverRef.current,
        focusKey: focusRef.current,
        t: reducedRef.current ? null : clockRef.current,
        showLabels: showLabelsRef.current,
        labeled: labeledRef.current,
        labelFont: labelFontRef.current,
        paper: paperRef.current,
        virtual,
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
  // ORDER matters: the density growth may re-derive the virtual space (the world grows
  // with the node count), the label tier depends on that area, and the boxes depend on
  // the tier — dims → labels → sync → boxes. A dims change also re-sizes the backing
  // store (the virtual→pane transform moved) via `applySize` under motion; the
  // reduced-motion static repaint effect below re-sizes through `staticPaint`.
  useLayoutEffect(() => {
    const dimsChanged = syncVirtual()
    refreshLabels()
    getSim().sync(nodes, edges)
    applyBoxes()
    syncKeepOuts()
    settledRef.current = false
    if (dimsChanged && !reducedRef.current) {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d') ?? null
      if (canvas !== null && ctx !== null) applySize(canvas, ctx)
    }
  }, [nodes, edges, getSim, applyBoxes, syncVirtual, refreshLabels, applySize, syncKeepOuts, canvasRef])

  // Selection promotes a label (a pinned key in the tier): recompute the set + the
  // boxes and let the layout re-flow around the (possibly grown) box — a gentle reheat
  // under motion, a fresh settle+paint under reduced motion.
  const promoteRepaint = useCallback((): void => {
    refreshLabels()
    applyBoxes()
    if (reducedRef.current) {
      settledRef.current = false
      staticPaint()
      return
    }
    simRef.current?.reheat()
  }, [refreshLabels, applyBoxes, staticPaint])

  useLayoutEffect(() => {
    promoteRepaint()
  }, [selectedKey, promoteRepaint])

  // The tap/click FOCUS (MYT-89 density redesign): sticky, one node at a time — the
  // focused node is raised + always labeled (the coarse-pointer name reveal). Imperative
  // (pointer handlers call it), so it re-tiers + re-flows exactly like a selection.
  const setFocus = useCallback(
    (key: string | null): void => {
      if (focusRef.current === key) return
      focusRef.current = key
      promoteRepaint()
    },
    [promoteRepaint],
  )

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

  // Pointer interaction. FINE pointer + motion: hover-raise + drag-to-pin are LIVE
  // (MYT-89 audit #5 — dragging a node through the fog is the toy) and a click focuses
  // (name reveal) + selects (reveal-gated). COARSE pointer (touch) or reduced motion:
  // a TAP-only surface — no capture, no drag, slop-gated so page scroll is untouched —
  // that focuses the tapped node (its label is promoted into the tier) and selects in
  // the reveal. Body at module scope.
  useEffect(() => {
    const deps: PointerDeps = {
      getSim,
      sizeRef,
      virtualRef,
      hoverRef,
      dragRef,
      onSelectRef,
      interactiveRef,
      setFocus,
    }
    return setupPointerHandlers(canvasRef.current, reducedMotion, deps)
  }, [reducedMotion, canvasRef, getSim, setFocus])

  // Repaint on container resize, honouring the current mode (static vs let-the-loop-
  // handle-it). Mount-only; reads the latest mode via ref. jsdom's ResizeObserver is
  // a no-op shim, so this is inert there.
  useEffect(
    () =>
      observeResize(canvasRef.current, {
        reducedRef,
        staticPaint: () => {
          staticPaint()
          syncKeepOuts() // moved card box → settle flag drops; the next paint re-settles
        },
        applySize: (canvas, ctx) => {
          applySize(canvas, ctx)
          syncKeepOuts() // the card's pane-relative box moves with the pane
        },
      }),
    [canvasRef, applySize, staticPaint, syncKeepOuts],
  )

  // WEB-FONT invalidation (density redesign follow-up): the label widths memoized into
  // `boxWidthCacheRef` are measured at whatever font the Canvas resolves AT THE TIME —
  // before the DS serif loads that's the fallback serif, and the stale widths under-
  // reserve every box (drawn text overruns its collision/clamp box → edge-clipped
  // names). When the document's fonts finish loading, drop the memo, re-measure the
  // boxes at the TRUE widths, and re-flow.
  useEffect(() => {
    if (!('fonts' in document)) return // jsdom has no FontFaceSet
    let cancelled = false
    void document.fonts.ready.then(() => {
      if (cancelled) return
      boxWidthCacheRef.current.clear()
      applyBoxes()
      settledRef.current = false
      simRef.current?.reheat()
    })
    return () => {
      cancelled = true
    }
  }, [applyBoxes])

  // Re-resolve the cached inks on a light/dark flip (MYT-89 audit #2). Body at module scope.
  useEffect(
    () => observeThemeInk({ canvasRef, inkRef, edgeInkRef, paperRef, reducedRef, staticPaint }),
    [canvasRef, staticPaint],
  )

  return { getFogEntities }
}

interface VirtualDimsDeps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  virtualRef: React.RefObject<VirtualDims>
  simRef: React.RefObject<ForceSim | null>
  settledRef: React.RefObject<boolean>
  /** The density-aware growth input (node count + knobs) — the space widens as the
   *  graph fills, so the dims re-derive on arrivals too, not just pane resizes. */
  growthRef: React.RefObject<VirtualGrowth>
}

/** Measure the pane box → derive the shared virtual dims (`virtualDims`, with the
 *  density-aware growth) → on a change, store them, re-size the live sim (containment
 *  bounds re-derive + a gentle reheat so the layout migrates), and drop the
 *  reduced-motion settle flag (a static graph re-settles into the new space). Returns
 *  whether the dims CHANGED (the caller re-sizes the backing store — the virtual→pane
 *  transform moved). No-op-false with no canvas or when the dims are unchanged (jsdom's
 *  zero rect falls back to the reference dims — the ref's initial value). Module-scoped
 *  so the hook stays lean (mirrors observeResize/reseedOnForceChange). */
function trackVirtualDims(deps: VirtualDimsDeps): boolean {
  const { canvasRef, virtualRef, simRef, settledRef, growthRef } = deps
  const canvas = canvasRef.current
  if (canvas === null) return false
  const rect = canvas.getBoundingClientRect()
  const next = virtualDims(Math.round(rect.width), Math.round(rect.height), growthRef.current)
  const current = virtualRef.current
  if (next.width === current.width && next.height === current.height) return false
  virtualRef.current = next
  simRef.current?.setSize(next.width, next.height)
  settledRef.current = false
  return true
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
  edgeInkRef: React.RefObject<string>
  paperRef: React.RefObject<string>
  reducedRef: React.RefObject<boolean>
  staticPaint: () => void
}

/** Re-resolve the cached inks (node ink + the lighter edge ink) when the theme flips (the
 *  `.dark` class toggling on `<html>`). The motion loop reads the refs each frame, so it
 *  repaints in the new inks on the next frame; a static (reduced-motion) graph needs an
 *  explicit repaint. Returns the disconnect teardown (or undefined where MutationObserver
 *  is absent — jsdom without a shim). This deterministic signal is what lets the loop CACHE
 *  the inks instead of re-reading `getComputedStyle` every frame (MYT-89 audit #2).
 *  Module-scoped so the hook stays lean. */
function observeThemeInk(deps: ThemeInkDeps): (() => void) | undefined {
  const { canvasRef, inkRef, edgeInkRef, paperRef, reducedRef, staticPaint } = deps
  if (typeof MutationObserver === 'undefined') return undefined
  const observer = new MutationObserver(() => {
    const canvas = canvasRef.current
    if (canvas !== null) {
      inkRef.current = resolveInk(canvas)
      edgeInkRef.current = resolveEdgeInk(canvas)
      paperRef.current = resolvePaper(canvas)
    }
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
