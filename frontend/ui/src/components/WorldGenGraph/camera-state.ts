import {
  cameraCentredOn,
  centreCamera,
  clampCamera,
  followCameraStep,
  type CameraPoint,
  type CameraWorld,
  type ForceSim,
  type VirtualDims,
} from '@mythrun/client-core/worldgen'
import type { GraphNode, WorldGenCameraSource } from '@mythrun/client-core/contract'

// The ONE camera over the world-gen virtual space (MYT-89 T1b — the pannable
// viewport), split from use-graph-canvas.ts (the module-size rail). When the world
// outgrows the pane (`cameraWorldDims` engages — a phone at real density), this
// controller owns WHERE the viewport looks: manual pans (one-finger drag / empty-space
// mouse drag), the auto-follow drift toward the newest arrival ("watch it be born"),
// the reduced-motion per-arrival snap, and the pan-bounds clamp. It is a RENDER
// transform only — the force-sim, containment, and collision all keep operating in the
// full world space; nothing here writes physics.
//
// ONE camera, BOTH layers (C5): the graph hook creates one controller and hands its
// `source` to the fog layer. Each render loop calls `source.current(frameMs)` with its
// rAF timestamp; the drift advances AT MOST ONCE per distinct timestamp, so both
// layers read the identical position for a given frame — a virtual point lands on the
// same screen pixel in each canvas at every camera position. `subscribe` is the
// STATIC (reduced-motion) repaint seam: a manual pan / snap has no loop to pick it up,
// so static painters redraw on notify.

/** τ (ms) of the auto-follow's exponential approach — the drift closes ~63% of the
 *  remaining distance per τ: slow and eased, a camera move, never a snap. */
export const FOLLOW_TAU_MS = 1400

/** How long (ms) the auto-follow stays deferred after a manual pan / node drag —
 *  the user's hand owns the view; the camera resumes after this idle window. */
export const FOLLOW_IDLE_MS = 5000

/** The refs the controller reads live (the hook's useLatest idiom, threaded once). */
export interface CameraDeps {
  /** The WORLD dims — the space the sim/labels/fog live in (the hook's `virtualRef`). */
  worldRef: { current: VirtualDims }
  /** The VIEW dims — the pane's window onto the world. */
  viewRef: { current: VirtualDims }
  reducedRef: { current: boolean }
  nodesRef: { current: GraphNode[] }
  simRef: { current: ForceSim | null }
  /** The pane's CSS box — client-px pan deltas map to view units through it. */
  sizeRef: { current: { cssW: number; cssH: number } }
  /** Injectable clock for the idle window (tests); defaults to `performance.now`. */
  now?: () => number
}

export interface CameraController {
  /** The shared render source both layers read (the contract seam the fog receives). */
  source: WorldGenCameraSource
  /** The camera value WITHOUT advancing the drift — for paint paths that run after
   *  the loop already advanced this frame (the graph's own `paintFrame`). */
  read: () => CameraPoint
  /** Whether the camera is engaged (the world is larger than the pane). */
  engaged: () => boolean
  /** Manual pan by a CLIENT-px delta (the pointer's movement): the world follows the
   *  finger (camera moves opposite), clamped to the world edges; defers the
   *  auto-follow; notifies static subscribers. No-op while disengaged. */
  panBy: (dxClient: number, dyClient: number) => void
  /** Defer the auto-follow without moving the camera (a node drag owns the view). */
  deferFollow: () => void
  /** Record arrivals: the last genuinely-NEW node becomes the follow target. */
  trackArrivals: (nodes: readonly GraphNode[]) => void
  /** Snap the camera onto the follow target — the reduced-motion arrival move (one
   *  discrete reposition per arrival, no continuous animation). Notifies. */
  snapToTarget: () => void
  /** Adopt freshly-derived dims (`cameraWorldDims`): identity while disengaged,
   *  CENTRED on the world at the moment of first engage, clamped into the new bounds
   *  while engaged (growth extends the range; the position holds). Notifies on a
   *  camera move. */
  syncBounds: (next: CameraWorld) => void
}

export function createCameraController(deps: CameraDeps): CameraController {
  const now = deps.now ?? ((): number => performance.now())
  let camera: CameraPoint = { x: 0, y: 0 }
  let isEngaged = false
  /** The follow target's SYNTH key — stable across a finalize (displayId swap). */
  let followKey: string | null = null
  const seenKeys = new Set<string>()
  let lastFrameMs = -1
  let deferUntilMs = -Infinity
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  /** The clamped camera that centres the follow target's CURRENT sim position, or
   *  null (no target / not yet placed). Positions are CENTRED sim coords; the camera
   *  lives in top-left world coords — recentre by the half-dimensions. */
  const targetCamera = (): CameraPoint | null => {
    const sim = deps.simRef.current
    if (followKey === null || sim === null) return null
    const node = deps.nodesRef.current.find((n) => n.synthKey === followKey)
    if (node === undefined) return null
    const p = sim.positions().get(node.displayId)
    if (p === undefined) return null
    const world = deps.worldRef.current
    return cameraCentredOn(
      { x: p.x + world.width / 2, y: p.y + world.height / 2 },
      world,
      deps.viewRef.current,
    )
  }

  /** The per-frame read (+ drift advance, at most once per distinct timestamp). */
  const current = (frameMs: number): CameraPoint => {
    if (frameMs === lastFrameMs) return camera
    const dt = lastFrameMs < 0 ? 0 : frameMs - lastFrameMs
    lastFrameMs = frameMs
    if (!isEngaged || deps.reducedRef.current || frameMs < deferUntilMs) return camera
    const target = targetCamera()
    if (target === null) return camera
    camera = followCameraStep(camera, target, dt, FOLLOW_TAU_MS)
    return camera
  }

  const panBy = (dxClient: number, dyClient: number): void => {
    if (!isEngaged) return
    deferUntilMs = now() + FOLLOW_IDLE_MS
    const view = deps.viewRef.current
    const { cssW, cssH } = deps.sizeRef.current
    const next = clampCamera(
      {
        x: camera.x - dxClient * (view.width / Math.max(1, cssW)),
        y: camera.y - dyClient * (view.height / Math.max(1, cssH)),
      },
      deps.worldRef.current,
      view,
    )
    if (next.x === camera.x && next.y === camera.y) return
    camera = next
    notify()
  }

  const trackArrivals = (nodes: readonly GraphNode[]): void => {
    let newest: string | null = null
    for (const node of nodes) {
      if (!seenKeys.has(node.synthKey)) {
        seenKeys.add(node.synthKey)
        newest = node.synthKey
      }
    }
    if (newest !== null) followKey = newest
  }

  const snapToTarget = (): void => {
    const target = targetCamera()
    if (target === null || (target.x === camera.x && target.y === camera.y)) return
    camera = target
    notify()
  }

  const syncBounds = (next: CameraWorld): void => {
    const before = camera
    if (!next.engaged) camera = { x: 0, y: 0 }
    else if (!isEngaged) camera = centreCamera(next.world, next.view)
    else camera = clampCamera(camera, next.world, next.view)
    isEngaged = next.engaged
    if (camera.x !== before.x || camera.y !== before.y) notify()
  }

  return {
    source: {
      current,
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    read: () => camera,
    engaged: () => isEngaged,
    panBy,
    deferFollow: (): void => {
      deferUntilMs = now() + FOLLOW_IDLE_MS
    },
    trackArrivals,
    snapToTarget,
    syncBounds,
  }
}
