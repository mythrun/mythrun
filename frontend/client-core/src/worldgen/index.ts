// World-gen streaming-graph brain (MYT-89 Phase C). The DOM-free physics + graph
// model the live world-gen loading experience renders: the `d3-force` wrapper
// (C2), the SSE-event → nodes/edges fold (C1). Exposed as its own subpath
// (`@mythrun/client-core/worldgen`) so the render surface (`@mythrun/ui`'s
// WorldGenGraph, C4) can import the physics WITHOUT pulling the whole client
// brain (react-query, stores, api clients) into the UI bundle — the main
// `@mythrun/client-core` barrel drags all of that in; this slice is pure data.

export { create as createForceSim } from './force-sim.ts'
export type { ForceSim } from './force-sim.ts'
export { deriveNodes, deriveEdges } from './graph-reducers.ts'
export type { GraphNode, GraphEdge, GraphNodeState } from './graph-reducers.ts'
