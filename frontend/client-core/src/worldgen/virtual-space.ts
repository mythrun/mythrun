import { VIRTUAL_HEIGHT, VIRTUAL_WIDTH } from './fog-params.ts'

// The RESPONSIVE virtual space (MYT-89 responsive fix). The fog + graph share ONE
// virtual coordinate space (C5): both canvases fill the same pane box, both draw in the
// same virtual units, so a virtual point lands on the same screen pixel in each layer.
// That space used to be FIXED at the reference's 900×470 behind an aspect-locked pane —
// which letterboxed every non-90/47 pane and CSS-shrank labels to ~5px at a 375px pane.
//
// `virtualDims` derives the virtual space FROM the pane instead:
//   - a pane NARROWER than the reference renders 1:1 (one virtual px == one CSS px), so
//     the design-system label font lands at its real size — legible at 375px;
//   - a pane WIDER than the reference keeps the reference WIDTH (scale = cssW/900) and
//     CSS-upscales — exactly the shipped, eye-approved desktop zoom at those widths;
//   - the virtual HEIGHT always follows the pane's own aspect (one uniform scale on
//     both axes), so the graph FILLS the pane at any aspect — no letterbox.
//
// The FOG stays visually correct under a variable aspect because its physics are
// per-virtual-px and aspect-agnostic by construction: the wind/turbulence/cloud
// frequencies are per-px (same on-screen texture), the particle count AREA-SCALES
// (constant density — `fog-sim.ts` §3.6), and the spawn flux weights already derive
// from width/height. Scale-1 panes render the fog at exactly the grain the reference
// was eye-tuned at; wider panes upscale uniformly (the pre-existing desktop look).
//
// Both render hooks (the graph's and the fog's) derive their dims through THIS one
// function from the SAME pane box, so the C5 shared-space invariant holds at every size.

/** Safety bound on the virtual HEIGHT: the fog sim's particle count area-scales, so a
 *  degenerate super-tall consumer pane must not inflate the sim unbounded. The
 *  production pane's own CSS height clamp sits far below this — it exists for other
 *  consumers of the helper, not for the world-gen pane. */
export const MAX_VIRTUAL_HEIGHT = 1200

export interface VirtualDims {
  width: number
  height: number
}

/** DENSITY-AWARE GROWTH (MYT-89 density redesign): the input that lets the virtual
 *  space GROW with the graph. A real generation lands ~46 entities — far more than the
 *  900-wide reference space can seat with labels — so past `startCount` nodes, each
 *  arrival widens the reference width by `perNode` virtual px: on a WIDE pane the
 *  CSS upscale relaxes toward 1:1 (the world visibly grows as it fills; more virtual
 *  area for the same pane), and the scale NEVER drops below 1 (virtual px never render
 *  smaller than CSS px — the label legibility floor caps the growth). Sub-reference
 *  panes (phones) are already 1:1 and unaffected. Derived from the node count via
 *  `growthFrom` (label-tiers) — the ONE derivation both layers share (C5). */
export interface VirtualGrowth {
  /** The current graph node count. */
  nodeCount: number
  /** Node count at which growth starts (below it: exactly the shipped zoom). */
  startCount: number
  /** Virtual px of reference-width growth per node past `startCount`. */
  perNode: number
}

/** The reference width, grown by the current density: `VIRTUAL_WIDTH` until
 *  `startCount` nodes, then `+ perNode` per node. No growth input → the shipped
 *  constant (every pre-density caller and the eye-approved low-count look). */
function grownReferenceWidth(growth: VirtualGrowth | undefined): number {
  if (growth === undefined) return VIRTUAL_WIDTH
  return VIRTUAL_WIDTH + Math.max(0, growth.nodeCount - growth.startCount) * growth.perNode
}

/** The virtual-space dims for a pane of `cssW`×`cssH` CSS px. Scale is uniform (the
 *  pane aspect is preserved exactly) and never below 1 (virtual px never render smaller
 *  than CSS px — the legibility floor). An unmeasured pane (jsdom's zero rect, a
 *  pre-layout read) falls back to the reference dims. `growth` (optional) widens the
 *  reference width with the node count — the density-aware growth above. */
export function virtualDims(cssW: number, cssH: number, growth?: VirtualGrowth): VirtualDims {
  if (cssW <= 1 || cssH <= 1) return { width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT }
  const scale = Math.max(1, cssW / grownReferenceWidth(growth), cssH / MAX_VIRTUAL_HEIGHT)
  return { width: cssW / scale, height: cssH / scale }
}

// ── The pannable camera world (MYT-89 T1b — the mobile redesign) ───────────────────────
// `virtualDims` sizes the virtual space FROM the pane — which on a phone shrinks the
// world to the glass (a 343×600 1:1 space seats ~6 labels of a 46-entity world; the
// REJECTED tier-down-and-tap design). The camera design stops shrinking instead: when
// the pane's own virtual space cannot SEAT every entity's label under the desktop
// density/budget rules, the WORLD keeps the size the density needs and the pane becomes
// a pannable CAMERA over it — the world renders at full legible scale (labels at true
// CSS-px size, the same budget rules as desktop, so every entity wears its name) and
// the user drags the viewport around it. Where the pane seats everything (desktop, and
// phones early in a generation), world === view and the camera is locked at identity —
// zero behavior change on those panes.
//
// Everything here is deterministic geometry (ZFC): pure, DOM-free, shared by BOTH
// render layers (graph + fog) so the C5 one-shared-space invariant extends to one
// shared CAMERA — a virtual point lands on the same screen pixel in each layer at
// every camera position.

/** A camera position: the WORLD coordinate (top-left virtual space) that the pane's
 *  top-left corner shows. `{0, 0}` when the camera is disengaged (world === view). */
export interface CameraPoint {
  x: number
  y: number
}

/** What the world must SEAT (the camera trigger + sizing input): the current node
 *  count × the density budget's per-label area. Derived from the density knobs via
 *  `seatFrom` (label-tiers) — the ONE derivation both layers share, like `growthFrom`. */
export interface WorldSeat {
  nodeCount: number
  /** Virtual px² one shown label needs to breathe (`DensityParams.areaPerLabel`). */
  areaPerLabel: number
}

/** Headroom factor over the bare seat area when the camera world is SIZED (not when it
 *  is TRIGGERED — the trigger uses the bare need, so a desktop pane that seats its
 *  labels today never spuriously engages). The slack covers the budget's `floor`, the
 *  status-card overlay, and layout breathing room so the seated world isn't wall-to-
 *  wall boxes. Eye-tuned with the max-density fixture at 375px. */
export const SEAT_HEADROOM = 1.35

/** The two-space result: the WORLD (where the sim, labels, and fog live) and the VIEW
 *  (the pane's window onto it). `engaged` is true when the world is larger than the
 *  view — the camera pans; false → world === view, camera locked at identity. */
export interface CameraWorld {
  world: VirtualDims
  view: VirtualDims
  engaged: boolean
}

/** Derive the world + view for a pane of `cssW`×`cssH` CSS px. The VIEW is exactly
 *  `virtualDims` (the shipped pane-adaptive space). The WORLD equals the view — the
 *  pre-camera behaviour — unless `seat` is given and the view's area cannot seat every
 *  label (`viewArea < nodeCount × areaPerLabel`): then the world takes the REFERENCE
 *  ASPECT (900:470 — the shape every force/density constant was eye-tuned at; wide
 *  label boxes make force layouts spread WIDE, so a reference-shaped world is the one
 *  the cloud actually FILLS — an aspect-matched portrait world leaves dead vertical
 *  bands the camera would pan over) at the seated area (`nodeCount × areaPerLabel ×
 *  SEAT_HEADROOM`), scaled up if needed to COVER the view on both axes (the camera
 *  must always have world under every pane pixel). The same node count therefore
 *  yields the same world on every phone — the world is the world; the pane is just a
 *  window. Its area is bounded by the seat need (~a desktop pane's area at max
 *  density), so the fog sim's area-scaled particle count stays in its normal envelope
 *  — which is why the world may exceed `MAX_VIRTUAL_HEIGHT` here (that bound guards
 *  degenerate PANES, not the deliberately-seated world). An unmeasured pane (jsdom's
 *  zero rect) falls back to the reference dims, disengaged. */
export function cameraWorldDims(
  cssW: number,
  cssH: number,
  growth?: VirtualGrowth,
  seat?: WorldSeat,
): CameraWorld {
  const view = virtualDims(cssW, cssH, growth)
  const identity: CameraWorld = { world: view, view, engaged: false }
  if (seat === undefined || cssW <= 1 || cssH <= 1) return identity
  const viewArea = view.width * view.height
  if (viewArea >= seat.nodeCount * seat.areaPerLabel) return identity
  const refAspect = VIRTUAL_WIDTH / VIRTUAL_HEIGHT
  const seatWidth = Math.sqrt(seat.nodeCount * seat.areaPerLabel * SEAT_HEADROOM * refAspect)
  const seatHeight = seatWidth / refAspect
  const cover = Math.max(1, view.width / seatWidth, view.height / seatHeight)
  return {
    world: { width: seatWidth * cover, height: seatHeight * cover },
    view,
    engaged: true,
  }
}

/** Clamp a camera into the world's pan bounds: `[0, world − view]` on each axis (zero
 *  range when the world fits the view — the identity camera). The world edge (plus the
 *  sim's own containment margin inside it) is the hard pan stop. */
export function clampCamera(
  camera: CameraPoint,
  world: VirtualDims,
  view: VirtualDims,
): CameraPoint {
  const maxX = Math.max(0, world.width - view.width)
  const maxY = Math.max(0, world.height - view.height)
  return {
    x: Math.min(maxX, Math.max(0, camera.x)),
    y: Math.min(maxY, Math.max(0, camera.y)),
  }
}

/** The initial camera: the view centred on the world. */
export function centreCamera(world: VirtualDims, view: VirtualDims): CameraPoint {
  return {
    x: Math.max(0, (world.width - view.width) / 2),
    y: Math.max(0, (world.height - view.height) / 2),
  }
}

/** The clamped camera that puts a world point (top-left virtual coords) at the view's
 *  centre — the auto-follow target for the newest arrival. */
export function cameraCentredOn(
  point: CameraPoint,
  world: VirtualDims,
  view: VirtualDims,
): CameraPoint {
  return clampCamera({ x: point.x - view.width / 2, y: point.y - view.height / 2 }, world, view)
}

/** One eased auto-follow step: exponential approach toward `target` — the camera
 *  closes `1 − e^(−dt/τ)` of the remaining distance each step, so the drift is slow,
 *  smooth, and FRAMERATE-INDEPENDENT (two half-steps land exactly where one full step
 *  does), and it never overshoots. A camera move, not a snap. */
export function followCameraStep(
  camera: CameraPoint,
  target: CameraPoint,
  dtMs: number,
  tauMs: number,
): CameraPoint {
  const a = 1 - Math.exp(-Math.max(0, dtMs) / tauMs)
  return {
    x: camera.x + (target.x - camera.x) * a,
    y: camera.y + (target.y - camera.y) * a,
  }
}
