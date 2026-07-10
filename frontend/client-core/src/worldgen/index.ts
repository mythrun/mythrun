// World-gen streaming-graph brain (MYT-89 Phase C). The DOM-free physics + graph
// model the live world-gen loading experience renders: the `d3-force` wrapper
// (C2), the SSE-event → nodes/edges fold (C1). Exposed as its own subpath
// (`@mythrun/client-core/worldgen`) so the render surface (`@mythrun/ui`'s
// WorldGenGraph, C4) can import the physics WITHOUT pulling the whole client
// brain (react-query, stores, api clients) into the UI bundle — the main
// `@mythrun/client-core` barrel drags all of that in; this slice is pure data.

export {
  create as createForceSim,
  FORCE_PARAMS,
  FORCE_PARAM_RANGES,
  REVEAL_FORCE_PARAMS,
} from './force-sim.ts'
export type { ForceSim, ForceParams, NodeBox, StaticKeepOut } from './force-sim.ts'
export { createFogSim } from './fog-sim.ts'
export type { FogSim, FogObstacle } from './fog-sim.ts'
// The LOCKED fog params + every render-side constant (C1). Pure data (no DOM), so it
// rides this UI-safe subpath: the fog RENDER surface (@mythrun/ui's fog-draw +
// WorldGenFogField, C3) consumes the cloud/coverage/fade/label constants WITHOUT
// importing from @mythrun/ui (the dependency direction is ui→client-core). The module
// header calls this out — "C3/C4 consume the render-side constants".
export * from './fog-params.ts'
// The pane-adaptive virtual space (MYT-89 responsive fix): the ONE derivation both
// render hooks (graph + fog) use to size the shared virtual coordinate space from
// the pane box, so the C5 fog↔graph alignment holds at every pane size/aspect.
// Plus the pannable CAMERA world (MYT-89 T1b): where the pane can't seat the density,
// the world keeps its full legible size and the pane becomes a camera over it.
export {
  cameraCentredOn,
  cameraWorldDims,
  centreCamera,
  clampCamera,
  followCameraStep,
  MAX_VIRTUAL_HEIGHT,
  SEAT_HEADROOM,
  virtualDims,
} from './virtual-space.ts'
export type {
  CameraPoint,
  CameraWorld,
  VirtualDims,
  VirtualGrowth,
  WorldSeat,
} from './virtual-space.ts'
// Label tiering + density-aware growth (MYT-89 density redesign): WHICH nodes wear a
// label at the current density, and how the virtual space grows with the node count.
// Pure geometry (DOM-free), shared by the graph render surface and its tuning harness.
export {
  ANCHOR_KINDS,
  DENSITY_PARAMS,
  DENSITY_PARAM_RANGES,
  growthFrom,
  labelBudget,
  labeledDisplayIds,
  seatFrom,
} from './label-tiers.ts'
export type { DensityParams, LabelTierOptions } from './label-tiers.ts'
// The world-gen entity floor (MYT-89 fog spawn-drain): the DB-derived minimum
// entity count a completed generation produces — the fog-clear denominator.
export { MIN_EXPECTED_ENTITIES } from './entity-floor.ts'
export { deriveNodes, deriveEdges } from './graph-reducers.ts'
export type { GraphNode, GraphEdge, GraphNodeState } from './graph-reducers.ts'

// The pure remaining-wait derivation (MYT-89 waiting-feedback): historical
// per-stage averages ∩ live stage statuses → the ms left in the visible wait
// at a given `now`. Pure data (only type imports from @mythrun/contract), so
// it rides this UI-safe subpath — the DS Storybook specimens drive it to
// demonstrate the live countdown without pulling in the whole client brain.
// The main barrel re-exports it for the app routes.
export { remainingWaitMs } from './stage-eta.ts'

// Wiki view model (MYT-89 Phase D): the pure normalizer that reshapes a
// world-snapshot into the browsable model + the injected data-source seam.
// DOM-free pure data (only a type import from @mythrun/contract), so it rides
// this UI-safe subpath alongside the graph reducers.
export { toWikiViewModel } from './wiki-view-model.ts'
export type {
  WikiViewModel,
  WikiGroup,
  WikiEntity,
  WikiFact,
  WikiRelatedLink,
  WikiDataSource,
} from './wiki-view-model.ts'

// The wiki history stack (MYT-89 Phase D, D3): the platform-neutral navigation
// brain D4's WorldWiki drives (push/back/home + per-entry scroll retention).
// DOM-free React hook — rides this UI-safe subpath alongside the reducers.
export { useWikiNavigation } from './use-wiki-navigation.ts'
export type { WikiLocation, WikiNavigation } from './use-wiki-navigation.ts'
