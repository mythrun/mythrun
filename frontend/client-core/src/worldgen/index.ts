// World-gen streaming-graph brain (MYT-89 Phase C). The DOM-free physics + graph
// model the live world-gen loading experience renders: the `d3-force` wrapper
// (C2), the SSE-event → nodes/edges fold (C1). Exposed as its own subpath
// (`@mythrun/client-core/worldgen`) so the render surface (`@mythrun/ui`'s
// WorldGenGraph, C4) can import the physics WITHOUT pulling the whole client
// brain (react-query, stores, api clients) into the UI bundle — the main
// `@mythrun/client-core` barrel drags all of that in; this slice is pure data.

export { create as createForceSim } from './force-sim.ts'
export type { ForceSim } from './force-sim.ts'
export { createFogSim } from './fog-sim.ts'
export type { FogSim, FogObstacle } from './fog-sim.ts'
// The LOCKED fog params + every render-side constant (C1). Pure data (no DOM), so it
// rides this UI-safe subpath: the fog RENDER surface (@mythrun/ui's fog-draw +
// WorldGenFogField, C3) consumes the cloud/coverage/fade/label constants WITHOUT
// importing from @mythrun/ui (the dependency direction is ui→client-core). The module
// header calls this out — "C3/C4 consume the render-side constants".
export * from './fog-params.ts'
export { deriveNodes, deriveEdges } from './graph-reducers.ts'
export type { GraphNode, GraphEdge, GraphNodeState } from './graph-reducers.ts'

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
  WikiDataSource,
} from './wiki-view-model.ts'
