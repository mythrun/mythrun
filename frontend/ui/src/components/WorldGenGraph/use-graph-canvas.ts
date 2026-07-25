import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  cameraWorldDims,
  createForceSim,
  growthFrom,
  seatFrom,
  VIRTUAL_HEIGHT,
  VIRTUAL_WIDTH,
  type DensityParams,
  type ForceParams,
  type ForceSim,
  type StaticKeepOut,
  type VirtualDims,
  type VirtualGrowth,
  type WorldgenLayout,
  type WorldSeat,
} from '@mythrun/client-core/worldgen'
import type {
  FogFieldEntity,
  GraphEdge,
  GraphNode,
  WorldGenCameraSource,
} from '@mythrun/client-core/contract'
import { createCameraController, type CameraController } from './camera-state.ts'
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
import { chooseLabelSides, graphSyncKey, pinSettledLabels } from './graph-stability.ts'
import type { LabelSide } from '../WorldGenFog/fog-obstacles.ts'
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
// audit #5; only tap-to-select is reveal-gated). The draw paths are guarded on a live 2D
// context, so under jsdom (getContext → null) nothing paints — the jsdom-testable surface
// is the layout classes plus the `data-camera-engaged` stamp `trackWorldDims` writes.
// The FOLD never runs here: nodes/edges arrive as props (the parent folds per SSE
// event); a change re-syncs.
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
  /** Whether the T1b camera may ENGAGE (MYT-89 audit v3 — the desktop reveal passes
   *  false: its pane fills, never pans). Gates the SEAT derivation to zero — the world
   *  never outgrows the pane — rather than touching the locked camera math. The
   *  component gates its fog-side `seatFrom` identically, so both layers agree (C5). */
  pannable: boolean
  /** The FORCEFUL settle regime (MYT-89 audit v4 — the reveal). Flips the pointer
   *  layer's drag-DROP from park-the-pin (the generating toy) to RELEASE (`unpin`),
   *  handing the node back to the sim whose release reheat snaps it home. The force
   *  profile itself arrives through `forceParams` (WorldGenGraph merges
   *  `REVEAL_FORCE_PARAMS` before this hook); this flag only drives the drop
   *  semantics — one regime, two seams, both stated by the consumer. */
  forcefulSettle: boolean
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
  /** The session-scoped layout home for this worldgen run (ux-run3 myth-aftau) —
   *  pin-on-settle writes each frozen placement through to it, and a remount pins
   *  the cached nodes straight back where the player saw them (only NEW entities
   *  settle freely). `undefined` (the reveal, standalone stories) → render-scoped
   *  layout, the pre-run3 behavior. Same required-with-`undefined` idiom as
   *  `forceParams`. */
  layout: WorldgenLayout | undefined
}

export interface GraphCanvas {
  /** Live node positions (+ the render-only bob) mapped into the fog's VIRTUAL space —
   *  the fog layer's per-frame obstacle source (C5 decision 3). Stable identity. */
  getFogEntities: () => FogFieldEntity[]
  /** The SHARED camera over the world (MYT-89 T1b): the graph hook owns the one
   *  camera; the fog layer reads it through this source so both canvases translate by
   *  the identical offset each frame (one camera, both layers — C5). Stable identity. */
  camera: WorldGenCameraSource
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
  const forcefulRef = useRef(params.forcefulSettle)
  const showLabelsRef = useRef(showLabels)
  const hoverRef = useRef<string | null>(null)
  // The sticky tap/click focus (MYT-89 density redesign): the focused node is drawn
  // raised and ALWAYS labeled — the coarse-pointer "show me this one's name" surface.
  const focusRef = useRef<string | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const sizeRef = useRef({ cssW: 0, cssH: 0 })
  // The CURRENT WORLD dims (pane-adaptive, MYT-89 responsive fix; seat-grown under the
  // T1b camera) — the shared space the sim, the draw, the pointer mapping, and the
  // fog-entity mapping all speak. Starts at the reference dims (the jsdom/unmeasured
  // fallback `cameraWorldDims` also returns) and follows the pane via `syncVirtual`.
  const virtualRef = useRef<VirtualDims>({ width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT })
  // The camera VIEW dims (T1b): the pane's window onto the world. Equal to the world
  // whenever the camera is disengaged (desktop; phones early in a generation).
  const viewRef = useRef<VirtualDims>({ width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT })
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
  // SUPPRESSED labels (ux-run3 myth-k0sja): tier-issued names whose pinned neighbours
  // leave neither an east nor a west slot free. They are NOT drawn — the node keeps its
  // mark and goes hollow, its name findable in the wiki index — because two names in
  // one slot is strictly worse than one name and one anonymous mark. Written by
  // `chooseLabelSides`, subtracted from `labeledRef` to give `drawnLabelsRef`.
  const suppressedRef = useRef<Set<string>>(new Set<string>())
  // The set the DRAW, the collision measure and the fog actually consume: the tier's
  // labeled set minus the suppressed. Recomputed by `applyBoxes` (the one place the
  // suppression can change), so the three surfaces can never disagree about which
  // names are on the map.
  const drawnLabelsRef = useRef<ReadonlySet<string>>(new Set<string>())
  const densityRef = useRef<Partial<DensityParams>>(params.densityParams ?? {})
  // Density-aware growth for the dims derivation (recomputed every render — cheap,
  // pure): the SAME derivation WorldGenGraph hands the fog, so the layers agree (C5).
  const growthRef = useRef<VirtualGrowth>(growthFrom(0))
  // The camera-world SEAT input (T1b): what the world must seat — the trigger + sizing
  // for the pannable camera. Same shared-derivation pattern as `growthRef`.
  const seatRef = useRef<WorldSeat>(seatFrom(0))
  // Resolved DS label font ("`${px}px ${family}`" from `--font-body`/`--text-sm`), cached on
  // first use (family/size don't animate or flip with the theme). The draw, the collision-box
  // measure, and the fog all key off this ONE string, so the reserved box bounds the drawn label.
  const labelFontRef = useRef('')
  const clockRef = useRef(0) // buoy-bob clock (seconds); 0 until the loop runs.
  // Draw-in state (C6 edge penstrokes): the ms clock plus each edge's first-seen ms
  // (synthKey → appear-time) its penstroke lerps from. Advanced/stamped per frame in
  // the motion loop; GC'd with the ref on unmount. (Nodes have no draw-in — an arriving
  // glyph renders full-ink on its first frame.)
  const drawInRef = useRef<DrawInState>({
    clockMs: 0,
    startMs: null,
    edgeAppear: new Map(),
  })
  const settledRef = useRef(false) // reduced-motion: has the current graph been settled?
  // The session-scoped layout home (myth-aftau): pin-on-settle persists into it,
  // the graph sync rehydrates from it. `undefined` → render-scoped layout.
  const layoutRef = useRef<WorldgenLayout | undefined>(params.layout)
  // Latest spread-tuner overrides, normalised to `{}` (never undefined) so `getSim`
  // passes them to `createForceSim` unconditionally under exactOptionalPropertyTypes.
  const forceParamsRef = useRef<Partial<ForceParams>>(params.forceParams ?? {})
  nodesRef.current = nodes
  edgesRef.current = edges
  selectedRef.current = selectedKey
  onSelectRef.current = onSelect
  reducedRef.current = reducedMotion
  interactiveRef.current = interactive
  forcefulRef.current = params.forcefulSettle
  showLabelsRef.current = showLabels
  forceParamsRef.current = params.forceParams ?? {}
  layoutRef.current = params.layout
  densityRef.current = params.densityParams ?? {}
  growthRef.current = growthFrom(nodes.length, densityRef.current)
  // The pannable gate (audit v3): a zeroed seat never engages `cameraWorldDims`
  // — world === view, the camera stays identity. Mirrors the component's fog-side
  // gate exactly (one derivation, both layers — C5).
  seatRef.current = seatFrom(params.pannable ? nodes.length : 0, densityRef.current)

  // The ONE camera over the world (T1b — created once; reads the live refs). Owns
  // where the viewport looks while the world is larger than the pane: manual pans,
  // the auto-follow drift toward the newest arrival, the reduced-motion snap, and
  // the pan-bounds clamp. Its `source` is handed to the fog layer (one camera, both
  // layers — C5). A pure render transform: the sim never sees it.
  const cameraCtlRef = useRef<CameraController | null>(null)
  cameraCtlRef.current ??= createCameraController({
    worldRef: virtualRef,
    viewRef,
    reducedRef,
    nodesRef,
    simRef,
    sizeRef,
  })
  const cameraCtl = cameraCtlRef.current

  // Track the pane → world/view dims (MYT-89 responsive fix + the T1b camera):
  // measure the canvas box, derive the shared spaces via `cameraWorldDims` (the
  // density-aware growth widens the space with the node count; the SEAT stops the
  // world shrinking below what the label budget needs — the camera engages instead),
  // and on a CHANGE re-size the live sim (the containment bounds follow), sync the
  // camera bounds, and drop the reduced-motion settle flag so a static graph
  // re-settles into the new space. The fog hook derives its dims from the SAME pane
  // box through the SAME function with the SAME growth+seat, so the two layers agree
  // (C5) at any size and any density. Returns whether the dims changed (the caller
  // re-sizes the backing store). Body at module scope (`trackWorldDims`).
  const syncVirtual = useCallback(
    (): boolean =>
      trackWorldDims({
        canvasRef,
        virtualRef,
        viewRef,
        simRef,
        settledRef,
        growthRef,
        seatRef,
        camera: cameraCtl,
      }),
    [canvasRef, cameraCtl],
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
  // `syncCardKeepOut`); re-run on graph syncs + sizes; a no-op when the box hasn't
  // moved. With the T1b camera engaged the keep-out is DROPPED — a pane-anchored
  // overlay can't be a world-space keep-out (its footprint would move with every pan).
  const keepOutElRef = params.keepOutRef
  const syncKeepOuts = useCallback((): void => {
    syncCardKeepOut({
      canvas: canvasRef.current,
      sim: simRef.current,
      card: keepOutElRef?.current ?? null,
      virtual: virtualRef.current,
      engaged: cameraCtl.engaged(),
      labelRefs: labelRefsRef.current,
      settledRef,
    })
  }, [canvasRef, keepOutElRef, cameraCtl])


  // Per-node label SIDES (myth-uis1p): the sticky east/west memory the draw, the
  // collision boxes, and the fog keep-outs all read — one map, three surfaces.
  const sidesRef = useRef<Map<string, LabelSide>>(new Map())
  // The pin memory (myth-uis1p pin-on-settle): which displayIds have been frozen
  // at their settled positions. Owned here (above applyBoxes — the side chooser
  // reads it); written by `pinSettled` below.
  const pinnedRef = useRef<Set<string>>(new Set())

  // Measure every node's CURRENT keep-out box (the SAME box the fog reserves —
  // `measureNodeBoxes` → `nodeBoxExtents`: icon+label ON ITS WORN SIDE when the name
  // is worn, icon-only when it isn't) and hand it to the sim's rectangular collide.
  // Sides are (re)chosen first — `chooseLabelSides` prunes retired labels and picks
  // east/west for any label worn by a PINNED node that lacks one — so the pushed
  // boxes always match what will be drawn. A no-op under jsdom (no 2D context →
  // nothing renders, nothing to collide); re-measured on every sync (memoized).
  const applyBoxes = useCallback((): void => {
    const sim = simRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (sim === null || canvas === null || ctx === null) return
    // Lazily resolve-and-cache the DS label font: this LAYOUT effect can run before
    // `applySize`'s passive effect fills the ref, and the box must be measured at the exact
    // font the label is drawn in. Idempotent — whoever runs first caches it.
    labelFontRef.current ||= resolveLabelFont(canvas)
    const widthOf = (name: string): number => {
      const cached = boxWidthCacheRef.current.get(name)
      if (cached !== undefined) return cached
      ctx.font = labelFontRef.current
      const width = ctx.measureText(name).width
      boxWidthCacheRef.current.set(name, width)
      return width
    }
    chooseLabelSides({
      nodes: nodesRef.current,
      positions: sim.positions(),
      labeled: labeledRef.current,
      pinned: pinnedRef.current,
      widthOf,
      sides: sidesRef.current,
      suppressed: suppressedRef.current,
    })
    drawnLabelsRef.current = drawnLabels(labeledRef.current, suppressedRef.current)
    sim.setBoxes(
      measureNodeBoxes(ctx, nodesRef.current, drawnLabelsRef.current, boxWidthCacheRef.current, labelFontRef.current, sidesRef.current),
    )
  }, [canvasRef])

  // Pin-on-settle (ux-run2 myth-uis1p — graph-stability.ts): once the field has
  // cooled, freeze every labeled-but-unpinned node at its current position. A
  // no-op while hot, so the motion loop calls it every frame and the reduced-
  // motion path right after its settle. Fresh pins re-run the box pass — the
  // side chooser commits east/west for the newly-frozen labels and the sim +
  // fog pick the mirrored geometry up immediately.
  const pinSettled = useCallback((): void => {
    const sim = simRef.current
    if (sim === null) return
    const fresh = pinSettledLabels(sim, labeledRef.current, pinnedRef.current)
    if (fresh > 0) {
      applyBoxes()
      // Write the freshly-frozen constellation through to the session layout
      // (myth-aftau) — AFTER the box pass, so the chosen label sides ride along.
      persistPlacements({
        sim,
        nodes: nodesRef.current,
        layout: layoutRef.current,
        pinned: pinnedRef.current,
        sides: sidesRef.current,
      })
    }
  }, [applyBoxes])

  // Reduced motion: settle the sim to convergence ONCE per graph change, idempotently —
  // whoever reads first (the fog's static settle via getFogEntities, or the graph's own
  // static paint) triggers it; the flag makes the other a no-op, so cross-hook effect
  // ordering doesn't matter. Under motion this never runs (the rAF loop drives tick()).
  const ensureSettled = useCallback((): void => {
    const sim = simRef.current
    if (sim === null || !reducedRef.current || settledRef.current) return
    settle(sim)
    settledRef.current = true
    pinSettled() // the settled constellation locks (myth-uis1p)
  }, [pinSettled])

  // Live fog obstacles (C5 decision 3): the current node positions (+ render-only bob,
  // disabled under reduced motion) in the fog's VIRTUAL space — the SAME positions the
  // glyphs are drawn at. Stable identity so the fog effect never re-binds on it.
  const getFogEntities = useCallback((): FogFieldEntity[] => {
    const sim = simRef.current
    if (sim === null) return []
    if (reducedRef.current) ensureSettled()
    const t = reducedRef.current ? null : clockRef.current
    return fogEntitiesFrom(nodesRef.current, sim.positions(), t, virtualRef.current, drawnLabelsRef.current, sidesRef.current)
  }, [ensureSettled])

  // Size the backing store to the pane AND cache the theme ink — the once-per-mount/resize
  // canvas prep the draw paths share. `syncVirtual` FIRST: the world/view dims follow
  // the pane (the sim's containment re-derives on a change), then the backing-store
  // transform maps the fresh VIEW (the camera's window — the whole world when
  // disengaged) onto the pane pixels. `resolveInk` reads `getComputedStyle`, which the
  // motion loop used to call EVERY frame (MYT-89 audit #2); caching it here (+ on a
  // theme flip, via the observer below) lets the loop read the ref instead.
  const applySize = useCallback(
    (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void => {
      syncVirtual()
      sizeRef.current = sizeCanvasForDpr(canvas, ctx, viewRef.current)
      inkRef.current = resolveInk(canvas)
      edgeInkRef.current = resolveEdgeInk(canvas)
      paperRef.current = resolvePaper(canvas)
      labelFontRef.current = resolveLabelFont(canvas)
    },
    [syncVirtual],
  )

  // Draw one frame of the graph (edges + glyphs) in the WORLD space, seen through the
  // camera (T1b): the context clears the VIEW and translates the origin to the world
  // centre MINUS the camera offset — with the camera disengaged (camera {0,0},
  // world === view) that is exactly the pre-camera (vw/2, vh/2) translate. The fog
  // layer translates by the same camera each frame, so the two canvases stay in
  // lockstep at every camera position (C5). Edges stroke in the LIGHTER edge ink
  // (`--ink-tertiary`) so the connection strings sit under the text; glyphs + labels
  // in the full ink. `t` is the bob clock (null under reduced motion → no bob);
  // `showLabels` draws the node name beside each glyph (ON during generation too —
  // MYT-89 audit #3), gated per node by the label tier (`labeled`).
  const paintFrame = useCallback(
    (ctx: CanvasRenderingContext2D, ink: string): void => {
      const virtual = virtualRef.current
      const view = viewRef.current
      const cam = cameraCtl.read()
      ctx.clearRect(0, 0, view.width, view.height)
      ctx.save()
      ctx.translate(virtual.width / 2 - cam.x, virtual.height / 2 - cam.y)
      const positions = getSim().positions()
      const drawIn = drawInRef.current
      ctx.strokeStyle = edgeInkRef.current || ink
      paintEdges(ctx, edgesRef.current, positions, drawIn, reducedRef.current)
      ctx.strokeStyle = ink
      ctx.fillStyle = ink
      drawNodes(
        ctx,
        nodesRef.current,
        positions,
        {
          selectedKey: selectedRef.current,
          hoverKey: hoverRef.current,
          focusKey: focusRef.current,
          t: reducedRef.current ? null : clockRef.current,
          showLabels: showLabelsRef.current,
          labeled: drawnLabelsRef.current,
          sides: sidesRef.current,
          labelFont: labelFontRef.current,
          paper: paperRef.current,
          virtual,
        },
      )
      ctx.restore()
    },
    [getSim, cameraCtl],
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
  // ORDER matters: the density growth/seat may re-derive the world (it grows with the
  // node count), the card keep-out reserves label-budget area, the label tier depends
  // on both, and the boxes depend on the tier — dims → sync → keep-out → labels →
  // boxes. The camera tracks the newest arrival (the auto-follow target — T1b). A
  // dims change also re-sizes the backing store (the view→pane transform moved) via
  // `applySize` under motion; the reduced-motion static repaint effect below re-sizes
  // through its own path.
  const syncKeyRef = useRef('')
  useLayoutEffect(() => {
    // Identity-only re-render guard (ux-run2 myth-uis1p — graph-stability.ts):
    // the parent re-renders on unrelated state (wiki pane, selection) with fresh
    // array identities but identical content; a re-sync would inject reheat and
    // jitter the settled constellation. Same content → skip everything.
    const key = graphSyncKey(nodes, edges)
    if (key === syncKeyRef.current) return
    syncKeyRef.current = key
    const dimsChanged = syncVirtual()
    getSim().sync(nodes, edges)
    // Rehydrate the session layout (myth-aftau) BEFORE the label/box passes: a
    // remount pins every cached node straight back at its frozen placement (its
    // worn side restored with it), so the side chooser and the collision boxes
    // see the constellation the player already saw. New arrivals aren't in the
    // cache and settle freely around it.
    rehydratePlacements({
      sim: getSim(),
      nodes,
      layout: layoutRef.current,
      pinned: pinnedRef.current,
      sides: sidesRef.current,
    })
    syncKeepOuts()
    refreshLabels()
    applyBoxes()
    cameraCtl.trackArrivals(nodes)
    settledRef.current = false
    if (dimsChanged && !reducedRef.current) {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d') ?? null
      if (canvas !== null && ctx !== null) applySize(canvas, ctx)
    }
  }, [nodes, edges, getSim, applyBoxes, syncVirtual, refreshLabels, applySize, syncKeepOuts, canvasRef, cameraCtl])

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

  // Reduced-motion static redraw: settle (once), SNAP the camera to the newest
  // arrival's settled position (T1b — the no-drift substitute for the auto-follow:
  // one discrete reposition per arrival, no continuous animation; a no-op while the
  // camera is disengaged or a manual pan hasn't idled out — the snap is clamped and
  // notify-driven, so the fog's static painter follows), then paint. The motion loop
  // that would otherwise pick a change up is off in this mode.
  useEffect(() => {
    if (!reducedMotion) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || ctx === null) return
    applySize(canvas, ctx)
    ensureSettled()
    cameraCtl.snapToTarget()
    paintFrame(ctx, inkRef.current)
  }, [nodes, edges, reducedMotion, canvasRef, applySize, ensureSettled, paintFrame, cameraCtl])

  // Static repaint on a DISCRETE camera move (T1b, reduced motion only): a manual pan
  // or an arrival snap has no rAF loop to pick it up — repaint the current settled
  // state at the new camera. Under motion the loop repaints every frame; the
  // subscription then never fires a paint (reducedRef gate).
  useEffect(
    () =>
      cameraCtl.source.subscribe(() => {
        if (reducedRef.current) staticPaint()
      }),
    [cameraCtl, staticPaint],
  )

  // The motion render loop. Off entirely under reduced motion (and when there's no
  // 2D context — jsdom). The loop body lives in startMotionLoop (module scope).
  // `advanceCamera` steps the auto-follow drift for this frame's timestamp (T1b);
  // the fog loop calls the same source with the same rAF timestamp and reads the
  // identical position (the idempotent per-timestamp advance — one camera, C5).
  useEffect(() => {
    if (reducedMotion) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || ctx === null) return
    applySize(canvas, ctx)
    return startMotionLoop(ctx, {
      getSim,
      paintFrame,
      clockRef,
      edgesRef,
      drawInRef,
      inkRef,
      pinSettled,
      advanceCamera: (frameMs) => cameraCtl.source.current(frameMs),
    })
  }, [reducedMotion, canvasRef, applySize, paintFrame, getSim, cameraCtl, pinSettled])

  // Pointer interaction. FINE pointer + motion: hover-raise + drag-to-pin are LIVE
  // (MYT-89 audit #5 — dragging a node through the fog is the toy), a click focuses
  // (name reveal) + selects (reveal-gated), and — camera engaged (T1b) — a drag from
  // EMPTY fog pans the camera. COARSE pointer (touch) or reduced motion: the tap+pan
  // surface — camera disengaged it is the shipped slop-gated tap (page scroll
  // untouched); engaged, the canvas owns touch (one-finger drag pans, a <8px press
  // taps). Body at module scope.
  useEffect(() => {
    const deps: PointerDeps = {
      getSim,
      sizeRef,
      virtualRef,
      viewRef,
      readCamera: cameraCtl.read,
      isEngaged: cameraCtl.engaged,
      panBy: cameraCtl.panBy,
      deferFollow: cameraCtl.deferFollow,
      hoverRef,
      dragRef,
      onSelectRef,
      interactiveRef,
      forcefulRef,
      setFocus,
    }
    return setupPointerHandlers(canvasRef.current, reducedMotion, deps)
  }, [reducedMotion, canvasRef, getSim, setFocus, cameraCtl])

  // Container resize: run the FULL re-derivation chain, in dependency order — dims +
  // backing store (`applySize` → `syncVirtual`), the card keep-out (its pane-relative
  // box moves with the pane), the label TIER (the budget is area-derived — a resize
  // changes it), and the collision BOXES (a promoted label needs its full box in the
  // keep-out set, or it rides icon-only until the next interaction — the T1 review
  // fix: the old path never re-tiered/re-boxed on resize). Then repaint: statically
  // under reduced motion (the loop is off — `staticPaint` re-settles into the new
  // space), else let the running loop pick the new state up next frame. Mount-only;
  // reads the latest mode via ref. jsdom's ResizeObserver is a no-op shim → inert.
  const handleResize = useCallback((): void => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || ctx === null) return
    applySize(canvas, ctx)
    syncKeepOuts()
    refreshLabels()
    applyBoxes()
    if (reducedRef.current) staticPaint()
  }, [canvasRef, applySize, syncKeepOuts, refreshLabels, applyBoxes, staticPaint])

  useEffect(() => observeResize(canvasRef.current, handleResize), [canvasRef, handleResize])

  // WEB-FONT invalidation (density redesign follow-up): the label widths memoized into
  // `boxWidthCacheRef` are measured at whatever font the Canvas resolves AT THE TIME —
  // before the DS serif loads that's the fallback serif, and the stale widths under-
  // reserve every box (drawn text overruns its collision/clamp box → edge-clipped
  // names). When the document's fonts finish loading, drop the memo, re-measure the
  // boxes at the TRUE widths, and re-flow. Under reduced motion nothing else would
  // repaint (the loop is off) — paint the re-measured state statically (T1 review
  // fix #2: the settle flag alone left the stale frame up until an interaction).
  useEffect(() => {
    if (!('fonts' in document)) return // jsdom has no FontFaceSet
    let cancelled = false
    void document.fonts.ready.then(() => {
      if (cancelled) return
      boxWidthCacheRef.current.clear()
      applyBoxes()
      settledRef.current = false
      simRef.current?.reheat()
      if (reducedRef.current) staticPaint()
    })
    return () => {
      cancelled = true
    }
  }, [applyBoxes, staticPaint])

  // Re-resolve the cached inks on a light/dark flip (MYT-89 audit #2). Body at module scope.
  useEffect(
    () => observeThemeInk({ canvasRef, inkRef, edgeInkRef, paperRef, reducedRef, staticPaint }),
    [canvasRef, staticPaint],
  )

  return { getFogEntities, camera: cameraCtl.source }
}

interface WorldDimsDeps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  /** The WORLD dims the sim/labels/fog live in (seat-grown under the camera). */
  virtualRef: React.RefObject<VirtualDims>
  /** The camera VIEW dims — the pane's window onto the world. */
  viewRef: React.RefObject<VirtualDims>
  simRef: React.RefObject<ForceSim | null>
  settledRef: React.RefObject<boolean>
  /** The density-aware growth input (node count + knobs) — the space widens as the
   *  graph fills, so the dims re-derive on arrivals too, not just pane resizes. */
  growthRef: React.RefObject<VirtualGrowth>
  /** The camera-world seat input (T1b) — the trigger + sizing for the camera. */
  seatRef: React.RefObject<WorldSeat>
  camera: CameraController
}

/** Measure the pane box → derive the shared world + view dims (`cameraWorldDims`:
 *  the density-aware growth widens the space with the node count; the SEAT stops the
 *  world shrinking below what the label budget needs, engaging the camera — T1b) →
 *  on a change, store them, sync the camera bounds (identity / engage-centre /
 *  clamp), flip the canvas's touch ownership (`touch-action: none` while the camera
 *  pans — the one-finger drag is ours; disengaged, the page keeps scroll), re-size
 *  the live sim (containment bounds re-derive + a gentle reheat so the layout
 *  migrates), and drop the reduced-motion settle flag (a static graph re-settles into
 *  the new space). Returns whether the dims CHANGED (the caller re-sizes the backing
 *  store — the view→pane transform moved). No-op-false with no canvas or when the
 *  dims are unchanged (jsdom's zero rect falls back to the reference dims — the refs'
 *  initial values). Module-scoped so the hook stays lean. */
function trackWorldDims(deps: WorldDimsDeps): boolean {
  const { canvasRef, virtualRef, viewRef, simRef, settledRef, growthRef, seatRef, camera } = deps
  const canvas = canvasRef.current
  if (canvas === null) return false
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
  camera.syncBounds(next)
  canvas.style.touchAction = next.engaged ? 'none' : ''
  // The engagement's DOM-observable (audit v3): jsdom's CSSStyleDeclaration drops
  // the touch-action write, so the pannable-gate tests (and the browser no-pan
  // proof) read this attribute instead.
  canvas.dataset.cameraEngaged = next.engaged ? 'true' : 'false'
  simRef.current?.setSize(next.world.width, next.world.height)
  settledRef.current = false
  return true
}

/** The label set the map actually DRAWS (ux-run3 myth-k0sja): the tier's issued labels
 *  minus the ones the slot resolver suppressed. Identity-stable in the common case
 *  (nothing suppressed → the tier's own set), so the draw does no needless work. */
function drawnLabels(labeled: ReadonlySet<string>, suppressed: ReadonlySet<string>): ReadonlySet<string> {
  if (suppressed.size === 0) return labeled
  return new Set([...labeled].filter((id) => !suppressed.has(id)))
}

/** The shared inputs of the two session-layout passes (myth-aftau): the live sim,
 *  the current graph, the run's layout home (absent → both passes no-op), and the
 *  hook's pin + side memories. */
interface PlacementDeps {
  sim: ForceSim
  nodes: GraphNode[]
  layout: WorldgenLayout | undefined
  pinned: Set<string>
  sides: Map<string, LabelSide>
}

/** Pin every cached node straight back at its frozen placement (myth-aftau — the
 *  remount half). Keyed by the STABLE `synthKey` (a finalize swaps displayId, the
 *  placement survives); pinned via the node's CURRENT displayId (the sim's pin
 *  id-space). Idempotent per node (`pinned` is the guard), so the per-sync call
 *  costs nothing once rehydrated. The cached label side is restored unless a live
 *  interaction already chose one (the worn side sticks — no flapping). */
function rehydratePlacements(deps: PlacementDeps): void {
  const { sim, nodes, layout, pinned, sides } = deps
  if (layout === undefined) return
  for (const node of nodes) {
    const placement = layout.placements.get(node.synthKey)
    if (placement === undefined || pinned.has(node.displayId)) continue
    sim.pin(node.displayId, placement.x, placement.y)
    pinned.add(node.displayId)
    if (placement.side !== undefined && !sides.has(node.displayId)) {
      sides.set(node.displayId, placement.side)
    }
  }
}

/** Write the pinned constellation through to the session layout (myth-aftau — the
 *  persist half; runs on fresh pins, after the box pass chose sides). Positions
 *  come from the sim (`fx`-held — exact), keyed by `synthKey` with the current
 *  displayId + worn side alongside, so a later mount rehydrates the identical
 *  picture. */
function persistPlacements(deps: PlacementDeps): void {
  const { sim, nodes, layout, pinned, sides } = deps
  if (layout === undefined) return
  const positions = sim.positions()
  for (const node of nodes) {
    if (!pinned.has(node.displayId)) continue
    const position = positions.get(node.displayId)
    if (position === undefined) continue
    const side = sides.get(node.displayId)
    layout.placements.set(node.synthKey, {
      displayId: node.displayId,
      x: position.x,
      y: position.y,
      ...(side !== undefined ? { side } : {}),
    })
  }
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

/** Observe container resize and run the hook's full resize chain (`handleResize` —
 *  dims, keep-out, re-tier, re-box, repaint). Returns the disconnect teardown (or
 *  undefined when there's no canvas / no ResizeObserver — jsdom). Module-scoped so
 *  the hook stays lean. */
function observeResize(
  canvas: HTMLCanvasElement | null,
  onResize: () => void,
): (() => void) | undefined {
  if (canvas === null || typeof ResizeObserver === 'undefined') return undefined
  const observer = new ResizeObserver(onResize)
  observer.observe(canvas)
  return () => {
    observer.disconnect()
  }
}

/** The draw-in clock + first-seen stamps (one mutable ref): the ms elapsed since the
 *  FIRST motion frame and each edge's first-seen ms (the C6 penstroke), keyed on
 *  synthKey. `startMs` persists ACROSS motion-loop restarts (a reduced-motion flip
 *  re-runs the loop effect) — resetting the clock would strand every recorded
 *  appear-time in the future, freezing edge penstrokes at 0. */
interface DrawInState {
  clockMs: number
  startMs: number | null
  edgeAppear: Map<string, number>
}

interface MotionLoopDeps {
  getSim: () => ForceSim
  paintFrame: (ctx: CanvasRenderingContext2D, ink: string) => void
  clockRef: React.RefObject<number>
  edgesRef: React.RefObject<GraphEdge[]>
  drawInRef: React.RefObject<DrawInState>
  inkRef: React.RefObject<string>
  /** Pin labeled nodes once the field cools (myth-uis1p) — a no-op while hot. */
  pinSettled: () => void
  /** Step the T1b camera's auto-follow drift for this frame's timestamp (idempotent
   *  per timestamp — the fog loop calls the same source with the same rAF time). */
  advanceCamera: (frameMs: number) => void
}

/** Paint the edge layer with the C6 draw-in: each edge reveals as a source→target penstroke
 *  over its stage duration, keyed on its first-seen clock (`state.appear`); reduced motion
 *  and seed edges (`arrivalIndex -1`) resolve to a full line inside `edgeDrawProgress`. */
function paintEdges(
  ctx: CanvasRenderingContext2D,
  edges: readonly GraphEdge[],
  positions: ReadonlyMap<string, Point>,
  state: DrawInState,
  reduced: boolean,
): void {
  drawEdges(ctx, edges, positions, (edge) =>
    edgeDrawProgress(edge, state.edgeAppear.get(edge.synthKey), state.clockMs, reduced),
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

/** Run the rAF loop: each frame advance the clock, stamp new edges' appear-times,
 *  tick the sim, and repaint the graph (edges drawing in as penstrokes, arriving
 *  glyphs appearing full-ink, all with the render-only buoy bob). Returns the cancel
 *  teardown. Module-scoped so the hook body stays lean.
 *
 *  The clock's origin lives in the STATE (`startMs`, set on the first frame ever), so
 *  a loop restart (a reduced-motion flip) resumes the same monotonic clock instead of
 *  resetting it under the recorded appear-times. The theme ink is read from `inkRef`
 *  (cached), NOT re-resolved via `getComputedStyle` every frame (MYT-89 audit #2 —
 *  that per-frame style read was pure waste). The hook's MutationObserver refreshes
 *  the ref on a light/dark flip, so the very next frame repaints in the new ink — the
 *  Canvas (the one surface Tailwind can't reach) still tracks the theme, without the
 *  per-frame cost. */
function startMotionLoop(ctx: CanvasRenderingContext2D, deps: MotionLoopDeps): () => void {
  const { getSim, paintFrame, clockRef, edgesRef, drawInRef, inkRef, pinSettled, advanceCamera } = deps
  let raf = 0
  const frame = (now: number): void => {
    const state = drawInRef.current
    state.startMs ??= now
    const elapsedMs = now - state.startMs
    clockRef.current = elapsedMs / 1000
    state.clockMs = elapsedMs
    recordEdgeAppearances(edgesRef.current, state.edgeAppear, elapsedMs)
    advanceCamera(now) // the auto-follow drift for THIS frame (paintFrame reads it)
    getSim().tick()
    pinSettled() // labeled nodes lock once the field cools (myth-uis1p)
    paintFrame(ctx, inkRef.current)
    raf = window.requestAnimationFrame(frame)
  }
  raf = window.requestAnimationFrame(frame)
  return () => {
    window.cancelAnimationFrame(raf)
  }
}
