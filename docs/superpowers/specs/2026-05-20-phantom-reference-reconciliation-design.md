# Phantom-Reference Reconciliation Design

**Beads:** `myth-tt2g` (entity_relationships hallucination), `myth-449j` (streamObject resilience), and the new entity_consolidation stage this spec introduces.

**Date:** 2026-05-20

**Status:** Design — pending user review.

## Problem

The entity_relationships stage (stage 4 of world-gen) crashes the worker process when the LLM emits structurally-invalid UUIDs in its output. The May 20 incident — campaign `019e4370-a908-7bde-9118-8a5e3c416d74`, "Skybound and Starving" — surfaced the failure mode in detail.

The proximate cause: the LLM emitted three syntactically-malformed UUIDs in the `hierarchy_stragglers` array (e.g., `019e4378-e4f8-0000-0000-000000000000`). Zod's `z.uuid()` rejected them inside the AI SDK's `streamObject` transform pipeline. The rejection escaped the handler's try/catch via the WebStreams' detached error path and surfaced as an unhandled promise rejection that killed the node process.

The deeper cause: the LLM was confabulating in response to a structural gap in the world data. The Bone Reach region's facts name-drop four hunting bands ("Ironjaw", "Long Vigil", "Ash-and-Salt", "Stoneback") but stage 2 only instantiated one of them as a faction entity. Stage 4 saw these phantom references in the prose, recognized that real entities ought to exist, and tried to fill the gap by inventing UUIDs in `hierarchy_stragglers` — the only schema slot that could plausibly carry "missing entity" semantics.

This pattern (prose mentions entities that no stage instantiates) is a *feature* of the early stages' generative breadth, not a bug. A world that mentions only its instantiated entities feels small and over-determined. The problem is downstream: stage 4 has no clean mechanism to express "this reference needs an entity," so the LLM either fabricates or fails.

## Goals

1. **No more whole-pipeline crashes from single-entity LLM failures.** Per-entity validation at the streaming layer: bad entries get dropped from the wire feed, the rest survive, end-of-stream repair stays as a safety net.

2. **First-class ghost entities.** Phantom references become real entities in the world — same depth as stage 2-3 entities (prose + facts + access_level + parent if applicable). No tier system. No "background" segregation.

3. **Bounded recursion.** Ghost entities are guaranteed-leaves of the entity graph. Their prose may reference only existing entities, vocabulary registry terms, or other ghosts declared in the same batch. Enforced by a Haiku post-audit, not regex (per ZFC).

4. **Best-effort failure handling.** If a specific ghost can't be created cleanly (audit keeps rejecting), drop just that ghost and the relationships referencing its placeholder; continue world-gen. World-gen completion is more important than 100% phantom resolution.

5. **Coherent wire UX.** Edges with placeholder endpoints buffer client-side; when the corresponding entity arrives during the consolidation stage, the buffered edges resolve and render. From the user's POV: most of the graph populates live during stage 4, then a handful of new entities pop in with their edges already attached at the end.

## Non-goals

- A "background" entity tier or segregated stub layer. Rejected — every entity is first-class.
- Suppressing phantom references upstream in stages 2-3. Phantom references are valid generative breadth; we reconcile rather than suppress.
- Replacing the existing repair chain in `ai.ts`. The chain stays as the end-of-stream safety net.
- Changing the BullMQ job shape or world-gen orchestration. Same `world-gen` queue, same stage loop, same retry semantics.
- Per-stage snapshot pushes. The wire feed during streaming is lightweight (names + types + endpoints); the full rich data lands in one snapshot at end-of-world-gen.

## Architecture

### 1. Stage architecture

A new stage `entity_consolidation` slots into `WORLD_GEN_STAGES` between `entity_relationships` and `starting_situation`. Updated stage list:

```ts
export const WORLD_GEN_STAGES = [
  'concept_intake',
  'vocabulary_intake',
  'world_and_factions',
  'locations_and_npcs',
  'entity_relationships',
  'entity_consolidation',  // NEW
  'starting_situation',
  'random_tables',
  'coherence_pass',
] as const
```

Stage handler lives at `backend/src/llm/prep/stages/entity-consolidation.ts`. It runs through the world-gen processor's existing stage loop: same `atomicClaimStage` claim semantics, same BEGIN/COMMIT per-stage transaction, same cost-cap accounting (spend rolls into the campaign's running total), same retry policy.

When the prior stage produces zero phantoms (the common case), stage 4b is a no-op early-return: claim the stage row, publish stage-started+completed, commit a zero-cost zero-token result, exit. The processor's stage loop runs it for consistency with the linear flow.

**`world_snapshot_ready` phase emit moves to fire after `entity_consolidation`.** The existing emit at `world-gen-processor.ts:240` (live emit) and `:200` (idempotent re-entry) is currently triggered after `entity_relationships` completes. With stage 4b inserted between stages 4 and 5, the post-stage-4 snapshot would be missing ghost entities + their relationships. The emit moves to fire after `entity_consolidation` completes (live + idempotent paths both update). Stages 6-8 see the post-4b inventory including ghosts; the snapshot view's "world is ready" signal aligns with the actually-complete entity graph.

### 2. Schema changes

One migration file with three changes:

**Migration: `017_entity_consolidation.sql`**

```sql
-- 1. Generic provenance column for entity creation source.
-- Stages 2-3 set 'stage:<stage_name>'; future Scribe creation
-- during play sessions sets 'session:<uuid>'. Existing rows are
-- stamped 'stage:legacy' via the DEFAULT clause on column add —
-- no separate UPDATE statement needed, Postgres applies the default
-- to all existing rows during ALTER.
ALTER TABLE entities
  ADD COLUMN created_in TEXT NOT NULL DEFAULT 'stage:legacy';

-- 2. Inter-stage handoff for entity_consolidation. Stage 4 writes the
-- pending phantom declarations + the relationships that referenced
-- them. Stage 4b reads, processes, then clears back to the populated-
-- shape default. Pattern mirrors worlds.starting_situation_entries
-- (one stage produces, a later stage consumes) including the CHECK
-- constraint shape from migrations 015/016.
ALTER TABLE worlds
  ADD COLUMN entity_consolidation_pending JSONB NOT NULL
    DEFAULT '{"declarations": [], "relationships": []}'::jsonb;

ALTER TABLE worlds
  ADD CONSTRAINT worlds_entity_consolidation_pending_shape
  CHECK (
    jsonb_typeof(entity_consolidation_pending) = 'object'
    AND jsonb_typeof(entity_consolidation_pending->'declarations') = 'array'
    AND jsonb_typeof(entity_consolidation_pending->'relationships') = 'array'
  );
```

Shape of `worlds.entity_consolidation_pending` when populated:

```json
{
  "declarations": [
    { "placeholderId": "new-001", "name": "The Ironjaw", "type": "faction" },
    { "placeholderId": "new-002", "name": "Ash-and-Salt", "type": "faction" }
  ],
  "relationships": [
    {
      "from": "new-001",
      "to": "<real-uuid>",
      "relationship": "opposed_to",
      "description": "..."
    }
  ]
}
```

**Zod schema changes (code-only, no migration):**

`backend/src/llm/schemas/entity-relationships.ts` (stage 4's schema) gains a `new_entity_declarations` field, and the `from` / `to` fields widen to accept either a real UUID or a placeholder ID:

```ts
const placeholderIdSchema = z.string().regex(/^new-\d{3}$/)

const endpointSchema = z.union([z.uuid(), placeholderIdSchema])

export const EntityRelationshipsSchema = z.object({
  relationships: z
    .array(
      z.object({
        from: endpointSchema,
        to: endpointSchema,
        relationship: z.enum(RELATIONSHIP_TYPES),
        description: z.string().min(10).max(600),
      }),
    )
    .min(5)
    .max(80),
  hierarchy_stragglers: z
    .array(
      z.object({
        parent_entity_id: endpointSchema,
        child_entity_id: endpointSchema,
      }),
    )
    .max(20),
  new_entity_declarations: z
    .array(
      z.object({
        placeholder_id: placeholderIdSchema,
        name: z.string().min(1).max(200),
        entity_type: z.enum(['faction', 'location', 'npc']),
      }),
    )
    .max(15),
})
```

New entity-consolidation schema at `backend/src/llm/schemas/entity-consolidation.ts`:

```ts
export const EntityConsolidationSchema = z.object({
  ghost_entities: z
    .array(
      z.object({
        placeholder_id: placeholderIdSchema,
        name: z.string().min(1).max(200),
        entity_type: z.enum(['faction', 'location', 'npc']),
        access_level: z.enum(['known', 'discoverable', 'secret']),
        parent_location_id: z.string().uuid().nullable(),
        prose: z.string().min(40).max(2400),
        facts: z.array(factSchema).min(2).max(12),
      }),
    )
    .max(15),
})
```

Haiku audit schema (deterministic check against allowed-names set):

```ts
export const GhostProseAuditSchema = z.object({
  proper_nouns: z
    .array(
      z.object({
        text: z.string().min(1).max(200),
        context_snippet: z.string().min(1).max(80),
      }),
    )
    .max(40),
})
```

### 3. Streaming-extractor rework

Three changes to `runStreamingStage` in `backend/src/llm/prep/streaming-extractor.ts`:

**Per-entity validation hooked into the existing array-path detection.**

The extractor already detects "new item appeared at this array path" (that's how `entity-added` / `edge-added` events get emitted today). Extend the `arrays` config to carry a sub-schema:

```ts
arrays: [
  {
    path: 'relationships',
    kind: 'edge',
    role: 'edge',
    sub_schema: relationshipItemSchema,
  },
  {
    path: 'new_entity_declarations',
    kind: 'entity',
    role: 'declaration',
    sub_schema: declarationItemSchema,
  },
]
```

**Validation timing**: an item at index N is Zod-validated when the array has grown to at least `N+2` elements (i.e., index N+1 has started streaming, which means N's closing `}` token has been observed by the SDK's partial-object parser). For the trailing item in each array, validation runs at end-of-stream. This convention relies on the Vercel AI SDK's `partialObjectStream` only adding an array element after its opening `{` is parsed, which means an element's appearance at N+1 reliably indicates N's structural completion. The implementer must NOT validate at the looser "any field beyond name/access_level is set" boundary the current extractor uses for emit gating; per-entity Zod validation is strictly post-close.

**Per-item schemas must be exported alongside the whole-tree schema.** Today's stage schemas (e.g., `EntityRelationshipsSchema`) declare inner item shapes inline. The streaming-extractor rework requires those inner shapes to be exported as named schemas (`relationshipItemSchema`, `worldFactionItemSchema`, `locationItemSchema`, `npcItemSchema`, `declarationItemSchema`, etc.) and the whole-tree schemas refactored to compose via `z.array(itemSchema)`. This prevents drift between the per-entity validator and the whole-tree validator.

When the extractor observes item N+1 starting in the array, item N is structurally complete. It runs Zod against item N's sub-schema:

- ✅ Valid → emit wire event (existing behavior).
- ❌ Invalid → log structured `pino.warn` (event: `llm.stream_item_dropped`) with the rejected partial JSON, Zod errors, stage, world_id, campaign_id, LLM call-site. Do NOT emit a wire event. Drop the item from accumulated survivor set.

The last item in each array gets validated at end-of-stream (no successor to trigger boundary detection).

**End-of-stream behavior keeps the repair chain.**

The full text response stays buffered through the entire stream. At end-of-stream:

1. Run full-tree Zod validation on the buffered text (same path `generateObject` uses).
2. If validation fails → run the existing Haiku→Sonnet repair chain on the full text.
3. If repair succeeds → use the repaired tree (it may include entities that were previously dropped at the per-entity layer; the SDK validation is the final authority).
4. If repair fails → throw `LlmStructuredOutputError`, stage handler propagates to the world-gen processor, retry happens at the BullMQ layer.

So safety properties: individual entity failures don't kill the stream (dropped from wire, accumulated in survivor set for the handler to decide), but catastrophic failures still hit the repair chain just like `generateObject`.

**Cross-validation for placeholder references.**

After the stream completes (success or repair), the stage handler runs a deterministic post-validation step on stage 4's output:

- Every placeholderId referenced in `relationships[].from`, `relationships[].to`, `hierarchy_stragglers[]` MUST have a corresponding entry in `new_entity_declarations[]`.
- Orphan references (placeholder used but never declared) are logged + dropped from the persisted set.
- Endpoints that look like real UUIDs but aren't in `entityIds` (hallucinated-but-syntactically-valid UUIDs — today's `partitionRelationships` failure mode) continue to be dropped + WARN-logged. Only `new-NNN`-shaped endpoints route to the pending-state path; the spec preserves the existing hallucinated-UUID drop behavior.

This is the structural fence that prevents the LLM from emitting placeholders into the void.

**Snapshot is canonical; wire feed is best-effort.** Per-entity drop semantics, combined with end-of-stream repair-chain reshaping, mean the wire feed during a stage can diverge from the persisted set in two cases: (a) repair recovers an entity that the per-entity layer dropped (no wire event fired but the entity persists), and (b) repair reshapes the tree to drop an entity the per-entity layer emitted (wire event fired but the entity isn't persisted). Both are resolved at end-of-world-gen by the snapshot push, which delivers the canonical persisted state and overwrites the client's locally-accumulated wire state. Mid-stream divergence is a transient acceptable cost; the snapshot is the reconciliation point. No mid-stream `entity-removed` events are emitted to compensate — the snapshot replacement handles it wholesale.

**Wire-protocol changes** (`backend/src/contract/pipeline-events.ts`):

```ts
// edge-added — from/to widen to accept placeholder strings.
// Existing fields preserved (synthKey unchanged, kept on the event for
// the post-commit `finalized` event's entityId reconciliation path).
type EdgeAdded = {
  type: 'edge-added'
  synthKey: string
  from: string                // UUID or `new-NNN`
  to: string                  // UUID or `new-NNN`
  relationship: string
  description?: string
}

// entity-added — preserves the existing { synthKey, entityKind, name }
// shape used by stages 2-3 + their dev-tool consumers. The optional
// placeholderId is the only new field; it's set ONLY by stage 4b ghost
// emissions and absent otherwise.
type EntityAdded = {
  type: 'entity-added'
  synthKey: string            // existing — keyed for finalized reconciliation
  entityKind: string          // existing — 'faction' / 'location' / 'npc'
  name: string                // existing
  placeholderId?: string      // NEW — present only for stage 4b ghosts
}
```

The `edge-added` widening (from/to accept placeholder strings) and the new optional `placeholderId` on `entity-added` are additive — existing consumers (`live-events-panel.ts`, `world-snapshot-panel.ts`, the panel tests) don't break. The earlier draft of this spec proposed renaming `synthKey`/`entityKind` to `id`/`entity_type` on `entity-added`; that's reverted to preserve the existing contract.

**synthKey convention for stage 4b ghost edges.** Stage 4 emits `edge-added` for placeholder-bearing edges with `synthKey: 'entity_relationships/relationships/${sourceIndex}'` (existing pattern). Stage 4b, when it persists each previously-stashed placeholder relationship, emits a `finalized { synthKey, entityId }` event carrying the SAME synthKey from stage 4's emit (NOT a new `entity_consolidation/...` synthKey). The frontend's `finalized` handler maps synthKey → real entity_id without ambiguity. Stage 4b ghost entities (`entity-added`) get fresh synthKeys under `entity_consolidation/ghosts/${i}` since they have no stage-4 antecedent.

**Telemetry:** every drop produces a structured `pino.warn` with sufficient context to triage (`partial_json`, `zod_errors`, `stage`, `call_site`, `world_id`, `campaign_id`). Greppable as `event:llm.stream_item_dropped`. Once myth-lmz6 (log persistence) lands, these become greppable from disk too; in the meantime they're terminal-scrollback-only.

**What this enables retroactively:** stages 2, 3, and 4 all become resilient to single-entity LLM failures. The MYT-53 streamObject hang shape and the entity_relationships UUID crash both reduce to "drop the bad entity, log a warning, continue." No more whole-pipeline kills.

### 4. Stage 4b handler

**File:** `backend/src/llm/prep/stages/entity-consolidation.ts`. Sibling to `entity-relationships.ts`, follows the same handler signature shape.

**Handler flow:**

```ts
export async function runEntityConsolidationStage(
  client: PoolClient,
  args: EntityConsolidationArgs,
): Promise<StageDispatchResult>
```

1. **Read pending state** from `worlds.entity_consolidation_pending`. If `declarations` is empty → skip path: publish stage-started + stage-completed, return zero-cost result. This is the common case.

2. **Idempotency wipe:**
   ```sql
   DELETE FROM entities
     WHERE world_id = $1 AND created_in = 'stage:entity_consolidation'
   ```
   Cascades to facts, prose_kernels, relationships referencing those entities. On retry, prior stage 4b output evaporates and we start fresh from the pending state.

3. **Assemble context.** Read current entity inventory (for allowed-names set), vocabulary registry, world summary, pending declarations + pending relationships.

4. **Generate ghosts via `generateObject` (Sonnet).** Schema is `EntityConsolidationSchema`. Output count should match `declarations.length`. The wire UX is provided by the worker emitting `entity-added` events per-ghost as it persists them (step 7), not by the LLM call streaming — generateObject is cleaner here because the Haiku audit needs the full response anyway.

5. **Reconcile output vs declarations.** Extras (ghost output for placeholderIds not declared) → drop. Missing (declared placeholderIds with no ghost output) → mark as failed-ghost, drop their relationships in step 8.

6. **Haiku audit per ghost.** For each surviving ghost, send `{prose, facts}` to Haiku with `GhostProseAuditSchema`. Then deterministic check: every extracted proper noun must be in the allowed-names set:

   - Existing entity names (from inventory)
   - Vocabulary registry terms (e.g., "Liftstone", "Sandlaw", "the Reckoning" — world-specific concepts)
   - Other ghosts being declared in this batch
   - This ghost's own name

   If a proper noun isn't in any of those → audit fails for this ghost.

   **Per-ghost retry policy:**
   - On first audit failure: retry once with a constrained Sonnet prompt that includes the previous output + the specific banned terms (*"Previous output mentioned 'X', 'Y', 'Z' which are not allowed. Rewrite without them."*). Re-run audit.
   - If second attempt also fails → drop this ghost. Log `event:llm.ghost_audit_failed` with the banned terms and the rejected prose.

7. **Persist surviving ghosts** in declaration order:
   - INSERT entities row with `created_in = 'stage:entity_consolidation'`.
   - INSERT prose_kernels row.
   - INSERT facts rows.
   - If `entity_type === 'location'` and `parent_location_id` is set → INSERT entity_hierarchy row.
   - Emit `entity-added { id, name, entity_type, placeholderId }` wire event.

8. **Persist pending relationships** with placeholder endpoints resolved. For each pending relationship:
   - Rewrite `from` / `to` placeholder IDs via the placeholder→UUID map built in step 7.
   - If either endpoint maps to a dropped ghost → drop this relationship from the persisted set. Log a warning.
   - Otherwise INSERT into relationships. Emit `edge-added` wire event.

9. **Clear state column:** `UPDATE worlds SET entity_consolidation_pending = '{}'::jsonb WHERE id = $1`.

10. **Return** `StageDispatchResult` with summed cost (main Sonnet call + N Haiku audits + any retry Sonnet calls), summed tokens, `finalizedEvents` for the surviving ghosts and relationships per the tier-gated post-commit pattern.

**Prompt structure** (`backend/src/llm/prompts/prep/entity-consolidation.txt`):

- World vocabulary registry block (so the model sees allowed concept-terms like "Liftstone").
- World summary (name, tone, themes, key tensions).
- Existing entity inventory: full UUID + name + type + brief description for each existing entity.
- Phantom declarations: the placeholder IDs + names + types stage 4 declared.
- Per-phantom relationship context: for each phantom, the list of relationships that referenced it (with quoted descriptions), so the LLM understands what role this entity plays in the world.
- Hard constraint, explicit: *"Your prose and facts for these new entities may reference, by name, only the entities listed in the existing inventory above OR the other ghost entities being declared in this response OR vocabulary registry terms. Any other proper noun introduces a dangling reference that will fail validation and cause the entity to be dropped."*
- Generation guidance: same tone and depth as stage 3 entities; ground the prose in the relationships that referenced this entity; do not narrate; concrete and specific.

### 5. Stage 4 prompt + handler changes

**Prompt template `backend/src/llm/prompts/prep/entity-relationships.txt`** gets a new instruction block:

> *"If a relationship requires an entity that doesn't appear in the inventory above — e.g., a faction the prose name-drops but that doesn't have a UUID — you may declare it as a phantom. Use a placeholder ID of the form `new-001`, `new-002`, etc. in the relationship's `from` or `to` field, and add an entry to `new_entity_declarations` with the placeholder ID, the entity's name, and its type. The placeholder will be resolved to a real entity in a subsequent stage."*

Plus a worked example so the model gets the shape right.

**Stage 4 handler** (`backend/src/llm/prep/stages/entity-relationships.ts`) gains a post-stream partitioning step. Today's partitioner drops relationships whose endpoints aren't in the entity inventory. New version routes them by endpoint type:

```ts
const { realRelationships, placeholderRelationships, validDeclarations } =
  partitionWithPlaceholders(validatedTree, entityIds)

// Persist only real-endpoint relationships during stage 4 transaction.
await relationships.insertMany(client, realRelationships)

// Stash phantom state for stage 4b.
await client.query(
  `UPDATE worlds SET entity_consolidation_pending = $1::jsonb WHERE id = $2`,
  [
    JSON.stringify({
      declarations: validDeclarations,
      relationships: placeholderRelationships,
    }),
    worldId,
  ],
)
```

The cross-validation post-check (placeholderIds used in relationships must have matching declarations) runs here. Orphan placeholders → log + drop from `placeholderRelationships` before persisting state.

**Stage 4 idempotency invariant**: stage 4's `UPDATE` always-overwrites the pending-state column (replaces the entire JSONB blob with the current run's declarations + placeholder relationships). On retry, even if the new LLM response produces a different placeholder set than the prior run, the column reflects the LATEST attempt's intent. Additionally, stage 4's existing `relationships.deleteByWorld` wipe at the top of the handler is extended to also delete any stage-4b-produced ghosts that may have persisted from a prior stage-4b run before the stage-4 retry fired:

```ts
// Existing — wipe stage 4 relationships output before re-running.
await relationships.deleteByWorld(client, worldId)

// NEW — stage 4 retry must also cascade-clear prior stage-4b ghosts
// (and their cascade-children: facts, prose_kernels, relationships).
// Otherwise a stage-4 retry leaves orphan ghosts whose declarations
// the new stage-4 attempt may not match.
await client.query(
  `DELETE FROM entities WHERE world_id = $1 AND created_in = 'stage:entity_consolidation'`,
  [worldId],
)
```

This makes stage 4 + stage 4b a single retry unit from the durability standpoint.

### 6. Frontend renderer changes

**Dev-tool renderer** (`backend/dev-tool/src/...`) gains a placeholder-buffer reconciliation layer. Pseudocode:

```ts
const placeholderBuffer = new Map<string, EdgeAdded[]>()

on edgeAdded(e):
  const placeholderId =
    e.from.startsWith('new-') ? e.from :
    e.to.startsWith('new-') ? e.to : null

  if (placeholderId !== null):
    if (!placeholderBuffer.has(placeholderId)):
      placeholderBuffer.set(placeholderId, [])
    placeholderBuffer.get(placeholderId).push(e)
    // do NOT render yet
  else:
    renderEdge(e)

on entityAdded(e):
  renderEntity(e)
  if (e.placeholderId):
    const buffered = placeholderBuffer.get(e.placeholderId) ?? []
    for (const edge of buffered):
      patchPlaceholderEndpoint(edge, e.placeholderId, e.id)
      renderEdge(edge)
    placeholderBuffer.delete(e.placeholderId)
```

End-of-world-gen snapshot push reconciles any remaining buffered edges (in practice, only ones whose ghost failed audit — those edges silently disappear when the canonical snapshot replaces local state, since the dropped ghost + its relationships aren't in the persisted set).

### 7. What doesn't change

- World-gen stage loop orchestration. Same `atomicClaimStage` + BEGIN/COMMIT per stage.
- Cost-cap accounting. Stage 4b spend rolls into the same running total; no new cap dimension.
- BullMQ job shape. Same `world-gen` queue, same retry semantics, same job payload.
- The Vercel AI SDK integration. Per-entity validation lives INSIDE `runStreamingStage`; the SDK's `streamObject` / `await stream.object` API stays as-is. The repair chain in the wrapper is unchanged.
- Stages 6-8 (`starting_situation`, `random_tables`, `coherence_pass`). They see the post-4b entity inventory which includes the ghosts; from their POV nothing distinguishes a ghost from a stage-2/3 entity except the `created_in` column they don't read.

## Testing strategy

Three layers — deterministic at the bottom, probabilistic-but-real at the top. The smoke is the gate per `feedback_dev_tool_e2e_smoke_required`. Typecheck + lint + mocked unit tests don't count toward acceptance.

### Layer 1: Deterministic unit/integration tests (`pnpm test`)

All new and extended test files run as part of the standard `pnpm test` suite. Mocked LLM via `vi.mock('../../ai.js')`. Exercise every branch.

- **`entity-relationships.test.ts` (existing, extended)** — placeholder routing scenarios:
  - LLM returns relationships with all real UUIDs → all persist, pending state is `{}`.
  - LLM returns relationships with some placeholder endpoints + matching declarations → real-endpoint relationships persist, placeholder ones land in pending state.
  - LLM returns orphan placeholder reference (used in relationship, not declared) → dropped + warning logged.
  - LLM returns extras in declarations (placeholderId declared but never referenced) → declarations preserved, no issue.

- **`entity-consolidation.test.ts` (new)** — handler unit tests with mocked Sonnet + mocked Haiku:
  - Empty pending state → skip path: zero-cost stage row, no ghosts created.
  - Happy path → ghosts persisted with `created_in='stage:entity_consolidation'`, pending relationships resolved + persisted, state column cleared, `entity-added` events emitted with `placeholderId`.
  - Audit-fails-once-then-passes → retry path; second Sonnet call uses constrained prompt; final ghost persists.
  - Audit-fails-twice → drop path; ghost not persisted; relationships referencing its placeholder dropped from persisted set; pino warning emitted.
  - Idempotency → second run after partial first run wipes prior `'stage:entity_consolidation'` entities + cascades, recreates.

- **`streaming-extractor.test.ts` (existing, extended)** — per-entity drop tests with mocked partial-object-stream:
  - One entity fails sub-schema mid-stream → no wire event emitted for it; rest of stream completes; survivors persist.
  - End-of-stream full-tree validation runs; repair chain fires on catastrophic failure.
  - Multiple entities pass + one fails → mixed wire output; structured pino warning includes rejected JSON.

### Layer 2: Real-LLM smoke test (`pnpm smoke:phantom-reconciliation`)

A scripted test in `backend/scripts/smoke/phantom-reconciliation.ts` that drives a fresh world creation against a running backend + real Anthropic API. Run manually (NOT in `pnpm test`, NOT in CI). ~5-10 minutes per run. Behind a flag.

The test:
1. POSTs to `/api/campaigns` with a world concept biased toward phantom production — specifically the "Skybound and Starving" shape (floating-city-vs-desert with a named supporting cast) that's known to name-drop factions stage 2 won't instantiate. Concept text captured as a fixture in the smoke script.
2. Tails the SSE stream at the pipeline-events channel; accumulates the full event log to `tmp/smoke/<run-id>/events.jsonl`.
3. Polls `GET /api/campaigns/<id>` every 5s until `world.status` reaches `complete` or `failed`.
4. After completion, runs DB queries via psql and asserts the full final state.

**LLM-variability-tolerant assertions:**

- `world.status === 'complete'` (NOT `failed`).
- `pipeline_runs` has rows for all 9 stages including `entity_consolidation`, all with `status='completed'`.
- `entities` count ≥ 30 (loose floor for LLM variability).
- ≥1 entity has `created_in='stage:world_and_factions'`.
- ≥1 entity has `created_in='stage:locations_and_npcs'`.
- **If phantoms were produced** (event log contains any edge-added with placeholder endpoint): ≥1 entity has `created_in='stage:entity_consolidation'`. Otherwise: stage 4b completed cleanly with zero ghosts and no error.
- ≥N `entity-added` events in the event log (where N = entity count for stages 2/3 — this is the myth-uqhy verification: entities are visible on the wire).
- Wire-protocol verification: every edge-added with a placeholder endpoint is followed within the same world-gen run by an entity-added carrying that placeholderId. No dangling placeholders.
- Snapshot endpoint response matches DB state at world completion.

**Retry budget with explicit gate assertion** (replaces the prior probabilistic acceptance). The smoke runs up to 3 times in sequence; it FAILS unless at least one of the 3 runs exercises the phantom path (i.e., at least one run has ≥1 `edge-added` event with a placeholder endpoint and ≥1 entity with `created_in='stage:entity_consolidation'`). All 3 runs must complete world-gen successfully; the retry budget is solely about ensuring the phantom code path gets exercised by the gate.

If the LLM stubbornly refuses to produce phantoms across all 3 runs (very unlikely with the Skybound-and-Starving concept shape), the smoke fails with a clear message: "phantom path not exercised after 3 attempts; increase retry budget or use a more phantom-prone concept." This makes the gate testable rather than hand-wavy.

As a future-work option (not in scope for this spec), a deterministic-stub-injection mode could force stage 4 to emit known placeholder declarations regardless of LLM output — useful for CI / hermetic-smoke environments where the real LLM is unavailable. Filed as a follow-up bead if needed.

### Layer 3: Manual dev-tool E2E

The user-facing acceptance gate after smoke passes. Non-skippable per `feedback_manual_smoke_is_not_optional`.

1. `pnpm dev` (backend) + `pnpm dev-tool` (frontend dev tool).
2. Create a campaign via the dev tool's create panel using a phantom-prone concept (e.g., the Skybound and Starving shape).
3. Watch the live event feed:
   - Entities populate the graph as stages 2/3 run.
   - During stage 4: edges appear with placeholder endpoints (buffered, not rendered yet).
   - During stage 4b: ghost entities pop in, and their connected buffered edges resolve and render simultaneously.
4. Inspect the entity browser — verify the mix of entities, including ghosts.
5. Open a ghost entity's detail — verify it has prose + facts that read alive but only reference existing entities.
6. World completes; world-snapshot panel shows the final structure.

### Acceptance criteria

The beads (`myth-tt2g`, `myth-449j`, and the new entity_consolidation work) are done when:

1. Layer 1 tests pass: all new + extended test files green; `pnpm test` clean.
2. Layer 2 smoke passes at least once: a real-LLM world-gen completes with at minimum the structural assertions met; ideally also exercises the phantom path.
3. Layer 3 manual run confirms the wire UX feels right (entities pop in coherently, ghosts mix with regular entities, no visual glitches from placeholder buffering).
4. The myth-uqhy streaming bug is verifiably fixed — `entity-added` events ARE visible during the manual dev-tool run.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Phantom-prone concept doesn't produce phantoms in a given smoke run. | Accept probabilistic nature; assertions handle the no-phantom path cleanly (stage 4b completes with zero ghosts). Run smoke 2-3 times in practice. |
| Haiku audit produces false-positives (flags legitimate vocabulary registry terms as new references). | The allowed-names set includes vocabulary registry terms explicitly. If false-positives surface during testing, tighten the prompt's "what counts as a new reference" definition or expand the allowed set. |
| Ghost prose ends up sounding generic / encyclopedia-shaped despite the prompt asking for full depth. | The prompt explicitly directs same-depth-as-stage-3. Manual review during Layer 3 catches generic-sounding ghosts; if it's a systemic problem, the prompt iterates. Eval-shaped concern; not a smoke gate. |
| Per-entity Zod validation timing (when is an item "complete"?) creates edge cases. | Use the same boundary detection the streaming-extractor already uses for emitting entity-added events: item N is complete when item N+1 starts (or stream ends). No new timing semantics introduced. |
| Frontend placeholder buffer leaks if a ghost is silently dropped. | Buffer is per-world-gen-run, scoped to a single dev-tool session. End-of-world-gen snapshot replaces all local state; any dangling buffered edges get garbage-collected on the swap. |
| Worker retry-after-crash leaves the pending state stale (stage 4 wrote it, stage 4b hadn't read it yet). | The pending state column is durable across retries by design (lives on worlds row). Stage 4b's idempotency wipe handles partial-prior-attempt state cleanly. |

## Out of scope (future work)

- **Phantom detection for stages 2-3 prose** — could surface mid-generation rather than after stage 4 sees them. Earlier detection might let stage 2 instantiate the phantom directly rather than deferring to stage 4b. Not pursued now; current shape is good enough.
- **Per-prompt eval harness for phantom-prone concepts.** Would let us measure "what % of world concepts produce phantoms, and how many per world." Useful for capacity planning + cost projections. Separate spec.
- **Smarter idempotency** — match-by-name across retries instead of wipe-and-recreate. Avoided here because LLM output is non-deterministic and name-matching is fragile.

## Source — files touched

Backend:
- `backend/migrations/017_entity_consolidation.sql` (new)
- `backend/src/llm/prep/stages/entity-consolidation.ts` (new)
- `backend/src/llm/prep/stages/__tests__/entity-consolidation.test.ts` (new)
- `backend/src/llm/schemas/entity-consolidation.ts` (new)
- `backend/src/llm/prompts/prep/entity-consolidation.txt` (new)
- `backend/src/llm/prep/streaming-extractor.ts` (extended — per-entity validation)
- `backend/src/llm/prep/__tests__/streaming-extractor.test.ts` (extended — per-entity drop tests)
- `backend/src/llm/schemas/entity-relationships.ts` (extended — new_entity_declarations + widened endpoints)
- `backend/src/llm/prep/stages/entity-relationships.ts` (extended — partition-with-placeholders + pending-state write)
- `backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts` (extended — placeholder routing tests)
- `backend/src/llm/prompts/prep/entity-relationships.txt` (extended — placeholder mechanism instructions)
- `backend/src/llm/prep/world-gen-processor.ts` (extended — add entity_consolidation to stage loop dispatch)
- `backend/src/llm/prep/__tests__/world-gen-processor.test.ts` (extended — stage 4b dispatch test)
- `backend/src/contract/pipeline-events.ts` (extended — placeholderId field)
- `backend/src/repo/entities.ts` (extended — created_in column)
- `backend/scripts/smoke/phantom-reconciliation.ts` (new)

Frontend:
- `backend/dev-tool/src/...` (extended — placeholder-buffer reconciliation in the renderer)

Package scripts:
- `backend/package.json` (add `smoke:phantom-reconciliation` script)

Docs:
- `docs/wiki/content/runtime/world-gen.html` (update — new stage in pipeline diagram + narrative)
- `docs/wiki/content/runtime/character-creation.html` (review — should be unaffected, but confirm)
