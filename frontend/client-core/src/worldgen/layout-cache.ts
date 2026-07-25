// The SESSION-SCOPED world-gen layout cache (ux-run3 myth-aftau). The live map
// is an unmountable surface: the generating view swaps it out whenever the
// player returns to the calm wait ("Wait quietly"), and the route unmounts it
// entirely when they leave. Before this cache, the settled layout lived only in
// component refs — every re-entry re-seeded the force-sim AND the fog's random
// field, so every named place migrated hundreds of pixels and the terrain
// re-rolled wholesale (run-3 pixel evidence, frames 007 vs 009). That curdles
// the fixed-world fiction: "the world keeps forming" became "the world keeps
// being regenerated".
//
// The fix: layout is WORLD state, not render state. One layout per worldgen run
// (keyed by campaign id), holding
//   - the PINNED PLACEMENTS — where each settled node was frozen (pin-on-settle,
//     myth-uis1p) plus the label side it wears, keyed by the node's STABLE
//     `synthKey` (a finalize swaps `displayId` synthKey→UUID; the placement must
//     survive that swap, so the current displayId rides along as data);
//   - the TERRAIN SEED — DERIVED from the run key (`terrainSeedFor`), feeding both
//     the fog sim's RNG and the static landmass field, so the ground the player
//     reads is born the same on every mount, never re-rolled.
// On re-entry the graph hook rehydrates: cached nodes are pinned straight back
// at their placements; NEW entities still settle freely around the pinned
// constellation (the world may GROW; what the player has seen placed does not
// move). Stage 2 reads as stage 1 plus accretion.
//
// Session-scoped by design (a module Map, no storage): a full page refresh
// restarts the SSE stream and re-snapshots the world anyway — the fiction to
// protect is within-session re-entry. Memory is bounded by campaigns visited
// per session (each entry is ~tens of placements). The SEED needs no such caveat:
// it is derived from the key, so the coastline survives a refresh for free.

/** The label side a placement wears (mirrors the ui's `LabelSide` — client-core
 *  cannot import the ui's type, but the literals are the contract). */
export type PlacementSide = 'e' | 'w'

/** One frozen node: where it pinned, which side its label wears, and the
 *  displayId it wore at persist time (informational — the stable key is the
 *  placements-map key, the `synthKey`). */
export interface PinnedPlacement {
  displayId: string
  x: number
  y: number
  side?: PlacementSide
}

/** One worldgen run's persistent layout: the pinned constellation + the
 *  one-per-world terrain seed. */
export interface WorldgenLayout {
  /** The world's terrain seed — `terrainSeedFor(key)`, so it is a pure function of
   *  the run's identity and the ground is the same on every mount (and after a
   *  refresh), never re-rolled. */
  readonly terrainSeed: number
  /** synthKey → frozen placement. Written by pin-on-settle; read on re-entry. */
  readonly placements: Map<string, PinnedPlacement>
}

const layouts = new Map<string, WorldgenLayout>()

/** The run key's own 32-bit hash (FNV-1a) — the TERRAIN SEED. Derived rather than
 *  rolled, so the ground is a function of the world's identity: the same campaign
 *  draws the same coastline on every mount, in every tab, and after a full refresh,
 *  with nothing stored anywhere. (Placements can't work this way — they depend on
 *  arrival order — which is why the cache below still exists.) UI jitter, not game
 *  mechanics: the ZFC no-random rule governs dice, not terrain. */
export function terrainSeedFor(key: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** Get-or-create the layout for a worldgen run. */
export function worldgenLayout(key: string): WorldgenLayout {
  const existing = layouts.get(key)
  if (existing !== undefined) return existing
  const fresh: WorldgenLayout = {
    terrainSeed: terrainSeedFor(key),
    placements: new Map(),
  }
  layouts.set(key, fresh)
  return fresh
}

/** Drop every cached layout — test isolation (and nothing else: production has
 *  no reset path; the session boundary is the lifecycle). */
export function resetWorldgenLayouts(): void {
  layouts.clear()
}

/** Mulberry32 — the standard tiny deterministic PRNG (32-bit state, [0,1)
 *  output), a drop-in for the sims' injectable `random`. Seeded with a layout's
 *  `terrainSeed` it replays the identical particle birth on every mount. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
