import { DPR_CAP, VIRTUAL_HEIGHT, VIRTUAL_WIDTH } from '@mythrun/client-core/worldgen'
import type { Point } from './canvas-draw.ts'

// Small DOM/geometry helpers for the WorldGenGraph Canvas (MYT-89 C5). Kept out of
// the hook so each piece stays tiny + independently reasoned. None of this runs
// under jsdom (no 2D context → the loop never starts, no pointer listeners attach).
//
// The graph canvas is AUTHORED in the fog's 900×470 VIRTUAL space (C5 §3.6) but
// RENDERED at the pane's FULL resolution (MYT-89 audit #2): the backing store is sized
// to the ELEMENT's real client pixels × DPR (not a fixed 900×470 that CSS then upscales
// to a wide/retina pane → the blur/zoom), and the context is scaled so 1 draw unit == 1
// virtual px. The fog canvas sizes identically off the same element, so both layers
// share one virtual→pane transform and the fog-holes line up with the glyphs in pixels
// (BUG 2.2 stays closed: draw in virtual units, the resolution is the pane's, not baked
// into the coordinates).

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

/** Size the backing store to the ELEMENT's real client pixels × (capped) DPR — full-pane
 *  resolution, so the render is crisp on a wide/retina pane instead of an upscaled fixed
 *  900×470 (MYT-89 audit #2). The context is scaled by `(cssW / VIRTUAL_WIDTH) × dpr` so
 *  draw code stays in the 900×470 VIRTUAL space; the `aspect-[90/47]` box keeps
 *  `cssH/cssW ≈ VIRTUAL_HEIGHT/VIRTUAL_WIDTH`, so one width-derived uniform scale fits
 *  both axes. Mirrors the fog's `sizeFogCanvas` exactly (same element dims + same scale)
 *  so the two layered canvases stay pixel-aligned. Returns the current CSS box (the size
 *  the ELEMENT occupies), which the pointer mapping needs to convert client px → virtual. */
export function sizeCanvasForDpr(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): { cssW: number; cssH: number } {
  const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1)
  const rect = canvas.getBoundingClientRect()
  const cssW = Math.max(1, Math.round(rect.width))
  const cssH = Math.max(1, Math.round(rect.height))
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  const scale = (cssW / VIRTUAL_WIDTH) * dpr
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  return { cssW, cssH }
}

/** Convert a pointer event to the graph's CENTRED VIRTUAL coordinate space (the space
 *  `sim.positions()` reports in). The canvas ELEMENT is CSS-scaled from the virtual
 *  render, so a client-px offset maps to virtual units by the pane→virtual ratio, then
 *  we recentre by the half-dimensions (the host translates the context by (VW/2, VH/2)). */
export function pointerToLocal(
  event: PointerEvent,
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
): Point {
  const rect = canvas.getBoundingClientRect()
  const scaleX = VIRTUAL_WIDTH / Math.max(1, cssW)
  const scaleY = VIRTUAL_HEIGHT / Math.max(1, cssH)
  return {
    x: (event.clientX - rect.left) * scaleX - VIRTUAL_WIDTH / 2,
    y: (event.clientY - rect.top) * scaleY - VIRTUAL_HEIGHT / 2,
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
