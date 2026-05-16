# myth-exac: Narrow streaming + access-tier-aware world snapshot

## Lead

Today's prep pipeline streams full entity and edge snapshots over SSE as the LLM emits them, including descriptions, prose, and any other fields the model has typed. Two symptoms result: (a) the dev tool's live-events panel shows duplicate `edge-added` lines because every progressive field update re-emits the event — edges have no `edge-updated` arm, so the extractor re-fires `edge-added` with the latest snapshot; (b) wire payloads carry data the live graph doesn't render, bloating the streaming hot path. A deeper gap also exists: the world model classifies facts by `access_level`, but no read path currently filters by that classification, so the enforced-ignorance principle (a non-negotiable in `CLAUDE.md`) isn't yet materialized at the API surface.

This design bundles five moves: (1) narrows the streaming event contract for stages 2-4 to identity-only fields, and changes the emit gate from "name plus one other field" to "the entire entity object has finished streaming," so the access_level is in hand at emit time; (2) reworks the three-tier access classification on facts and extends it to entities, with the rename `public → known`, `private → discoverable`, `secret unchanged`, grounded in D&D-mechanic semantics (no-roll / roll-required / actively-hidden); (3) adds a `GET /api/campaigns/:campaignId/world-snapshot` endpoint that returns the known-tier slice of the world for a dev-tool wiki inspector panel; (4) gates snapshot availability on a new `world_snapshot_ready` pipeline phase fired when stage 4 (entity_relationships) completes, with stage-7 (coherence pass) deltas flowing on the existing SSE channel after the snapshot ships, filtered to the known-tier surface the client actually has; (5) adds a dev-mode opt-in tier-filter bypass — a per-create toggle (default OFF) on the dev-tool campaign-create panel that surfaces all tiers (including secrets) for that world to dev-mode requesters, for inspection and tier-correctness verification.

The same delta transport pattern is reusable for future Scribe-driven mid-session updates. Future per-character visibility overrides (different characters seeing different tiers of the same fact) are out of scope here, tracked in bead `myth-8iid`.

## Access tier classification

### Three tiers

The `access_level` enum is reclassified to three D&D-grounded tiers:

- **`known`** — Common knowledge to anyone in the world or in the relevant locality. The kind of thing a DM tells players for free, no roll required. The name of a famous city, the role of a notable public figure, the location of a well-known tavern, the broad strokes of regional history.
- **`discoverable`** — Findable through normal investigation but not advertised. Requires a successful skill check (history, investigation, persuasion), a conversation with the right person, or time spent in a location. Not actively concealed — no one is keeping these secret — they just aren't common knowledge. An ancient king's name found via history, a dive bar's location learned from a local, a magistrate whose office you'd have to visit to find.
- **`secret`** — Load-bearing plot reveals, actively concealed by those who know them. Discovery drives the narrative forward in a meaningful direction. A church's real identity as a cult, a magistrate's embezzlement, a faction's hidden hand behind public events.

The tier classification applies to both **facts** (existing column, enum rewrite) and **entities** (new column added).

### Why this applies to entities too

A tavern might be in the `discoverable` tier — it exists in the world, but the player won't see it in the initial wiki because they wouldn't know about it without asking around. An NPC might be `secret` — pulled from public view until the plot reveals their existence. The wiki snapshot at world-ready time should show the player only what their character would plausibly know going in: the `known` slice. Discovery is the play loop.

The world-gen LLM assigns the tier to each entity it generates, mirroring how it currently tags facts. The "mix tiers deliberately" instruction in today's prompts extends to entities — every world should have a mix of `known` entities (the visible world) and `discoverable`/`secret` entities (the world's depth).

### Future extension: per-character overrides

Today's tier model is **world-default** — all players in a campaign see the same tier per fact/entity. A future extension (bead `myth-8iid`) layers per-character overrides for cases like "character X is a local and knows secrets character Y doesn't" or "character Z's investigation revealed a discoverable fact, but the other party members haven't been told yet." The extension path: new tables `fact_character_visibility (fact_id, character_id, access_level)` and `entity_character_visibility (entity_id, character_id, access_level)`, with read-path resolution via `COALESCE(per_character_override.access_level, default.access_level)`. The `facts.access_level` and `entities.access_level` columns shipped in myth-exac are the default basis; no migration on them is required when the override tables land.

A related deferred concern: post-character-creation, a pass may flip a character-specific subset of entities/facts to `known` based on the character's background, origin, profession. That pass isn't designed yet; same future bead can cover it.

## Lifecycle

A new `PipelinePhase` arm `world_snapshot_ready` is inserted between `world_gen` and `world_ready` in `backend/src/contract/pipeline-events.ts`. The world-gen processor emits `phase: world_snapshot_ready` immediately after the stage-4 (entity_relationships) commit. Stages 5 (starting situation), 6 (random tables), and 7 (coherence pass) run with the phase still at `world_snapshot_ready`. On stage-7 completion, the phase flips to `world_ready` — preserving today's semantic of "all stages done, world canonical, ready to proceed."

```
phase transitions:
  not_started → world_gen → world_snapshot_ready → world_ready → character_creation → ...
                                ^                        ^
                            stage 4 done             stage 7 done
                            (snapshot fetchable)     (coherence deltas applied)
```

The `worlds.status` column does not get a new value. `phase` is the wire contract; `status` continues with its existing arms. The snapshot endpoint computes readiness by looking at the latest `pipeline_runs` row for stage `entity_relationships`: if `status='completed'`, the world is past the snapshot-ready gate.

**`derivePhase` update**: `backend/src/sse/derive-phase.ts` derives the phase for the SSE initial-snapshot frame from `worlds.status` + `pipeline_runs`. It must be extended to return `world_snapshot_ready` when the `entity_relationships` run is `completed` AND `worlds.status` is still `generating`. Without this update, a client that subscribes mid-window (after stage 4 completes, before stage 7 finishes) receives an initial snapshot reporting `phase: world_gen` and never observes the live `world_snapshot_ready` event (Redis pub/sub doesn't persist) — the inspector panel stays in `idle`/`loading` forever. The lifecycle phase emission at stage-4 commit is also re-fired on idempotent re-runs (a BullMQ retry that re-enters the stage loop and sees stage-4 already `completed`) — so a reconnecting client whose phase fetch happens before the worker re-fires gets the correct phase from `derivePhase`.

## Streaming events (stages 2-4)

### Closed-entry emit gate

`backend/src/llm/prep/streaming-extractor.ts` currently emits an event the moment an array entry crosses the "isEmittable" predicate (name present + at least one other field). The result is partial-state emissions during progressive field arrival — the duplicate `edge-added` symptom that motivated this design.

The new gate emits only when an array entry is **structurally complete** — the LLM has finished writing it. Detection mechanism has two parts:

1. **Non-last entries**: an entry at index `i` is closed when `partial.array.length > i + 1`. By JSON parser linear-scan semantics, the parser must have consumed entry `i`'s closing `}` before opening entry `i+1`. The extractor processes closed entries by looping `[lastEmittedIndex, partial.array.length - 1)` on every partial (not just checking the next index) — between two adjacent emitted SDK partials, the array length may jump by more than 1 if the LLM emitted multiple short entries within one accumulation/dedup window.

2. **Last-entry post-loop pass**: after the `for await` loop exits (stream complete), the extractor runs a final pass over each tracked array's trailing entry (`array[array.length - 1]`). The trailing entry of each array would otherwise never observe an `i+1` opening — and without this pass, the last entity/edge of every stage is silently dropped from the live stream. The pass applies the same emit gate as in-loop processing.

To make the gate's closure point coincide with `access_level` being present, the LLM Zod schemas pin `access_level` as the **second** field in every entity object (immediately after `name`), and the prompts add a corresponding instruction. The "field order in Zod" → "field order the model emits" mapping is the AI SDK's standard behavior. With `access_level` second, by the time a closure observation fires (`i+1` opens), the parser has guaranteed-consumed `name` and `access_level` for entry `i`, and the access-level filter can decide emit-or-skip deterministically.

Once an entry is closed and the access-level filter is applied, its identity-only payload is emitted (or silently dropped). The extractor's emit-once guarantee is enforced via `emitted: Set<synthKey>` — the helper asserts `!emitted.has(synthKey)` before publishing, failing loudly if a re-emit attempt ever leaks in from a future change.

In-memory state: today's `emittedSnapshots: Map<synthKey, snapshot>` becomes `emitted: Set<synthKey>`. The `diffPatch` helper, the prior-snapshot tracking, and the progressive-update branch are deleted.

**Validation timing**: if a closed entry lacks `access_level` or carries an invalid value, the extractor logs a warning and skips the emit (entry is treated as not-`known`). The Zod schema marks `access_level` as required (no `.optional()`, no `.default()`) so stage-end validation fails the stage on missing/invalid field — failures stay at the proper layer (Zod, not streaming-extractor).

### Tier-aware emission

After a closed entry passes structural completeness, the extractor checks `access_level`:

- `access_level === 'known'` → emit `entity-added` (or `edge-added` for stage 4) to the SSE channel.
- `access_level === 'discoverable'` or `'secret'` → no SSE event. Entry still gets persisted by the stage handler (downstream consumers — FT context-build, future Scribe — will read from the DB).

For **edges** in stage 4, the endpoint pair must both be `known`-tier for the edge to emit:

- Stage 4's existing inventory query (`entities.listByWorld` in `entity-relationships.ts:226`) already loads the world's entities. With migration 014, the inventory rows carry `access_level`. The stage handler builds a `Map<entityId, AccessLevel>` (UUID-keyed — stage 4's relationships reference entities by UUID per design §D9, not by name) and passes it to the streaming-extractor in the stage args.
- The streaming-extractor consults the map at closed-edge time. If either `from` or `to` is missing from the map (impossible if the inventory is consistent) or maps to a non-`known` tier, the edge is persisted silently.
- This prevents the live graph from accidentally hinting at a `discoverable` or `secret` entity via an incoming relationship.

**`finalized` event tier filter**: today, `runStage` unconditionally publishes every persisted entity's `finalized { synthKey, entityId }` event post-COMMIT (`world-gen-processor.ts` finalized-events loop). After this design, the persister's `finalizedEvents` array is built only for entities the streaming-extractor emitted (i.e., `known`-tier — or any-tier under bypass). Without this filter, the client receives `finalized` events for synthKeys it never received `entity-added` for; the inspector panel's synthKey→entityId map then contains orphan entries and downstream patch-application code paths reference unknown nodes. The filter mirrors the streaming-extractor's emit gate exactly, applied at the persister's finalize-events construction site in each stage handler.

**Bypass interaction**: when the world's `dev_bypass_access_filter` flag is true (see "Dev-mode access tier bypass" section below), the tier check is short-circuited at the streaming-extractor emit gate, at the edge-endpoint check, AND at the `finalized` events filter. Every closed entry/edge emits regardless of `access_level`. The wire payload stays identity-only — bypass changes *what* gets emitted, not what's in each payload.

### Wire payload (still narrow)

Even though the gate now waits for the full entity, the wire payload stays identity-only. The point of waiting is to know `access_level` deterministically, not to ship more data.

```ts
// Before
| { type: 'entity-added'; synthKey: string; entityKind: string; data: Record<string, unknown> }
| { type: 'edge-added'; synthKey: string; from: string; to: string; relationship: string; description?: string }

// After
| { type: 'entity-added'; synthKey: string; entityKind: string; name: string }
| { type: 'edge-added'; synthKey: string; from: string; to: string; relationship: string }
```

Unchanged arms: `phase`, `stage-started`, `stage-completed`, `stage-failed`, `cost-update`, `job-failed`, `stage-reset`, `entity-updated`, `entity-removed`, `edge-removed`, `finalized`.

`entity-updated` remains in the contract. Its only emit site after this change is `coherence-pass.ts` (for name and prose patches). Streaming-extractor no longer fires it. Wire shape `{ synthKey, patch }` preserved.

## Schema changes

### Migration 014: tier rename + entity tier column + dev-mode bypass flag

```sql
-- 014_access_tier_rework.sql
-- Drop and re-add the facts.access_level CHECK constraint with the new
-- three-tier vocabulary, then backfill existing rows.

ALTER TABLE facts DROP CONSTRAINT facts_access_level_check;

UPDATE facts SET access_level = 'known' WHERE access_level = 'public';
UPDATE facts SET access_level = 'discoverable' WHERE access_level = 'private';
-- 'secret' is unchanged

ALTER TABLE facts ADD CONSTRAINT facts_access_level_check
  CHECK (access_level IN ('known', 'discoverable', 'secret'));

-- New column on entities, default 'known' so any existing rows (none in
-- production yet, but defensive) are treated as visible by default.
ALTER TABLE entities ADD COLUMN access_level TEXT NOT NULL DEFAULT 'known'
  CHECK (access_level IN ('known', 'discoverable', 'secret'));

CREATE INDEX idx_entities_world_access ON entities(world_id, access_level);

-- Dev-mode tier-filter bypass flag (see "Dev-mode access tier bypass"
-- section). Defaults false; production code paths never set this.
ALTER TABLE worlds ADD COLUMN dev_bypass_access_filter BOOLEAN NOT NULL DEFAULT false;
```

The existing `idx_facts_entity_access_status` already covers the facts filter — no new index needed there.

### LLM Zod schemas

All entity-level `access_level` additions are **required fields, no `.optional()`, no `.default()`** — Zod failure at stage-end is the correct rejection layer for missing/invalid values (the streaming-extractor's "skip emit on missing access_level" is a defense-in-depth log, not the authoritative gate).

Field positioning matters: AI SDK's `generateObject` / `streamObject` forwards the schema's JSON-Schema representation to the model, and the model emits fields in roughly schema-declared order. Place `access_level` **second** in every entity object (immediately after `name`). This co-locates with the closed-entry detection invariant (see Streaming events section): by the time the parser observes index `i+1` opening, entry `i`'s `name` and `access_level` are guaranteed present, regardless of how long the trailing `prose`/`facts` fields stream.

`backend/src/llm/schemas/world-and-factions.ts`:

- Fact schema: bump `access_level: z.enum(['known', 'discoverable', 'secret'])`.
- Region schema: insert `access_level: z.enum(['known', 'discoverable', 'secret'])` as the second field (after `name`, before `prose`/`facts`).
- Faction schema: same.

`backend/src/llm/schemas/locations-and-npcs.ts`:

- Same: bump the fact enum; insert entity-level `access_level` as the second field in location and NPC schemas.

`backend/src/llm/schemas/entity-relationships.ts`: relationships don't get an access_level. Their visibility is derived from the endpoint pair (see edge emit gate above).

### Persistence path (load-bearing — easy to miss)

The Zod schema additions alone do not write `access_level` to the DB. Three sites must be updated in lockstep with the schemas to thread the field from LLM output → row:

- `backend/src/repo/entities.ts`: `InsertEntityInput` gains `accessLevel: AccessLevel`. `entities.insert` writes the new `access_level` column.
- `backend/src/llm/prep/stages/world-and-factions.ts`: the `persistEntities` callsite for regions and factions reads `access_level` from each LLM-emitted entry and threads it through to `entities.insert`.
- `backend/src/llm/prep/stages/locations-and-npcs.ts`: same for locations and NPCs.

Without these three changes, the migration's `DEFAULT 'known'` becomes the persisted value for every entity regardless of what the LLM emitted, and the entire tier-filter machinery is structurally bypassed at the persistence layer — every player snapshot would return secret-tier content as known. The Zod schema marks `access_level` as required, but a schema-validated value that isn't written to the DB is just discarded validation work.

### Prompt updates

`backend/src/llm/prompts/prep/world-and-factions.txt`:

- Rewrite the fact access_level definition block (currently lines ~48-50) with the three-tier semantic above.
- Add an analogous entity-level block: "Each region and faction has an `access_level` of `known`, `discoverable`, or `secret`. `known` regions and factions are the visible world — common knowledge, the kind of thing players are told for free. `discoverable` entities exist in the world but aren't advertised — a hidden grove, a faction operating quietly, found through investigation or asking around. `secret` entities are concealed — a cult faction pulling strings, a lost city — revealed by plot."
- Extend the "mix tiers deliberately" instruction (currently line 54) to entities: "Mix entity access levels too. Most regions should be `known`. At least one region or faction per world should be `discoverable` (a place players uncover through play) and at least one should be `secret` (a load-bearing reveal). Don't over-stuff the visible world with secrets; depth comes from a few well-placed hidden things, not from making everything mysterious."
- Add a field-order constraint matching the new schema shape: "Within every region and faction object, emit `name` FIRST and `access_level` SECOND, before any other field. This is a streaming-correctness requirement, not a stylistic one."
- Add the **prose-tier consistency** constraint (the inverse of "mix tiers deliberately"): "Do not reveal `discoverable`-tier or `secret`-tier entities, facts, or plot reveals inside `known`-tier prose fields or fact `content`. The prose of a `known` region/faction is the public-knowledge view of that thing — what anyone in the world casually knows. If a `secret` truth about the region exists, it belongs in a `secret`-tier fact on that region, NOT woven into the region's prose. Treat each tier as a separate 'what-can-be-said-here' boundary."

`backend/src/llm/prompts/prep/locations-and-npcs.txt`:

- Same rewrite for the fact access_level definition block (currently line ~62).
- Add an analogous entity-level block for locations and NPCs.
- Mix-tiers instruction extends to locations and NPCs.
- Same field-order constraint (`name` first, `access_level` second).
- Same prose-tier consistency constraint.
- Add a cross-stage awareness note: "Stage 2 (world_and_factions) already classified regions and factions before you. Your locations and NPCs should COMPLEMENT that classification — if stage 2 placed a `secret` cult faction in a region, your locations under that region should mix tiers; don't classify every location in a 'secret-rich' region as `secret` itself. Aim for a coherent overall world distribution, not a per-stage repeat of the floor."

## Snapshot endpoint

### Route

`GET /api/campaigns/:campaignId/world-snapshot`

**Naming note**: a prototype-era `world_snapshots` table already exists (`migrations/001_initial_schema.sql:312`) carrying labeled save-game artifacts (`id, campaign_id, label, data TEXT`). To avoid grep collisions and conceptual confusion, the new runtime view's repo file is `backend/src/repo/world-snapshot-view.ts` (not `world-snapshot.ts`), and its in-code symbol is `worldSnapshotView` (not `worldSnapshot`). The HTTP route name uses the hyphenated `world-snapshot` form which is distinct enough from the snake_cased `world_snapshots` table reference.

- **Auth**: `requireCampaignMember(repo, 'owner')`. The campaign owner fetches snapshots for the campaigns they own.
- **Tier filter**: applied to the response payload independent of who the viewer is. Even the owner sees only the `known`-tier slice — the snapshot is for player exploration, and the owner is a player. Per-character overrides (future bead `myth-8iid`) would refine this.
- **Bypass interaction**: when `world.dev_bypass_access_filter === true` AND the requesting user is in bypass auth mode, the tier filter is short-circuited and the endpoint returns unfiltered content (all entities, all facts including secrets, all relationships, all hierarchy, all prose kernels). Detection of "requester in bypass auth mode" uses `request.user.scopes.includes('bypass')` (the bypass plugin attaches `scopes: ['bypass']` at `backend/src/auth/bypass-plugin.ts:22`). The `AuthUser` type has no `authMode` field — do not introduce one. See "Dev-mode access tier bypass" section.
- **Pipeline route**: `config: { pipelineRoute: true }`. Registered in `backend/src/contract/pipeline-routes.ts` so the onReady reverse-check passes.
- **Rate limit**: 30/min per-IP (matches `/api/campaigns/mine`). Endpoint is fetch-once-per-session in normal use.
- **Pre-readiness**: returns `409 { code: 'snapshot_not_ready' }` when the latest `entity_relationships` pipeline_run for the world is anything other than `completed`. 200 otherwise.

### Response shape

```ts
{
  world: WorldSummary,                   // see column allowlist below — NOT the full worlds row
  entities: EntityRow[],                 // entities WHERE access_level = 'known'
  facts: FactRow[],                      // facts of those entities WHERE access_level = 'known'
                                         //   (no narrative_status filter — see note below)
  relationships: RelationshipRow[],      // relationships where both endpoints are in the known set
  proseKernels: ProseKernelRow[],        // kernels for known entities only (1:1 with entity)
  entityHierarchy: EntityHierarchyRow[], // hierarchy rows where both parent and child are in the known set
  statBlocks: StatBlockRow[]             // referenced by entity.stat_block_id for entities in the known set
}
```

**`WorldSummary` column allowlist (load-bearing).** The `worlds` table carries plot-bearing freeform-prose columns generated by stages 1 and 5 (`key_tensions`, `political_summary`, `starting_situations`, `follow_up_questions`, and possibly `geography_summary` depending on how stage 1 populates it) that must NOT surface in the player wiki — they're the latent narrative substrate of the play loop. The endpoint returns a curated projection:

```ts
type WorldSummary = {
  id: string
  name: string
  concept: string         // the original concept string the user submitted
  tone: string            // public-feel descriptors
  themes: string
  era: string
  geography_summary: string  // INCLUDED ONLY if a per-row review confirms geography_summary is
                             // intended as known-tier exposition; otherwise OMIT.
                             // Default safe choice: omit. Add later if user-facing demand emerges.
  // EXCLUDED, explicitly: key_tensions, political_summary, starting_situations,
  //                       follow_up_questions, dev_bypass_access_filter, status, created_at, updated_at
}
```

The implementer must add a Zod schema for `WorldSummary` that enforces this allowlist at serialize time (not just at the route's response construction). A whole-row spread is a footgun — any future column added to `worlds` would silently surface. The Zod schema acts as the wire-shape gate.

Under the dev-mode bypass, the endpoint MAY return the full worlds row (or a wider projection that includes the plot fields) — the dev operator's audience IS the audience that should see those columns. Default safe choice: even under bypass, omit `starting_situations` (since that's a stage-5 reveal the inspector explicitly defers); include the rest of the plot columns for inspection.

Each `*Row` schema is co-located with the route handler. Schemas mirror the DB columns (with the world allowlist applied as above); timestamps serialize as ISO strings.

**Repo composition** — most of the repo methods this endpoint composes do NOT exist today. They must be added in lockstep with this ticket:

- `repo.worlds.getById(worldId)` — exists.
- `repo.entities.listByWorld(worldId, { accessLevels: AccessLevel[] })` — extend the existing signature with an options arg; the WHERE clause becomes `world_id = $1 AND access_level = ANY($2)` against `idx_entities_world_access`.
- `repo.facts.listByEntities(entityIds, { accessLevels: AccessLevel[] })` — **new method** in `backend/src/repo/facts.ts`; today the file only exports `insertMany` / `updateContentById`. Query: `entity_id = ANY($1) AND access_level = ANY($2)` against `idx_facts_entity_access_status`.
- `repo.relationships.listAmong(entityIds)` — **new method** in `backend/src/repo/relationships.ts` (the existing `listByWorld` doesn't apply a tier-aware endpoint pair). Performance note: rather than two ANY checks (which the planner has to bitmap-AND across two single-column indices), use the single-trip subselect form: `WHERE source_entity_id IN (SELECT id FROM entities WHERE world_id = $1 AND access_level = ANY($2)) AND target_entity_id IN (SELECT id FROM entities WHERE world_id = $1 AND access_level = ANY($2))`. Let the planner co-evaluate.
- `repo.proseKernels.listByEntities(entityIds)` — **new method** in `backend/src/repo/prose-kernels.ts`.
- `repo.entityHierarchy.listForWorld(worldId)` — **new method** in `backend/src/repo/entity-hierarchy.ts`. The `entity_hierarchy` table has no `world_id` column; the query must JOIN entities: `SELECT eh.* FROM entity_hierarchy eh JOIN entities pe ON pe.id = eh.parent_entity_id WHERE pe.world_id = $1`. Route handler then filters in-memory to pairs where both parent and child are in the known-tier entity set.
- `repo.statBlocks.listByIds(statBlockIds)` — **new module** `backend/src/repo/stat-blocks.ts`, since no current code reads stat_blocks. Query: `id = ANY($1)` against the primary key.

All new repo methods follow the bare-export `ClientLike` pattern (the convention everywhere except `worlds.ts`'s pool-bound factory; `worlds.ts` is the outlier). The snapshot route opens a read-only pool client, runs the six queries in one round of `Promise.all`, and constructs the response.

When the dev-mode bypass is honored, the `accessLevels` option is widened to `['known', 'discoverable', 'secret']` everywhere — same query shape, same indices, just an unfiltered superset. The endpoint's only divergence under bypass is the wider `accessLevels` arg + the wider `WorldSummary` projection above.

**On `narrative_status`**: facts have a `narrative_status` column (`undelivered` / `delivered` / `developed` / `resolved`). The snapshot returns ALL known-tier facts regardless of `narrative_status` — this view is "what the player would know going in," and undelivered-but-known facts are exactly the prep-time exposition the player can be told day one. Future Scribe-era callers (who care about delivered vs developed) will use a different read path or pass an explicit filter.

### Why filter for the owner too

The owner is a player. The wiki snapshot is the player's "here's the world you're about to explore" view — showing `discoverable` or `secret` content there spoils the exploration loop, which is the play loop. The world generator literally tags content with how it's meant to surface; the snapshot honors those tags.

A separate ticket can build an owner-as-DM filtered variant if Mythrun ever supports a human-DM-leads-AI-players mode (out of current scope; AI is the DM).

## Post-snapshot delta lifecycle

The existing SSE endpoint `GET /api/campaigns/:campaignId/status/stream` stays open across all phases. The worker publishes events to the Redis channel `${keyPrefix}pipeline:campaign:${campaignId}` via `redisRealtime.publish`; the SSE endpoint subscribes to that channel and forwards each event to the connected client. No new transport infra — same channel, same endpoint.

Client behavior by phase:

- **`world_gen`**: SSE events drive the live graph build. Only known-tier entity-added / edge-added events arrive (the streaming-extractor's tier filter handles this); the graph reflects what the player will see in their initial wiki.
- **On `phase: world_snapshot_ready`**: client HTTP-GETs the snapshot endpoint once, parses the response, switches to wiki mode.
- **During `world_snapshot_ready` (stages 5-7 running)**: stages 5 and 6 emit no entity events. Stage 7 (coherence) emits `entity-updated`, `edge-added`, `edge-removed`.
- **On `phase: world_ready`**: all coherence deltas applied; the local snapshot equals what the snapshot endpoint would return now.

### Tier-aware coherence emits

Stage 7's existing emit paths fire for any entity/edge it patches. After myth-exac, `coherence-pass.ts` must filter its emissions to the known-tier surface:

- Before emitting `entity-updated { synthKey, patch }`, look up the entity's access_level. Only emit if `access_level === 'known'`.
- Before emitting `edge-added` / `edge-removed`, look up both endpoints' access_levels. Only emit if both are `known`.

The DB writes still happen (coherence patches persist regardless of tier). The filter is on the SSE emit only — the client wouldn't have non-known entities in its snapshot, so a delta for them would be meaningless. Without this filter, the inspector panel's "apply patch" code path references unknown nodes.

Concrete code-touch points:

- `loadWorldInventory` (`coherence-pass.ts:108-156`) loads `entitiesById` as `{id, name, entityType}` — extend the SELECT to include `access_level`. This is the existing inventory load, not a new query.
- `renderWorldDump` (`coherence-pass.ts:164`) renders entities into the prompt the coherence LLM sees. Add `[access_level: known|discoverable|secret]` per entity to the rendered output. This is load-bearing for prompt-correctness: without it, the coherence LLM has no signal about which entities are sensitive, and a "fix_prose" patch that merges secret-neighbor detail into a known entity's prose immediately leaks via the next `entity-updated` SSE event (the entity's tier passes the filter; the prose content is the leak vector). Pair this with the prose-tier consistency constraint in the stage-7 prompt — if it doesn't already exist there, add the same instruction the stage-2 and stage-3 prompts get.
- The emit gate runs against `loadedInventory.entitiesById[entityId].access_level` for each patch in `finalizedEvents` construction; non-`known` patches' events are dropped while the persist continues.

**Bypass interaction**: when the world's `dev_bypass_access_filter` flag is true, the coherence-pass tier filter is short-circuited and all coherence patches emit as SSE deltas regardless of the patched entity's tier.

### Operational details

**Reconnect recovery**: `EventSource` auto-reconnects on transport failure. The client may miss events during the gap. Recovery: on reconnect, if the world's phase is at or past `world_snapshot_ready` (read from the SSE initial-snapshot frame's phase, which now returns `world_snapshot_ready` thanks to the `derivePhase` update — see Lifecycle section), the client **replaces** (not merges) its local snapshot state with the result of `GET /world-snapshot`. Cheap (small payload, infrequent), idempotent — no event cursor / replay log needed. Any in-flight deltas that arrive between the snapshot fetch and steady-state are re-applied harmlessly because the fresh snapshot already reflects them. The replace-not-merge invariant matters: a `edge-removed` event the client missed during the gap would otherwise leave a stale edge in local state forever; the snapshot's authoritative state evicts it.

**Keep-alives**: the existing `/status/stream` endpoint emits a `:keepalive\n\n` comment frame every 25 seconds (`backend/src/sse/sse-connection.ts:7`), well under the ALB 60-second idle timeout. No change needed.

## Dev tool snapshot inspector panel

New panel: `backend/dev-tool/src/components/world-snapshot-panel.ts`.

### Lifecycle

The panel subscribes to the existing SSE stream and the existing campaign-selection state. State machine:

- **`idle`** — no campaign selected, OR campaign selected but current phase is `not_started` / `world_gen` / `world_gen_failed` / `failed`. Panel renders an empty placeholder.
- **`loading`** — phase reached `world_snapshot_ready` (or `world_ready`+); panel called `GET /world-snapshot`; awaiting response.
- **`ready`** — snapshot loaded into local state. Panel renders the tree + detail view. Subsequent SSE delta events mutate local state and trigger re-render.
- **`error`** — snapshot fetch failed (network, 403, 5xx). Panel renders an error card with the code; allows manual retry.

`data-state` attribute on the panel root reflects this state machine for the JSDOM verifier.

### Layout

```
+----------------------+--------------------------------+
|  Entities (tree)     |  Selected entity detail        |
|                      |                                |
|  ▼ Factions (3)      |  [name]    [kind: faction]     |
|     The Storm Wardens|                                |
|     The Drowned Court|  Prose kernel:                 |
|     ...              |  ...long-form content...       |
|  ▼ Locations (12)    |                                |
|     ▼ The Old Keep   |  Facts (5):                    |
|        Cellar        |   - The Storm Wardens are the  |
|        Solarium      |     lighthouse-keepers of the  |
|     Storm Beach      |     coast.                     |
|  ▼ NPCs (8)          |   - Their lamps are bound      |
|     ...              |     storm-spirits.             |
|  ▼ Items (2)         |                                |
|     ...              |  Relationships:                |
|                      |   → controls: The Old Keep     |
|                      |   ← member_of: Storm Wardens   |
|                      |                                |
|                      |  Stat block (if any):          |
|                      |   ...renders compactly...      |
+----------------------+--------------------------------+
```

Left pane: tree of entities grouped by `entity_type` (factions, locations, npcs, items). Locations sub-nest by `entity_hierarchy`. Counts in parentheses per group. Selecting an entity sets `selectedEntityId` state; right pane re-renders.

Right pane: detail card for the selected entity. Shows name, kind, prose kernel content, facts (when the bypass is OFF, all facts visible are known-tier so no subdivision; when the bypass is ON, facts are grouped by access_level to make the dev-mode view immediately distinguishable from prod-mode), in/out relationships, and the stat block if `stat_block_id` is non-null.

### Delta handling

On SSE events post-snapshot:

- `entity-updated { synthKey, patch }`: resolve `synthKey` → DB entity id; apply patch fields onto the matching `EntityRow` (or `ProseKernelRow` if `patch.prose` is present). Re-render if the affected entity is selected.
- `edge-added { synthKey, from, to, relationship }`: insert a new `RelationshipRow` into local state. Re-render the affected entities' relationship sections.
- `edge-removed { synthKey, reason }`: remove the `RelationshipRow` whose `synthKey` matches. Re-render.

**synthKey ↔ DB id resolution.** DB rows for entities and relationships are keyed by UUID `id`, not `synthKey` — the snapshot returns DB ids. Stage 2/3/4 stream `entity-added` / `edge-added` with `synthKey` (per-stage in-stream identifier) and later emit `finalized { synthKey, entityId }` post-COMMIT. Coherence-pass (stage 7) emits its events with the same `synthKey` shape, populated from the entity/relationship's DB id at patch-construction time.

For the inspector to apply deltas keyed by `synthKey` to a snapshot keyed by DB id, the inspector subscribes to `finalized` events from the moment it has a campaign selected (pre-snapshot or post) and builds a local `Map<synthKey, entityId>`. Coherence's `entity-updated` / `edge-added` / `edge-removed` events arrive with `synthKey`s the map already covers (because they reference entities created in stages 2/3/4 — all of which fired `finalized` before stage 7 runs). The inspector resolves `synthKey → entityId` against this map, then locates the row in its snapshot.

For relationships specifically: coherence's `edge-added` produces a new relationship row at patch time; the corresponding `finalized` is published with the new relationship's DB id. The inspector's `Map<synthKey, entityOrRelId>` is heterogeneous — keys are synthKeys from any stage; values are either entity ids or relationship ids depending on the originating event. Splitting into two maps (`Map<synthKey, entityId>` + `Map<synthKey, relationshipId>`) avoids ambiguity and matches the wire-event shape (`edge-removed { synthKey }` references a relationship id; `entity-updated { synthKey }` references an entity id).

The panel does not handle `entity-removed` post-snapshot because coherence doesn't delete entities today; if a future stage introduces entity removal, the panel will need the handler. Explicitly out of scope.

## Dev-mode access tier bypass

A per-creation, default-OFF toggle on the campaign-create surface lets the operator opt a single world out of tier filtering. When the toggle is ON, the world's `dev_bypass_access_filter` column is set to true at insert time; all downstream filter sites for THIS world short-circuit and behave as if every entity/fact/relationship were known-tier. The wire payload of streaming events stays narrow (identity-only) — the bypass changes *which* events fire, not what's in each payload.

This affordance exists for two reasons: (a) inspecting what the LLM is generating end-to-end during world-gen, which the standard known-tier UX hides by design; (b) verifying the tier-filter machinery itself — diff the snapshots of two worlds generated from the same concept, one with bypass ON and one with bypass OFF, and confirm the discoverable/secret content is exactly what's missing from the filtered view.

### Gating

The optional body field `devBypassAccessFilter: boolean` on `POST /api/campaigns`:

- Added to `CreateCampaignBodySchema` as `devBypassAccessFilter: z.boolean().optional()`. Zod's default behavior strips unknown fields silently, so the "fail loud" behavior is NOT achievable by leaving the field off the schema — it MUST be present on the schema so the route handler can inspect whether it was supplied.
- Honored at the route handler ONLY when **both** the caller is bypass-auth AND the env permits dev-mode bypass. Detection: `request.user.scopes.includes('bypass')` for the auth mode (the bypass plugin attaches `scopes: ['bypass']`); `env.nodeEnv === 'development' || env.nodeEnv === 'test'` for the env check (pattern: same predicate the existing dev-credits route uses to gate registration in `backend/src/app.ts:315`).
- Rejected with `400 { code: 'bypass_not_permitted' }` when the field is present (`request.body.devBypassAccessFilter !== undefined` after Zod parse) AND either gate fails. Failing loud (vs. silently dropping the field) is intentional — a production code path that accidentally sets this field is a bug worth surfacing.
- Default behavior when the field is absent (`devBypassAccessFilter === undefined` after Zod parse): the world row's `dev_bypass_access_filter` column takes the migration default (false). Toggle defaults OFF in the UI.

The flag persists on the world row regardless of subsequent environment changes. If a world was created with the bypass in a dev environment and the dev-tool then connects to a prod-mode backend, the snapshot endpoint applies tier filtering anyway (defense-in-depth, see below).

### Defense-in-depth at the snapshot endpoint

Even when `world.dev_bypass_access_filter === true`, the snapshot endpoint returns unfiltered content only if the requesting user is ALSO in bypass-auth mode. A non-bypass-auth requester hitting a dev-created world receives the standard known-tier filtered response. The check happens at the route handler:

```ts
const bypass =
  world.dev_bypass_access_filter && request.user.scopes.includes('bypass')
const accessLevels: AccessLevel[] = bypass
  ? ['known', 'discoverable', 'secret']
  : ['known']
```

(`request.user.scopes.includes('bypass')` is how the bypass-plugin's user is identified — `AuthUser` does not have an `authMode` field. The jwt-plugin attaches scopes from the verified JWT.)

The worker doesn't have a per-request auth context, so the streaming-extractor and coherence-pass filter sites use `world.dev_bypass_access_filter` directly (no request-mode check). The consequence: in a dev environment with `AUTH_MODE=bypass`, the worker streams all tiers for a bypass-flagged world to anyone watching the SSE channel. This is the intended behavior — the dev-tool operator is the audience.

### Audit

The campaign-create route logs at INFO when the flag is set:

```ts
const dbUser = requireDbUser(request)
request.log.info(
  { event: 'world.dev_bypass_access_filter.enabled', campaignId, userId: dbUser.id },
  'dev-mode access tier bypass enabled for new world',
)
```

(`userId` is the internal users-table UUID — pattern matches existing audit logs like `input_gate_reject` at `routes/campaigns.ts:777-784`, so the bypass-audit event can be joined to other request traces without a sub→user-id lookup.)

In production, the gate would have rejected the field before logging — so this event in production logs is itself a signal worth alerting on.

### UI: dev-tool campaign-create panel

A new checkbox below the concept input in `backend/dev-tool/src/components/campaign-create-panel.ts`:

```
[ ] Bypass access tiers (dev mode — see secrets in stream + snapshot)
```

- Default: unchecked (toggle OFF). This is a per-create toggle: the operator decides for each world, no sticky preference across creates.
- When checked, the panel includes `devBypassAccessFilter: true` in the POST body. When unchecked, the field is omitted (not sent as `false`) — keeps the request body lean.
- The checkbox renders unconditionally in the dev tool. The dev tool is dev-mode-only by definition; if Mythrun ever ships the dev tool to a production audience, gating the checkbox is a separate concern.

The inspector panel right-pane subdivides facts by access_level only when the bypass is ON (a visual cue distinguishing dev-mode unfiltered views from standard known-tier views). When the bypass is OFF, all visible facts are known-tier and subdivision adds no information.

## Coverage / contract registrations

- `backend/src/contract/pipeline-events.ts`: change `entity-added` and `edge-added` shapes; add `world_snapshot_ready` to `PipelinePhase`. No new event arms.
- `backend/src/contract/backend-routes.ts`: add `{ method: 'GET', path: '/api/campaigns/:campaignId/world-snapshot' }`.
- `backend/src/contract/pipeline-routes.ts`: add `'GET /api/campaigns/:campaignId/world-snapshot'`.
- `backend/dev-tool/coverage.json`: add `'GET /api/campaigns/:campaignId/world-snapshot'` to `routes`.
- `backend/dev-tool/verify-registry.ts`: add `world-snapshot` panel with `exercises: [route('GET', '/api/campaigns/:campaignId/world-snapshot')]` and the `data-state` markers.

## Wiki updates

- `docs/wiki/content/runtime/world-gen.html`: add the `world_snapshot_ready` phase to the lifecycle narrative; describe the snapshot endpoint as an owner-only known-tier slice; describe the post-snapshot delta channel; describe the three-tier access classification; document the dev-mode bypass.
- `docs/wiki/content/runtime/dev-tool.html`: mention the new world-snapshot panel and the campaign-create bypass checkbox.
- `docs/wiki/content/data/schema.html`: update for `entities.access_level` and `worlds.dev_bypass_access_filter` columns.

## Testing

TDD-shaped per the standing rules. Each implementation task starts with a failing test.

### Streaming-extractor (`streaming-extractor.test.ts`)

- A partial stream where entity i+1 begins → entity i is processed exactly once. Repeated partials with entity i still open → no premature emit.
- Closed entity with `access_level: 'known'` → `redisRealtime.publish` called once with `{ type: 'entity-added', synthKey, entityKind, name }`. No `data` field on the published payload.
- Closed entity with `access_level: 'discoverable'` or `'secret'` → no publish (silent persistence still happens via the stage handler, asserted by a separate test).
- Closed edge with both endpoints in known-tier map → `edge-added` published. Closed edge with either endpoint discoverable/secret → no publish.
- Closed entity with missing/invalid `access_level` → warning logged, no publish; Zod validation at stage-end still fails the stage (asserted in the stage-level test).
- Last entry in array is processed on stream-end (no following entry signals closure).
- With `bypassAccessFilter: true` in stage args, a closed `secret`-tier entity DOES publish.
- With `bypassAccessFilter: true`, an edge with one `secret`-tier endpoint DOES publish.

### Snapshot endpoint (`world-snapshot.test.ts`)

- 409 `snapshot_not_ready` when the latest `entity_relationships` pipeline_run is null, pending, in_progress, or failed.
- 200 with full payload when the run is `completed`.
- 403 `not_campaign_owner` for a non-owner member.
- 403 `not_campaign_member` for a stranger.
- Payload contains: only known-tier entities; only known-tier facts of those entities; only relationships where both endpoints are in the known set; prose kernels for known entities only; entityHierarchy filtered to pairs where both nodes are known; statBlocks referenced by known entities only.
- A discoverable entity in the world is NOT in the response.
- A known entity with a relationship to a discoverable entity has that relationship omitted.
- Zod schema round-trip: parsing the response with the schema succeeds; serialize → parse → equal.
- Dev-mode bypass: world with `dev_bypass_access_filter = true` AND requester in bypass-auth → unfiltered response (secret-tier entity included, secret-tier facts included, cross-tier relationships included).
- Dev-mode bypass: world with `dev_bypass_access_filter = true` AND requester NOT in bypass-auth → filtered response (defense-in-depth assertion).

### World-gen-processor (`world-gen-processor.test.ts`)

- After stage 4 commit, `redisRealtime.publish` is called with a `phase: world_snapshot_ready` event.
- After stage 7 commit, `phase: world_ready` is emitted (semantic preserved).
- Phase events are emitted post-COMMIT, not pre.
- The stage-4 args carry a `nameToAccessLevel` map built from stages 2-3 outputs (asserted by spying on the stage-4 dispatcher input).
- The worker reads `world.dev_bypass_access_filter` and threads it through stage args as `bypassAccessFilter`.

### Coherence-pass (`coherence-pass.test.ts`)

- `entity-updated` fires for a coherence patch targeting a known-tier entity.
- `entity-updated` does NOT fire for a patch targeting a discoverable/secret entity (the DB write still happens, asserted separately).
- `edge-added` / `edge-removed` fire only when both endpoints are known-tier.
- With `bypassAccessFilter: true` in the stage args, all coherence patches fire SSE deltas regardless of tier.

### POST /api/campaigns (`campaigns-create.test.ts`)

- Body with `devBypassAccessFilter: true` under bypass-auth + dev/test env → 201, world row has `dev_bypass_access_filter = true`.
- Body with `devBypassAccessFilter: true` under non-bypass auth → 400 `bypass_not_permitted`.
- Body with `devBypassAccessFilter: true` under bypass-auth + non-dev env (e.g., NODE_ENV=production) → 400 `bypass_not_permitted`.
- Body without `devBypassAccessFilter` field → 201, world row has `dev_bypass_access_filter = false` (default).
- Audit log emitted when the flag is set.

### Migration 014 (`migrate-schema.test.ts`)

- Up-migration: `facts.access_level` CHECK accepts `('known','discoverable','secret')`, rejects `('public','private')`.
- Existing fixtures with `'public'` / `'private'` were rewritten to `'known'` / `'discoverable'` (the migration's backfill).
- `entities.access_level` column exists with NOT NULL DEFAULT 'known' and the matching CHECK.
- `idx_entities_world_access` index exists.
- `worlds.dev_bypass_access_filter` column exists with NOT NULL DEFAULT false.

### LLM schemas

- `world-and-factions.ts` schema: a region/faction without `access_level` fails Zod; with an invalid value fails Zod; with `known`/`discoverable`/`secret` passes.
- Same for `locations-and-npcs.ts` location and NPC schemas.
- Fact enum: rejects `public`/`private`; accepts `known`/`discoverable`/`secret`.

### Dev-tool snapshot inspector panel (`world-snapshot-panel.test.ts` + JSDOM verifier)

- Vitest: state machine transitions on simulated SSE events (`idle` → `loading` → `ready`); error path on simulated 4xx.
- JSDOM verifier: panel mounts, snapshot fetch succeeds, `data-state="ready"` reached; subsequent `entity-updated` event mutates DOM (selected entity's name updates).

### Dev-tool campaign-create panel (`campaign-create-panel.test.ts`)

- Checkbox renders unchecked by default.
- Checking the checkbox and submitting → POST body includes `devBypassAccessFilter: true`.
- Unchecked submit → POST body omits the field.

### Existing tests requiring update

- Any test asserting `entity-added.data` payload shape — update to assert `name`.
- Any test asserting `edge-added.description` field — drop the assertion.
- Any test using `'public'` or `'private'` access_level — rename to `'known'` / `'discoverable'`.
- Coherence-pass tests already use `entity-updated { patch: { name } }` and `entity-updated { patch: { prose } }` — payload unchanged, but now they need to set up fixtures with tier-classified entities to exercise the new tier filter.

## Out of scope (named for context)

- **Production frontend wiki UI** (React route + components): the dev-tool inspector is the only consumer of the snapshot endpoint in this ticket. The React wiki lands separately when the frontend stack is further along.
- **Per-character fact + entity visibility overrides**: bead `myth-8iid`. Schema extension to layer per-character access_level on top of the world-default shipped here. Blocked on characters being persisted with stable IDs; designed for the Scribe-era or multi-character knowledge differentiation.
- **Post-character-creation tier-flip pass**: a character-creation-time pass that flips a subset of `discoverable` entities/facts to effectively `known` for that character based on their background, origin, profession. Same future bead can cover it; not designed yet.
- **Scribe delta event arms** (`fact-added`, `fact-updated`, `fact-removed`, etc.): the SSE+Redis transport is reusable; the new event types and their producer/consumer wiring land with the Scribe ticket.
- **Random tables in the wiki**: deferred. When the wiki UX wants to render encounter / loot tables, extend the snapshot shape.
- **Starting-situation reveal UX**: a separate flow opens the starting situation after the user finishes exploring. Outside this design.
- **Snapshot caching / ETag / If-None-Match**: the payload is small and fetched once per session; caching is YAGNI at launch scale.
- **DM-leads-AI-players mode**: if Mythrun ever supports a human-DM-leads-AI-players mode, the owner-as-DM unfiltered snapshot variant lives there. Not the current model (AI is the DM).
- **Sticky bypass preference / per-user bypass default**: the bypass is a per-create toggle. No "remember my choice" affordance; if an operator wants every world to be unfiltered they check the box each time. Keeps the dev-only surface explicit.

## Open questions

None. All decisions captured in the brainstorm + round-1 blind-review fixes:

- Scope: backend (contract + migration + endpoint) + dev-tool snapshot inspector + campaign-create bypass checkbox. Production frontend wiki deferred.
- `entity-updated`: stays in the contract, fired only by coherence pass post-design.
- New phase arm: `world_snapshot_ready`.
- Snapshot shape: flat arrays, DB-mirror.
- Snapshot gate: strict 409 pre-readiness.
- Transport for post-snapshot deltas: existing SSE stream + Redis channel; no new infra.
- Tier rename: `public → known`, `private → discoverable`, `secret` unchanged.
- Entity-level access_level: new column, default `known`.
- Streaming-extractor emit gate: closed-entry detection; only known-tier emits.
- Coherence-pass post-snapshot deltas: filtered to known-tier surface.
- Dev-mode bypass: per-create toggle, default OFF, persisted on world row, gated by bypass-auth + dev/test NODE_ENV; defense-in-depth at snapshot endpoint (requester must also be bypass-auth); short-circuits all filter sites for that world. Bypass-auth detected via `request.user.scopes.includes('bypass')`, NOT a fictional `request.user.authMode` field.
- Per-character overrides: out of scope, future bead `myth-8iid`.
- `WorldSummary` projection (snapshot endpoint): allowlist of safe columns from the worlds table; plot-bearing columns (`key_tensions`, `political_summary`, `starting_situations`, `follow_up_questions`) explicitly excluded under the standard tier filter; under bypass, `starting_situations` is still excluded by default (a stage-5 reveal the dev inspector defers).
- Persistence path for `entities.access_level`: `InsertEntityInput` + `entities.insert` + `persistEntities` (in stages 2 and 3) updated in lockstep with the migration so the LLM's emitted tier actually reaches the DB.
- `finalized` events tier-filtered same as `entity-added` (was a gap in the v1/v2/v3 spec; closed in v4 post-blind-review).
- Streaming-extractor needs explicit post-loop pass for the last entry of each array.
- LLM Zod schemas: `access_level` is the second field in each entity object (after `name`), required (no `.optional()`/`.default()`).
- Prompts: explicit field-order constraint (`name` first, `access_level` second), prose-tier consistency constraint (no secret/discoverable content in known-tier prose/content), cross-stage awareness for stage 3.
- `derivePhase` extension: returns `world_snapshot_ready` when the `entity_relationships` pipeline_run is `completed` and `worlds.status` is still `generating`.
- Coherence pass: loads `entities.access_level` in the inventory query, renders it in the world-dump prompt, AND applies the tier filter at emit time.
- Reconnect recovery: re-fetched snapshot REPLACES (not merges) the local snapshot state.
- Inspector synthKey→DB-id mapping: built from `finalized` events arriving for stages 2/3/4 outputs; split into separate `Map<synthKey, entityId>` and `Map<synthKey, relationshipId>` (the wire-event types reference different DB-id namespaces).
- Repo composition: most needed methods (`facts.listByEntities`, `relationships.listAmong`, `proseKernels.listByEntities`, `entityHierarchy.listForWorld`, `statBlocks.listByIds`) are NEW; spec lists them explicitly. `statBlocks` is a new repo module entirely.
- Naming: runtime view's repo file is `world-snapshot-view.ts` to avoid grep collision with the prototype-era `world_snapshots` save-game table.
