import type { Point } from '../canvas-draw.ts'

// A recording Canvas-2D stand-in shared by the WorldGenGraph draw tests: jsdom has
// no real 2D context, so the draw helpers are exercised against a call recorder —
// draw methods append to logs, everything else is a no-op, and property writes are
// absorbed (the `font` set is captured). Enough to assert what got drawn, where,
// and in which font.

export interface Recorder {
  ctx: CanvasRenderingContext2D
  strokes: number
  moves: Point[]
  /** Every `lineTo` endpoint — edges are STRAIGHT lines now (the density redesign
   *  dropped the quadratic bow: straight strings read cleanly at a real ~70-edge load
   *  and fit the ruled-paper register). */
  lines: Point[]
  translates: Point[]
  /** Every `fillText(text, …)` call's text — the node-label draws (drawGlyph never
   *  fillTexts, only fill/stroke rects), so this is exactly the rendered names. */
  texts: string[]
  /** Every `fillText` call with its position — so a test can assert WHERE the label lands
   *  (the shared `LABEL_TEXT_OFFSET_X` the collision box + fog reserve to). */
  fillTexts: { text: string; x: number; y: number }[]
  /** Every value assigned to `ctx.font` — so a test can assert the label draws in the
   *  resolved design-system font the host passes (not a bespoke literal). */
  fonts: string[]
  /** Every `fillRect` call — the glyph geometry, so a test can assert the hover/focus
   *  raise actually scales the drawn shape. */
  rects: { x: number; y: number; w: number; h: number }[]
  /** Every `strokeRect` call — the selection FRAME and the stroked glyph rings
   *  (world/campaign frames, the pc ring), so a test can assert a frame's real
   *  presence/absence. */
  strokeRects: { x: number; y: number; w: number; h: number }[]
  /** Every `strokeText` call — the paper HALO under each label (density redesign). */
  strokeTexts: { text: string; x: number; y: number }[]
}

export function recorder(): Recorder {
  const r: Recorder = {
    strokes: 0,
    moves: [],
    lines: [],
    translates: [],
    texts: [],
    fillTexts: [],
    fonts: [],
    rects: [],
    strokeRects: [],
    strokeTexts: [],
    ctx: undefined as unknown as CanvasRenderingContext2D,
  }
  const impl: Record<string, (...args: never[]) => void> = {
    stroke: () => {
      r.strokes += 1
    },
    moveTo: (x: number, y: number) => {
      r.moves.push({ x, y })
    },
    lineTo: (x: number, y: number) => {
      r.lines.push({ x, y })
    },
    translate: (x: number, y: number) => {
      r.translates.push({ x, y })
    },
    fillText: (text: string, x: number, y: number) => {
      r.texts.push(text)
      r.fillTexts.push({ text, x, y })
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      r.rects.push({ x, y, w, h })
    },
    strokeRect: (x: number, y: number, w: number, h: number) => {
      r.strokeRects.push({ x, y, w, h })
    },
    strokeText: (text: string, x: number, y: number) => {
      r.strokeTexts.push({ text, x, y })
    },
  }
  r.ctx = new Proxy(
    {},
    {
      get: (_t, prop: string) => impl[prop] ?? ((): void => undefined),
      set: (_t, prop: string, value: unknown) => {
        if (prop === 'font') r.fonts.push(String(value))
        return true
      },
    },
  ) as unknown as CanvasRenderingContext2D
  return r
}
