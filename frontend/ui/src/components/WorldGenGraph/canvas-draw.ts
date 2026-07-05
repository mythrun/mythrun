import type { GraphEdge, GraphNode } from '@mythrun/client-core/contract'

// Pure Canvas-2D draw helpers for the world-gen streaming graph (MYT-89 C4). The
// brand register is FLAT 1-BIT PAPER: every entity is a SQUARE ink glyph (never a
// circle/dot/badge), every link a hand-drawn ink line. No colour lives here — the
// host sets `ctx.strokeStyle`/`ctx.fillStyle` to the resolved theme ink before
// calling, exactly like GhostBloomField (keeps R3 intact for a raw Canvas surface
// Tailwind can't reach). The host also translates the context to graph centre, so
// these draw in the centred, non-negative-friendly coordinate space.

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

/** Stable small hash of a string → used for a deterministic (non-animating) bow on
 *  each edge, so the "hand-drawn" wobble is fixed per link, not reshuffled per frame. */
function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

/** Draw every edge whose endpoints both have a position, as a faint hand-drawn ink
 *  arc (a quadratic bowed off the straight line by a stable per-edge offset). */
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

/** How to emphasise a node this frame. Both fields are always passed (may be
 *  absent-as-`undefined`/`null`) — required-but-nullable keeps the render loop's
 *  object literal clean under `exactOptionalPropertyTypes`. */
export interface NodeDecoration {
  selectedKey: string | undefined
  hoverKey: string | null
}

/**
 * Draw every node as its per-kind square glyph plus a quiet name label, and return
 * the anchor points for the ghost-bloom field (so churn clusters near real nodes).
 * The hovered node is drawn raised (larger); the selected node gets a square frame.
 */
export function drawNodes(
  ctx: CanvasRenderingContext2D,
  nodes: readonly GraphNode[],
  positions: ReadonlyMap<string, Point>,
  deco: NodeDecoration,
): Point[] {
  const points: Point[] = []
  for (const node of nodes) {
    const p = positions.get(node.synthKey)
    if (p === undefined) continue
    points.push(p)
    const hovered = node.synthKey === deco.hoverKey
    const selected = node.synthKey === deco.selectedKey
    drawNode(ctx, node, p, hovered, selected)
  }
  return points
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  node: GraphNode,
  p: Point,
  hovered: boolean,
  selected: boolean,
): void {
  const half = GLYPH_HALF * (hovered ? HOVER_SCALE : 1)
  ctx.save()
  ctx.translate(p.x, p.y)
  if (selected) {
    ctx.strokeRect(-(half + SELECT_FRAME_PAD), -(half + SELECT_FRAME_PAD), (half + SELECT_FRAME_PAD) * 2, (half + SELECT_FRAME_PAD) * 2)
  }
  drawGlyph(ctx, node.kind, half)
  drawLabel(ctx, node.name, half)
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
