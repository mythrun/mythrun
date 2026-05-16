# myth-exac: Narrow streaming event contract + world snapshot endpoint

## Lead

Today's prep pipeline streams full entity/edge snapshots over SSE as the LLM emits them, including descriptions, prose, and any other fields the model has typed. Two symptoms result: (1) the dev tool's live-events panel shows duplicate `edge-added` lines, because every progressive-field change re-emits the event — edges have no `edge-updated` arm, so the extractor re-fires `edge-added` with the latest snapshot; (2) wire payloads carry data the live graph doesn't render (descriptions, prose), bloating the streaming hot path.

This design (a) narrows the streaming event contract for stages 2-4 to identity-only fields (entity: synthKey + kind + name; edge: synthKey + from + to + relationship), making each event truly fire-once per `synthKey`; (b) adds a `GET /api/campaigns/:campaignId/world-snapshot` endpoint that returns the full persisted world content for a dev-tool wiki inspector panel; (c) gates snapshot availability on a new `world_snapshot_ready` pipeline phase fired when stage 4 (entity_relationships) completes; (d) reuses the existing SSE stream for stage-7 (coherence pass) delta events, which mutate the client's snapshot copy in place. The same delta channel is reusable later for Scribe-driven mid-session updates.

## Lifecycle

A new `PipelinePhase` arm `world_snapshot_ready` is inserted between `world_gen` and `world_ready` in `backend/src/contract/pipeline-events.ts`. The world-gen processor emits `phase: world_snapshot_ready` immediately after the stage-4 (entity_relationships) commit. Stages 5 (starting situation), 6 (random tables), and 7 (coherence pass) run with the phase still at `world_snapshot_ready`. On stage-7 completion, the phase flips to `world_ready` — preserving today's semantic of "all stages done, world canonical, ready to proceed."

```
phase transitions:
  not_started → world_gen → world_snapshot_ready → world_ready → character_creation → ...
                                ^                        ^
                            stage 4 done             stage 7 done
                            (snapshot fetchable)     (coherence deltas applied)
```

The `worlds.status` column does not get a new value. `phase` is the wire contract; `status` continues with its existing arms. The snapshot endpoint computes readiness by looking at the latest `pipeline_runs` row for stage `entity_relationships`: if `status='completed'`, the world is past the snapshot-ready gate. (If a persistent column becomes warranted later — e.g., for a dashboard query — we can add it; YAGNI for this design.)

## Narrowed streaming events (stages 2-4)

`backend/src/llm/prep/streaming-extractor.ts` is the shared loop used by stages 2 (world_and_factions), 3 (locations_and_npcs), and 4 (entity_relationships). Today it emits two kinds of changes per `synthKey`:

1. **First emission** (entry crosses the "isEmittable" threshold): fires `entity-added` with the full `data` blob or `edge-added` with the full snapshot.
2. **Subsequent diffs** (any tracked field changes after first emission): fires `entity-updated { patch }` for entities, or RE-EMITS `edge-added` with the latest snapshot for edges (the duplicate-emission symptom).

After this design:

1. **First emission**: fires `entity-added { synthKey, entityKind, name }` or `edge-added { synthKey, from, to, relationship }`.
2. **Subsequent diffs**: removed. Once a `synthKey` is emitted, no further events from the extractor.

Implementation details:

- `emittedSnapshots: Map<synthKey, snapshotObj>` becomes `emitted: Set<synthKey>`. The map's value (the prior snapshot) is no longer needed because there's no diff comparison.
- The `diffPatch` helper and the post-first-emit branch of the extractor are deleted.
- The `isEmittableEntity` / `isEmittableEdge` predicates **stay unchanged**. Their job is the maturity gate ("don't fire until the entry is structurally complete enough"), which is independent of the wire payload. The entity predicate's "name plus one other field" rule still guards against premature firing on `{ name: "X" }` partials where the LLM hasn't typed past the name yet.

### Contract shape changes (`backend/src/contract/pipeline-events.ts`)

```ts
// Before
| { type: 'entity-added'; synthKey: string; entityKind: string; data: Record<string, unknown> }
| { type: 'edge-added'; synthKey: string; from: string; to: string; relationship: string; description?: string }

// After
| { type: 'entity-added'; synthKey: string; entityKind: string; name: string }
| { type: 'edge-added'; synthKey: string; from: string; to: string; relationship: string }
```

Unchanged arms: `phase`, `stage-started`, `stage-completed`, `stage-failed`, `cost-update`, `job-failed`, `stage-reset`, `entity-updated`, `entity-removed`, `edge-removed`, `finalized`.

**`entity-updated` lifecycle change**: still in the contract, but its only emit site after this change is `backend/src/llm/prep/stages/coherence-pass.ts` (for name and prose patches). The streaming-extractor no longer fires it. The wire shape `{ synthKey, patch }` is preserved.

## Snapshot endpoint

### Route

`GET /api/campaigns/:campaignId/world-snapshot`

- **Auth**: `requireCampaignMember(repo, 'owner')`. Facts carry `access_level: 'secret'`; only the campaign owner sees secrets. Member-but-not-owner → 403 `not_campaign_owner`. Stranger → 403 `not_campaign_member`. Per the enforced-ignorance principle (CLAUDE.md #1), a future player-facing variant would filter facts by access_level; not part of this design.
- **Pipeline route**: `config: { pipelineRoute: true }`. The route is registered in `backend/src/contract/pipeline-routes.ts` so the onReady reverse-check passes.
- **Rate limit**: 30/min per-IP (matches `/api/campaigns/mine`). The endpoint is fetch-once-per-session in normal use; the limit is generous enough for retries.
- **Pre-readiness**: returns `409 { code: 'snapshot_not_ready' }` when the latest `entity_relationships` pipeline_run for the world is anything other than `completed`. 200 otherwise.

### Response shape

```ts
{
  world: WorldRow,                       // the worlds table row
  entities: EntityRow[],                 // all entities for the world (factions, locations, npcs, items)
  facts: FactRow[],                      // all facts for those entities; owner sees all access_levels
  relationships: RelationshipRow[],      // all relationships among the world's entities
  proseKernels: ProseKernelRow[],        // one per entity (UNIQUE constraint enforces 1:1)
  entityHierarchy: EntityHierarchyRow[], // parent/child entity links (e.g., room-in-building)
  statBlocks: StatBlockRow[]             // referenced by entity.stat_block_id (NPCs typically)
}
```

Each `*Row` is a Zod schema co-located with the route handler. Schemas mirror the DB columns; timestamps are serialized as ISO strings. The response is computed by composing existing repo methods:

- `repo.worlds.getById(worldId)`
- `repo.entities.listByWorld(worldId)`
- `repo.facts.listByEntities(entityIds)`
- `repo.relationships.listByEntities(entityIds)` (returns rows where either source or target is in the set)
- `repo.proseKernels.listByEntities(entityIds)`
- `repo.entityHierarchy.listByWorld(worldId)` (new method if not present)
- `repo.statBlocks.listByIds(statBlockIds)` (new method if not present; filtered to entity stat_block_ids that are non-null)

New repo methods, if any, are minimal `SELECT ... WHERE world_id = $1` (or `IN (...)`) queries co-located with their tables.

## Post-snapshot delta lifecycle

The existing SSE endpoint `GET /api/campaigns/:campaignId/status/stream` stays open across all phases. The worker publishes events to the Redis channel `${keyPrefix}pipeline:campaign:${campaignId}` via `redisRealtime.publish`; the SSE endpoint subscribes to that channel and forwards each event to the connected client. No new transport infra — same channel, same endpoint.

Client behavior, by phase:

- **`world_gen`**: SSE events drive the live graph build (entity-added pops a node; edge-added draws an edge). The snapshot endpoint returns 409 if called.
- **On `phase: world_snapshot_ready`**: client HTTP-GETs the snapshot endpoint once, parses the response, and switches to wiki mode. Existing graph view may stay rendered or be replaced.
- **During `world_snapshot_ready` (stages 5-7 running in background)**: stages 5 and 6 do not emit entity/edge events (they persist silently). Stage 7 (coherence pass) emits `entity-updated`, `edge-added`, `edge-removed` per the coherence-pass.ts apply functions. Client applies each event to its local snapshot copy: mutate the matching entity row for `entity-updated`; splice the relationships array for `edge-added`/`edge-removed`.
- **On `phase: world_ready`**: all coherence deltas applied; the local snapshot equals what the snapshot endpoint would return now. Wiki may show a "world complete" affordance and unblock the user proceeding to character creation.

Future Scribe deltas during play sessions will use the same SSE channel. New event arms for fact-level mutations (`fact-added`, `fact-updated`, `fact-removed`) and entity-state mutations (encountered, modified_by_play) will be designed when Scribe lands; not part of this ticket.

### Operational details

**Reconnect recovery**: `EventSource` auto-reconnects on transport failure. The client may miss events during the gap. Recovery strategy: on reconnect, if the world's phase is at or past `world_snapshot_ready`, re-fetch the snapshot via the endpoint. Cheap (small payload, infrequent) and idempotent — no event cursor / replay log needed.

**Keep-alives**: Fastify SSE must emit a keep-alive comment frame at least every 30 seconds to survive the ALB 60-second idle timeout. The existing `/status/stream` endpoint should already handle this; this design does not introduce a new SSE endpoint.

## Dev tool snapshot inspector panel

New panel: `backend/dev-tool/src/components/world-snapshot-panel.ts`.

### Lifecycle

The panel subscribes to the existing SSE stream and the existing campaign-selection state in the dev tool (same patterns as the live-events panel and campaign-details panel). State machine:

- **`idle`**: no campaign selected, OR campaign selected but current phase is `not_started` / `world_gen`. Panel renders an empty placeholder.
- **`loading`**: phase reached `world_snapshot_ready` (or `world_ready`+); panel called `GET /world-snapshot`; awaiting response.
- **`ready`**: snapshot loaded into local state. Panel renders the tree + detail view. Subsequent SSE delta events mutate local state and trigger re-render.
- **`error`**: snapshot fetch failed (network, 403, 5xx). Panel renders an error card with the error code; allows manual retry.

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
|        Cellar        |   public:  The Storm Wardens   |
|        Solarium      |           are the lighthouse-  |
|     Storm Beach      |           keepers of the coast.|
|  ▼ NPCs (8)          |   private: Their lamps are     |
|     ...              |           bound storm-spirits. |
|  ▼ Items (2)         |   secret:  The eldest spirit   |
|     ...              |           is plotting freedom. |
|                      |                                |
|                      |  Relationships:                |
|                      |   → controls: The Old Keep     |
|                      |   ← member_of: Storm Wardens   |
|                      |                                |
|                      |  Stat block (if any):          |
|                      |   ...renders compactly...      |
+----------------------+--------------------------------+
```

Left pane: tree of entities grouped by `entity_type` (factions, locations, npcs, items). Locations sub-nest by `entity_hierarchy` (parent/child). Counts in parentheses per group. Selecting an entity sets `selectedEntityId` state; right pane re-renders.

Right pane: detail card for the selected entity. Shows name, kind, the prose kernel content, facts (subdivided by `access_level` with visual distinction), in/out relationships with the other entity's name and relationship type, and the stat block (if `stat_block_id` is non-null) rendered as a compact card.

Delta-event handling on the SSE stream:

- `entity-updated { synthKey, patch }`: resolve `synthKey` → DB entity id (via the prior `finalized` event), apply patch fields onto the matching `EntityRow` (or the matching `ProseKernelRow` if `patch.prose` is present). Re-render the affected entity if it is the selected one.
- `edge-added { synthKey, from, to, relationship }`: insert a new `RelationshipRow` into local state. (Post-snapshot edges added by coherence pass.) Re-render the affected entities' relationship sections.
- `edge-removed { synthKey, reason }`: remove the `RelationshipRow` whose `synthKey` matches. Re-render.

The panel does not handle `entity-removed` post-snapshot because coherence pass does not delete entities — only modifies and adjusts relationships. If a future stage (or Scribe) introduces entity removal, the panel will need an `entity-removed` handler too; explicitly out of scope.

## Coverage / contract registrations

- `backend/src/contract/pipeline-events.ts`: change `entity-added` and `edge-added` shapes. No new arms.
- `backend/src/contract/backend-routes.ts`: add `{ method: 'GET', path: '/api/campaigns/:campaignId/world-snapshot' }`.
- `backend/src/contract/pipeline-routes.ts`: add `'GET /api/campaigns/:campaignId/world-snapshot'`.
- `backend/dev-tool/coverage.json`: add `'GET /api/campaigns/:campaignId/world-snapshot'` to `routes`.
- `backend/dev-tool/verify-registry.ts`: add `world-snapshot` panel with `exercises: [route('GET', '/api/campaigns/:campaignId/world-snapshot')]` and the `data-state` markers.

## Wiki updates

- `docs/wiki/content/runtime/world-gen.html`: add the `world_snapshot_ready` phase to the lifecycle narrative (between world_gen and world_ready); describe the snapshot endpoint as a member-only read surface; describe the post-snapshot delta channel (same SSE stream, coherence pass events flow as patches).
- `docs/wiki/content/runtime/dev-tool.html`: mention the new world-snapshot panel in the panel list and the lifecycle section.

## Testing

TDD-shaped per the standing rules. Each implementation task starts with a failing test.

### Streaming-extractor (`streaming-extractor.test.ts`)

- Third partial that adds `description` to a previously-emitted edge → expect `redisRealtime.publish` called exactly once for that synthKey (was 3 times pre-design).
- Second partial that adds `geography_summary` to a previously-emitted entity → expect no second publish for that synthKey.
- First partial with `{ name: "X" }` only → no publish (maturity gate).
- First partial with `{ name: "X", tone: "misted" }` → publish once with `{ type: 'entity-added', synthKey, entityKind, name: "X" }`. No `data` field on the published payload.
- Edge: first partial with `{ from: "A", to: "B", relationship: "located_in" }` → publish once with `{ type: 'edge-added', synthKey, from, to, relationship }`. No `description` field.

### Snapshot endpoint (`world-snapshot.test.ts`)

- 409 `snapshot_not_ready` when the latest `entity_relationships` pipeline_run is null, pending, in_progress, or failed.
- 200 with full payload when the run is `completed`.
- 403 `not_campaign_owner` for a non-owner member.
- 403 `not_campaign_member` for a stranger.
- Payload contains the world row, all entities (filtered by `world_id`), all facts (regardless of access_level for owner), all relationships joining set-internal entities, all prose kernels, all entity hierarchy rows, and only the stat blocks referenced by the world's entities.
- Zod schema round-trip: parsing the response with the schema succeeds; serialization → parse → equal.

### World-gen-processor (`world-gen-processor.test.ts`)

- After stage 4 commit, `redisRealtime.publish` is called with a `phase: world_snapshot_ready` event.
- After stage 7 commit, `phase: world_ready` is emitted (semantic preserved).
- Phase events are emitted post-COMMIT, not pre.

### Dev-tool snapshot inspector panel (`world-snapshot-panel.test.ts` + JSDOM verifier)

- Vitest: state machine transitions on simulated SSE events (`idle` → `loading` → `ready`); error path on simulated 4xx.
- JSDOM verifier: panel mounts, snapshot fetch succeeds, `data-state="ready"` reached; subsequent delta event mutates DOM (selected entity's name updates after an `entity-updated` event with a name patch).

### Existing tests requiring update

- Any test asserting against `entity-added.data` payload shape — update to assert `name`.
- Any test asserting against `edge-added.description` field — drop the assertion.
- Coherence-pass tests already use `entity-updated { patch: { name } }` and `entity-updated { patch: { prose } }` — unchanged.

## Out of scope (named for context)

- **Production frontend wiki UI** (React route + components): the dev-tool inspector is the only consumer of the snapshot endpoint in this ticket. The React wiki lands separately when the frontend stack is further along.
- **Scribe delta event arms** (`fact-added`, `fact-updated`, `fact-removed`, etc.): the transport (SSE + Redis channel) is reusable; the new event types and their producer/consumer wiring land with the Scribe ticket.
- **Random tables in the wiki**: per scoping, defer. When the wiki UX wants to render "encounter / loot tables," extend the snapshot shape.
- **Starting-situation reveal UX**: a separate flow opens the starting situation after the user finishes exploring. Outside this design.
- **Snapshot caching / ETag / If-None-Match**: the payload is small and fetched once per session; caching is YAGNI at launch scale.
- **Player-member filtered snapshot**: facts at `access_level: 'secret'` are visible to the owner only via this endpoint. A future filtered variant for non-owner members is outside scope.

## Open questions

None. All decisions captured in the brainstorm:

- Scope: backend + dev-tool snapshot inspector (not production frontend wiki).
- `entity-updated`: stays in the contract, fired only by coherence pass post-design.
- New phase arm: `world_snapshot_ready`.
- Snapshot shape: flat arrays, DB-mirror.
- Snapshot gate: strict 409 pre-readiness.
- Transport for post-snapshot deltas: existing SSE stream + Redis channel; no new infra.
