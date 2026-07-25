import type { BaseProps } from './index.ts'
import type { CameraPoint, VirtualGrowth, WorldSeat } from '../worldgen/virtual-space.ts'

// Re-export the obstacle shape off the same contract surface a consumer reads the
// props from (the fluid brain lives in the DOM-free `../worldgen`, the render
// contract here). A consumer that pre-builds obstacles (rather than passing raw
// entities) reads `FogObstacle` from here.
export type { FogObstacle } from '../worldgen/fog-sim.ts'

/**
 * One label the fog streams around, in the 900×470 VIRTUAL coordinate space (§3.6).
 * `x`/`y` is the marker anchor (the label text baseline sits just below it); `kind`
 * sizes the marker (FACTION / NPC / everything-else); `name` is measured to size the
 * label capsule. The shell (`WorldGenFogField`) turns each entity into a `FogObstacle`
 * — the doublet-line the fog routes around, the hard exclusion, and the density
 * box-clear that keeps fog off the text — so the caller passes plain data, not boxes.
 *
 * Platform-neutral (§9): plain data, no DOM types. Positions are VIRTUAL units, so a
 * caller places entities once (in the 900×470 space) and the shell CSS-scales the
 * whole field to the host pane — no per-pane pixel math leaks into the caller.
 */
export interface FogFieldEntity {
  /** Marker-anchor x in the 900×470 virtual space. */
  x: number
  /** Marker-anchor y (the label baseline) in the 900×470 virtual space. */
  y: number
  /** Entity kind — sizes the marker (`FACTION` 12 / `NPC` 9 / else 11). */
  kind: string
  /** Label text — measured (at the locked label font) to size the capsule the fog
   *  parts around and the box the density is cleared under. */
  name: string
  /** Whether this entity currently WEARS its label (MYT-89 density redesign — label
   *  tiering). `false` → the fog reserves only an ICON-sized hole (the name isn't
   *  drawn, so fog may roll over where it would sit). Omitted → `true` (the
   *  pre-tiering behaviour every standalone caller gets). */
  labeled?: boolean
  /** Which side of the marker the worn label sits on (ux-run2 myth-uis1p): `'e'`
   *  (east — the default) or `'w'` (west — the collision-relief mirror chosen for
   *  a label revealed on an already-pinned field). The fog mirrors its keep-out
   *  to match the drawn side. Omitted → `'e'`. */
  side?: 'e' | 'w'
}

/**
 * The world-gen FOG layer (MYT-89 Phase C, C3) — the decorative rolling clouds that
 * part and close around the streaming entity labels, and DRAIN toward nothing as the
 * entities arrive (the "chaos → order" arc; MYT-89 spawn-drain — the wind carries the
 * fog off the pane and ever fewer particles replace it). This is JUST the fog layer
 * (§5, layered canvases): it sits BEHIND the graph canvas (C4), owns its own Canvas,
 * and never renders the entities themselves — only the fog that routes around them.
 *
 * The shell owns the fixed-timestep sim loop, the obstacle construction (each entity →
 * a `FogObstacle`), the 900×470 VIRTUAL coordinate space + CSS scale (BUG 2.2: draw in
 * virtual units, scale uniformly — fog never overhangs the pane), and the reduced-
 * motion static settle. All the fluid numerics live in the DOM-free `FogSim`
 * (client-core); this contract is the platform-neutral prop surface.
 */
/**
 * The SHARED camera over the world-gen virtual space (MYT-89 T1b — the pannable
 * viewport). The graph hook owns the one camera; the fog layer reads it through this
 * source, so both canvases translate by the identical offset every frame (the C5
 * one-camera guarantee — a virtual point lands on the same screen pixel in each layer
 * at every camera position).
 */
export interface WorldGenCameraSource {
  /** The camera for render frame `frameMs` (the rAF timestamp). Advances any
   *  auto-follow drift AT MOST ONCE per distinct timestamp — both layers' loops call
   *  this with the same frame time and read the identical position, whichever runs
   *  first. */
  current: (frameMs: number) => CameraPoint
  /** Subscribe to DISCRETE camera mutations (a manual pan, a reduced-motion snap, the
   *  engage recentre) — the seam a STATIC (reduced-motion) layer repaints on, since it
   *  has no per-frame loop to pick the move up. Returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void
}

export interface WorldGenFogFieldProps extends Omit<BaseProps, 'children'> {
  /** The currently-shown entities the fog parts around (virtual-space positions). One
   *  `FogObstacle` is built per entity each frame. Optional when `entitiesSource` is
   *  provided (a LIVE per-frame source supersedes it); defaults to none. */
  entities?: FogFieldEntity[]
  /** A LIVE per-frame obstacle source (C5 integration): when set, the fog reads it EACH
   *  frame instead of the static `entities` prop, so the fog-holes track the graph's
   *  force-sim positions (+ the render-only buoy bob) without a React re-render per
   *  frame. The composer (WorldGenGraph) derives it from the shared force-sim in the
   *  fog's VIRTUAL space, so obstacle and glyph land on one coordinate. */
  entitiesSource?: () => readonly FogFieldEntity[]
  /** Drain NUMERATOR — how many entities have arrived. Typically `entities.length`,
   *  but passed explicitly so the drain progress can be driven by the caller's own
   *  metric independent of the exact obstacle set. */
  shownEntities: number
  /** Drain DENOMINATOR — the entity count at which the fog is fully GONE (production:
   *  `MIN_EXPECTED_ENTITIES`, the DB-derived floor). The sim's respawn flux scales by
   *  `1 − shown/total` (MYT-89 spawn-drain): as entities arrive fewer particles spawn
   *  in, the wind carries the rest off the pane, and at `shown ≥ total` nothing
   *  respawns — the fog DRAINS to nothing (never a paint fade). `0` disables the
   *  drain (full spawn — the fog holds). */
  totalEntities: number
  /** Base fog thickness (the reference `density` slider) — a CONSTANT paint
   *  multiplier; the clear is the spawn drain above, never a density fade. Defaults
   *  to the LOCKED `FOG_PARAMS.density`. */
  density?: number
  /** Density-aware virtual-space growth (MYT-89 density redesign): the SAME growth
   *  input the composing graph feeds `virtualDims`, so both layers derive identical
   *  dims from the shared pane box while the space grows with the node count (the C5
   *  alignment invariant). Omitted (standalone fog) → the fixed shipped space. */
  growth?: VirtualGrowth
  /** The camera-world SEAT input (MYT-89 T1b): the SAME `seatFrom` derivation the
   *  composing graph feeds `cameraWorldDims`, so both layers agree on when the world
   *  outgrows the pane and on the grown world's dims. Omitted (standalone fog) → the
   *  world always fits the pane (no camera). */
  seat?: WorldSeat
  /** The SHARED camera (T1b): the graph hook's camera source. The fog translates its
   *  paint by the same offset the graph does — one camera, both layers (C5). Omitted
   *  (standalone fog) → the identity camera. */
  camera?: WorldGenCameraSource
  /** Honour the user's reduced-motion preference: no requestAnimationFrame loop —
   *  settle the density to convergence once and repaint only when the entity count
   *  changes. NOT a blanket freeze: the fade-with-entities signal (the progress
   *  indicator) is preserved, just sampled statically. */
  reducedMotion?: boolean
}
