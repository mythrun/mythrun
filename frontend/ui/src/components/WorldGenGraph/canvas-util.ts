import { DPR_CAP, VIRTUAL_HEIGHT, VIRTUAL_WIDTH } from '@mythrun/client-core/worldgen'
import type { Point } from './canvas-draw.ts'

// Small DOM/geometry helpers for the WorldGenGraph Canvas (MYT-89 C5). Kept out of
// the hook so each piece stays tiny + independently reasoned. None of this runs
// under jsdom (no 2D context → the loop never starts, no pointer listeners attach).
//
// The graph canvas renders in the fog's 900×470 VIRTUAL space (C5 §3.6): the backing
// store is sized to the virtual dims × DPR and the ELEMENT is CSS-stretched to the
// pane, exactly like the fog canvas — so both layers share one CSS scale and the
// fog-holes line up with the glyphs in pixels (BUG 2.2 closes: draw in virtual units,
// scale by CSS, never bake the scale into the coordinates).

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

/** Size the backing store to the 900×470 VIRTUAL space × (capped) DPR and scale the
 *  context so 1 unit == 1 virtual px — mirrors the fog's `sizeFogCanvas` so the two
 *  layered canvases render at the same virtual resolution and CSS-scale identically.
 *  Returns the current CSS box (the physical px size the ELEMENT occupies), which the
 *  pointer mapping needs to convert client px → virtual units. */
export function sizeCanvasForDpr(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): { cssW: number; cssH: number } {
  const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1)
  canvas.width = Math.round(VIRTUAL_WIDTH * dpr)
  canvas.height = Math.round(VIRTUAL_HEIGHT * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const rect = canvas.getBoundingClientRect()
  return { cssW: Math.max(1, Math.round(rect.width)), cssH: Math.max(1, Math.round(rect.height)) }
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
