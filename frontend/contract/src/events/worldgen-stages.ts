// Canonical world-gen stage taxonomy — the SINGLE source of truth for the
// 11 world-gen pipeline stages, in the exact order the worker iterates them
// (backend/src/llm/prep/world-gen-processor.ts's stage loop).
//
// Consumers import from HERE — no local drift copies:
//   - world-gen-processor.ts   re-exports WORLD_GEN_STAGES + WorldGenStage
//                              (the loop authority).
//   - sse/derive-phase.ts      aliases WORLDGEN_STAGES to this list for its
//                              stageScope() bucketing + STAGE_ORDER sort.
//   - the MYT-89 generation status card renders a FIXED-count loading bar off
//     this list (all stages known from the start, not grown one bar per stage).
//
// MYT-89 audit ③ homes the taxonomy here to kill a 10-vs-11 drift: derive-phase
// carried a hand-maintained 10-stage copy that omitted `entity_consolidation`
// (stage 4b), so an entity_consolidation pipeline_runs row fell into the
// 'unknown' scope bucket and sorted to the front. This list is authoritative.
export const WORLD_GEN_STAGES = [
  'concept_intake',
  // MYT-87 T8: pick the world's two-stop WorldColor dither identity. Placed
  // right after concept_intake so tone/themes are loaded for the vibe inputs.
  'world_color',
  // myth-pfke: stage 1.5 — build the vocabulary registry downstream stages read.
  'vocabulary_intake',
  'world_and_factions',
  'locations_and_npcs',
  'entity_relationships',
  // Stage 4b: resolves stage-4's phantom declarations into real rows — the new
  // last entity-creating stage + the world-snapshot-ready boundary.
  'entity_consolidation',
  'starting_situation',
  'random_tables',
  'coherence_pass',
  // MYT-71 T10: terminal embed stage — runs AFTER all content stages, BEFORE
  // worlds.status flips to 'complete', so a finished world is semantically
  // searchable on completion.
  'embed_world',
] as const

export type WorldGenStage = (typeof WORLD_GEN_STAGES)[number]

// ---------------------------------------------------------------------------
// The PREP / ENTITY split (MYT-89 two-act generating flow).
//
// The player-facing generating experience is two acts: a generic loading screen
// while the early prep stages run (no graph — nothing visible exists yet), then
// the graph / entity-generation view once entities start streaming. The
// boundary is `world_and_factions` — the FIRST stage that emits `entity-added`
// events (it streams entities through streaming-extractor.ts; see
// backend/src/llm/prep/stages/world-and-factions.ts). Everything before it
// (concept_intake / world_color / vocabulary_intake) produces registry/tone
// context, never a graph-visible entity.
//
// Both slices are DERIVED from WORLD_GEN_STAGES at that boundary — a single
// source, so a taxonomy reorder/addition can never drift the split (the sum of
// the two slices IS the canonical list, asserted in worldgen-stages.test.ts).
//
// Consumers:
//   - the generating route's loading screen owns the PREP act (the flavor-text
//     loading screen renders while only PREP_STAGES have run);
//   - the WorldGenStatusCard seeds its fixed bars from ENTITY_STAGES only (the
//     prep stretch lives in the loading screen, not the graph's status card).
const FIRST_ENTITY_STAGE: WorldGenStage = 'world_and_factions'
const ENTITY_BOUNDARY = WORLD_GEN_STAGES.indexOf(FIRST_ENTITY_STAGE)

/** The pre-entity prep stages (the loading-screen act): every canonical stage
 *  BEFORE the first `entity-added`-emitting stage. */
export const PREP_STAGES: readonly WorldGenStage[] = WORLD_GEN_STAGES.slice(0, ENTITY_BOUNDARY)

/** The entity-generation stages (the graph act): `world_and_factions` — the
 *  first stage that emits `entity-added` — and everything after it. */
export const ENTITY_STAGES: readonly WorldGenStage[] = WORLD_GEN_STAGES.slice(ENTITY_BOUNDARY)

// ---------------------------------------------------------------------------
// The WIKI-REVEAL boundary split (MYT-89 reveal timing).
//
// The player's visible wait ends the moment the connections are woven —
// `entity_relationships` completing IS the wiki-reveal moment (the route swaps
// the generating view for the world reveal there; the world-snapshot endpoint's
// 409 gate and derive-phase's `world_snapshot_ready` both key on this same
// stage). Everything after it (`entity_consolidation` → `embed_world`) is the
// SILENT TAIL: it keeps running behind the reveal while the player explores the
// wiki — nobody is watching a bar for it. Consolidated ghosts, the starting
// situations, and the coherence-pass reconciliation surface as QUIET wiki/graph
// updates, not as progress.
//
// NOTE this is a different boundary from the graph-entry beat above: the
// PREP/ENTITY split marks where entities START (the "watch your world be born"
// button); this split marks where the visible wait ENDS (the wiki reveal). All
// slices are DERIVED from WORLD_GEN_STAGES — a single source, reassembly-tested
// in worldgen-stages.test.ts, so a taxonomy reorder/addition can never drift
// either split.
//
// Consumers:
//   - the campaign-detail route transitions generating → reveal when the
//     boundary stage completes (client-core's `connectionsDone`);
//   - the WorldGenStatusCard seeds its fixed bars from WATCHED_ENTITY_STAGES —
//     the bars hit 100% exactly at the reveal moment (a card whose bars kept
//     counting the tail would vanish at ~62%);
//   - the reveal quietly refetches its wiki snapshot as TAIL_STAGES complete
//     (client-core's `completedTailStageCount`).
export const REVEAL_BOUNDARY_STAGE: WorldGenStage = 'entity_relationships'
const TAIL_BOUNDARY = WORLD_GEN_STAGES.indexOf(REVEAL_BOUNDARY_STAGE) + 1

/** The visible wait: every canonical stage the player actually waits through,
 *  ending at (and including) the reveal-boundary stage. */
export const WATCHED_STAGES: readonly WorldGenStage[] = WORLD_GEN_STAGES.slice(0, TAIL_BOUNDARY)

/** The status card's bar slice: the graph-act stages of the visible wait
 *  (ENTITY_STAGES ∩ WATCHED_STAGES — `world_and_factions` through the
 *  reveal-boundary stage). */
export const WATCHED_ENTITY_STAGES: readonly WorldGenStage[] =
  WATCHED_STAGES.slice(ENTITY_BOUNDARY)

/** The silent tail: the stages that run behind the wiki reveal while the
 *  player explores — their completions surface as quiet data refreshes. */
export const TAIL_STAGES: readonly WorldGenStage[] = WORLD_GEN_STAGES.slice(TAIL_BOUNDARY)
