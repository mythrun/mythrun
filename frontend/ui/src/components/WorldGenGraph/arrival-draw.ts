import type { GraphNode } from '@mythrun/client-core/contract'
import type { Point } from './canvas-draw.ts'

// The node ARRIVAL treatment (MYT-89 audit v2): an arriving entity is DRAWN, not
// popped in — "trace, then stamp." The same hand that draws the C6 edge penstrokes
// outlines the glyph's silhouette as a partial stroke over NODE_TRACE_MS, starting
// at a per-node deterministic point on the perimeter (hashed on synthKey, so a
// burst of simultaneous arrivals doesn't move in lockstep); at completion the
// solid ink lands in one beat — the fill, the inner detail (the world frame's
// inner square, the pc's stack), and the name label together. Strictly the
// surface's existing vocabulary: crisp 1px ink strokes and solid fills — no alpha
// fades, no gradients, no scaling.
//
// Keying and seeding mirror the C6 edge idiom (`recordEdgeAppearances`):
// appear-times are stamped by synthKey (a finalize re-keys displayId only, so the
// arrival never replays), and nodes already present at the first motion frame (a
// mid-gen reload's seed snapshot) are stamped SEED_APPEAR_MS — render full
// immediately, the node counterpart of the edge `arrivalIndex < 0` rule. Reduced
// motion resolves progress 1: instant final state, never a stranded partial.
// Everything here is pure geometry + clock math; the drawNode branch in
// canvas-draw.ts consumes it.

/** The silhouette trace duration (ms) — between the edge SNAP (180) and WEAVE
 *  (900) reference points: brief enough that ~40 arrivals per generation stay
 *  quiet, deliberate enough to read as a pen move rather than a flicker. */
export const NODE_TRACE_MS = 320

/** Appear-time sentinel for nodes present BEFORE the first motion frame (a
 *  mid-gen reload's seeds): infinitely in the past, so progress resolves 1 and
 *  they render full without ever animating. */
export const SEED_APPEAR_MS = Number.NEGATIVE_INFINITY

/** The stack glyph's head square, as a ratio of the glyph half-extent — shared by
 *  the final drawn stack (canvas-draw's drawStack) and the arrival silhouette, so
 *  the trace can never drift from the ink it becomes. */
export const STACK_HEAD_RATIO = 0.7

/** The pc outline ring's padding (px) beyond the glyph half-extent — shared with
 *  the final drawn ring for the same no-drift reason. */
export const PC_RING_PAD = 2

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** A node's [0,1] arrival progress at `nowMs`, given the rAF-clock time its
 *  synthKey was first seen (`appearMs`). Reduced motion is 1 (instant final
 *  state); an unstamped node is 0 (about to start, same convention as the edge
 *  draw-in); a SEED_APPEAR_MS stamp resolves 1 at any clock. */
export function nodeArriveProgress(
  appearMs: number | undefined,
  nowMs: number,
  reducedMotion: boolean,
): number {
  if (reducedMotion) return 1
  if (appearMs === undefined) return 0
  return clamp01((nowMs - appearMs) / NODE_TRACE_MS)
}

/** Stamp each not-yet-seen node's appear-time (first-seen only — a later frame,
 *  a rename, or a finalize displayId re-key can never restart a trace, because
 *  the map keys on the stable synthKey). The hook's motion loop calls this every
 *  frame: with SEED_APPEAR_MS on its first pass (whatever is already present is a
 *  seed), then with the live clock. */
export function recordNodeAppearances(
  nodes: readonly Pick<GraphNode, 'synthKey'>[],
  appear: Map<string, number>,
  nowMs: number,
): void {
  for (const node of nodes) {
    if (!appear.has(node.synthKey)) appear.set(node.synthKey, nowMs)
  }
}

/** A deterministic fraction in [0, 1) for a node key — where on its perimeter the
 *  trace starts, so simultaneous arrivals start at different corners. FNV-1a over
 *  the key's chars with the same xorshift finisher as the dither's `chaosAt`:
 *  mechanical computation, never Math.random in the render path (an identical
 *  frame must redraw identically). */
export function hashFrac(key: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < key.length; i++) {
    h = (h ^ key.charCodeAt(i)) >>> 0
    h = Math.imul(h, 16777619) >>> 0
  }
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 1274126177) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return h / 0x100000000
}

/** An axis-aligned square outline at ±h, corner-first — the default silhouette. */
function rectOutline(h: number): Point[] {
  return [
    { x: -h, y: -h },
    { x: h, y: -h },
    { x: h, y: h },
    { x: -h, y: h },
  ]
}

/** The npc/pc stack's OUTER silhouette — the union outline of the head square over
 *  the body square (the head's bottom edge is swallowed by the body), matching
 *  drawStack's fill geometry exactly so the completed fill lands on the trace. */
function stackOutline(half: number): Point[] {
  const head = half * STACK_HEAD_RATIO
  const bodyTop = -head + 1
  const bodyBottom = half + 1
  return [
    { x: -head, y: -half - head },
    { x: head, y: -half - head },
    { x: head, y: bodyTop },
    { x: half, y: bodyTop },
    { x: half, y: bodyBottom },
    { x: -half, y: bodyBottom },
    { x: -half, y: bodyTop },
    { x: -head, y: bodyTop },
  ]
}

/**
 * The closed silhouette polyline an arriving glyph traces, centred at the origin
 * (the same local space drawGlyph draws in):
 *  - world/campaign → the outer frame ring (the inner square stamps at completion)
 *  - faction        → the diamond
 *  - npc            → the stacked-pair union silhouette
 *  - pc             → its outline ring (the stack stamps at completion)
 *  - item           → the small square
 *  - location/other → the glyph square
 */
export function arrivalOutline(kind: string, half: number): Point[] {
  switch (kind) {
    case 'faction':
      return [
        { x: 0, y: -half },
        { x: half, y: 0 },
        { x: 0, y: half },
        { x: -half, y: 0 },
      ]
    case 'pc':
      return rectOutline(half + PC_RING_PAD)
    case 'npc':
      return stackOutline(half)
    case 'item':
      return rectOutline(half / 2)
    default:
      return rectOutline(half)
  }
}

/**
 * Stroke `progress` of the way around the closed polyline `pts`, starting
 * `startFrac` of the perimeter in (the per-node hash) — the node-glyph
 * counterpart of the edge penstroke's endpoint lerp. A draw that runs past the
 * loop closure wraps as a second subpath of the SAME stroke. Progress ≤ 0 and
 * degenerate outlines draw nothing; the caller switches to the full glyph at
 * progress ≥ 1, so a full-perimeter stroke here is only a defensive fallback.
 */
export function strokePartialOutline(
  ctx: CanvasRenderingContext2D,
  pts: readonly Point[],
  startFrac: number,
  progress: number,
): void {
  if (progress <= 0 || pts.length < 2) return
  // Cumulative arc distances: cum[i] = distance along the loop to vertex i,
  // cum[pts.length] = the full perimeter (back around to vertex 0).
  const cum: number[] = [0]
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    if (a === undefined || b === undefined) return
    cum.push((cum[i] ?? 0) + Math.hypot(b.x - a.x, b.y - a.y))
  }
  const total = cum[pts.length] ?? 0
  if (total <= 0) return
  const start = (((startFrac % 1) + 1) % 1) * total
  const end = start + Math.min(progress, 1) * total
  ctx.beginPath()
  traceArc(ctx, pts, cum, start, Math.min(end, total))
  if (end > total) traceArc(ctx, pts, cum, 0, end - total)
  ctx.stroke()
}

/** One subpath along the loop, from arc-distance `a` to `b` (both in [0, total]). */
function traceArc(
  ctx: CanvasRenderingContext2D,
  pts: readonly Point[],
  cum: readonly number[],
  a: number,
  b: number,
): void {
  if (b <= a) return
  const from = pointAt(pts, cum, a)
  ctx.moveTo(from.x, from.y)
  for (let i = 1; i < pts.length; i++) {
    const d = cum[i] ?? 0
    if (d <= a) continue
    if (d >= b) break
    const v = pts[i]
    if (v !== undefined) ctx.lineTo(v.x, v.y)
  }
  const to = pointAt(pts, cum, b)
  ctx.lineTo(to.x, to.y)
}

/** The point at arc-distance `d` along the closed loop. */
function pointAt(pts: readonly Point[], cum: readonly number[], d: number): Point {
  for (let i = 0; i < pts.length; i++) {
    const segEnd = cum[i + 1] ?? 0
    if (d <= segEnd) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      if (a === undefined || b === undefined) break
      const segStart = cum[i] ?? 0
      const segLen = segEnd - segStart
      const t = segLen > 0 ? (d - segStart) / segLen : 0
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
  }
  const first = pts[0]
  return first === undefined ? { x: 0, y: 0 } : { x: first.x, y: first.y }
}
