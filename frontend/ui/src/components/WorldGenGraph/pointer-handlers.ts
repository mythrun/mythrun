import type { CameraPoint, ForceSim, VirtualDims } from '@mythrun/client-core/worldgen'
import type { Point } from './canvas-draw.ts'
import { hasFinePointer, nearestKey, pointerToLocal } from './canvas-util.ts'

// The pointer interaction layer for the WorldGenGraph Canvas (MYT-89 C5/audit #5 + the
// density redesign + the T1b pannable camera), split from use-graph-canvas.ts (the
// module-size rail). Two surfaces:
//
//   FINE pointer + motion — hover-raise + drag-to-pin are LIVE whenever motion is on
//   (dragging a node through the fog is the toy, available DURING generation), a click
//   FOCUSES the node (its name is promoted into the label tier) and, in the reveal,
//   selects (`interactiveRef`). With the CAMERA engaged (the world larger than the
//   pane), a drag that starts on EMPTY fog pans the camera instead — node drag keeps
//   priority on a glyph hit. Where the world fits the pane nothing changes (the pan is
//   never armed).
//
//   COARSE pointer (touch) or reduced motion — the T1b touch surface. With the camera
//   DISENGAGED (the world fits the pane): the shipped tap-only behaviour — a
//   movement-slop gate, NO pointer capture, no camera, so the canvas never fights page
//   scroll. With the camera ENGAGED (a phone at real density; the pane also carries
//   `touch-action: none`): the canvas OWNS touch — one-finger drag PANS the camera
//   (the world follows the finger, clamped at the edges), and a press that stays
//   within the slop is a TAP: it focuses the glyph (name reveal) and, in the reveal,
//   selects. This deliberately replaces the previous tap-not-drag mechanism on small
//   panes; taps are unchanged.
//
// All geometry is converted through the CURRENT world/view/camera (`virtualRef` /
// `viewRef` / `readCamera`), so a hit lands on the same node at every pane size and
// every camera position.

/** px radius (VIRTUAL units) a FINE pointer must fall within to hit a node glyph. */
const HIT_RADIUS = 16
/** px radius (VIRTUAL units) for a COARSE (touch) tap — a fatter finger target. */
const HIT_RADIUS_COARSE = 28
/** px (client) a pointer must travel before a press becomes a drag (vs a select tap). */
const DRAG_THRESHOLD = 4
/** px (client) of movement past which a touch press is a PAN (camera engaged) or a
 *  page scroll (camera disengaged), never a tap. */
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
  /** The CURRENT WORLD dims (the centred space `sim.positions()` reports in). */
  virtualRef: React.RefObject<VirtualDims>
  /** The camera VIEW dims — what the pane's CSS box maps to (T1b). */
  viewRef: React.RefObject<VirtualDims>
  /** The camera position (top-left world coords) — the hit-test pan offset (T1b). */
  readCamera: () => CameraPoint
  /** Whether the camera is engaged (world > pane): drags pan; touch is owned (T1b). */
  isEngaged: () => boolean
  /** Manual camera pan by a client-px delta (clamped; defers the auto-follow). */
  panBy: (dxClient: number, dyClient: number) => void
  /** Defer the auto-follow while the user drags a NODE (their hand owns the view). */
  deferFollow: () => void
  hoverRef: React.RefObject<string | null>
  dragRef: React.RefObject<DragState | null>
  onSelectRef: React.RefObject<(displayId: string) => void>
  /** Gates ONLY tap-to-select (MYT-89 audit #5): a click fires `onSelect` in the reveal
   *  (`true`), but is inert during generation (`false`). Drag-to-pin is live either way. */
  interactiveRef: React.RefObject<boolean>
  /** The FORCEFUL settle regime (MYT-89 audit v4 — the reveal's snap-back). `false`
   *  (generation): a moved drag PARKS its pin on drop — drag-to-pin, the toy. `true`
   *  (the reveal): the drop RELEASES the node back to the sim (`unpin`), whose
   *  release reheat snaps it home. Taps are identical in both regimes. */
  forcefulRef: React.RefObject<boolean>
  /** Sticky focus (the density redesign): promotes the node's name into the label tier
   *  + raises the glyph. `null` clears. The hook re-tiers, re-boxes, and re-flows. */
  setFocus: (displayId: string | null) => void
}

/** Attach the pointer surface for the current mode, when the canvas has a live 2D
 *  context (jsdom → no-op; the entity list is the accessible selection surface):
 *  the full fine-pointer handlers under motion + a fine pointer, otherwise the
 *  tap+pan surface (touch, and reduced motion where drag has no live physics to
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

/** The client→centred-world conversion both surfaces share. */
function localOf(event: PointerEvent, canvas: HTMLCanvasElement, deps: PointerDeps): Point {
  return pointerToLocal(
    event,
    canvas,
    deps.sizeRef.current.cssW,
    deps.sizeRef.current.cssH,
    deps.viewRef.current,
    deps.readCamera(),
    deps.virtualRef.current,
  )
}

/** Wire pointermove/down/up/leave on the canvas; returns the teardown. Split out of
 *  the hook so the effect body stays small and this stays independently readable.
 *  Exported for unit test (jsdom can't drive real pointer capture through the effect). */
export function attachPointerHandlers(canvas: HTMLCanvasElement, deps: PointerDeps): () => void {
  const { getSim, hoverRef, dragRef, onSelectRef, interactiveRef, forcefulRef, setFocus } = deps
  // A camera drag in flight (T1b): the last client point panned from. Armed by a
  // press on EMPTY fog while the camera is engaged; a glyph hit always wins (node
  // drag keeps priority — the toy is untouched).
  let camPan: { x: number; y: number } | null = null

  const onDown = (e: PointerEvent): void => {
    const key = nearestKey(getSim().positions(), localOf(e, canvas, deps), HIT_RADIUS)
    if (key === null) {
      setFocus(null) // pressing empty fog clears the sticky name reveal
      if (deps.isEngaged()) {
        camPan = { x: e.clientX, y: e.clientY }
        canvas.setPointerCapture(e.pointerId)
      }
      return
    }
    dragRef.current = { key, moved: false, downX: e.clientX, downY: e.clientY }
    canvas.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent): void => {
    if (camPan !== null) {
      deps.panBy(e.clientX - camPan.x, e.clientY - camPan.y)
      camPan = { x: e.clientX, y: e.clientY }
      return
    }
    const drag = dragRef.current
    if (drag === null) {
      hoverRef.current = nearestKey(getSim().positions(), localOf(e, canvas, deps), HIT_RADIUS)
      return
    }
    if (
      !drag.moved &&
      Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) > DRAG_THRESHOLD
    ) {
      drag.moved = true
    }
    if (drag.moved) {
      deps.deferFollow() // the user's hand owns the view — no drift underneath it
      const local = localOf(e, canvas, deps)
      getSim().pin(drag.key, local.x, local.y)
    }
  }
  const onUp = (): void => {
    camPan = null
    const drag = dragRef.current
    if (drag === null) return
    if (!drag.moved) {
      getSim().unpin(drag.key) // a tap (not a drag) releases any prior pin, always
      setFocus(drag.key) // …and focuses: the name joins the label tier (density redesign)
      if (interactiveRef.current) onSelectRef.current(drag.key) // …but only selects in the reveal
    } else if (forcefulRef.current) {
      // The forceful settle regime (MYT-89 audit v4): the drop RELEASES the node
      // back to the sim — never parks the pin — and the sim's release reheat
      // snaps it home. The generating act (regime off) keeps drag-to-pin.
      getSim().unpin(drag.key)
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

/** One touch press in flight: the down point (the tap-slop gate) plus the LAST point
 *  (incremental pan deltas once the press becomes a pan). */
interface TouchPress {
  downX: number
  downY: number
  lastX: number
  lastY: number
  panning: boolean
}

/** Wire the coarse-pointer / reduced-motion surface: TAP + (camera-engaged) PAN.
 *
 *  Camera DISENGAGED — the shipped tap-only behaviour: a slop-gated down→up pair
 *  focuses the nearest glyph (name reveal) or clears the focus on empty fog, and
 *  selects in the reveal. NO capture, no pan — a scroll gesture that starts on the
 *  canvas travels past `TAP_SLOP` (or fires pointercancel) and is ignored, so the
 *  page scrolls exactly as if the canvas weren't there.
 *
 *  Camera ENGAGED (T1b — the world is larger than the pane; the hook also sets
 *  `touch-action: none` on the canvas): the canvas OWNS touch. The press is captured;
 *  movement past the slop becomes a PAN (deltas rebase at the slop edge so the camera
 *  never jumps by the slop distance); a press that stays within the slop is a TAP —
 *  focus, and select in the reveal. Exported for unit test. */
export function attachTapHandlers(canvas: HTMLCanvasElement, deps: PointerDeps): () => void {
  const { getSim, onSelectRef, interactiveRef, setFocus } = deps
  let press: TouchPress | null = null

  const onDown = (e: PointerEvent): void => {
    press = { downX: e.clientX, downY: e.clientY, lastX: e.clientX, lastY: e.clientY, panning: false }
    if (deps.isEngaged()) canvas.setPointerCapture(e.pointerId) // the camera owns the gesture
  }
  const onMove = (e: PointerEvent): void => {
    const p = press
    if (p === null) return
    if (!p.panning) {
      if (Math.hypot(e.clientX - p.downX, e.clientY - p.downY) <= TAP_SLOP) return
      if (!deps.isEngaged()) {
        press = null // a page scroll — the browser owns it, never a tap
        return
      }
      p.panning = true
      p.lastX = e.clientX // pan from HERE — no slop-sized jump on the first delta
      p.lastY = e.clientY
      return
    }
    deps.panBy(e.clientX - p.lastX, e.clientY - p.lastY)
    p.lastX = e.clientX
    p.lastY = e.clientY
  }
  const onUp = (e: PointerEvent): void => {
    const start = press
    press = null
    if (start === null || start.panning) return
    if (Math.hypot(e.clientX - start.downX, e.clientY - start.downY) > TAP_SLOP) return
    const key = nearestKey(getSim().positions(), localOf(e, canvas, deps), HIT_RADIUS_COARSE)
    setFocus(key)
    if (key !== null && interactiveRef.current) onSelectRef.current(key)
  }
  const onCancel = (): void => {
    press = null // the browser took the gesture (a scroll) — never a tap
  }

  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onCancel)
  return () => {
    canvas.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('pointerup', onUp)
    canvas.removeEventListener('pointercancel', onCancel)
  }
}
