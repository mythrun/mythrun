import { BUOY_BOB, LABEL_TEXT_OFFSET_X, type VirtualDims } from '@mythrun/client-core/worldgen'
import type { FogFieldEntity, GraphEdge, GraphNode } from '@mythrun/client-core/contract'

// Pure Canvas-2D draw helpers for the world-gen streaming graph (MYT-89 C5). The
// brand register is FLAT 1-BIT PAPER: every entity is a SQUARE ink glyph (never a
// circle/dot/badge), every link a hand-drawn ink line. No colour lives here — the
// host sets `ctx.strokeStyle`/`ctx.fillStyle` to the resolved theme ink before
// calling (keeps R3 intact for a raw Canvas surface Tailwind can't reach).
//
// COORDINATE SPACE (C5 unification, §3.6): the graph shares the fog's VIRTUAL space —
// PANE-ADAPTIVE since the MYT-89 responsive fix (`virtualDims`: sized from the pane, so
// the graph fills any aspect and stays legible at 375px). The force-sim reports CENTRED
// positions in `[−vw/2, vw/2] × [−vh/2, vh/2]`; the host translates the context by
// (vw/2, vh/2) before calling, so these draw in the centred space AND `centredToVirtual`
// (below) maps the exact same point into the fog's top-left virtual space — one point,
// two surfaces, so a node's glyph and its fog-hole land on the identical coordinate.
// The helpers that cross the two spaces take the CURRENT dims explicitly.

/** A resolved node position in the host's (centred) canvas space. */
export interface Point {
  x: number
  y: number
}

/** Base glyph half-extent (px) at 1× device scale. Hover/selection scale it up. */
const GLYPH_HALF = 6
const HOVER_SCALE = 1.5
const SELECT_FRAME_PAD = 5
const LABEL_ALPHA = 0.62
/** Edge stroke alpha over the (already lighter) edge ink — the connection strings sit
 *  UNDER the text: the host strokes them in the `--ink-tertiary` step (see
 *  `resolveEdgeInk`) and this alpha keeps them a quiet web at real density (~70 edges),
 *  so a label always reads over a crossing line. */
const EDGE_ALPHA = 0.55

// ── Act-2 penstroke edge draw-in (MYT-89 C6) ──────────────────────────────────────────
// Edges are DRAWN, not popped in: on first appearance each reveals as a partial line from
// source→target (a penstroke), over a duration keyed by B3's `sourceStage`. `weave`
// (relationship/consolidation passes) is the slow, deliberate stroke; `snap` (the late
// coherence_pass batch) is near-instant. Seed edges (`arrivalIndex -1`) and reduced motion
// render FULL immediately. Durations are NAMED constants, not magic numbers.

/** Slow, deliberate penstroke (ms) — a `weave` edge's draw-in duration. */
export const EDGE_WEAVE_MS = 900
/** Fast draw-in (ms) — the late `coherence_pass` `snap` batch appears near-instantly. */
export const EDGE_SNAP_MS = 180

/** The draw-in duration (ms) for an edge's originating pass — `weave` slow, `snap` fast. */
export function edgeDrawDurationMs(stage: GraphEdge['sourceStage']): number {
  return stage === 'snap' ? EDGE_SNAP_MS : EDGE_WEAVE_MS
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** An edge's [0,1] draw-in progress at `nowMs`, given the rAF-clock time it was first seen
 *  in the edges array (`appearMs`). Seed/pre-existing edges (`arrivalIndex < 0`) and the
 *  reduced-motion path render FULL immediately (1); a not-yet-clocked edge is 0 (about to
 *  start); otherwise it lerps over `edgeDrawDurationMs(sourceStage)` from its appear-time. */
export function edgeDrawProgress(
  edge: GraphEdge,
  appearMs: number | undefined,
  nowMs: number,
  reducedMotion: boolean,
): number {
  if (reducedMotion || edge.arrivalIndex < 0) return 1
  if (appearMs === undefined) return 0
  return clamp01((nowMs - appearMs) / edgeDrawDurationMs(edge.sourceStage))
}

/** Point `t` of the way from `a` to `b` (the penstroke's drawn endpoint). */
function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** Map a CENTRED sim point (`[−vw/2, vw/2] × [−vh/2, vh/2]`) into the fog's top-left
 *  VIRTUAL space (`[0, vw] × [0, vh]`) at the CURRENT pane-adaptive dims. This is the
 *  exact translation the host applies to the graph context (`translate(vw/2, vh/2)`),
 *  so a node drawn here lands on the SAME virtual coordinate the fog obstacle is built
 *  at — the C5 coord unification, at every pane size. */
export function centredToVirtual(p: Point, virtual: VirtualDims): Point {
  return { x: p.x + virtual.width / 2, y: p.y + virtual.height / 2 }
}

/** The per-node buoy-bob OFFSET (px) at virtual position (x, y) and clock `t` (s) —
 *  the reference's idle sway, verbatim from `BUOY_BOB`. A RENDER-time offset: it is
 *  never written back to the physics (`positions()` stays authoritative), and BOTH
 *  the glyph draw and the fog-obstacle mapping add the identical offset, so a node
 *  and its fog-hole bob together. The phase is seeded on the (unbobbed) virtual
 *  position so labels desync. */
export function bobOffset(x: number, y: number, t: number): Point {
  const ph = x * BUOY_BOB.phase.xCoeff + y * BUOY_BOB.phase.yCoeff
  const dx = BUOY_BOB.x.reduce((sum, term) => sum + Math.sin(t * term.timeFreq + ph * term.phaseMul) * term.amp, 0)
  const dy = BUOY_BOB.y.reduce((sum, term) => {
    const fn = term.fn === 'sin' ? Math.sin : Math.cos
    return sum + fn(t * term.timeFreq + ph * term.phaseMul) * term.amp
  }, 0)
  return { x: dx, y: dy }
}

/**
 * Map the current graph nodes (+ their CENTRED sim positions) into the fog's
 * `FogFieldEntity[]` in the shared VIRTUAL space (C5 decision 3): each node becomes a
 * label the fog parts around, at the SAME virtual coordinate its glyph is drawn at,
 * plus the render-only buoy bob so the fog-hole tracks the bobbing glyph. `t === null`
 * disables the bob (reduced motion) — the fog then parts around the static positions.
 * `labeled` (label tiering) marks which nodes WEAR their name: an unlabeled node gets
 * `labeled: false`, so the fog reserves only its icon-sized hole (omitted → all
 * labeled, the pre-tiering behaviour). Nodes without a position (not yet placed) are
 * skipped. Pure — unit-testable without a Canvas, and the SINGLE source both the fog
 * obstacles and the glyph draw derive from.
 */
export function fogEntitiesFrom(
  nodes: readonly GraphNode[],
  positions: ReadonlyMap<string, Point>,
  t: number | null,
  virtual: VirtualDims,
  labeled?: ReadonlySet<string>,
): FogFieldEntity[] {
  const out: FogFieldEntity[] = []
  for (const node of nodes) {
    const centred = positions.get(node.displayId)
    if (centred === undefined) continue
    const v = centredToVirtual(centred, virtual)
    const bob = t === null ? { x: 0, y: 0 } : bobOffset(v.x, v.y, t)
    out.push({
      x: v.x + bob.x,
      y: v.y + bob.y,
      kind: node.kind,
      name: node.name,
      labeled: labeled === undefined || labeled.has(node.displayId),
    })
  }
  return out
}

/** Draw every edge whose endpoints both have a position, as a STRAIGHT quiet ink line
 *  (the density redesign: the old per-edge quadratic bow read as tangle at a real
 *  ~70-edge load; straight lines fit the ruled-paper register and cross cleanly). The
 *  host strokes edges in a LIGHTER ink step than the label text (`resolveEdgeInk` →
 *  `--ink-tertiary`) so a name always reads over a crossing line. Edge endpoints are
 *  entity UUIDs and `positions` is keyed by `displayId` (also the UUID once finalized)
 *  — the two id-spaces are reconciled, so the lookup matches (BUG 2.1: keying nodes on
 *  synthKey made this miss and drop every edge).
 *
 *  `progressOf` (C6) returns each edge's [0,1] draw-in progress: the stroke reveals
 *  from source→target, its endpoint at `lerp(source, target, progress)` — a penstroke,
 *  not a fade. Omitted → every edge is FULL (1), the pre-C6 behaviour B1's tests pin. */
export function drawEdges(
  ctx: CanvasRenderingContext2D,
  edges: readonly GraphEdge[],
  positions: ReadonlyMap<string, Point>,
  progressOf?: (edge: GraphEdge) => number,
): void {
  ctx.save()
  ctx.globalAlpha = EDGE_ALPHA
  ctx.lineWidth = 1
  for (const edge of edges) {
    const a = positions.get(edge.from)
    const b = positions.get(edge.to)
    if (a === undefined || b === undefined) continue
    drawEdge(ctx, a, b, progressOf ? progressOf(edge) : 1)
  }
  ctx.restore()
}

/** One STRAIGHT link, revealed `progress` of the way source→target (C6): a line from
 *  the source to `lerp(source, target, progress)` — the penstroke draw-in is the same
 *  endpoint lerp as before, just along the true segment. At `progress >= 1` the
 *  endpoint is the exact target — a crisp full line, never a fade. */
function drawEdge(ctx: CanvasRenderingContext2D, a: Point, b: Point, progress: number): void {
  const end = progress >= 1 ? b : lerpPoint(a, b, progress)
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(end.x, end.y)
  ctx.stroke()
}

/** How to emphasise + animate the node layer this frame — all in `displayId` space
 *  (the render/selection id-space). `t` is the buoy-bob clock in seconds (`null`
 *  disables the bob, reduced motion); `showLabels` gates the name label (OFF during
 *  generation — §3.4 — the glyphs are mono-ink shapes only; the reveal turns it on). */
export interface NodeDecoration {
  selectedKey: string | undefined
  hoverKey: string | null
  /** The sticky tap/click focus (MYT-89 density redesign): drawn raised like a hover
   *  and always labeled — the mobile "show me this one's name" surface. */
  focusKey: string | null
  t: number | null
  showLabels: boolean
  /** WHICH nodes wear their name at the current density (label tiering) — anchors +
   *  the freshest arrivals + pins, from `labeledDisplayIds`. `undefined` → every node
   *  (the pre-tiering behaviour; the tuning stories can force it). Only consulted when
   *  `showLabels` is on. */
  labeled: ReadonlySet<string> | undefined
  /** The CURRENT pane-adaptive virtual dims (the bob phase seeds off the node's
   *  top-left-virtual position, shared with the fog's obstacle mapping). */
  virtual: VirtualDims
  /** The entity-name label font as a Canvas `font` string, resolved from the design-system
   *  tokens (`resolveLabelFont` → `--font-body` at `--text-sm`). The host resolves it once at
   *  mount and passes it every frame, so the label uses the SITE's typography and — measured
   *  at the same font as the collision box — never over/under-runs its reserved keep-out. */
  labelFont: string
  /** The PAPER colour (`--bg` via `resolvePaper`) — the label's cartographic HALO: each
   *  name is stroked in paper before its ink fill, so an edge crossing UNDER the text is
   *  knocked out around the letterforms (the text always reads over the lines — MYT-89
   *  density redesign). Still strictly two-tone paper+ink. Empty string → no halo
   *  (a bare/jsdom Canvas). */
  paper: string
}

/**
 * Draw every node as its per-kind square glyph, with a RENDER-only buoy bob applied
 * to the draw position (the physics position is untouched). Optionally a quiet name
 * label (reveal only). The hovered node is drawn raised (larger); the selected node
 * gets a square frame.
 */
export function drawNodes(
  ctx: CanvasRenderingContext2D,
  nodes: readonly GraphNode[],
  positions: ReadonlyMap<string, Point>,
  deco: NodeDecoration,
): void {
  for (const node of nodes) {
    const p = positions.get(node.displayId)
    if (p === undefined) continue
    const raised = node.displayId === deco.hoverKey || node.displayId === deco.focusKey
    const selected = node.displayId === deco.selectedKey
    const showLabel =
      deco.showLabels && (deco.labeled === undefined || deco.labeled.has(node.displayId))
    const bob = bobFor(p, deco.t, deco.virtual)
    drawNode(ctx, node, { x: p.x + bob.x, y: p.y + bob.y }, raised, selected, showLabel, deco)
  }
}

/** The bob offset for a centred point (or zero when the bob is disabled). Kept beside
 *  `fogEntitiesFrom`'s identical logic so the glyph and its fog-hole share one bob. */
function bobFor(p: Point, t: number | null, virtual: VirtualDims): Point {
  if (t === null) return { x: 0, y: 0 }
  const v = centredToVirtual(p, virtual)
  return bobOffset(v.x, v.y, t)
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  node: GraphNode,
  p: Point,
  hovered: boolean,
  selected: boolean,
  showLabel: boolean,
  deco: NodeDecoration,
): void {
  const half = GLYPH_HALF * (hovered ? HOVER_SCALE : 1)
  ctx.save()
  ctx.translate(p.x, p.y)
  if (selected) {
    ctx.strokeRect(-(half + SELECT_FRAME_PAD), -(half + SELECT_FRAME_PAD), (half + SELECT_FRAME_PAD) * 2, (half + SELECT_FRAME_PAD) * 2)
  }
  drawGlyph(ctx, node.kind, half)
  if (showLabel) drawLabel(ctx, node.name, deco.labelFont, deco.paper)
  ctx.restore()
}

/** Halo stroke width (px) around the label letterforms — just wide enough to knock a
 *  1px edge line out from under the text. */
const LABEL_HALO_WIDTH = 3

/** The quiet entity name to the right of the glyph — low-alpha ink, in the design-system
 *  label font (`labelFont`, resolved from `--font-body`/`--text-sm`), over a PAPER halo
 *  (`paper` — `--bg`): the name is stroked in paper first, so a lighter edge line crossing
 *  under the text is knocked out around the letterforms and the name always reads (the
 *  density redesign; empty `paper` skips the halo). Drawn at the SHARED
 *  `LABEL_TEXT_OFFSET_X` (NOT a hover-scaled offset), so the label sits at one fixed x the
 *  collision box + fog keep-out reserve to exactly — the box's right edge is that offset plus
 *  this same-font `measureText` width, a hard no-overlap bound in every hover/select state. */
function drawLabel(ctx: CanvasRenderingContext2D, name: string, labelFont: string, paper: string): void {
  ctx.save()
  ctx.font = labelFont
  ctx.textBaseline = 'middle'
  if (paper.length > 0) {
    ctx.strokeStyle = paper
    ctx.lineWidth = LABEL_HALO_WIDTH
    ctx.lineJoin = 'round'
    ctx.strokeText(name, LABEL_TEXT_OFFSET_X, 0)
  }
  ctx.globalAlpha = LABEL_ALPHA
  ctx.fillText(name, LABEL_TEXT_OFFSET_X, 0)
  ctx.restore()
}

/**
 * Draw a kind's SQUARE glyph centred at the origin (never a circle):
 *  - world/campaign → a hollow frame (the root container)
 *  - faction        → a filled diamond (a rotated square banner)
 *  - npc/pc         → a stacked pair (pc gets an outline ring)
 *  - item           → a small filled square
 *  - location/other → a filled square
 */
function drawGlyph(ctx: CanvasRenderingContext2D, kind: string, half: number): void {
  const s = half * 2
  switch (kind) {
    case 'world':
    case 'campaign':
      ctx.strokeRect(-half, -half, s, s)
      ctx.strokeRect(-half / 2, -half / 2, s / 2, s / 2)
      return
    case 'faction':
      drawDiamond(ctx, half)
      return
    case 'pc':
      ctx.strokeRect(-half - 2, -half - 2, s + 4, s + 4)
      drawStack(ctx, half)
      return
    case 'npc':
      drawStack(ctx, half)
      return
    case 'item':
      ctx.fillRect(-half / 2, -half / 2, s / 2, s / 2)
      return
    default:
      ctx.fillRect(-half, -half, s, s)
  }
}

/** A filled diamond — a square rotated 45°, still hard-edged 1-bit ink. */
function drawDiamond(ctx: CanvasRenderingContext2D, half: number): void {
  ctx.beginPath()
  ctx.moveTo(0, -half)
  ctx.lineTo(half, 0)
  ctx.lineTo(0, half)
  ctx.lineTo(-half, 0)
  ctx.closePath()
  ctx.fill()
}

/** Two stacked squares — a small "head" square over a larger "body" square. */
function drawStack(ctx: CanvasRenderingContext2D, half: number): void {
  const head = half * 0.7
  ctx.fillRect(-head, -half - head, head * 2, head * 2)
  ctx.fillRect(-half, -head + 1, half * 2, half + head)
}
