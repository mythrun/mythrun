import type { ForceSim, VirtualDims } from '@mythrun/client-core/worldgen'
import type { Point } from './canvas-draw.ts'
import { hasFinePointer, nearestKey, pointerToLocal } from './canvas-util.ts'

// The pointer interaction layer for the WorldGenGraph Canvas (MYT-89 C5/audit #5 + the
// density redesign), split from use-graph-canvas.ts (the module-size rail). Two surfaces:
//
//   FINE pointer + motion — hover-raise + drag-to-pin are LIVE whenever motion is on
//   (dragging a node through the fog is the toy, available DURING generation), a click
//   FOCUSES the node (its name is promoted into the label tier — the density redesign's
//   reveal-a-name gesture) and, in the reveal, selects (`interactiveRef`).
//
//   COARSE pointer (touch) or reduced motion — a TAP-only surface: pointerdown/up with
//   a movement-slop gate, NO pointer capture, NO preventDefault, no drag — so the
//   canvas never fights page scroll (the touch-drag conflict that kept touch gated
//   off). A tap on a glyph focuses it (name reveal); a tap on empty fog clears the
//   focus; in the reveal a glyph tap also selects.
//
// All geometry is converted through the CURRENT pane-adaptive virtual dims
// (`virtualRef`), so a hit lands on the same node at every pane size.

/** px radius (VIRTUAL units) a FINE pointer must fall within to hit a node glyph. */
const HIT_RADIUS = 16
/** px radius (VIRTUAL units) for a COARSE (touch) tap — a fatter finger target. */
const HIT_RADIUS_COARSE = 28
/** px (client) a pointer must travel before a press becomes a drag (vs a select tap). */
const DRAG_THRESHOLD = 4
/** px (client) of movement past which a touch press is a SCROLL/pan, not a tap. */
const TAP_SLOP = 8

export interface DragState {
  /** The dragged node's `displayId` (the render/selection id-space). */
  key: string
  moved: boolean
  downX: number
  downY: number
}

export interface PointerDeps {
  getSim: () => ForceSim
  sizeRef: React.RefObject<{ cssW: number; cssH: number }>
  /** The CURRENT pane-adaptive virtual dims — the client-px → virtual mapping's scale. */
  virtualRef: React.RefObject<VirtualDims>
  hoverRef: React.RefObject<string | null>
  dragRef: React.RefObject<DragState | null>
  onSelectRef: React.RefObject<(displayId: string) => void>
  /** Gates ONLY tap-to-select (MYT-89 audit #5): a click fires `onSelect` in the reveal
   *  (`true`), but is inert during generation (`false`). Drag-to-pin is live either way. */
  interactiveRef: React.RefObject<boolean>
  /** Sticky focus (the density redesign): promotes the node's name into the label tier
   *  + raises the glyph. `null` clears. The hook re-tiers, re-boxes, and re-flows. */
  setFocus: (displayId: string | null) => void
}

/** Attach the pointer surface for the current mode, when the canvas has a live 2D
 *  context (jsdom → no-op; the entity list is the accessible selection surface):
 *  the full fine-pointer handlers under motion + a fine pointer, otherwise the
 *  tap-only surface (touch, and reduced motion where drag has no live physics to
 *  show). Returns the teardown (or undefined). Module-scoped so the hook body stays
 *  lean (mirrors `observeResize`). */
export function setupPointerHandlers(
  canvas: HTMLCanvasElement | null,
  reducedMotion: boolean,
  deps: PointerDeps,
): (() => void) | undefined {
  if (canvas === null) return undefined
  if (canvas.getContext('2d') === null) return undefined
  if (!reducedMotion && hasFinePointer()) return attachPointerHandlers(canvas, deps)
  return attachTapHandlers(canvas, deps)
}

/** Wire pointermove/down/up/leave on the canvas; returns the teardown. Split out of
 *  the hook so the effect body stays small and this stays independently readable.
 *  Exported for unit test (jsdom can't drive real pointer capture through the effect). */
export function attachPointerHandlers(canvas: HTMLCanvasElement, deps: PointerDeps): () => void {
  const { getSim, sizeRef, virtualRef, hoverRef, dragRef, onSelectRef, interactiveRef, setFocus } = deps
  const localOf = (e: PointerEvent): Point =>
    pointerToLocal(e, canvas, sizeRef.current.cssW, sizeRef.current.cssH, virtualRef.current)

  const onDown = (e: PointerEvent): void => {
    const key = nearestKey(getSim().positions(), localOf(e), HIT_RADIUS)
    if (key === null) {
      setFocus(null) // pressing empty fog clears the sticky name reveal
      return
    }
    dragRef.current = { key, moved: false, downX: e.clientX, downY: e.clientY }
    canvas.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent): void => {
    const drag = dragRef.current
    if (drag === null) {
      hoverRef.current = nearestKey(getSim().positions(), localOf(e), HIT_RADIUS)
      return
    }
    if (
      !drag.moved &&
      Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) > DRAG_THRESHOLD
    ) {
      drag.moved = true
    }
    if (drag.moved) {
      const local = localOf(e)
      getSim().pin(drag.key, local.x, local.y)
    }
  }
  const onUp = (): void => {
    const drag = dragRef.current
    if (drag === null) return
    if (!drag.moved) {
      getSim().unpin(drag.key) // a tap (not a drag) releases any prior pin, always
      setFocus(drag.key) // …and focuses: the name joins the label tier (density redesign)
      if (interactiveRef.current) onSelectRef.current(drag.key) // …but only selects in the reveal
    }
    dragRef.current = null
  }
  const onLeave = (): void => {
    hoverRef.current = null
  }

  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointerleave', onLeave)
  return () => {
    canvas.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('pointerup', onUp)
    canvas.removeEventListener('pointerleave', onLeave)
  }
}

/** Wire the TAP-only surface (coarse pointers / reduced motion): a slop-gated
 *  down→up pair focuses the nearest glyph (name reveal) or clears the focus on empty
 *  fog, and selects in the reveal. Deliberately NO capture / NO preventDefault / no
 *  move handling — a scroll gesture that starts on the canvas travels past `TAP_SLOP`
 *  (or fires pointercancel) and is ignored, so the page scrolls exactly as if the
 *  canvas weren't there. Exported for unit test. */
export function attachTapHandlers(canvas: HTMLCanvasElement, deps: PointerDeps): () => void {
  const { getSim, sizeRef, virtualRef, onSelectRef, interactiveRef, setFocus } = deps
  let press: { x: number; y: number } | null = null

  const onDown = (e: PointerEvent): void => {
    press = { x: e.clientX, y: e.clientY }
  }
  const onUp = (e: PointerEvent): void => {
    const start = press
    press = null
    if (start === null) return
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP) return // a scroll, not a tap
    const local = pointerToLocal(e, canvas, sizeRef.current.cssW, sizeRef.current.cssH, virtualRef.current)
    const key = nearestKey(getSim().positions(), local, HIT_RADIUS_COARSE)
    setFocus(key)
    if (key !== null && interactiveRef.current) onSelectRef.current(key)
  }
  const onCancel = (): void => {
    press = null // the browser took the gesture (a scroll) — never a tap
  }

  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onCancel)
  return () => {
    canvas.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('pointerup', onUp)
    canvas.removeEventListener('pointercancel', onCancel)
  }
}
