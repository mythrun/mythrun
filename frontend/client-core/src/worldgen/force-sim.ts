import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Force,
  type ForceLink,
  type Simulation,
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

// ──────────────────────────────────────────────────────────────────────────
// TUNABLE FORCE PARAMS (MYT-89 audit #4 — the spread re-tune)
// The graph used to CLUMP in the centre: weak repulsion (charge −30, capped at
// `distanceMax` = half-height, which truncated cross-cloud repulsion) fighting a
// full-strength `forceCenter` + an inward `forceX/Y(0)`, with new nodes seeded
// STACKED at ±1px of origin. The re-tune below SPREADS the graph to FILL the
// 900×470 space. Every knob is a `create` param (merged over `FORCE_PARAMS`), so
// the Storybook spread-tuning harness dials the exact feel live — the values Miklos
// lands on replace these defaults, which then become the locked spec.
// ──────────────────────────────────────────────────────────────────────────

/** The tunable forces. `create` merges a caller's partial override over
 *  `FORCE_PARAMS`; each field maps to one d3-force setting. Threaded end-to-end so
 *  the harness re-seeds the live graph as the sliders move — production omits them
 *  (→ the locked defaults). */
export interface ForceParams {
  /** `forceManyBody().strength` — node↔node repulsion (negative = repel). More
   *  negative pushes the cloud OUT to fill the space (was d3's −30 default). */
  chargeStrength: number
  /** `forceManyBody().distanceMax` (px) — the range beyond which a pair stops
   *  repelling. Too small (the old half-height cap) truncates cross-space repulsion
   *  → a central clump; raised here so repulsion reaches across the width. */
  chargeDistanceMax: number
  /** `forceCenter().strength` — the whole-cloud centring pull. High = the main
   *  clumping force; 0 = off (the per-node boundary pull below handles centring). */
  centerStrength: number
  /** `forceX(0)/forceY(0).strength` — a gentle per-node inward pull toward each
   *  centre line. Low, so the cloud fills the space rather than collapsing to a ball;
   *  the hard clamp (not this force) is what guarantees the bound. */
  boundaryStrength: number
  /** AABB-collision AIR (virtual px) — the extra gap enforced BETWEEN two nodes' label
   *  boxes (icon + full text label), on top of the boxes themselves (MYT-89 re-audit). The
   *  box is the collision unit now, not a circle: the rectangular keep-out force separates
   *  the offset icon+label boxes (the SAME box the fog reserves — see the ui's box
   *  measurement) so text can never overlap a neighbour's icon or text. This knob just tunes
   *  the breathing room around each box; `0` = boxes may touch but never overlap. */
  collisionPadding: number
  /** New-node seed spread: a node seeds at a random offset within ±(seedJitter/2) of
   *  centre. Bigger = real initial spread (breaks the stacked-at-origin symmetry);
   *  small = a streaming node emerges near centre and flies out organically. */
  seedJitter: number
  /** Containment INSET (virtual px) — a CSS-style margin the node cloud is held
   *  inside (MYT-89 follow-up). The per-tick clamp bounds tighten from the full
   *  half-dimensions to `±(halfW − margin) / ±(halfH − margin)`, so a boundary node
   *  settles a label-safe distance BEFORE the frame edge and its NAME (drawn beside
   *  the glyph — see `canvas-draw.ts` `drawLabel`) clears the viewport instead of
   *  clipping. Picked to clear a typical label; Miklos dials it in the Storybook
   *  spread tuner. `0` restores the pre-margin full-edge clamp. */
  margin: number
}

/** The LOCKED force defaults — the MYT-89 audit #4 re-tune that FILLS 900×470
 *  instead of clumping. A balanced starting point (spread, contained, room for
 *  labels); Miklos finalises the exact feel via the Storybook spread-tuning harness,
 *  and the values he lands on replace these. */
export const FORCE_PARAMS: ForceParams = {
  chargeStrength: -120,
  chargeDistanceMax: 720,
  centerStrength: 0,
  boundaryStrength: 0.01,
  collisionPadding: 3,
  seedJitter: 250,
  margin: 15,
}

/** The slider envelopes (`min`/`max`/`step`) the spread-tuning harness exposes for
 *  each force param — mirrors `FOG_PARAM_RANGES`. `FORCE_PARAMS` holds the default
 *  within each. */
export const FORCE_PARAM_RANGES = {
  chargeStrength: { min: -400, max: 0, step: 5 },
  chargeDistanceMax: { min: 100, max: 1400, step: 20 },
  centerStrength: { min: 0, max: 1, step: 0.02 },
  boundaryStrength: { min: 0, max: 0.2, step: 0.005 },
  collisionPadding: { min: 0, max: 80, step: 1 },
  seedJitter: { min: 0, max: 400, step: 5 },
  margin: { min: 0, max: 150, step: 5 },
} as const

// VIEWPORT CONTAINMENT (MYT-89 Phase B, BUG 2.2). The repulsion cloud has no
// natural bound — `forceCenter` only removes net drift, it does not pull inward —
// so a dense graph can push nodes off-screen ("should be impossible"). Three
// layers, weakest→hardest:
//   1. a gentle inward `forceX(0)`/`forceY(0)` (`boundaryStrength`) that biases each
//      node toward the centre lines so containment reads as a soft settle;
//   2. a `distanceMax` on the charge (`chargeDistanceMax`) so far-apart pairs stop
//      repelling — caps the long-range accumulation that lets the cloud inflate;
//   3. a per-tick hard clamp of every node to the INSET half-dimensions (the full
//      half less `margin`) — the guarantee that NO node ever draws outside
//      `[−(w/2−m), w/2−m] × [−(h/2−m), h/2−m]`, even mid-settle, so a boundary node's
//      LABEL clears the frame edge (MYT-89 follow-up — the CSS-style containment margin).
// Applies to BOTH the generation and reveal graphs (they share this sim); there is
// no phase-specific gating.

/** The collision box for one node — the icon + its FULL text label, as SIGNED extents
 *  RELATIVE to the node's position (the icon centre). The box is offset from the position:
 *  it extends further RIGHT than left (the label sits to the right of the icon) and is
 *  centred slightly ABOVE the anchor (the reference capsule offset). `left`/`top` are
 *  negative, `right`/`bottom` positive. This is the EXACT box the fog reserves per entity
 *  (`WorldGenFog/fog-obstacles.ts` `labelBoxExtents`) — collision + fog share one geometry,
 *  so a node's label can never overlap a neighbour's icon or text (MYT-89 re-audit). The
 *  sim receives these as NUMBERS (the ui measures the text via canvas; the sim stays
 *  DOM-free). */
export interface NodeBox {
  /** x-min offset from the node position (≤ 0 — the icon's left edge). */
  left: number
  /** x-max offset (> 0 — the right edge of the text label). */
  right: number
  /** y-min offset (< 0 — the top of the label clear-window, above the anchor). */
  top: number
  /** y-max offset (> 0 — the bottom of the label clear-window, below the anchor). */
  bottom: number
}

/** A d3 simulation node carrying BOTH identities: the stable internal `synthKey`
 *  (d3's link-resolver id, never changes → position continuity) and the current
 *  `displayId` (the external render/edge id-space, refreshed every `sync` — swaps
 *  synthKey→UUID at finalize). `vx/vy/fx/fy` are the d3-managed fields (see
 *  SimulationNodeDatum). `x`/`y` are NARROWED to required: `seedNode` always
 *  assigns finite coordinates and d3 only reassigns them when `isNaN` (never our
 *  case), so a sim node's position is always defined — `positions()` needs no
 *  `?? 0` defensiveness. `box` is the measured icon+label AABB (set via `setBoxes`
 *  from the ui) the rectangular collision force keeps apart; `undefined` until the
 *  ui has measured the label (the node is then ignored by collision). */
interface SimNode extends SimulationNodeDatum {
  synthKey: string
  displayId: string
  x: number
  y: number
  // Required-with-`undefined` (not plain optional) so `applyBoxes` can clear a stale box by
  // assigning the `Map.get(…)` result directly under `exactOptionalPropertyTypes`.
  box: NodeBox | undefined
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
  /** Supply the measured icon+label collision box per `displayId` (the ui measures the
   *  text; the sim stays DOM-free). Stored and RE-APPLIED on every `sync`, so a node that
   *  streams in later still picks up its box, and a finalize (displayId swap) re-keys it.
   *  The rectangular collision force keeps every pair of boxes from overlapping. */
  setBoxes(boxes: Map<string, NodeBox>): void
  /** Advance the simulation one step. Driven by the render loop (C4). */
  tick(): void
  /** displayId → current position. */
  positions(): Map<string, { x: number; y: number }>
  /** Fix a node at (x, y) — drag-to-pin (C4). */
  pin(displayId: string, x: number, y: number): void
  /** Release a pinned node back to the simulation. */
  unpin(displayId: string): void
}

function seedNode(
  synthKey: string,
  displayId: string,
  jitter: number,
  random: () => number,
): SimNode {
  return {
    synthKey,
    displayId,
    x: (random() - 0.5) * jitter,
    y: (random() - 0.5) * jitter,
    vx: 0,
    vy: 0,
    box: undefined, // set by `applyBoxes` once the ui has measured the label.
  }
}

// ──────────────────────────────────────────────────────────────────────────
// RECTANGULAR (AABB) COLLISION — the box IS the keep-out unit (MYT-89 re-audit)
// The old `forceCollide(radius)` kept node CENTRES a fixed distance apart — a
// CIRCLE around the icon. But a node's TEXT LABEL extends well past that circle
// (to the right of the icon), so a label could overlap a neighbour's icon or text
// even when the icons didn't touch. Miklos: "there should never be situations where
// the text overlaps an icon or other text — this needs to be readable."
//
// The fix: collide on the node's icon+label BOUNDING BOX — the SAME offset AABB the
// fog reserves per entity (`WorldGenFog/fog-obstacles.ts`). A simple O(n²) pairwise
// separation (fine for the ~20–40 nodes here — no quadtree): for each overlapping
// pair, push the two boxes apart along their MINIMUM-overlap axis, splitting the
// overlap 50/50, iterated per tick like d3's own collide. Because the boxes are
// OFFSET from the node position (asymmetric: the label extends right, the box sits
// slightly above the anchor), the separation is computed on the offset extents, not
// on the centres — a wide label claims horizontal room without forcing the excess
// VERTICAL spacing a circumscribing circle would (rectangles pack tighter).
// ──────────────────────────────────────────────────────────────────────────

/** Separate ONE overlapping pair of offset label boxes (velocity-based, like d3's
 *  collide): work in the PROJECTED positions (`x + vx`), expand each box by half the
 *  air gap, and if the projected AABBs overlap on BOTH axes, nudge the two velocities
 *  apart along the MINIMUM-overlap axis by half the overlap each. Not alpha-scaled (the
 *  keep-out is a hard constraint, not a soft settle) — over the tick loop the pair
 *  converges to non-overlapping. Deterministic on an exact tie (equal centres → a fixed
 *  split direction), so no RNG is needed. */
function separateBoxes(
  a: SimNode,
  aBox: NodeBox,
  b: SimNode,
  bBox: NodeBox,
  halfPad: number,
): void {
  const avx = a.vx ?? 0
  const avy = a.vy ?? 0
  const bvx = b.vx ?? 0
  const bvy = b.vy ?? 0
  const ax = a.x + avx
  const ay = a.y + avy
  const bx = b.x + bvx
  const by = b.y + bvy

  const overlapX =
    Math.min(ax + aBox.right + halfPad, bx + bBox.right + halfPad) -
    Math.max(ax + aBox.left - halfPad, bx + bBox.left - halfPad)
  if (overlapX <= 0) return
  const overlapY =
    Math.min(ay + aBox.bottom + halfPad, by + bBox.bottom + halfPad) -
    Math.max(ay + aBox.top - halfPad, by + bBox.top - halfPad)
  if (overlapY <= 0) return

  if (overlapX < overlapY) {
    const push = overlapX / 2
    const dir = ax + (aBox.left + aBox.right) / 2 <= bx + (bBox.left + bBox.right) / 2 ? 1 : -1
    a.vx = avx - dir * push
    b.vx = bvx + dir * push
  } else {
    const push = overlapY / 2
    const dir = ay + (aBox.top + aBox.bottom) / 2 <= by + (bBox.top + bBox.bottom) / 2 ? 1 : -1
    a.vy = avy - dir * push
    b.vy = bvy + dir * push
  }
}

/** The rectangular keep-out force: an O(n²) pairwise pass over the CURRENT node set,
 *  separating every overlapping pair of icon+label boxes (`separateBoxes`). Nodes whose
 *  box the ui hasn't measured yet (`box === undefined`) are skipped. `padding` is the AIR
 *  between two boxes — split half onto each box's extents, so two boxes hold at least
 *  `padding` px apart. Built as a d3 `Force`: `initialize` captures the live node array
 *  (re-run on every `simulation.nodes()`), the call applies one separation pass per tick. */
function boxCollide(padding: number): Force<SimNode, SimLink> {
  const halfPad = padding / 2
  let simNodes: SimNode[] = []
  return Object.assign(
    (): void => {
      const n = simNodes.length
      for (let i = 0; i < n; i++) {
        const a = simNodes[i]
        const aBox = a?.box
        if (a === undefined || aBox === undefined) continue
        for (let j = i + 1; j < n; j++) {
          const b = simNodes[j]
          const bBox = b?.box
          if (b === undefined || bBox === undefined) continue
          separateBoxes(a, aBox, b, bBox, halfPad)
        }
      }
    },
    {
      initialize: (nextNodes: SimNode[]): void => {
        simNodes = nextNodes
      },
    },
  )
}

/** Build the STOPPED d3 simulation with the re-tuned spread forces (MYT-89 audit #4):
 *  charge (`chargeStrength` + `chargeDistanceMax`), the link force, a centre pull
 *  (`centerStrength`), the rectangular box collide (`collisionPadding` — no icon/label
 *  overlap, the box is the keep-out unit), and the per-axis inward boundary pull
 *  (`boundaryStrength`). `.stop()` because C4's render loop drives `tick()`, not d3's
 *  internal timer. */
function buildSimulation(
  nodes: SimNode[],
  linkForce: ForceLink<SimNode, SimLink>,
  params: ForceParams,
): Simulation<SimNode, SimLink> {
  return forceSimulation<SimNode, SimLink>(nodes)
    .force(
      'charge',
      forceManyBody<SimNode>()
        .strength(params.chargeStrength)
        .distanceMax(params.chargeDistanceMax),
    )
    .force('link', linkForce)
    .force('center', forceCenter<SimNode>().strength(params.centerStrength))
    .force('collide', boxCollide(params.collisionPadding))
    .force('boundX', forceX<SimNode>(0).strength(params.boundaryStrength))
    .force('boundY', forceY<SimNode>(0).strength(params.boundaryStrength))
    .stop()
}

/** Clamp ONE axis so the node's BOX — signed extents `lo` (≤ 0) / `hi` (≥ 0) from the node
 *  position — stays inside `[−bound, bound]`. The box spans `[pos + lo, pos + hi]`; holding it
 *  inside gives `pos ∈ [−bound − lo, bound − hi]` (the `lo`/`hi` sign moves each end INWARD, so
 *  the box, not the icon point, clears the edge). When the box is WIDER than the available span
 *  the upper bound falls BELOW the lower (an inverted range) — centre the box in the span rather
 *  than inverting (a label wider than the viewport overflows symmetrically; rare). */
function clampBoxAxis(pos: number, lo: number, hi: number, bound: number): number {
  const lower = -bound - lo // lo ≤ 0 → lower moves inward by |lo|
  const upper = bound - hi // hi ≥ 0 → upper moves inward by hi
  if (upper < lower) return (lower + upper) / 2 // box wider than span → centre, don't invert
  if (pos < lower) return lower
  if (pos > upper) return upper
  return pos
}

/** HARD-clamp every node into the INSET draw space (`±boundW / ±boundH` = the full
 *  half-dimensions less the `margin`). The boundary force + distanceMax keep the settle
 *  smooth; this clamp is the GUARANTEE that no node — and thus no label — is ever reported
 *  (or drawn) outside the frame's margin (MYT-89 BUG 2.2). For a node whose icon+label BOX the
 *  ui has measured, the whole BOX (not just the icon point) is held inside the inset — a
 *  right-extending label can no longer clip out even with the icon in frame (MYT-89 label-clip
 *  fix, `box.right`/`box.left`/`box.top`/`box.bottom` are signed offsets from the node position).
 *  A not-yet-measured node (`box === undefined`) falls back to the plain icon-point clamp.
 *  Module-scoped so `tick` stays lean. */
function clampNodes(nodes: SimNode[], boundW: number, boundH: number): void {
  for (const simNode of nodes) {
    const box = simNode.box
    if (box === undefined) {
      // No measured label yet — clamp the icon point (the pre-fix behaviour, unchanged).
      if (simNode.x < -boundW) simNode.x = -boundW
      else if (simNode.x > boundW) simNode.x = boundW
      if (simNode.y < -boundH) simNode.y = -boundH
      else if (simNode.y > boundH) simNode.y = boundH
      continue
    }
    simNode.x = clampBoxAxis(simNode.x, box.left, box.right, boundW)
    simNode.y = clampBoxAxis(simNode.y, box.top, box.bottom, boundH)
  }
}

/** The persistent icon+label box store: the ui-measured boxes keyed by the EXTERNAL
 *  `displayId`, plus `applyBoxes` which stamps each onto the matching persistent `SimNode`.
 *  Kept off `create` so the box plumbing is one line there. `setBoxes` replaces the whole set
 *  (a fresh measurement) and re-applies; `applyBoxes` is also called after every `sync` so a
 *  freshly-seeded node picks up an already-known box and a finalize (displayId swap) re-keys. */
function makeBoxStore(byKey: Map<string, SimNode>): {
  applyBoxes: () => void
  setBoxes: (next: Map<string, NodeBox>) => void
} {
  let boxesByDisplayId = new Map<string, NodeBox>()
  const applyBoxes = (): void => {
    for (const simNode of byKey.values()) simNode.box = boxesByDisplayId.get(simNode.displayId)
  }
  const setBoxes = (next: Map<string, NodeBox>): void => {
    boxesByDisplayId = next
    applyBoxes()
  }
  return { applyBoxes, setBoxes }
}

export function create(opts: {
  width: number
  height: number
  /** Injectable RNG for deterministic seeding (tests); defaults to `Math.random`. */
  random?: () => number
  /** Partial force overrides, merged over `FORCE_PARAMS` — the spread-tuning harness
   *  passes the live slider values; production omits it (→ the locked defaults). */
  params?: Partial<ForceParams>
}): ForceSim {
  // The centred draw space: nodes live in `[−halfW, halfW] × [−halfH, halfH]`
  // (the host translates the canvas by (w/2, h/2) before drawing raw sim coords).
  const halfW = opts.width / 2
  const halfH = opts.height / 2
  const random = opts.random ?? Math.random
  const params: ForceParams = { ...FORCE_PARAMS, ...opts.params }

  // CONTAINMENT INSET (MYT-89 follow-up) — a CSS-style margin: the clamp bounds inset
  // from the full half-dimensions to `±(half − margin)` so a boundary node settles a
  // label-safe distance before the frame edge and its NAME clears the viewport (names
  // now render during generation — audit #3 — which made edge-clipping visible).
  // `Math.max(0, …)` guards a degenerate margin ≥ half from inverting the bound (it
  // just collapses to the centre line). The soft `boundX/boundY` forces pull toward
  // the centre (0), which is inside ANY inset, so they need no adjustment — the CLAMP
  // is the mechanism that guarantees the inset bound.
  const boundW = Math.max(0, halfW - params.margin)
  const boundH = Math.max(0, halfH - params.margin)

  // The persistent state: `byKey` is the source of truth for identity; `nodes`
  // is the SAME array handed to d3 every sync (mutated in place — survivor
  // object references are reused, never rebuilt).
  const byKey = new Map<string, SimNode>()
  const nodes: SimNode[] = []
  const linkForce = forceLink<SimNode, SimLink>([]).id((node) => node.synthKey)
  const simulation = buildSimulation(nodes, linkForce, params)

  // Icon+label box store (keyed by displayId); re-applied after every merge so a late node resolves its box.
  const { applyBoxes, setBoxes } = makeBoxStore(byKey)

  /** Advance one step, then HARD-clamp every node into the INSET draw space
   *  (`±boundW / ±boundH` = the full half-dimensions less the `margin`) via `clampNodes`. */
  function tick(): void {
    simulation.tick()
    clampNodes(nodes, boundW, boundH)
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
        byKey.set(
          graphNode.synthKey,
          seedNode(graphNode.synthKey, graphNode.displayId, params.seedJitter, random),
        )
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
    applyBoxes() // re-attach the measured boxes to survivors + freshly-seeded nodes.
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
    setBoxes,
    tick,
    positions,
    pin,
    unpin,
  }
}
