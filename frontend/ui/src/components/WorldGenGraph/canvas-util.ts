import { DPR_CAP, type VirtualDims } from '@mythrun/client-core/worldgen'
import type { Point } from './canvas-draw.ts'

// Small DOM/geometry helpers for the WorldGenGraph Canvas (MYT-89 C5). Kept out of
// the hook so each piece stays tiny + independently reasoned. None of this runs
// under jsdom (no 2D context → the loop never starts, no pointer listeners attach).
//
// The graph canvas is AUTHORED in the shared VIRTUAL space (C5 §3.6 — now PANE-ADAPTIVE,
// `virtualDims`: 1:1 with CSS px on narrow panes, the reference width CSS-upscaled on
// wide ones) but RENDERED at the pane's FULL resolution (MYT-89 audit #2): the backing
// store is sized to the ELEMENT's real client pixels × DPR, and the context is scaled so
// 1 draw unit == 1 virtual px. The fog canvas sizes off the same element with the same
// `virtualDims`, so both layers share one virtual→pane transform and the fog-holes line
// up with the glyphs in pixels at every pane size (BUG 2.2 stays closed: draw in virtual
// units, the resolution is the pane's, not baked into the coordinates).

/** The theme ink for the Canvas — the one surface Tailwind can't reach, so the
 *  render loop resolves the token itself. The generated `--color-ink` token is
 *  FROZEN at the light value under `.dark`; the SEMANTIC `--ink` var flips
 *  correctly, so we read `--ink` (see reference_theme_inline_color_var_frozen).
 *  Falls back to the element's resolved `color` (the inherited ink) if `--ink` is
 *  unresolved — a RUNTIME value, so no raw colour literal lives in source (R3). */
export function resolveInk(canvas: HTMLCanvasElement): string {
  const style = getComputedStyle(canvas)
  const ink = style.getPropertyValue('--ink').trim()
  return ink.length > 0 ? ink : style.color
}

/** Last-resort label font when the design-system tokens are unresolved (a bare Canvas /
 *  jsdom, where no 2D context runs anyway). The family mirrors the tail of `--font-body`
 *  and the rem the value of `--text-sm` (0.875rem) — a fallback, never the source of truth. */
const LABEL_FONT_FALLBACK_FAMILY = 'ui-serif, Georgia, serif'
const LABEL_FONT_FALLBACK_REM = 0.875
const ROOT_FONT_PX_FALLBACK = 16

/** The entity-name label font as a Canvas `font` string (`"${px}px ${family}"`), resolved
 *  from the DESIGN-SYSTEM tokens — `--font-body` (the narrative serif the entity-list renders
 *  names in) at `--text-sm` (0.875rem). The Canvas is the one surface Tailwind can't reach, so
 *  we read the tokens ourselves (the same `getComputedStyle` technique as `resolveInk`) and
 *  resolve the rem to px against the root font-size — the DS token, not a bespoke literal,
 *  drives both the size and the family. The DRAWN label, the collision-box measure, and the
 *  fog keep-out all use this ONE string, so the reserved box bounds the drawn glyph. Cache the
 *  result in a ref at mount (the family/size don't animate); falls back to a serif literal if
 *  the tokens are unresolved (jsdom) — a runtime value, no bespoke font baked into a draw path. */
export function resolveLabelFont(canvas: HTMLCanvasElement): string {
  const style = getComputedStyle(canvas)
  const family = style.getPropertyValue('--font-body').trim() || LABEL_FONT_FALLBACK_FAMILY
  const rem = parseFloat(style.getPropertyValue('--text-sm'))
  const sizeRem = Number.isFinite(rem) ? rem : LABEL_FONT_FALLBACK_REM
  const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize)
  const root = Number.isFinite(rootPx) && rootPx > 0 ? rootPx : ROOT_FONT_PX_FALLBACK
  return `${String(Math.round(sizeRem * root))}px ${family}`
}

/** Size the backing store to the ELEMENT's real client pixels × (capped) DPR — full-pane
 *  resolution, so the render is crisp on a wide/retina pane instead of an upscaled fixed
 *  virtual store (MYT-89 audit #2). The context is scaled by `(cssW / virtual.width) ×
 *  dpr` so draw code stays in the shared VIRTUAL space; `virtualDims` derives the virtual
 *  box from the pane's OWN aspect, so one width-derived uniform scale fits both axes at
 *  any pane shape (the responsive fix — no aspect-locked box needed). Mirrors the fog's
 *  `sizeFogCanvas` (same element dims + same scale) so the two layered canvases stay
 *  pixel-aligned. Returns the current CSS box (the size the ELEMENT occupies), which the
 *  pointer mapping needs to convert client px → virtual. */
export function sizeCanvasForDpr(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  virtual: VirtualDims,
): { cssW: number; cssH: number } {
  const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1)
  const rect = canvas.getBoundingClientRect()
  const cssW = Math.max(1, Math.round(rect.width))
  const cssH = Math.max(1, Math.round(rect.height))
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  const scale = (cssW / virtual.width) * dpr
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  return { cssW, cssH }
}

/** Convert a pointer event to the graph's CENTRED VIRTUAL coordinate space (the space
 *  `sim.positions()` reports in). The canvas ELEMENT is CSS-scaled from the virtual
 *  render, so a client-px offset maps to virtual units by the pane→virtual ratio, then
 *  we recentre by the half-dimensions (the host translates the context by (vw/2, vh/2)). */
export function pointerToLocal(
  event: PointerEvent,
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
  virtual: VirtualDims,
): Point {
  const rect = canvas.getBoundingClientRect()
  const scaleX = virtual.width / Math.max(1, cssW)
  const scaleY = virtual.height / Math.max(1, cssH)
  return {
    x: (event.clientX - rect.left) * scaleX - virtual.width / 2,
    y: (event.clientY - rect.top) * scaleY - virtual.height / 2,
  }
}

/** The `displayId` of the node nearest `local` within `radius` px, or null.
 *  `positions` is keyed by `displayId` (the render/selection id-space), so the
 *  returned key threads straight into `pin`/`onSelect` without translation. */
export function nearestKey(
  positions: ReadonlyMap<string, Point>,
  local: Point,
  radius: number,
): string | null {
  let best: string | null = null
  let bestDist = radius
  for (const [key, p] of positions) {
    const d = Math.hypot(p.x - local.x, p.y - local.y)
    if (d <= bestDist) {
      bestDist = d
      best = key
    }
  }
  return best
}

/** True when the primary pointer is FINE (a mouse/trackpad) — hover-raise and
 *  drag-to-pin are fine-only; a coarse (touch) pointer selects via the list. */
export function hasFinePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(pointer: fine)').matches
}
