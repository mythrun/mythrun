import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import type { GraphEdge, GraphNode } from './graph-reducers.ts'

// ForceSim (MYT-89 Phase C, Task C2): a platform-neutral (DOM-free) wrapper
// around `d3-force` for the world-gen streaming graph. The graph populates live
// as entities stream in over ~10 minutes; the physics must NOT reset every time
// a new entity arrives. This is the spec §6 "Vidia-I2" fix.
//
// The whole point is NODE-IDENTITY PRESERVATION. `sync` MERGES the incoming
// derived graph into a PERSISTENT internal array of d3 sim-node objects keyed by
// `synthKey`: a survivor keeps its exact object reference (and thus its settled
// `x/y/vx/vy`), a genuinely-new key is seeded near centre, a vanished key drops
// out. We therefore NEVER hand d3 a freshly-mapped array of new objects — that
// zeroes every position and teleports the whole graph on every arrival.
//
// The sim is NOT auto-run on a timer (`.stop()` at construction, no `.restart()`
// on reheat) — C4's render loop drives `tick()`. Reheat is a modest `alpha()`
// bump; using `.restart()` would re-arm d3's internal RAF timer and double-drive
// the manual loop.

/** Re-heat energy injected on each `sync`. Modest, so a new arrival nudges the
 *  layout back to life without the settled graph snapping. */
const REHEAT_ALPHA = 0.3

/** New nodes are seeded within ±(SEED_JITTER/2) of the layout centre so they fly
 *  out organically instead of arriving from d3's phyllotaxis spiral. */
const SEED_JITTER = 2

/** A d3 simulation node carrying its stable `synthKey` identity. `x/y/vx/vy/fx/fy`
 *  are the d3-managed fields (see SimulationNodeDatum). */
interface SimNode extends SimulationNodeDatum {
  synthKey: string
}

/** A d3 link datum. `source`/`target` are seeded as `synthKey` strings and
 *  resolved to node objects by d3 via the `id` accessor on (re-)initialisation. */
interface SimLink extends SimulationLinkDatum<SimNode> {
  synthKey: string
}

export interface ForceSim {
  /** MERGE the derived graph into the persistent sim: survivors keep their
   *  position/momentum, new keys are seeded near centre, vanished keys drop. */
  sync(nodes: GraphNode[], edges: GraphEdge[]): void
  /** Advance the simulation one step. Driven by the render loop (C4). */
  tick(): void
  /** synthKey → current position. */
  positions(): Map<string, { x: number; y: number }>
  /** Fix a node at (x, y) — drag-to-pin (C4). */
  pin(synthKey: string, x: number, y: number): void
  /** Release a pinned node back to the simulation. */
  unpin(synthKey: string): void
}

function seedNode(synthKey: string): SimNode {
  return {
    synthKey,
    x: (Math.random() - 0.5) * SEED_JITTER,
    y: (Math.random() - 0.5) * SEED_JITTER,
    vx: 0,
    vy: 0,
  }
}

export function create(): ForceSim {
  // The persistent state: `byKey` is the source of truth for identity; `nodes`
  // is the SAME array handed to d3 every sync (mutated in place — survivor
  // object references are reused, never rebuilt).
  const byKey = new Map<string, SimNode>()
  const nodes: SimNode[] = []
  const linkForce = forceLink<SimNode, SimLink>([]).id((node) => node.synthKey)
  const simulation = forceSimulation<SimNode, SimLink>(nodes)
    .force('charge', forceManyBody<SimNode>())
    .force('link', linkForce)
    .force('center', forceCenter<SimNode>())
    .stop() // manual control — C4's render loop drives tick(), not d3's timer.

  function mergeNodes(incoming: GraphNode[]): void {
    const wanted = new Set(incoming.map((n) => n.synthKey))
    for (const key of [...byKey.keys()]) {
      if (!wanted.has(key)) byKey.delete(key)
    }
    for (const graphNode of incoming) {
      if (!byKey.has(graphNode.synthKey)) byKey.set(graphNode.synthKey, seedNode(graphNode.synthKey))
    }
    nodes.length = 0
    for (const simNode of byKey.values()) nodes.push(simNode)
  }

  function buildLinks(edges: GraphEdge[]): SimLink[] {
    // Only edges whose endpoints both survive can render; a dangling endpoint
    // would make d3's `id` resolver throw (`node not found`).
    return edges
      .filter((e) => byKey.has(e.from) && byKey.has(e.to))
      .map((e) => ({ synthKey: e.synthKey, source: e.from, target: e.to }))
  }

  function sync(incoming: GraphNode[], edges: GraphEdge[]): void {
    linkForce.links([]) // drop stale object refs before the node set changes.
    mergeNodes(incoming)
    simulation.nodes(nodes) // re-inits forces; survivors keep x/y/vx/vy (valid → not re-seeded).
    linkForce.links(buildLinks(edges)) // resolves string endpoints against the current nodes.
    simulation.alpha(REHEAT_ALPHA) // reheat WITHOUT restart — keeps the timer stopped.
  }

  function positions(): Map<string, { x: number; y: number }> {
    const out = new Map<string, { x: number; y: number }>()
    for (const simNode of byKey.values()) {
      out.set(simNode.synthKey, { x: simNode.x ?? 0, y: simNode.y ?? 0 })
    }
    return out
  }

  function pin(synthKey: string, x: number, y: number): void {
    const simNode = byKey.get(synthKey)
    if (simNode === undefined) return
    simNode.fx = x
    simNode.fy = y
  }

  function unpin(synthKey: string): void {
    const simNode = byKey.get(synthKey)
    if (simNode === undefined) return
    simNode.fx = null
    simNode.fy = null
  }

  return {
    sync,
    tick: () => void simulation.tick(),
    positions,
    pin,
    unpin,
  }
}
