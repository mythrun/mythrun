import type { Point } from './canvas-draw.ts'

// Small DOM/geometry helpers for the WorldGenGraph Canvas (MYT-89 C4). Kept out of
// the hook so each piece stays tiny + independently reasoned. None of this runs
// under jsdom (no 2D context → the loop never starts, no pointer listeners attach).

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

/** Size the backing store to the CSS box × devicePixelRatio and scale the context
 *  so 1 unit == 1 CSS px. Returns the CSS dimensions (the drawing space). */
export function sizeCanvasForDpr(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): { cssW: number; cssH: number } {
  const rect = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, Math.round(rect.width))
  const cssH = Math.max(1, Math.round(rect.height))
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { cssW, cssH }
}

/** Convert a pointer event to the graph's CENTRED coordinate space (the space
 *  `sim.positions()` reports in — the host translates the context by (w/2, h/2)). */
export function pointerToLocal(
  event: PointerEvent,
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
): Point {
  const rect = canvas.getBoundingClientRect()
  return {
    x: event.clientX - rect.left - cssW / 2,
    y: event.clientY - rect.top - cssH / 2,
  }
}

/** The `synthKey` of the node nearest `local` within `radius` px, or null. */
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
