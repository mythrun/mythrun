import { forceLink, type ForceLink, type SimulationLinkDatum } from 'd3-force'
import type { ForceParams, SimNode } from './force-sim.ts'
import type { GraphEdge } from './graph-reducers.ts'

// ForceLinks (MYT-89 untangle): the LINK force + its degree-normalised spring
// strengths, split out of `force-sim.ts` (the node-identity core) so both modules
// stay under the 400-line cap. The link concern is self-contained: it owns the
// `SimLink` datum, the per-edge spring-strength computation (d3's `1 / min(degree)`
// default scaled by the tunable `linkStrength`), and the `createLinkForce` wiring
// (the `synthKey` id resolver + the tuned `distance` / `strength`). `force-sim.ts`
// keeps the node identity / merge / collision / containment machinery and calls
// into here. PURE EXTRACTION — every value here is byte-identical to the pre-split
// `force-sim.ts`; the generating-profile GOLDEN_TRACE (a bit-exact parity test in
// `force-sim-regime.test.ts`) guards that nothing shifted.

/** A d3 link datum. `source`/`target` are seeded as `synthKey` strings (the edge's
 *  UUID endpoints translated to the endpoints' stable `synthKey` by `buildSimLinks`)
 *  and resolved to node objects by d3 via the `id` accessor on (re-)initialisation.
 *  `synthKey` here is the edge's OWN stable id (unused by the node resolver).
 *  `strength` is the PRE-COMPUTED spring strength for this link — d3's
 *  degree-normalised default (`1 / min(degree)`) scaled by the tunable
 *  `linkStrength` multiplier, stamped by `buildSimLinks` (which already walks the
 *  edge set and so computes the degrees d3 would) and read by the link force's
 *  strength accessor (MYT-89 untangle). */
export interface SimLink extends SimulationLinkDatum<SimNode> {
  synthKey: string
  strength: number
}

/** A mutable per-endpoint link count. SHARED BY REFERENCE between the degree tally
 *  and every resolved link touching the endpoint, so after the resolve pass each
 *  link reads its endpoints' FINAL degrees — no post-hoc map lookup (whose
 *  `undefined` arm would be unreachable) needed. */
interface DegreeCounter {
  n: number
}

/** Get-or-create the endpoint's counter and count this link against it. */
function tallyDegree(degrees: Map<string, DegreeCounter>, synthKey: string): DegreeCounter {
  const existing = degrees.get(synthKey)
  if (existing !== undefined) {
    existing.n += 1
    return existing
  }
  const fresh = { n: 1 }
  degrees.set(synthKey, fresh)
  return fresh
}

/** Translate the derived edges into d3 link data. Edge endpoints are entity UUIDs
 *  (= the endpoints' `displayId`); each is translated through `toSynth` to the
 *  endpoint's internal `synthKey` so d3's `id` resolver (keyed on synthKey) finds the
 *  node. An edge with an unknown endpoint is DROPPED — a dangling endpoint would make
 *  the resolver throw (`node not found`). Each link is stamped with its spring
 *  strength (MYT-89 untangle): d3's degree-normalised default (`1 / min(degree)`,
 *  counted over the SAME resolved link set d3 would count) scaled by the tunable
 *  `linkStrength` multiplier. */
export function buildSimLinks(
  edges: GraphEdge[],
  toSynth: Map<string, string>,
  linkStrength: number,
): SimLink[] {
  const degrees = new Map<string, DegreeCounter>()
  const resolved: {
    synthKey: string
    source: string
    target: string
    sourceDeg: DegreeCounter
    targetDeg: DegreeCounter
  }[] = []
  for (const e of edges) {
    const source = toSynth.get(e.from)
    const target = toSynth.get(e.to)
    if (source === undefined || target === undefined) continue
    resolved.push({
      synthKey: e.synthKey,
      source,
      target,
      sourceDeg: tallyDegree(degrees, source),
      targetDeg: tallyDegree(degrees, target),
    })
  }
  // The shared counters now hold the FINAL degrees, so each link's strength reads
  // them directly — the exact `1 / min(degree)` d3 would compute, times the knob.
  return resolved.map((link) => ({
    synthKey: link.synthKey,
    source: link.source,
    target: link.target,
    strength: linkStrength / Math.min(link.sourceDeg.n, link.targetDeg.n),
  }))
}

/** Build the CLUSTERING-tuned d3 link force (MYT-89 untangle) with an empty link set —
 *  `sync` supplies the resolved links each fold. The `id` resolver keys on the node's
 *  STABLE `synthKey` (so a finalize's displayId swap never re-resolves a link onto a
 *  different node — position continuity), `distance` is the box-scale rest length
 *  (`linkDistance`), and the per-link `strength` accessor reads the `buildSimLinks`-stamped
 *  spring strength (d3's degree-normalised default scaled by the tunable `linkStrength`).
 *  The accessors are set at construction; d3 reads them when `sync` first calls `.links()`. */
export function createLinkForce(params: ForceParams): ForceLink<SimNode, SimLink> {
  return forceLink<SimNode, SimLink>([])
    .id((node) => node.synthKey)
    .distance(params.linkDistance)
    .strength((link) => link.strength)
}
