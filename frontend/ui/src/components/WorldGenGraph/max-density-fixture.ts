import type { GraphEdge, GraphNode } from '@mythrun/client-core/contract'

// The REALISTIC MAX-DENSITY fixture (MYT-89 density redesign) — the graph the density
// work is designed and eye-verified against. Shaped from the dev DB's real completed
// generations (measured 2026-06): ~43–46 entities per world (the densest: 22 locations
// / 15 npcs / 9 factions) and 63–81 relationships; names average ~17 chars, max 32
// ("The Second Switchback Checkpoint"). This fixture mirrors that exactly:
//
//   46 nodes — 1 world + 9 factions + 15 npcs + 20 locations + 1 pc
//   72 edges — 64 streamed `weave` + a late 8-edge `coherence_pass` `snap` batch
//
// Storybook-only data (imported by WorldGenGraph.stories.tsx): the arrivals build
// deterministically — nodes in bursty stage-shaped waves, each edge landing once both
// endpoints exist, the snap batch last — compressed to ~35s so a design pass sees the
// full density arc without the real pipeline's ~10 minutes.

export interface FixtureArrival {
  afterMs: number
  node?: GraphNode
  edge?: GraphEdge
}

const node = (synthKey: string, kind: string, name: string, index: number): GraphNode => ({
  synthKey,
  kind,
  name,
  displayId: synthKey,
  state: 'live',
  lastEventIndex: index,
})

// Ordered by ARRIVAL (stage-shaped: the world, the early factions + core locations,
// the npc wave, the late locations, the pc last) — [synthKey, kind, name].
const NODE_SPECS: readonly (readonly [string, string, string])[] = [
  ['w/ashfen', 'world', 'Ashfen Reach'],
  ['l/ward', 'location', 'The Drowned Ward'],
  ['f/tallow', 'faction', 'The Tallow Guild'],
  ['l/loft', 'location', 'The Bell-Loft'],
  ['f/wardens', 'faction', 'Reach Wardens'],
  ['l/road', 'location', 'The Forgetting Road'],
  ['f/recollects', 'faction', "Recollects' Circle"],
  ['l/galleries', 'location', 'The Lower Galleries'],
  ['f/bellwardens', 'faction', 'Bell-Wardens'],
  ['l/bowl', 'location', 'The Cracked Bowl'],
  ['f/concord', 'faction', 'The Salt Crescent Concord'],
  ['l/stir', 'location', 'The Understirring'],
  ['f/league', 'faction', "The Dockworkers' League"],
  ['l/still', 'location', 'Stillwater'],
  ['f/order', 'faction', 'The Order of the Sixth Phase'],
  ['f/quietglass', 'faction', 'Quietglass Guildhouse'],
  ['f/ferrymen', 'faction', 'The Ferrymen of the Undertide'],
  ['n/maeris', 'npc', 'Maeris Vale'],
  ['n/corr', 'npc', 'Old Corr'],
  ['n/sennel', 'npc', 'Abbot Sennel'],
  ['n/ivarn', 'npc', 'Lector Ivarn'],
  ['n/peret', 'npc', 'Master Peret Vell'],
  ['n/wren', 'npc', 'Wren the Quiet'],
  ['n/dill', 'npc', 'Harbormaster Dill'],
  ['n/oduma', 'npc', 'Saltwife Oduma'],
  ['n/brac', 'npc', 'The Lamplighter Brac'],
  ['n/halstrom', 'npc', 'Mother Halstrom'],
  ['n/ashvane', 'npc', 'Keeper Ashvane'],
  ['n/tolliver', 'npc', 'Tolliver of the Locks'],
  ['n/marrick', 'npc', 'Grey Marrick'],
  ['n/pell', 'npc', 'Sister Pell'],
  ['n/vesh', 'npc', 'The Tidecaller Vesh'],
  ['l/switchback', 'location', 'The Second Switchback Checkpoint'],
  ['l/cairn', 'location', 'The Caravan Rest at Black Cairn'],
  ['l/funicular', 'location', 'The Funicular Foot Station'],
  ['l/office', 'location', "The Harbormaster's Office"],
  ['l/molewalk', 'location', 'The Old Mole Lamp-Walk'],
  ['l/scale', 'location', 'The Notched Scale Room'],
  ['l/frost', 'location', 'The Frost Approaches'],
  ['l/stairs', 'location', 'The Salt Stairs'],
  ['l/candlewharf', 'location', 'Candlewharf'],
  ['l/vaults', 'location', 'The Ledger Vaults'],
  ['l/commons', 'location', 'The Sunken Commons'],
  ['l/gullsgate', 'location', 'Gullsgate'],
  ['l/shallows', 'location', 'The Long Shallows'],
  ['pc/you', 'pc', 'You'],
]

// The relationship web — [from, to, relationship, stage]: faction↔location holdings,
// npc→faction allegiances, the location containment tree, npc↔npc ties, and a late
// coherence `snap` batch. 64 weave + 8 snap = 72 (the real 63–81 band).
type EdgeSpec = readonly [string, string, string, 'weave' | 'snap']
const EDGE_SPECS: readonly EdgeSpec[] = [
  // locations within the world / one another (20)
  ['l/ward', 'w/ashfen', 'within', 'weave'],
  ['l/loft', 'w/ashfen', 'within', 'weave'],
  ['l/road', 'w/ashfen', 'within', 'weave'],
  ['l/bowl', 'w/ashfen', 'within', 'weave'],
  ['l/still', 'w/ashfen', 'within', 'weave'],
  ['l/frost', 'w/ashfen', 'within', 'weave'],
  ['l/candlewharf', 'w/ashfen', 'within', 'weave'],
  ['l/gullsgate', 'w/ashfen', 'within', 'weave'],
  ['l/shallows', 'w/ashfen', 'within', 'weave'],
  ['l/switchback', 'l/road', 'along', 'weave'],
  ['l/cairn', 'l/road', 'along', 'weave'],
  ['l/galleries', 'l/ward', 'beneath', 'weave'],
  ['l/stir', 'l/galleries', 'beneath', 'weave'],
  ['l/funicular', 'l/loft', 'serves', 'weave'],
  ['l/office', 'l/candlewharf', 'faces', 'weave'],
  ['l/molewalk', 'l/candlewharf', 'along', 'weave'],
  ['l/scale', 'l/vaults', 'within', 'weave'],
  ['l/vaults', 'l/ward', 'beneath', 'weave'],
  ['l/commons', 'l/ward', 'within', 'weave'],
  ['l/stairs', 'l/gullsgate', 'climbs to', 'weave'],
  // faction holdings (9)
  ['f/tallow', 'l/ward', 'controls', 'weave'],
  ['f/wardens', 'l/road', 'patrols', 'weave'],
  ['f/recollects', 'l/galleries', 'keeps', 'weave'],
  ['f/bellwardens', 'l/loft', 'holds', 'weave'],
  ['f/concord', 'l/candlewharf', 'controls', 'weave'],
  ['f/league', 'l/office', 'pickets', 'weave'],
  ['f/order', 'l/stir', 'wards', 'weave'],
  ['f/quietglass', 'l/scale', 'keeps', 'weave'],
  ['f/ferrymen', 'l/shallows', 'works', 'weave'],
  // npc allegiances (15)
  ['n/maeris', 'f/tallow', 'leads', 'weave'],
  ['n/corr', 'f/wardens', 'scouts for', 'weave'],
  ['n/sennel', 'f/recollects', 'leads', 'weave'],
  ['n/ivarn', 'f/recollects', 'serves', 'weave'],
  ['n/peret', 'f/quietglass', 'leads', 'weave'],
  ['n/wren', 'f/bellwardens', 'listens for', 'weave'],
  ['n/dill', 'f/concord', 'answers to', 'weave'],
  ['n/oduma', 'f/ferrymen', 'leads', 'weave'],
  ['n/brac', 'f/league', 'speaks for', 'weave'],
  ['n/halstrom', 'f/order', 'leads', 'weave'],
  ['n/ashvane', 'f/bellwardens', 'leads', 'weave'],
  ['n/tolliver', 'f/league', 'serves', 'weave'],
  ['n/marrick', 'f/wardens', 'leads', 'weave'],
  ['n/pell', 'f/order', 'serves', 'weave'],
  ['n/vesh', 'f/ferrymen', 'guides', 'weave'],
  // npcs at places (8)
  ['n/corr', 'l/cairn', 'haunts', 'weave'],
  ['n/dill', 'l/office', 'keeps', 'weave'],
  ['n/brac', 'l/molewalk', 'lights', 'weave'],
  ['n/wren', 'l/loft', 'lives in', 'weave'],
  ['n/oduma', 'l/shallows', 'poles', 'weave'],
  ['n/pell', 'l/commons', 'tends', 'weave'],
  ['n/tolliver', 'l/funicular', 'works', 'weave'],
  ['n/vesh', 'l/still', 'reads', 'weave'],
  // npc ↔ npc (7)
  ['n/maeris', 'n/dill', 'owes', 'weave'],
  ['n/corr', 'n/marrick', 'distrusts', 'weave'],
  ['n/sennel', 'n/ivarn', 'tutors', 'weave'],
  ['n/wren', 'n/ashvane', 'reports to', 'weave'],
  ['n/halstrom', 'n/pell', 'guards', 'weave'],
  ['n/peret', 'n/maeris', 'rivals', 'weave'],
  ['n/brac', 'n/oduma', 'married', 'weave'],
  // faction ↔ faction (4)
  ['f/tallow', 'f/concord', 'undercuts', 'weave'],
  ['f/wardens', 'f/order', 'treaty with', 'weave'],
  ['f/league', 'f/concord', 'strikes against', 'weave'],
  ['f/recollects', 'f/bellwardens', 'shares bells', 'weave'],
  // the player (1)
  ['pc/you', 'f/wardens', 'sworn to', 'weave'],
  // the late coherence_pass batch (8) — lands together, snaps in fast
  ['n/maeris', 'l/vaults', 'holds key to', 'snap'],
  ['n/marrick', 'l/switchback', 'commands', 'snap'],
  ['f/order', 'l/frost', 'watches', 'snap'],
  ['n/ashvane', 'l/stairs', 'keeps', 'snap'],
  ['f/ferrymen', 'l/stir', 'avoids', 'snap'],
  ['n/ivarn', 'l/scale', 'studies', 'snap'],
  ['n/halstrom', 'l/bowl', 'seals', 'snap'],
  ['pc/you', 'l/ward', 'arrived at', 'snap'],
]

/** Bursty node-arrival gaps (ms), cycled — a lull, then a cluster, mirroring how the
 *  prep pipeline emits (a stage goes quiet, then dumps several entities at once). */
const NODE_GAPS = [1600, 220, 160, 260, 150, 950, 180, 240, 150, 2100] as const
/** Edge gaps (ms) — the weave streams steadily between node bursts. */
const EDGE_GAPS = [140, 260, 180, 120, 320] as const
/** The snap batch lands nearly at once. */
const SNAP_GAP = 60

const edgeOf = (spec: EdgeSpec, index: number): GraphEdge => ({
  synthKey: `${spec[3] === 'snap' ? 'coherence_pass' : 'weave'}/e${String(index)}`,
  from: spec[0],
  to: spec[1],
  relationship: spec[2],
  arrivalIndex: index,
  sourceStage: spec[3],
})

/** Build the deterministic arrival script: nodes land in bursty waves; each WEAVE edge
 *  lands as soon as both endpoints exist (drained after every node, so the penstroke
 *  streams through the whole generation); the SNAP batch lands last, together. */
function buildArrivals(): FixtureArrival[] {
  const out: FixtureArrival[] = []
  const present = new Set<string>()
  const pendingWeave = EDGE_SPECS.filter((e) => e[3] === 'weave')
  const snap = EDGE_SPECS.filter((e) => e[3] === 'snap')
  const emitted = new Set<EdgeSpec>()
  let edgeIndex = 0
  let edgeGapIdx = 0

  NODE_SPECS.forEach(([synthKey, kind, name], i) => {
    out.push({ afterMs: NODE_GAPS[i % NODE_GAPS.length] ?? 300, node: node(synthKey, kind, name, i) })
    present.add(synthKey)
    for (const spec of pendingWeave) {
      if (emitted.has(spec) || !present.has(spec[0]) || !present.has(spec[1])) continue
      emitted.add(spec)
      out.push({ afterMs: EDGE_GAPS[edgeGapIdx++ % EDGE_GAPS.length] ?? 200, edge: edgeOf(spec, edgeIndex++) })
    }
  })
  for (const spec of snap) out.push({ afterMs: SNAP_GAP, edge: edgeOf(spec, edgeIndex++) })
  return out
}

/** The full ~35s max-density arrival script (46 nodes, 72 edges). */
export const MAX_DENSITY_ARRIVALS: readonly FixtureArrival[] = buildArrivals()

/** Total node count (the fog fade denominator). */
export const MAX_DENSITY_TOTAL = NODE_SPECS.length

/** The settled end state — every node + edge at once (the tuning harness's instant
 *  full-density spread). */
export const MAX_DENSITY_NODES: readonly GraphNode[] = NODE_SPECS.map(([k, kind, name], i) =>
  node(k, kind, name, i),
)
export const MAX_DENSITY_EDGES: readonly GraphEdge[] = EDGE_SPECS.map((spec, i) => edgeOf(spec, i))
