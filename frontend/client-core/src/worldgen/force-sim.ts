import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
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
// the STABLE `synthKey`: a survivor keeps its exact object reference (and thus its
// settled `x/y/vx/vy`), a genuinely-new key is seeded near centre, a vanished key
// drops out. We therefore NEVER hand d3 a freshly-mapped array of new objects —
// that zeroes every position and teleports the whole graph on every arrival.
//
// DUAL IDENTITY — internal `synthKey`, external `displayId` (BUG 2.1, §2.1's
// continuity-preserving alternative). Nodes carry both: a `${stage}/…` `synthKey`
// (the reducer's fold key, which `stage-reset` prefix-deletes) and a `displayId`
// (the synthKey until finalize, then the real entity UUID). EDGES reference entity
// UUIDs. The `synthKey` is STABLE across a node's whole life; the `displayId`
// CHANGES at finalize. So the sim keys its INTERNAL identity (`byKey`, `seedNode`,
// `mergeNodes`, `linkForce.id`) on `synthKey` — a node keeps its object ref + its
// settled position across a finalize, never teleporting to centre. But every
// EXTERNAL surface speaks `displayId`: `positions()` is keyed by `displayId`,
// `pin`/`unpin` take a `displayId`, and `buildLinks` translates each edge's UUID
// endpoints to `synthKey` (via a displayId→synthKey map over the current nodes)
// before linking. Net: node render-identity === edge endpoint-space === `displayId`
// externally, while the physics keeps a stable internal key for position continuity.
// Each `SimNode.displayId` is refreshed every `sync` (a finalize just updates the
// field on the persistent object — the node keeps its position).
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

// VIEWPORT CONTAINMENT (MYT-89 Phase B, BUG 2.2). The repulsion cloud has no
// natural bound — `forceCenter` only removes net drift, it does not pull inward —
// so a dense graph can push nodes off-screen ("should be impossible"). Three
// layers, weakest→hardest:
//   1. a gentle inward `forceX(0)`/`forceY(0)` (BOUNDARY_STRENGTH) that biases the
//      whole cloud toward the centre so containment reads as a soft settle;
//   2. a `distanceMax` on the charge so far-apart pairs stop repelling — caps the
//      long-range accumulation that otherwise lets the cloud expand unboundedly;
//   3. a per-tick hard clamp of every node to the half-dimensions — the guarantee
//      that NO node ever draws outside `[−w/2, w/2] × [−h/2, h/2]`, even mid-settle.
// Applies to BOTH the generation and reveal graphs (they share this sim); there is
// no phase-specific gating.

/** Inward pull toward the centre line on each axis. Gentle (well under d3's 0.1
 *  forceX default) so a normal graph still fills the space rather than collapsing
 *  to a tight ball — the hard clamp, not this force, is what guarantees the bound. */
const BOUNDARY_STRENGTH = 0.04

/** Fraction of the smaller half-dimension beyond which two nodes no longer repel.
 *  Keeps repulsion local so the cloud can't inflate from long-range 1/d² tails. */
const CHARGE_RANGE_FACTOR = 1

/** A d3 simulation node carrying BOTH identities: the stable internal `synthKey`
 *  (d3's link-resolver id, never changes → position continuity) and the current
 *  `displayId` (the external render/edge id-space, refreshed every `sync` — swaps
 *  synthKey→UUID at finalize). `vx/vy/fx/fy` are the d3-managed fields (see
 *  SimulationNodeDatum). `x`/`y` are NARROWED to required: `seedNode` always
 *  assigns finite coordinates and d3 only reassigns them when `isNaN` (never our
 *  case), so a sim node's position is always defined — `positions()` needs no
 *  `?? 0` defensiveness. */
interface SimNode extends SimulationNodeDatum {
  synthKey: string
  displayId: string
  x: number
  y: number
}

/** A d3 link datum. `source`/`target` are seeded as `synthKey` strings (the edge's
 *  UUID endpoints translated to the endpoints' stable `synthKey` by `buildLinks`)
 *  and resolved to node objects by d3 via the `id` accessor on (re-)initialisation.
 *  `synthKey` here is the edge's OWN stable id (unused by the node resolver). */
interface SimLink extends SimulationLinkDatum<SimNode> {
  synthKey: string
}

export interface ForceSim {
  /** MERGE the derived graph into the persistent sim: survivors keep their
   *  position/momentum, new keys are seeded near centre, vanished keys drop. */
  sync(nodes: GraphNode[], edges: GraphEdge[]): void
  /** Advance the simulation one step. Driven by the render loop (C4). */
  tick(): void
  /** displayId → current position. */
  positions(): Map<string, { x: number; y: number }>
  /** Fix a node at (x, y) — drag-to-pin (C4). */
  pin(displayId: string, x: number, y: number): void
  /** Release a pinned node back to the simulation. */
  unpin(displayId: string): void
}

function seedNode(synthKey: string, displayId: string): SimNode {
  return {
    synthKey,
    displayId,
    x: (Math.random() - 0.5) * SEED_JITTER,
    y: (Math.random() - 0.5) * SEED_JITTER,
    vx: 0,
    vy: 0,
  }
}

export function create(opts: { width: number; height: number }): ForceSim {
  // The centred draw space: nodes live in `[−halfW, halfW] × [−halfH, halfH]`
  // (the host translates the canvas by (w/2, h/2) before drawing raw sim coords).
  const halfW = opts.width / 2
  const halfH = opts.height / 2
  const chargeRange = (Math.min(opts.width, opts.height) / 2) * CHARGE_RANGE_FACTOR

  // The persistent state: `byKey` is the source of truth for identity; `nodes`
  // is the SAME array handed to d3 every sync (mutated in place — survivor
  // object references are reused, never rebuilt).
  const byKey = new Map<string, SimNode>()
  const nodes: SimNode[] = []
  const linkForce = forceLink<SimNode, SimLink>([]).id((node) => node.synthKey)
  const simulation = forceSimulation<SimNode, SimLink>(nodes)
    .force('charge', forceManyBody<SimNode>().distanceMax(chargeRange))
    .force('link', linkForce)
    .force('center', forceCenter<SimNode>())
    .force('boundX', forceX<SimNode>(0).strength(BOUNDARY_STRENGTH))
    .force('boundY', forceY<SimNode>(0).strength(BOUNDARY_STRENGTH))
    .stop() // manual control — C4's render loop drives tick(), not d3's timer.

  /** Advance one step, then HARD-clamp every node into the centred draw space.
   *  The boundary force + distanceMax keep the settle smooth; this clamp is the
   *  guarantee that no node is ever reported (or drawn) outside the viewport. */
  function tick(): void {
    simulation.tick()
    for (const simNode of nodes) {
      if (simNode.x < -halfW) simNode.x = -halfW
      else if (simNode.x > halfW) simNode.x = halfW
      if (simNode.y < -halfH) simNode.y = -halfH
      else if (simNode.y > halfH) simNode.y = halfH
    }
  }

  function mergeNodes(incoming: GraphNode[]): void {
    // Identity is the STABLE `synthKey`, so a finalize (displayId synthKey→UUID)
    // keeps the same node object + its settled position — no delete-then-reseed.
    const wanted = new Set(incoming.map((n) => n.synthKey))
    for (const key of [...byKey.keys()]) {
      if (!wanted.has(key)) byKey.delete(key)
    }
    for (const graphNode of incoming) {
      const existing = byKey.get(graphNode.synthKey)
      if (existing === undefined) {
        byKey.set(graphNode.synthKey, seedNode(graphNode.synthKey, graphNode.displayId))
      } else {
        existing.displayId = graphNode.displayId // refresh the external id (finalize swap); position is untouched.
      }
    }
    nodes.length = 0
    for (const simNode of byKey.values()) nodes.push(simNode)
  }

  /** A `displayId → synthKey` map over the CURRENT nodes — the translation from the
   *  external (edge/render/pointer) id-space into the sim's internal synthKey key. */
  function displayIdToSynthKey(): Map<string, string> {
    const out = new Map<string, string>()
    for (const simNode of byKey.values()) out.set(simNode.displayId, simNode.synthKey)
    return out
  }

  function buildLinks(edges: GraphEdge[]): SimLink[] {
    // Edge endpoints are entity UUIDs (= the endpoints' `displayId`); translate each
    // to the endpoint's internal `synthKey` so d3's `id` resolver (keyed on synthKey)
    // finds the node. Drop an edge whose endpoint is unknown — a dangling endpoint
    // would make the resolver throw (`node not found`).
    const toSynth = displayIdToSynthKey()
    const links: SimLink[] = []
    for (const e of edges) {
      const source = toSynth.get(e.from)
      const target = toSynth.get(e.to)
      if (source === undefined || target === undefined) continue
      links.push({ synthKey: e.synthKey, source, target })
    }
    return links
  }

  function sync(incoming: GraphNode[], edges: GraphEdge[]): void {
    linkForce.links([]) // drop stale object refs before the node set changes.
    mergeNodes(incoming)
    simulation.nodes(nodes) // re-inits forces; survivors keep x/y/vx/vy (valid → not re-seeded).
    linkForce.links(buildLinks(edges)) // resolves string endpoints against the current nodes.
    simulation.alpha(REHEAT_ALPHA) // reheat WITHOUT restart — keeps the timer stopped.
  }

  function positions(): Map<string, { x: number; y: number }> {
    // Keyed by the EXTERNAL `displayId` so consumers resolve in displayId/UUID space
    // (drawNodes via `node.displayId`, drawEdges via UUID edge endpoints).
    const out = new Map<string, { x: number; y: number }>()
    for (const simNode of byKey.values()) {
      out.set(simNode.displayId, { x: simNode.x, y: simNode.y })
    }
    return out
  }

  /** The persistent `SimNode` for an external `displayId`, or undefined — the same
   *  displayId→synthKey lookup `buildLinks` uses, then resolved to the sim node. */
  function nodeByDisplayId(displayId: string): SimNode | undefined {
    const synthKey = displayIdToSynthKey().get(displayId)
    return synthKey === undefined ? undefined : byKey.get(synthKey)
  }

  function pin(displayId: string, x: number, y: number): void {
    const simNode = nodeByDisplayId(displayId)
    if (simNode === undefined) return
    simNode.fx = x
    simNode.fy = y
  }

  function unpin(displayId: string): void {
    const simNode = nodeByDisplayId(displayId)
    if (simNode === undefined) return
    simNode.fx = null
    simNode.fy = null
  }

  return {
    sync,
    tick,
    positions,
    pin,
    unpin,
  }
}
