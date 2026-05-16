# myth-exac: Narrow streaming + access-tier-aware world snapshot

## Lead

Today's prep pipeline streams full entity and edge snapshots over SSE as the LLM emits them, including descriptions, prose, and any other fields the model has typed. Two symptoms result: (a) the dev tool's live-events panel shows duplicate `edge-added` lines because every progressive field update re-emits the event — edges have no `edge-updated` arm, so the extractor re-fires `edge-added` with the latest snapshot; (b) wire payloads carry data the live graph doesn't render, bloating the streaming hot path. A deeper gap also exists: the world model classifies facts by `access_level`, but no read path currently filters by that classification, so the enforced-ignorance principle (a non-negotiable in `CLAUDE.md`) isn't yet materialized at the API surface.

This design bundles four moves: (1) narrows the streaming event contract for stages 2-4 to identity-only fields, and changes the emit gate from "name plus one other field" to "the entire entity object has finished streaming," so the access_level is in hand at emit time; (2) reworks the three-tier access classification on facts and extends it to entities, with the rename `public → known`, `private → discoverable`, `secret unchanged`, grounded in D&D-mechanic semantics (no-roll / roll-required / actively-hidden); (3) adds a `GET /api/campaigns/:campaignId/world-snapshot` endpoint that returns the known-tier slice of the world for a dev-tool wiki inspector panel; (4) gates snapshot availability on a new `world_snapshot_ready` pipeline phase fired when stage 4 (entity_relationships) completes, with stage-7 (coherence pass) deltas flowing on the existing SSE channel after the snapshot ships, filtered to the known-tier surface the client actually has.

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

A related deferred concern: post-character-creation, a pass may flip a character-specific subset of entities/facts to `known` based on the character's background, origin, profession (per the conversation that produced this spec). That pass isn't designed yet; same future bead can cover it.

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

## Streaming events (stages 2-4)

### Closed-entry emit gate

`backend/src/llm/prep/streaming-extractor.ts` currently emits an event the moment an array entry crosses the "isEmittable" predicate (name present + at least one other field). The result is partial-state emissions during progressive field arrival — the duplicate `edge-added` symptom that motivated this design.

The new gate emits only when an array entry is **structurally complete** — the LLM has finished writing it. Detection mechanism: an entry at index `i` is closed when `partial.array.length > i + 1` (the partial-object stream has started populating index `i + 1`, so the parser has definitively moved past `i`). For the *last* entry in an array, closure is signaled by stream-end OR by the parent object's next sibling field beginning to populate. The extractor processes closed entries by indexing forward from `lastEmittedIndex`; each closed entry is examined exactly once.

Once an entry is closed, its full content is in hand — including `access_level`. The extractor applies the access-level filter (see below) and either emits the event or persists silently.

In-memory state: `emittedSnapshots: Map<synthKey, snapshot>` becomes `emitted: Set<synthKey>`. The `diffPatch` helper, the prior-snapshot tracking, and the progressive-update branch are deleted.

**Validation timing**: if a closed entry lacks `access_level` or carries an invalid value, the extractor logs a warning and skips the emit (entry is treated as not-`known`). Zod schema validation at stage-end will fail the stage on the missing/invalid field — failures stay at the proper layer (Zod, not streaming-extractor).

### Tier-aware emission

After a closed entry passes structural completeness, the extractor checks `access_level`:

- `access_level === 'known'` → emit `entity-added` (or `edge-added` for stage 4) to the SSE channel.
- `access_level === 'discoverable'` or `'secret'` → no SSE event. Entry still gets persisted by the stage handler (downstream consumers — FT context-build, future Scribe — will read from the DB).

For **edges** in stage 4, the endpoint pair must both be `known`-tier for the edge to emit:

- Stages 2 and 3 persist entities. The world-gen-processor passes a `Map<entityName, accessLevel>` (built from stage-2 and stage-3 outputs) into stage 4 as part of the stage's args.
- Stage 4's streaming-extractor consults this map at closed-edge time. If either endpoint isn't `known`-tier, the edge is persisted silently.
- This prevents the live graph from accidentally hinting at a `discoverable` or `secret` entity via an incoming relationship.

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

### Migration 014: tier rename + entity tier column

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
```

The existing `idx_facts_entity_access_status` already covers the facts filter — no new index needed there.

### LLM Zod schemas

`backend/src/llm/schemas/world-and-factions.ts`:

- Fact schema: bump `access_level: z.enum(['known', 'discoverable', 'secret'])`.
- Region schema: add `access_level: z.enum(['known', 'discoverable', 'secret'])` at the entity level.
- Faction schema: same.

`backend/src/llm/schemas/locations-and-npcs.ts`:

- Same: bump the fact enum; add entity-level `access_level` to location and NPC schemas.

`backend/src/llm/schemas/entity-relationships.ts`: relationships don't get an access_level. Their visibility is derived from the endpoint pair (see edge emit gate above).

### Prompt updates

`backend/src/llm/prompts/prep/world-and-factions.txt`:

- Rewrite the fact access_level definition block (currently lines ~48-50) with the three-tier semantic above.
- Add an analogous entity-level block: "Each region and faction has an `access_level` of `known`, `discoverable`, or `secret`. `known` regions and factions are the visible world — common knowledge, the kind of thing players are told for free. `discoverable` entities exist in the world but aren't advertised — a hidden grove, a faction operating quietly, found through investigation or asking around. `secret` entities are concealed — a cult faction pulling strings, a lost city — revealed by plot."
- Extend the "mix tiers deliberately" instruction (currently line 54) to entities: "Mix entity access levels too. Most regions should be `known`. At least one region or faction per world should be `discoverable` (a place players uncover through play) and at least one should be `secret` (a load-bearing reveal). Don't over-stuff the visible world with secrets; depth comes from a few well-placed hidden things, not from making everything mysterious."

`backend/src/llm/prompts/prep/locations-and-npcs.txt`:

- Same rewrite for the fact access_level definition block (currently line ~62).
- Add an analogous entity-level block for locations and NPCs.
- Mix-tiers instruction extends to locations and NPCs.

## Snapshot endpoint

### Route

`GET /api/campaigns/:campaignId/world-snapshot`

- **Auth**: `requireCampaignMember(repo, 'owner')`. The campaign owner fetches snapshots for the campaigns they own.
- **Tier filter**: applied to the response payload independent of who the viewer is. Even the owner sees only the `known`-tier slice — the snapshot is for player exploration, and the owner is a player. Per-character overrides (future bead `myth-8iid`) would refine this.
- **Pipeline route**: `config: { pipelineRoute: true }`. Registered in `backend/src/contract/pipeline-routes.ts` so the onReady reverse-check passes.
- **Rate limit**: 30/min per-IP (matches `/api/campaigns/mine`). Endpoint is fetch-once-per-session in normal use.
- **Pre-readiness**: returns `409 { code: 'snapshot_not_ready' }` when the latest `entity_relationships` pipeline_run for the world is anything other than `completed`. 200 otherwise.

### Response shape

```ts
{
  world: WorldRow,                       // the worlds table row
  entities: EntityRow[],                 // entities WHERE access_level = 'known'
  facts: FactRow[],                      // facts of those entities WHERE access_level = 'known'
  relationships: RelationshipRow[],      // relationships where both endpoints are in the known set
  proseKernels: ProseKernelRow[],        // kernels for known entities only (1:1 with entity)
  entityHierarchy: EntityHierarchyRow[], // hierarchy rows where both parent and child are in the known set
  statBlocks: StatBlockRow[]             // referenced by entity.stat_block_id for entities in the known set
}
```

Each `*Row` is a Zod schema co-located with the route handler. Schemas mirror the DB columns; timestamps serialize as ISO strings.

Repo composition (`backend/src/repo/world-snapshot.ts`, new file, or inline in the route):

- `repo.worlds.getById(worldId)`
- `repo.entities.listByWorld(worldId, { accessLevels: ['known'] })` — new options arg; tiles to a `WHERE world_id = $1 AND access_level = ANY($2)` query against `idx_entities_world_access`.
- `repo.facts.listByEntities(knownEntityIds, { accessLevels: ['known'] })` — same pattern; tiles to `idx_facts_entity_access_status`.
- `repo.relationships.listByEntities(knownEntityIds)` — returns rows where BOTH `source_entity_id` AND `target_entity_id` are in `knownEntityIds`. Use `WHERE source_entity_id = ANY($1) AND target_entity_id = ANY($1)`.
- `repo.proseKernels.listByEntities(knownEntityIds)`.
- `repo.entityHierarchy.listByWorld(worldId)` filtered server-side to pairs where both parent and child are in the known set. (Or: list all, filter in the route handler — single round trip, smaller index footprint. Pick at implementation time.)
- `repo.statBlocks.listByIds(statBlockIds)` where `statBlockIds = knownEntities.map(e => e.stat_block_id).filter(Boolean)`.

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

Stage 7's existing emit paths fire for any entity/edge it patches. After myth-exac, coherence-pass.ts must filter its emissions to the known-tier surface:

- Before emitting `entity-updated { synthKey, patch }`, look up the entity's access_level. Only emit if `access_level === 'known'`.
- Before emitting `edge-added` / `edge-removed`, look up both endpoints' access_levels. Only emit if both are `known`.

The DB writes still happen (coherence patches persist regardless of tier). The filter is on the SSE emit only — the client wouldn't have non-known entities in its snapshot, so a delta for them would be meaningless. Stage 7 already loads the world's facts with their access_level (line 133 of coherence-pass.ts); it can be extended to load entities' access_level for the tier check.

This filter is load-bearing: without it, the client gets a delta event for an entity it doesn't have, and the inspector panel's "apply patch" code path hits a missing-key bug.

### Operational details

**Reconnect recovery**: `EventSource` auto-reconnects on transport failure. The client may miss events during the gap. Recovery: on reconnect, if the world's phase is at or past `world_snapshot_ready`, re-fetch the snapshot via the endpoint. Cheap (small payload, infrequent), idempotent — no event cursor / replay log needed.

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

Right pane: detail card for the selected entity. Shows name, kind, prose kernel content, facts (all known-tier; no per-access-level subdivision since the snapshot only returns one tier), in/out relationships, and the stat block if `stat_block_id` is non-null.

### Delta handling

On SSE events post-snapshot:

- `entity-updated { synthKey, patch }`: resolve `synthKey` → DB entity id (from the prior `finalized` event), apply patch fields onto the matching `EntityRow` (or `ProseKernelRow` if `patch.prose` is present). Re-render if the affected entity is selected.
- `edge-added { synthKey, from, to, relationship }`: insert a new `RelationshipRow` into local state. Re-render the affected entities' relationship sections.
- `edge-removed { synthKey, reason }`: remove the `RelationshipRow` whose `synthKey` matches. Re-render.

The panel does not handle `entity-removed` post-snapshot because coherence doesn't delete entities today; if a future stage introduces entity removal, the panel will need the handler. Explicitly out of scope.

## Coverage / contract registrations

- `backend/src/contract/pipeline-events.ts`: change `entity-added` and `edge-added` shapes; add `world_snapshot_ready` to `PipelinePhase`. No new event arms.
- `backend/src/contract/backend-routes.ts`: add `{ method: 'GET', path: '/api/campaigns/:campaignId/world-snapshot' }`.
- `backend/src/contract/pipeline-routes.ts`: add `'GET /api/campaigns/:campaignId/world-snapshot'`.
- `backend/dev-tool/coverage.json`: add `'GET /api/campaigns/:campaignId/world-snapshot'` to `routes`.
- `backend/dev-tool/verify-registry.ts`: add `world-snapshot` panel with `exercises: [route('GET', '/api/campaigns/:campaignId/world-snapshot')]` and the `data-state` markers.

## Wiki updates

- `docs/wiki/content/runtime/world-gen.html`: add the `world_snapshot_ready` phase to the lifecycle narrative; describe the snapshot endpoint as an owner-only known-tier slice; describe the post-snapshot delta channel; describe the three-tier access classification.
- `docs/wiki/content/runtime/dev-tool.html`: mention the new world-snapshot panel.
- `docs/wiki/content/data/schema.html`: update for `entities.access_level` column.

## Testing

TDD-shaped per the standing rules. Each implementation task starts with a failing test.

### Streaming-extractor (`streaming-extractor.test.ts`)

- A partial stream where entity i+1 begins → entity i is processed exactly once. Repeated partials with entity i still open → no premature emit.
- Closed entity with `access_level: 'known'` → `redisRealtime.publish` called once with `{ type: 'entity-added', synthKey, entityKind, name }`. No `data` field on the published payload.
- Closed entity with `access_level: 'discoverable'` or `'secret'` → no publish (silent persistence still happens via the stage handler, asserted by a separate test).
- Closed edge with both endpoints in known-tier map → `edge-added` published. Closed edge with either endpoint discoverable/secret → no publish.
- Closed entity with missing/invalid `access_level` → warning logged, no publish; Zod validation at stage-end still fails the stage (asserted in the stage-level test).
- Last entry in array is processed on stream-end (no following entry signals closure).

### Snapshot endpoint (`world-snapshot.test.ts`)

- 409 `snapshot_not_ready` when the latest `entity_relationships` pipeline_run is null, pending, in_progress, or failed.
- 200 with full payload when the run is `completed`.
- 403 `not_campaign_owner` for a non-owner member.
- 403 `not_campaign_member` for a stranger.
- Payload contains: only known-tier entities; only known-tier facts of those entities; only relationships where both endpoints are in the known set; prose kernels for known entities only; entityHierarchy filtered to pairs where both nodes are known; statBlocks referenced by known entities only.
- A discoverable entity in the world is NOT in the response.
- A known entity with a relationship to a discoverable entity has that relationship omitted.
- Zod schema round-trip: parsing the response with the schema succeeds; serialize → parse → equal.

### World-gen-processor (`world-gen-processor.test.ts`)

- After stage 4 commit, `redisRealtime.publish` is called with a `phase: world_snapshot_ready` event.
- After stage 7 commit, `phase: world_ready` is emitted (semantic preserved).
- Phase events are emitted post-COMMIT, not pre.
- The stage-4 args carry a `nameToAccessLevel` map built from stages 2-3 outputs (asserted by spying on the stage-4 dispatcher input).

### Coherence-pass (`coherence-pass.test.ts`)

- `entity-updated` fires for a coherence patch targeting a known-tier entity.
- `entity-updated` does NOT fire for a patch targeting a discoverable/secret entity (the DB write still happens, asserted separately).
- `edge-added` / `edge-removed` fire only when both endpoints are known-tier.

### Migration 014 (`migrate-schema.test.ts`)

- Up-migration: `facts.access_level` CHECK accepts `('known','discoverable','secret')`, rejects `('public','private')`.
- Existing fixtures with `'public'` / `'private'` were rewritten to `'known'` / `'discoverable'` (the migration's backfill).
- `entities.access_level` column exists with NOT NULL DEFAULT 'known' and the matching CHECK.
- `idx_entities_world_access` index exists.

### LLM schemas

- `world-and-factions.ts` schema: a region/faction without `access_level` fails Zod; with an invalid value fails Zod; with `known`/`discoverable`/`secret` passes.
- Same for `locations-and-npcs.ts` location and NPC schemas.
- Fact enum: rejects `public`/`private`; accepts `known`/`discoverable`/`secret`.

### Dev-tool snapshot inspector panel (`world-snapshot-panel.test.ts` + JSDOM verifier)

- Vitest: state machine transitions on simulated SSE events (`idle` → `loading` → `ready`); error path on simulated 4xx.
- JSDOM verifier: panel mounts, snapshot fetch succeeds, `data-state="ready"` reached; subsequent `entity-updated` event mutates DOM (selected entity's name updates).

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

## Open questions

None. All decisions captured in the brainstorm:

- Scope: backend (contract + migration + endpoint) + dev-tool snapshot inspector. Production frontend wiki deferred.
- `entity-updated`: stays in the contract, fired only by coherence pass post-design.
- New phase arm: `world_snapshot_ready`.
- Snapshot shape: flat arrays, DB-mirror.
- Snapshot gate: strict 409 pre-readiness.
- Transport for post-snapshot deltas: existing SSE stream + Redis channel; no new infra.
- Tier rename: `public → known`, `private → discoverable`, `secret` unchanged.
- Entity-level access_level: new column, default `known`.
- Streaming-extractor emit gate: closed-entry detection; only known-tier emits.
- Coherence-pass post-snapshot deltas: filtered to known-tier surface.
- Per-character overrides: out of scope, future bead `myth-8iid`.
