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
