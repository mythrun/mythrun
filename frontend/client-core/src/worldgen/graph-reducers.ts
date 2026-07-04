import type { PipelineEvent } from '@mythrun/contract/events'

// Graph reducers (MYT-89 Phase C): fold the world-gen SSE `PipelineEvent`
// stream into the nodes + edges the streaming graph renders. Pure and
// platform-neutral (DOM-free) — the parent hook (`useWorldGenStream`, C5)
// accumulates the event log and calls these; the render surface (C2 force-sim,
// C4 Canvas) consumes the derived arrays.
//
// This is the RECONCILED successor to the dev-tool's `deriveInventory` /
// `derivePlaceholderBuffer` (backend/dev-tool/.../live-events-panel.ts). It
// keeps their reconciliation RULES but re-types them against the LIVE, flat
// `PipelineEvent` contract (@mythrun/contract/events): `entity-added` carries
// `name` / `entityKind` DIRECTLY — there is no stale `data` bag — so a
// `GraphNode` is the lean render model: no arbitrary field state, just the
// lifecycle the events distinguish.
//
// Reconciliation rules (mirror of the dev-tool algorithm):
//   - Nodes come only from `entity-added`, keyed by `synthKey`. A stage-4b
//     ghost (`entity-added` carrying a `placeholderId`) is ONE node keyed by
//     its `synthKey`; the `new-NNN` placeholder never becomes its own node, so
//     a ghost + its buffered edges reconcile to one node, not two.
//   - `entity-updated {synthKey, patch}` is an RFC 7396 merge patch; the only
//     graph-relevant field is `name` (kind/identity don't change), so a string
//     `patch.name` renames the node and every other key is ignored.
//   - `entity-removed` / `edge-removed` drop by `synthKey`.
//   - `stage-reset {stage}` prefix-deletes every `synthKey` under `${stage}/`
//     (synthKey is `${stage}/`-prefixed per the contract, D7).
//   - `finalized {synthKey, entityId}` swaps the node's `displayId` synthKey →
//     entityId and marks it finalized.
//   - An `edge-added` whose `from`/`to` is a `new-NNN` placeholder is BUFFERED
//     (not emitted) until the ghost `entity-added {placeholderId}` maps that id
//     to a real `synthKey`. The reconciliation pass runs at the end, so an edge
//     and its ghost may arrive in either order.

/** The lifecycle a node passes through — the only states the fold distinguishes.
 *  Placeholder is an EDGE-ENDPOINT concept (handled by buffering in
 *  `deriveEdges`), NOT a node state: a `new-NNN` id never materialises a node. */
export type GraphNodeState = 'live' | 'finalized'

export interface GraphNode {
  readonly synthKey: string
  readonly kind: string
  readonly name: string
  /** The `synthKey` until `finalized`, then the real entity UUID. */
  readonly displayId: string
  readonly state: GraphNodeState
  /** Index of the most recent event that touched this node — the authoritative
   *  recency field. Nodes are returned in chronological arrival order. */
  readonly lastEventIndex: number
}

export interface GraphEdge {
  readonly synthKey: string
  readonly from: string
  readonly to: string
  readonly relationship: string
}

interface EdgeRecord {
  readonly from: string
  readonly to: string
  readonly relationship: string
}

/** stage-4 (entity_relationships) may emit an edge endpoint as a `new-NNN`
 *  placeholder when the relationship references a phantom entity; stage-4b
 *  (entity_consolidation) later emits the ghost `entity-added` carrying the
 *  same string in `placeholderId`. */
function isPlaceholderId(id: string): boolean {
  return id.startsWith('new-')
}

/** Delete every key under the reset stage's `${stage}/` prefix, in place. */
function deleteStagePrefix<V>(map: Map<string, V>, stage: string): void {
  const prefix = `${stage}/`
  for (const key of [...map.keys()]) {
    if (key.startsWith(prefix)) map.delete(key)
  }
}

/** Fold the event log into the current node set, keyed + ordered by first
 *  appearance. `lastEventIndex` tracks the most recent touch for recency. */
export function deriveNodes(events: PipelineEvent[]): GraphNode[] {
  const byKey = new Map<string, GraphNode>()
  events.forEach((event, index) => {
    applyNodeEvent(byKey, event, index)
  })
  return [...byKey.values()]
}

function applyNodeEvent(byKey: Map<string, GraphNode>, e: PipelineEvent, index: number): void {
  if (e.type === 'entity-added') {
    byKey.set(e.synthKey, {
      synthKey: e.synthKey,
      kind: e.entityKind,
      name: e.name,
      displayId: e.synthKey,
      state: 'live',
      lastEventIndex: index,
    })
  } else if (e.type === 'entity-updated') {
    const existing = byKey.get(e.synthKey)
    if (existing === undefined) return
    const patchName = e.patch.name
    const name = typeof patchName === 'string' ? patchName : existing.name
    byKey.set(e.synthKey, { ...existing, name, lastEventIndex: index })
  } else if (e.type === 'entity-removed') {
    byKey.delete(e.synthKey)
  } else if (e.type === 'stage-reset') {
    deleteStagePrefix(byKey, e.stage)
  } else if (e.type === 'finalized') {
    const existing = byKey.get(e.synthKey)
    if (existing === undefined) return
    byKey.set(e.synthKey, {
      ...existing,
      displayId: e.entityId,
      state: 'finalized',
      lastEventIndex: index,
    })
  }
}

/** Fold the event log into the current rendered edge set. Edges whose endpoints
 *  are unresolved `new-NNN` placeholders are buffered (not returned) until the
 *  matching ghost `entity-added` resolves them; the resolution pass runs last,
 *  so edge/ghost arrival order doesn't matter. */
export function deriveEdges(events: PipelineEvent[]): GraphEdge[] {
  const resolutions = new Map<string, string>()
  const edges = new Map<string, EdgeRecord>()
  for (const event of events) {
    applyEdgeEvent(resolutions, edges, event)
  }
  return renderEdges(resolutions, edges)
}

function applyEdgeEvent(
  resolutions: Map<string, string>,
  edges: Map<string, EdgeRecord>,
  e: PipelineEvent,
): void {
  if (e.type === 'entity-added') {
    if (e.placeholderId !== undefined) resolutions.set(e.placeholderId, e.synthKey)
  } else if (e.type === 'edge-added') {
    edges.set(e.synthKey, { from: e.from, to: e.to, relationship: e.relationship })
  } else if (e.type === 'edge-removed') {
    edges.delete(e.synthKey)
  } else if (e.type === 'stage-reset') {
    deleteStagePrefix(edges, e.stage)
  }
}

function renderEdges(resolutions: Map<string, string>, edges: Map<string, EdgeRecord>): GraphEdge[] {
  const rendered: GraphEdge[] = []
  for (const [synthKey, edge] of edges) {
    const from = resolveEndpoint(edge.from, resolutions)
    const to = resolveEndpoint(edge.to, resolutions)
    if (from === null || to === null) continue
    rendered.push({ synthKey, from, to, relationship: edge.relationship })
  }
  return rendered
}

/** Resolve an edge endpoint: real ids pass through; a `new-NNN` placeholder is
 *  looked up in the resolutions map. Returns null when a placeholder has no
 *  resolution yet — the caller buffers such edges. */
function resolveEndpoint(endpoint: string, resolutions: Map<string, string>): string | null {
  if (!isPlaceholderId(endpoint)) return endpoint
  return resolutions.get(endpoint) ?? null
}
