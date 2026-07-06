import { BUOY_BOB, VIRTUAL_HEIGHT, VIRTUAL_WIDTH } from '@mythrun/client-core/worldgen'
import type { FogFieldEntity, GraphEdge, GraphNode } from '@mythrun/client-core/contract'

// Pure Canvas-2D draw helpers for the world-gen streaming graph (MYT-89 C5). The
// brand register is FLAT 1-BIT PAPER: every entity is a SQUARE ink glyph (never a
// circle/dot/badge), every link a hand-drawn ink line. No colour lives here — the
// host sets `ctx.strokeStyle`/`ctx.fillStyle` to the resolved theme ink before
// calling (keeps R3 intact for a raw Canvas surface Tailwind can't reach).
//
// COORDINATE SPACE (C5 unification, §3.6): the graph shares the fog's 900×470
// VIRTUAL space. The force-sim reports CENTRED positions in `[−VW/2, VW/2] ×
// [−VH/2, VH/2]`; the host translates the context by (VW/2, VH/2) before calling,
// so these draw in the centred space AND `centredToVirtual` (below) maps the exact
// same point into the fog's top-left virtual space — one point, two surfaces, so a
// node's glyph and its fog-hole land on the identical coordinate.

/** A resolved node position in the host's (centred) canvas space. */
export interface Point {
  x: number
  y: number
}

/** Base glyph half-extent (px) at 1× device scale. Hover/selection scale it up. */
const GLYPH_HALF = 6
const HOVER_SCALE = 1.5
const SELECT_FRAME_PAD = 5
const LABEL_OFFSET = 12
const LABEL_ALPHA = 0.62
const EDGE_ALPHA = 0.4
/** Deterministic per-edge bow (px) so links read hand-drawn without frame jitter. */
const EDGE_BOW = 7

/** Map a CENTRED sim point (`[−VW/2, VW/2] × [−VH/2, VH/2]`) into the fog's top-left
 *  VIRTUAL space (`[0, VW] × [0, VH]`). This is the exact translation the host applies
 *  to the graph context (`translate(VW/2, VH/2)`), so a node drawn here lands on the
 *  SAME virtual coordinate the fog obstacle is built at — the C5 coord unification. */
export function centredToVirtual(p: Point): Point {
  return { x: p.x + VIRTUAL_WIDTH / 2, y: p.y + VIRTUAL_HEIGHT / 2 }
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
 * Nodes without a position (not yet placed) are skipped. Pure — unit-testable without
 * a Canvas, and the SINGLE source both the fog obstacles and the glyph draw derive from.
 */
export function fogEntitiesFrom(
  nodes: readonly GraphNode[],
  positions: ReadonlyMap<string, Point>,
  t: number | null,
): FogFieldEntity[] {
  const out: FogFieldEntity[] = []
  for (const node of nodes) {
    const centred = positions.get(node.displayId)
    if (centred === undefined) continue
    const v = centredToVirtual(centred)
    const bob = t === null ? { x: 0, y: 0 } : bobOffset(v.x, v.y, t)
    out.push({ x: v.x + bob.x, y: v.y + bob.y, kind: node.kind, name: node.name })
  }
  return out
}

/** Stable small hash of a string → used for a deterministic (non-animating) bow on
 *  each edge, so the "hand-drawn" wobble is fixed per link, not reshuffled per frame. */
function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

/** Draw every edge whose endpoints both have a position, as a faint hand-drawn ink
 *  arc (a quadratic bowed off the straight line by a stable per-edge offset). Edge
 *  endpoints are entity UUIDs and `positions` is keyed by `displayId` (also the
 *  UUID once finalized) — the two id-spaces are reconciled, so the lookup matches
 *  (BUG 2.1: keying nodes on synthKey made this miss and drop every edge). */
export function drawEdges(
  ctx: CanvasRenderingContext2D,
  edges: readonly GraphEdge[],
  positions: ReadonlyMap<string, Point>,
): void {
  ctx.save()
  ctx.globalAlpha = EDGE_ALPHA
  ctx.lineWidth = 1
  for (const edge of edges) {
    const a = positions.get(edge.from)
    const b = positions.get(edge.to)
    if (a === undefined || b === undefined) continue
    drawEdge(ctx, a, b, edge.synthKey)
  }
  ctx.restore()
}

/** One bowed link: a quadratic curve whose control point is nudged perpendicular
 *  to the midline by a stable ±EDGE_BOW so parallel links don't overlap flat. */
function drawEdge(ctx: CanvasRenderingContext2D, a: Point, b: Point, key: string): void {
  const midX = (a.x + b.x) / 2
  const midY = (a.y + b.y) / 2
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const bow = ((hash(key) % 200) / 100 - 1) * EDGE_BOW // stable in [-EDGE_BOW, EDGE_BOW]
  const cx = midX + (-dy / len) * bow
  const cy = midY + (dx / len) * bow
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.quadraticCurveTo(cx, cy, b.x, b.y)
  ctx.stroke()
}

/** How to emphasise + animate the node layer this frame — all in `displayId` space
 *  (the render/selection id-space). `t` is the buoy-bob clock in seconds (`null`
 *  disables the bob, reduced motion); `showLabels` gates the name label (OFF during
 *  generation — §3.4 — the glyphs are mono-ink shapes only; the reveal turns it on). */
export interface NodeDecoration {
  selectedKey: string | undefined
  hoverKey: string | null
  t: number | null
  showLabels: boolean
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
    const hovered = node.displayId === deco.hoverKey
    const selected = node.displayId === deco.selectedKey
    const bob = bobFor(p, deco.t)
    drawNode(ctx, node, { x: p.x + bob.x, y: p.y + bob.y }, hovered, selected, deco.showLabels)
  }
}

/** The bob offset for a centred point (or zero when the bob is disabled). Kept beside
 *  `fogEntitiesFrom`'s identical logic so the glyph and its fog-hole share one bob. */
function bobFor(p: Point, t: number | null): Point {
  if (t === null) return { x: 0, y: 0 }
  const v = centredToVirtual(p)
  return bobOffset(v.x, v.y, t)
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  node: GraphNode,
  p: Point,
  hovered: boolean,
  selected: boolean,
  showLabel: boolean,
): void {
  const half = GLYPH_HALF * (hovered ? HOVER_SCALE : 1)
  ctx.save()
  ctx.translate(p.x, p.y)
  if (selected) {
    ctx.strokeRect(-(half + SELECT_FRAME_PAD), -(half + SELECT_FRAME_PAD), (half + SELECT_FRAME_PAD) * 2, (half + SELECT_FRAME_PAD) * 2)
  }
  drawGlyph(ctx, node.kind, half)
  if (showLabel) drawLabel(ctx, node.name, half)
  ctx.restore()
}

/** The quiet entity name to the right of the glyph — low-alpha ink, mono. */
function drawLabel(ctx: CanvasRenderingContext2D, name: string, half: number): void {
  ctx.save()
  ctx.globalAlpha = LABEL_ALPHA
  ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace'
  ctx.textBaseline = 'middle'
  ctx.fillText(name, half + LABEL_OFFSET, 0)
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
