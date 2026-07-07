import type { ForceSim, VirtualDims } from '@mythrun/client-core/worldgen'
import type { Point } from './canvas-draw.ts'
import { hasFinePointer, nearestKey, pointerToLocal } from './canvas-util.ts'

// The fine-pointer interaction layer for the WorldGenGraph Canvas (MYT-89 C5/audit #5),
// split from use-graph-canvas.ts (the module-size rail): hover-raise + drag-to-pin are
// LIVE whenever motion is on and a FINE pointer is present — dragging a node through the
// fog is the toy, available DURING generation — while tap-to-select is reveal-gated
// (`interactiveRef`). All geometry is converted through the CURRENT pane-adaptive
// virtual dims (`virtualRef`), so a hit lands on the same node at every pane size.

/** px radius (VIRTUAL units) a pointer must fall within to hit a node glyph. */
const HIT_RADIUS = 16
/** px (client) a pointer must travel before a press becomes a drag (vs a select tap). */
const DRAG_THRESHOLD = 4

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
}

/** Attach the fine-pointer handlers when motion is on, a FINE pointer is present, and the
 *  canvas has a live 2D context; otherwise a no-op (a coarse/touch pointer, reduced motion,
 *  or jsdom → the entity list is the selection surface). Returns the teardown (or undefined).
 *  Module-scoped so the hook body stays lean (mirrors `observeResize`). NOT gated on
 *  `interactive` — drag is live during generation; only `onSelect` is reveal-gated (#5). */
export function setupPointerHandlers(
  canvas: HTMLCanvasElement | null,
  reducedMotion: boolean,
  deps: PointerDeps,
): (() => void) | undefined {
  if (reducedMotion || !hasFinePointer() || canvas === null) return undefined
  if (canvas.getContext('2d') === null) return undefined
  return attachPointerHandlers(canvas, deps)
}

/** Wire pointermove/down/up/leave on the canvas; returns the teardown. Split out of
 *  the hook so the effect body stays small and this stays independently readable.
 *  Exported for unit test (jsdom can't drive real pointer capture through the effect). */
export function attachPointerHandlers(canvas: HTMLCanvasElement, deps: PointerDeps): () => void {
  const { getSim, sizeRef, virtualRef, hoverRef, dragRef, onSelectRef, interactiveRef } = deps
  const localOf = (e: PointerEvent): Point =>
    pointerToLocal(e, canvas, sizeRef.current.cssW, sizeRef.current.cssH, virtualRef.current)

  const onDown = (e: PointerEvent): void => {
    const key = nearestKey(getSim().positions(), localOf(e), HIT_RADIUS)
    if (key === null) return
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
