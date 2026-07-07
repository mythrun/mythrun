import type { BaseProps } from './index.ts'
import type { VirtualGrowth } from '../worldgen/virtual-space.ts'

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
}

/**
 * The world-gen FOG layer (MYT-89 Phase C, C3) — the decorative rolling clouds that
 * part and close around the streaming entity labels, and FADE toward nothing as the
 * graph fills (the "chaos → order" arc). This is JUST the fog layer (§5, layered
 * canvases): it sits BEHIND the graph canvas (C4), owns its own Canvas, and never
 * renders the entities themselves — only the fog that routes around them.
 *
 * The shell owns the fixed-timestep sim loop, the obstacle construction (each entity →
 * a `FogObstacle`), the 900×470 VIRTUAL coordinate space + CSS scale (BUG 2.2: draw in
 * virtual units, scale uniformly — fog never overhangs the pane), and the reduced-
 * motion static settle. All the fluid numerics live in the DOM-free `FogSim`
 * (client-core); this contract is the platform-neutral prop surface.
 */
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
  /** Fade NUMERATOR — how many entities are shown. Typically `entities.length`, but
   *  passed explicitly so the fade progress can be driven by the caller's own metric
   *  independent of the exact obstacle set. */
  shownEntities: number
  /** Fade DENOMINATOR — the full expected graph size. As `shownEntities/totalEntities`
   *  → 1 the fog fades to nothing; `0` disables the fade (guards divide-by-zero). */
  totalEntities: number
  /** Base fog thickness before the fade (the reference `density` slider — the STARTING
   *  thickness when the fade is on). Defaults to the LOCKED `FOG_PARAMS.density`. */
  density?: number
  /** Density-aware virtual-space growth (MYT-89 density redesign): the SAME growth
   *  input the composing graph feeds `virtualDims`, so both layers derive identical
   *  dims from the shared pane box while the space grows with the node count (the C5
   *  alignment invariant). Omitted (standalone fog) → the fixed shipped space. */
  growth?: VirtualGrowth
  /** Honour the user's reduced-motion preference: no requestAnimationFrame loop —
   *  settle the density to convergence once and repaint only when the entity count
   *  changes. NOT a blanket freeze: the fade-with-entities signal (the progress
   *  indicator) is preserved, just sampled statically. */
  reducedMotion?: boolean
}
