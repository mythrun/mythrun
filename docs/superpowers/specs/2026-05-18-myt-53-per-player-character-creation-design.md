# MYT-53: Per-player parallel character creation

## Lead

Mythrun's campaign-creation flow has five phases: pre-world-gen lobby → world generation → wiki read → per-player character creation → owner-gated cross-PC integration. MYT-53 owns the middle three steps: it lands the routes, worker pipeline, and data shapes that let multiple players each create their own character against an existing campaign, run those creations in parallel on the `campaign-setup` BullMQ queue, and integrate each player's PC into the world. Phase 1 (pre-world-gen lobby retrofit of `POST /api/campaigns`) is filed as bead `myth-0b2r`. Phase 5 (cross-PC integration + owner's "established relationships" prompt + barrier-gated post-creation stages) is MYT-54's scope.

This design also pins three deliberate simplifications surfaced during brainstorming: (a) starting situation is the owner's choice, applied to the entire party (different characters cannot have different starting situations and still play together); (b) character submission requires two text inputs — a character description ("who is this character?") and a situation-grounding text ("why is this character at this tavern?") — that together give the player agency on character *and* on entry-point motivation; (c) the order between owner-picks-situation and player-submits-character is strict, not permissive: until the owner has picked a starting situation, players cannot submit. The strictness eliminates a class of edge cases ("what if a player submitted before the owner picked?") and makes the frontend lobby flow trivial: until the owner has picked, players see a "waiting on owner" state.

Late joiners are accommodated by the same flow with a reworded second prompt ("describe the situation the party is in right now" instead of "describe how you got to the starting situation"). Backend identical; only the UI copy differs.

Guided character creation (D&D-Beyond-style step-by-step picker for race / class / background / abilities / spells / equipment) is fully out of scope for v1 but the POST endpoint's body shape is forward-compatible — a `guidedChoices` field is reserved on the request schema. A future bead adds the SRD reference data (races, classes, backgrounds, spell lists), the picker UI, and the deterministic-assembly paths in stages 2-3 without reshaping the endpoint.

## Trigger and scope

MYT-53 is the Prep Pipeline milestone's per-player parallel character-creation surface. Owner has already created a campaign (MYT-51), world-gen has completed (MYT-51 + the streaming stages from MYT-52), the wiki snapshot is fetchable (myth-exac). What's still missing for multiplayer campaigns to actually start is the connective tissue: invitees need to be able to submit characters, owner needs to be able to lock in a starting situation and trigger fan-out, the per-player stages need to run in parallel, and each PC needs to land in the world as a real entity with PC↔world relationships.

The ticket's nine new routes + the `campaign-setup` queue + the four character-creation stages per player are MYT-53's surface. The existing `pipeline_runs(stage, user_id)` keying (myth-51) supports per-player concurrent rows; the existing status panel (MYT-50) renders per-player progress because it already keys by `(stage, user_id)`. The existing `requireCampaignMember` middleware (MYT-38) handles auth.

## Goals and non-goals

**Goals:**

1. Members can submit a character (concept text + situation-grounding text) after world-gen completes and owner has picked a starting situation.
2. Owner can pick one of the three world-generated starting situations for the entire party.
3. Owner can trigger per-player parallel character creation. Fan-out enqueues `character-creation` jobs on the `campaign-setup` BullMQ queue, one per submitted member.
4. Each per-player job runs four stages (`location_selection` → `character_concept` → `character_sheet` → `character_integration`) and ends with the PC as a real entity in the world with PC↔world relationships and facts.
5. Late joiners (members who accept invite after the initial fan-out) can submit characters, and the owner can re-trigger fan-out to run their creation on a second pass.
6. The dev-tool exercises every new route + the BullMQ job per the standing coverage rule.
7. The request payload is forward-compatible with a future guided-character-creation flow (no reshape needed when guided ships).
8. Real-LLM E2E smoke verifies 2-3 dev-user characters created in parallel end-to-end before merging.

**Non-goals (deferred, each named):**

- **Pre-world-gen lobby** — retrofit of `POST /api/campaigns` into create-shell + submit-concept-later. Filed as bead `myth-0b2r`. Pick up between MYT-53 and MYT-54.
- **Cross-PC integration** — weaving PCs together via shared backstory, owner-provided "established relationships" prompt, barrier-gated post-creation stage. MYT-54.
- **Guided character creation** — D&D-Beyond-style step-by-step picker. Future bead (not yet filed); blocked on SRD reference data import. Forward-compat hooks live in MYT-53's POST body schema.
- **Concept media-inspirations** (guided-flow "submit media that inspired me") — pinned in the user's product vision but explicitly deferred.
- **Player session UX for mid-session late-joiners** — backend mechanism in MYT-53 supports late character creation any time; the UX of "your party is mid-dungeon and a new player drops in" is a session-runtime concern owned by whoever ships sessions.

## Architecture overview and data flow

```
                    ┌──────────────────────────────────────────────────┐
PHASE 2 (shipped):  │ POST /api/campaigns                              │
World generation    │   fires world-gen worker on the world-gen queue  │
                    │ SSE on /status/stream                            │
                    │ World snapshot ready (myth-exac)                 │
                    └──────────────────────────────────────────────────┘
                                          ↓
                    ┌──────────────────────────────────────────────────┐
PHASE 3 (shipped):  │ GET /world-snapshot                              │
Wiki read           │   Members read the world's wiki                  │
                    └──────────────────────────────────────────────────┘
                                          ↓
                    ┌──────────────────────────────────────────────────┐
PHASE 4 ★ MYT-53:   │ Step 1: Owner picks starting situation           │
Per-player char    │   POST /api/campaigns/:id/starting-situation     │
creation           │   campaigns.starting_situation_index ← {0,1,2}  │
                    │                                                  │
                    │ Step 2: Members submit characters                │
                    │   POST /api/campaigns/:id/characters             │
                    │   {conceptText, situationGroundingText}          │
                    │   character_concepts(campaign_id, user_id)       │
                    │   status='submitted'                             │
                    │   (re-POST allowed while still 'submitted')      │
                    │                                                  │
                    │ Step 3: Owner triggers fan-out                   │
                    │   POST /api/campaigns/:id/start-character-creation
                    │   Gate: situation chosen + ≥1 'submitted' row    │
                    │   Atomically flips matching rows → 'processing'  │
                    │   Enqueues per-player jobs on campaign-setup     │
                    │                                                  │
                    │ campaign-setup BullMQ queue (concurrency 5)      │
                    │   Each job: character-creation(campaignId,userId)│
                    │                                                  │
                    │   ├── 1. location_selection (no LLM)             │
                    │   │     reads campaigns.starting_situation_index │
                    │   │     defers fact-write to stage 4             │
                    │   ├── 2. character_concept (Sonnet)              │
                    │   │     generateObject; creates characters row   │
                    │   │     + campaign_characters join                │
                    │   ├── 3. character_sheet (Sonnet)                │
                    │   │     generateObject; fills character_skills /  │
                    │   │     character_features / character_equipment │
                    │   │     / character_spells                        │
                    │   └── 4. character_integration ★ stream (Opus)   │
                    │         streamObject; creates PC entities row   │
                    │         (entity_type='pc'), links                │
                    │         characters.entity_id, creates PC↔world   │
                    │         relationships + facts, writes the        │
                    │         deferred "starts at $location" fact      │
                    │         Streams entity-added + edge-added events │
                    │                                                  │
                    │ pipeline_runs.user_id distinguishes per-player   │
                    │ rows; status panel already renders per-player    │
                    │ progress.                                        │
                    └──────────────────────────────────────────────────┘
                                          ↓
PHASE 5 ▶ MYT-54   Owner-gated cross-PC integration + post-creation stages
PHASE 1 ▶ myth-0b2r Pre-world-gen lobby retrofit
```

### Components

**New files:**

- `backend/migrations/016_character_concepts.sql` — `character_concepts` table + `campaigns.starting_situation_index` column.
- `backend/src/repo/character-concepts.ts` — repo CRUD for the new table.
- `backend/src/repo/__tests__/character-concepts.test.ts` — integration tests.
- `backend/src/llm/prep/stages/location-selection.ts` — stage 1 handler (no LLM).
- `backend/src/llm/prep/stages/character-concept.ts` — stage 2 handler.
- `backend/src/llm/prep/stages/character-sheet.ts` — stage 3 handler.
- `backend/src/llm/prep/stages/character-integration.ts` — stage 4 handler (streaming).
- `backend/src/llm/prompts/prep/character-concept.txt` — stage 2 prompt.
- `backend/src/llm/prompts/prep/character-sheet.txt` — stage 3 prompt.
- `backend/src/llm/prompts/prep/character-integration.txt` — stage 4 prompt.
- `backend/src/llm/schemas/character-concept.ts` — Zod schemas for stage 2 output.
- `backend/src/llm/schemas/character-sheet.ts` — Zod schemas for stage 3 output.
- `backend/src/llm/schemas/character-integration.ts` — Zod schemas for stage 4 output.
- `backend/src/llm/prep/character-creation-processor.ts` — BullMQ processor (parallels world-gen-processor).
- `backend/src/routes/campaign-characters.ts` — eight new route handlers.
- `backend/src/routes/__tests__/campaign-characters.test.ts` — route tests.
- `backend/dev-tool/src/components/character-creation-panel.ts` — dev-tool panel for exercising the new routes.
- `docs/wiki/content/runtime/character-creation.html` — new wiki page documenting the pipeline.

**Modified files:**

- `backend/src/llm/prep/stages/starting-situation.ts` — extend stage output to emit a structured array of three situation entries (each with `index`, `locationEntityId`, `prose`) alongside the existing prose blob on `worlds.starting_situations`. The starting_situation stage already runs AFTER `locations_and_npcs` (per the pipeline order in the world-gen processor), so location entities exist by the time this stage runs. Resolution path from LLM-emitted `location_name` → `locationEntityId`: the handler performs a post-validate lookup against `entities WHERE world_id=$1 AND entity_type='location' AND name=$2` (case-insensitive). On miss, the handler retries the LLM with a `valid_location_names` constraint listing the actual entity names; on second miss, treats it as a stage failure (terminal). The Zod schema accepts `location_name` (text) from the LLM and the handler stamps `locationEntityId` on persistence.
- `backend/src/llm/schemas/starting-situation.ts` — extend Zod schema for the new structured field (LLM emits `{index, location_name, prose}`; handler stamps `locationEntityId` after lookup).
- The `worlds.starting_situation_entries jsonb` column is added in migration 016 alongside the `character_concepts` table — single migration, single push.
- `backend/src/routes/campaigns.ts` — extend `GET /api/campaigns/:campaignId` response to include `characters[]`.
- `backend/src/app.ts` — register the new route plugin + the new BullMQ processor.
- `backend/src/contract/pipeline-routes.ts` — register 8 new routes.
- `backend/src/contract/pipeline-jobs.ts` — register `character-creation` job.
- `backend/src/contract/backend-routes.ts` — register 8 new routes.
- `backend/dev-tool/src/main.ts` — mount the new panel.
- `backend/dev-tool/verify-registry.ts` — register the new panel.
- `backend/dev-tool/coverage.json` — update coverage manifest.

## Schema

### Migration 016 — `character_concepts` + starting-situation column

```sql
-- backend/migrations/016_character_concepts.sql
-- MYT-53: per-player character submission input. One row per
-- (campaign_id, user_id). Pre-fan-out it holds the player's input;
-- post-fan-out it tracks status. Consumed by the character-creation
-- worker on owner-triggered fan-out.

ALTER TABLE campaigns ADD COLUMN starting_situation_index SMALLINT
  CHECK (starting_situation_index IS NULL
         OR starting_situation_index BETWEEN 0 AND 2);

CREATE TABLE character_concepts (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Membership integrity: a character_concepts row only makes sense for
  -- a current member of the campaign. The composite FK ensures that if a
  -- member is removed from the campaign (campaign_members row deleted),
  -- their concept row cascades out too — no orphaned rows referencing
  -- non-members. campaign_members already has UNIQUE(campaign_id, user_id).
  FOREIGN KEY (campaign_id, user_id)
    REFERENCES campaign_members(campaign_id, user_id) ON DELETE CASCADE,

  -- Freeform mode input. The "who is this character?" half of the two-prompt
  -- model. NULL only when the player is purely-guided (future).
  concept_text TEXT
    CHECK (concept_text IS NULL OR length(concept_text) BETWEEN 20 AND 4000),

  -- "Why is this character at this tavern?" half. Always required in v1.
  -- Late-joiner UX reuses this field with a reworded prompt ("describe
  -- the situation the party is in right now").
  situation_grounding_text TEXT NOT NULL
    CHECK (length(situation_grounding_text) BETWEEN 20 AND 2000),

  -- Guided mode input. JSONB so the shape can evolve. Always {} in v1
  -- (forward-compat reservation for the guided-mode follow-on bead).
  guided_choices JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Submission lifecycle:
  --   'submitted'  — both texts present, awaiting owner fan-out trigger
  --   'processing' — character-creation worker has claimed this row
  --   'completed'  — all 4 stages succeeded; characters row exists
  --   'failed'     — terminal failure during creation; resubmit allowed
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'processing', 'completed', 'failed')),

  error JSONB,

  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(campaign_id, user_id)
);

CREATE INDEX idx_character_concepts_campaign_status
  ON character_concepts(campaign_id, status);

-- Mark each generated starting situation as a structured entry on the
-- world. The existing worlds.starting_situations prose blob stays; this
-- adds the structured array the GET /starting-situations endpoint needs.
ALTER TABLE worlds ADD COLUMN starting_situation_entries jsonb NOT NULL
  DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(starting_situation_entries) = 'array');

-- Extend the entities.entity_type CHECK to allow 'pc'. PCs are
-- conceptually distinct from NPCs (one is owned by a real user, the
-- other is purely game-fiction); reusing 'npc' would mean every
-- "list NPCs" path needs a PC-exclusion filter retrofit. Adding 'pc'
-- explicitly is one line in the migration and keeps consumer paths
-- clean. Stage 4 creates entities rows with entity_type='pc'.
ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_entity_type_check;
ALTER TABLE entities ADD CONSTRAINT entities_entity_type_check
  CHECK (entity_type IN ('npc', 'location', 'faction', 'item', 'pc'));
```

### Application-layer validation invariants

- POST `/characters` body validates BOTH `concept_text` (or `guided_choices`) AND `situation_grounding_text` present + length-bounded. Rejects at the route layer with 400 if missing.
- `campaigns.starting_situation_index IS NOT NULL` required at POST `/characters` time. 409 if not.
- Updates to text fields only allowed when current `status='submitted'`. Other states → 409. Re-POST after failure replaces the row and resets status to 'submitted'.
- `start-character-creation` gate: `campaigns.starting_situation_index IS NOT NULL` AND `≥1 character_concepts row with status='submitted' AND campaign_id=$1`. 409 with specific error code if either gate fails.

### Why a new table vs. extending campaign_members

- `campaign_members` is a join table; concept input is conceptually separate from membership.
- One row per `(campaign_id, user_id)` matches `campaign_members`'s grain exactly.
- Keeps the concept lifecycle (status, error, edits) self-contained rather than mixing with membership state.

### Forward-compat for guided mode

- `guided_choices JSONB` is reserved. The follow-on guided-mode bead populates it with a structured payload. No migration needed when guided ships.
- POST `/characters` body schema accepts the field as optional + `{}`-defaulted.

## Routes

Eight new routes plus one shape-extension on an existing route. Auth + rate-limit match the ticket.

### Owner-only routes

```
POST /api/campaigns/:campaignId/starting-situation
  Auth: requireCampaignMember(repo, 'owner')
  Rate: 5/min per-sub
  Body: { index: 0 | 1 | 2 }
  Errors:
    409 'world_not_complete'             — worlds.status !== 'complete'
    409 'situation_locked'               — any character_concepts row
                                           with status ∈ {'processing','completed'}
  Sets campaigns.starting_situation_index. Idempotent re-set allowed while
  all concepts are still 'submitted' or absent.

POST /api/campaigns/:campaignId/start-character-creation
  Auth: requireCampaignMember(repo, 'owner')
  Rate: 2/min per-sub
  Body: empty
  Logic:
    Query character_concepts WHERE campaign_id=$1 AND status='submitted'.
    Atomically flip all matching rows to status='processing'.
    Enqueue one character-creation job per row on campaign-setup queue.
  Response: { enqueued: [{ userId, jobId }] }
  Errors:
    409 'starting_situation_not_chosen'  — campaigns.starting_situation_index IS NULL
    409 'no_submitters'                  — zero rows in 'submitted'
  Idempotent under double-click: a second call enqueues for any new
  'submitted' rows (late-joiner case).

POST /api/campaigns/:campaignId/archive
  Auth: requireCampaignMember(repo, 'owner')
  Rate: 5/min per-sub
  Body: empty
  Flips campaigns.status: {'setup','active'} → 'archived'.
  (MYT-53 never advances campaigns past 'setup'; the trigger for
  'setup' → 'active' lives with the future multiplayer-runtime ticket.
  Until then, allowing 'setup' → 'archived' is the only path to a
  soft-delete; without it the route is dead code for every MYT-53 era
  campaign.)
  Errors: 409 'cannot_archive' from status='archived'.
```

### Member routes

```
POST /api/campaigns/:campaignId/characters
  Auth: requireCampaignMember(repo)
  Rate: 5/min per-sub
  Body:
    {
      conceptText?: string,            // 20-4000 chars; required unless guided
      guidedChoices?: object,          // future; {} in v1
      situationGroundingText: string,  // 20-2000 chars; always required
    }
  Validation:
    At least one of {conceptText, guidedChoices non-empty} must be present.
    campaigns.starting_situation_index IS NOT NULL required.
  Logic: UPSERT on (campaign_id, user_id). Allowed when current row's
    status='submitted' or row doesn't exist or status='failed'
    (failed→submitted resets the row). Disallowed for 'processing'
    or 'completed' (409 'concept_locked').
  Response: { conceptId, status: 'submitted' }
  Errors:
    409 'world_not_complete'             — worlds.status !== 'complete'
    409 'starting_situation_not_chosen'  — campaigns.starting_situation_index IS NULL
    409 'concept_locked'                 — status ∈ {'processing','completed'}

GET /api/campaigns/:campaignId/starting-situations
  Auth: requireCampaignMember(repo)
  Rate: 30/min per-IP
  Response:
    {
      situations: [
        { index, locationEntityId, prose }, ...   // 3 entries from worlds.starting_situation_entries
      ],
      chosenIndex: number | null,                  // campaigns.starting_situation_index
    }
  404 'world_not_ready' if worlds.starting_situation_entries is empty
  (world-gen's starting_situation stage hasn't completed yet).

GET /api/campaigns/:campaignId/characters
  Auth: requireCampaignMember(repo)
  Rate: 30/min per-IP
  Response:
    {
      members: [
        {
          userId,
          displayName,
          conceptStatus: 'none' | 'submitted' | 'processing' | 'completed' | 'failed',
          characterId?: UUID,
        }, ...
      ],
    }
  conceptStatus='none' for members who joined but haven't submitted yet.

GET /api/campaigns/:campaignId/characters/:charId
  Auth: requireCampaignMember(repo)
  Rate: 30/min per-IP
  Response: the portable character + skills + features + equipment + spells.
  404 if charId not in this campaign.

GET /api/campaigns/:campaignId/hierarchy
  Auth: requireCampaignMember(repo)
  Rate: 30/min per-IP
  Response: { hierarchy: EntityHierarchyRow[] }
  Tier-filtered (known-only for default; bypass widens) per myth-exac's filter logic.

GET /api/campaigns/:campaignId/random-tables
  Auth: requireCampaignMember(repo)
  Rate: 30/min per-IP
  Response: { tables: RandomTable[] }
  World-gen stage 6 output.
```

### Shape-extension on existing route

```
GET /api/campaigns/:campaignId  (shipped MYT-51)
  Response extended to include:
    characters: [{ userId, characterId, name, /* portable summary */ }]
  Resolves character_concepts.status='completed' rows + their joined
  characters rows.
```

### Cross-cutting

- All POST endpoints that mutate state require `worlds.status='complete'` (gate-equivalent to "wiki readable").
- All eight new routes register in `pipeline-routes.ts` so the route audit catches missing wires.
- Auth uses existing `requireCampaignMember(repo, role)` middleware (MYT-38).
- All routes carry `config.pipelineRoute = true` for the route-audit invariant.

## Worker — `campaign-setup` queue: `character-creation` job

### Job shape

```typescript
interface CharacterCreationJobPayload {
  campaignId: string;
  userId: string;
}

// One job per (campaign, user) pair. N players → N parallel jobs.
// Queue concurrency: 5 (matches existing infra).
```

### Processor

`backend/src/llm/prep/character-creation-processor.ts` — parallels `world-gen-processor.ts`:
- Outer scope owns transaction lifecycle (BEGIN / COMMIT / ROLLBACK + post-COMMIT event publish).
- `atomicClaimStage` keyed on `(world_id, stage, user_id)`. The existing helper in `world-gen-processor.ts:326-386` hardcodes `user_id IS NULL` in its non-conflict paths — that branch claims world-level stages. The character-creation processor needs the same atomic-claim semantics with `user_id = $userId` instead. Two options: (a) parameterize the existing helper on a user_id (preferred — single source of truth for claim logic), or (b) extract the claim primitive into a shared module that both processors import. Plan picks (a) and updates the existing helper to accept an optional `userId` arg, defaulting to NULL for world-level claims.
- `isTerminalError(err)` (myth-uppw) classifies LLM errors: terminal arms abort with `stage-failed willRetry:false`; retryable arms throw and BullMQ retry fires.
- Per-player failure does NOT abort other parallel jobs.
- On all four stages succeeding: `UPDATE character_concepts SET status='completed' WHERE id=$1`.
- On terminal failure: `UPDATE character_concepts SET status='failed', error=$1 WHERE id=$2`.
- Events published per-player on the existing campaign-scoped channel `{redisKeyPrefix}pipeline:campaign:{campaignId}`. Each event carries `user_id` so subscribers can route per-player.

### Recovery contract for stranded rows

`POST /start-character-creation` is not atomic across the DB UPDATE (`status='processing'`) and the BullMQ enqueue. Two failure modes to bound:

1. **DB UPDATE succeeds, BullMQ enqueue fails.** Some rows are now `'processing'` with no job to advance them. The handler runs the enqueue inside the same transaction as the UPDATE — `BEGIN; UPDATE …; <enqueue>; COMMIT`. If the enqueue throws, the UPDATE rolls back; the rows stay `'submitted'` and the owner retries. (BullMQ's `add()` returns a Promise that resolves before the job is durable in Redis, so we cannot make this fully atomic — but a retry from the owner is the supported recovery path. The 409 'no_submitters' arm of `start-character-creation` is the gate: a second click is always safe.)
2. **DB UPDATE succeeds + BullMQ enqueue succeeds, but worker crashes before claiming the stage.** The character_concepts row sits in `'processing'` with a queued (or in-progress and abandoned) job. Recovery: existing BullMQ retry semantics fire (3 attempts with exponential backoff per existing infra defaults). On all attempts failing, BullMQ marks the job `failed` and the existing failed-job inspector path (myth-uppw) sets `character_concepts.status='failed'`. The owner can then re-trigger `/start-character-creation` for any row a player re-submits.

Both paths are operationally observable via the existing `pipeline_runs` view: rows in `'processing'` older than the queue's job timeout (60s currently) are the candidate set for ops review. No new alert in MYT-53; reuse the existing prep-pipeline ops surface.

### Stages

```
1. location_selection (no LLM, ~0.1s)
   Reads campaigns.starting_situation_index. Resolves to a location
   entity_id via worlds.starting_situation_entries[index].locationEntityId.
   Validates that the location entity still exists (defensive against
   campaign state drift). DEFERS the actual fact write to stage 4 (the
   PC entity doesn't exist until stage 4). Stage 4 re-derives the
   location_entity_id by re-querying the same path — no inter-stage
   handoff column needed (pipeline_runs has no metadata column, and
   adding one for a single deferred id is overkill when the source
   record is stable).

2. character_concept (Sonnet generateObject, ~5-10s, ~$0.02 per player)
   Input:
     - character_concepts.concept_text (freeform mode)
     - character_concepts.guided_choices (v1+ guided mode, accepted verbatim)
     - World snapshot (tone, themes, era, key tensions, geography summary,
       starting situation prose for context)
   Output: the narrative half of the character only:
     - name, race, class, background
     - alignment, age, gender, physical description blurb
     - personality traits, ideals, bonds, flaws
     - backstory paragraph
   Persists: writes the narrative-half payload to a transient field on
   the worker (in-job context). Does NOT yet INSERT into the `characters`
   table — `characters` has NOT NULL ability scores + HP + AC + proficiency
   that the mechanical stage 3 generates. Inserting at stage 2 would
   violate the NOT NULL constraints; we wait for stage 3 to assemble the
   full row.

3. character_sheet (Sonnet generateObject, ~10-20s, ~$0.04 per player)
   Input: stage 2's narrative-half payload + world snapshot.
   Output: ability scores (str/dex/con/int/wis/cha), derived hit_points /
   max_hit_points / armor_class / proficiency_bonus, plus character_skills[],
   character_features[], character_equipment[], character_spells[] rows.
   Bounded D&D 5e SRD-compliant.
   Persists, in a single transaction:
     - INSERT into `characters` (narrative-half from stage 2 + mechanicals
       from stage 3) — characters.entity_id is NULL until stage 4 fills it.
     - INSERT into `campaign_characters` joining (campaign_id, user_id,
       characters.id).
     - Bulk INSERT into the four sub-tables (skills/features/equipment/spells).
   This is the only stage that writes to `characters` + `campaign_characters`.

4. character_integration ★ streams (Opus streamObject, ~15-30s, ~$0.10 per player)
   Input:
     - characters row from stage 3 (fully populated, mechanics + narrative)
     - character_concepts.situation_grounding_text
     - Chosen starting situation entry (re-derived: read
       campaigns.starting_situation_index, look up
       worlds.starting_situation_entries[index] for both `prose` and
       `locationEntityId`)
     - Relevant world entities (entity_type IN ('faction','location','npc'))
   Output:
     - PC entities row (entity_type='pc', name from characters.name,
       access_level='known')
     - characters.entity_id ← PC entity id
     - PC↔world relationships (rows in relationships table; PC as source
       OR target depending on relationship_type semantics)
     - PC↔world facts (rows in facts table tagged with PC entity_id, e.g.,
       "Bran owes a debt to the merchant Vorrel", "Mira was apprenticed at
       the Bone Sept in her youth")
     - The deferred "starts at $location" fact from stage 1 — written as a
       row in facts table tagged with PC entity_id
   Streaming: emits entity-added events when the PC entity is created;
   emits edge-added events for PC↔world relationships as they're written.
   Subscribers see PC nodes join the live graph.

   ★ THIS IS PER-PLAYER ONLY. Cross-PC relationships (PC↔PC) are NOT
   in scope here. MYT-54 handles those after all per-player jobs complete.

Total expected cost per player: ~$0.50 (Opus for stage 4, Sonnet for
stages 2-3; stages 1 is no-LLM).
```

### Per-stage cost frame

Sonnet $3/$15 per MTok in/out; Opus $15/$75:

| Stage | Model | ~Input | ~Output | Cost |
|---|---|---|---|---|
| 1. location_selection | none | n/a | n/a | $0 |
| 2. character_concept | Sonnet | 2K | 1K | ~$0.02 |
| 3. character_sheet | Sonnet | 2K | 2K | ~$0.04 |
| 4. character_integration | Opus | 2K | 1K | ~$0.10 |
| **Total per player (point estimate)** | | | | **~$0.16** |

The point estimate assumes minimal input context. Real per-player cost rises if the world snapshot input is substantial (full snapshot can run 8-15K input tokens), the player's `situation_grounding_text` is at the upper bound, or stage 4's output is reasoning-heavy. Realistic per-player range is **$0.20-$0.50** depending on world size + player text length. The cost-cap default ($5.00 per campaign) gives ~10 players of headroom at the realistic upper end, which matches the multiplayer concurrency target (5 player default, up to ~8 for a single party).

For a 5-player campaign: ~$0.80 of character creation on top of ~$1 of world-gen. Well within the world_gen credit budget.

(Note: this revised cost estimate replaces the brainstorm's earlier mistaken $1.50/player anchor. The revised number reflects character output being ~1/10 the content volume of a world, and using Sonnet for the mechanical stages 2-3.)

### Model-tier rationale

The parent spec (`docs/specs/2026-04-13-world-campaign-pipeline.md` §4) sketches all four stages as Opus. MYT-53 demotes stages 2-3 to Sonnet for cost reasons (~3x cheaper input, 5x cheaper output) and keeps stage 4 on Opus. The rationale:

- **Stages 2-3 are bounded structured output.** Stage 2 produces an MYT-48 portable-character payload (name + race + class + background + traits + a backstory paragraph); stage 3 produces D&D 5e SRD mechanical rows. Sonnet handles bounded structured output reliably (validated through prep-pipeline stages 4, 6, 7).
- **Stage 4 is the load-bearing PC↔world integration.** It receives the world snapshot, the player's situation_grounding_text, and the chosen starting situation, and produces a coherent narrative weave (PC↔world relationships + facts tagged with the PC entity). It also streams (★) for SSE consumption. The narrative judgment + cross-reference work matches the Slow Thinker role spec; Opus is the right tier here.
- **The only streaming stage is also the most expensive.** Opus + streamObject is the existing pattern from MYT-52's streaming stages (concept_intake, world_and_factions, locations_and_npcs); stage 4 reuses that wiring.

If stage 4 outputs degrade under Opus pricing pressure, the fallback is Sonnet-with-stronger-prompting; we do not down-tier preemptively.

### Cost-cap coverage

The existing `cost-cap.ts` aggregation (`backend/src/llm/prep/cost-cap.ts`) filters `WHERE world_id = $1 AND user_id IS NULL AND status = 'completed'` and was designed for the world-gen cap. Per-player character-creation rows are keyed on `campaign_id` (per the derive-phase convention at `backend/src/sse/derive-phase.ts:56`) and carry `user_id`, so they're excluded from the world-gen aggregation by both filters. MYT-53 extends `cost-cap.ts` to add a parallel `sumCharacterCreationStageCosts(campaignId)` aggregation that filters `WHERE campaign_id = $1 AND user_id IS NOT NULL AND status = 'completed'` and a new `settings.character_creation_cost_cap_usd` row (default `$5.00` — covers ~10 players at the per-player frame above, with headroom). The cap is checked at the start of each per-player job; over-cap aborts the player's stages with `stage-failed` and a specific `character_creation_cost_cap_exceeded` reason. This keeps character-creation cost-bounded on the happy path and prevents an unbounded uncap from a runaway prompt-regression.

## Lifecycle and late joiners

### Permissive membership lifecycle

- Members join via `POST /api/invites/:inviteCode/accept` any time (shipped MYT-38).
- Once joined, members can read all GET routes for the campaign.
- Members can submit a character (POST `/characters`) as soon as:
  - `worlds.status = 'complete'`
  - `campaigns.starting_situation_index IS NOT NULL`
  Until both conditions, POST `/characters` returns 409 with the specific gate code.
- Once `character_concepts.status` flips to `'submitted'`, the player can re-POST to update prose. Disallowed for `'processing'` / `'completed'` (409 'concept_locked').
- Owner triggers `POST /start-character-creation` any time, idempotent under repeat. Each call enqueues for whatever's currently in `'submitted'`.

### Re-submit after failure — cleanup contract

A character_concepts row in `status='failed'` may be reset to `'submitted'` by re-POSTing `/characters` (validated and length-bounded same as initial submission). The processor's re-run is idempotent on a per-stage basis, NOT a delete-and-recreate:

- Re-run treats `characters` row + `campaign_characters` join as existing-already if `stage 3` previously succeeded. Stage 3 detects an existing characters row for `(campaign_id, user_id)` and short-circuits to UPDATE-not-INSERT semantics; the four sub-tables (skills/features/equipment/spells) are TRUNCATE-by-character-id then re-INSERT.
- Stage 4 detects an existing `characters.entity_id` and skips the entity creation; PC↔world relationships + facts are TRUNCATE-by-entity-id then re-INSERT.
- This avoids `UNIQUE(campaign_id, user_id)` collisions on `campaign_characters` and `UNIQUE(world_id, name)` on `entities` while keeping the re-run idempotent.
- If the player wants a clean slate (different character name/race/class), they DELETE the row via the dev-tool or admin path (no member-facing DELETE in v1; failed→resubmit is the supported flow).

### Late-joiner mechanics

The same flow accommodates members who accept invites mid- or post- initial-fan-out:

1. Late member accepts invite. Their `campaign_members` row exists; no `character_concepts` row yet.
2. Late member POSTs `/characters`. New `character_concepts` row created, `status='submitted'`.
3. Owner POSTs `/start-character-creation`. Atomic claim flips the late-joiner's row to `'processing'`, enqueues their job. (Already-`processing` and `completed` rows are skipped by the WHERE clause.)
4. Late-joiner's character creation runs in parallel with any other in-flight jobs.

Frontend UX nuance handled in copy, not backend: the question "describe how you got to this starting situation" reframes for late joiners as "describe the situation the party is in right now." Both forms map to the same `situation_grounding_text` field.

### Campaign status transitions

- `'setup'` (default at create): pre-fan-out. World-gen may be running or complete. Characters may or may not exist.
- `'active'`: post-character-creation. The trigger for the `'setup'` → `'active'` flip is out of scope here — that decision lives with whichever future ticket ships sessions/play (likely the multiplayer-runtime ticket). For MYT-53's purposes, the campaign remains in `'setup'` after character creation completes; no state machine in this scope flips it.
- `'archived'`: soft-deleted via `POST /archive`. From `'active'` only.

## Backstory and situation-grounding semantics

### The two-prompt model

The character-submission body has two load-bearing text fields:

- **`conceptText`** (or `guidedChoices` for the v1+ guided path): "Who is this character?" — identity, race, class, background, personality, backstory. The character_concept stage (stage 2) consumes it.

- **`situationGroundingText`**: "Why is this character at this tavern?" — the player's framing of how their PC arrived at the chosen starting situation. The character_integration stage (stage 4) consumes it.

The separation gives players agency on both axes: who the PC is, AND how the PC connects to the campaign's opening. Without the grounding prompt, character_integration's stage 4 has only a generic "introduce this PC to the world" prompt to work with; with it, stage 4 has the player's specific entry-point narrative to weave through the PC's facts and PC↔world relationships.

### Late-joiner reframing (frontend only)

For new members joining after sessions have begun, the second prompt reframes:

- Initial cohort prompt: "Describe how your character ended up at this starting situation."
- Late-joiner prompt: "Describe the situation the party is currently in and how your character fits."

Backend is identical — both map to `situation_grounding_text`. The reframing is a frontend copy decision.

### Cross-PC backstory entanglement (MYT-54, not MYT-53)

Players sometimes want explicit cross-character relationships ("we're siblings," "I owe him money"). This is MYT-54's territory:

- MYT-54 adds a post-fan-out barrier that waits for all per-player jobs to complete.
- MYT-54 adds an owner-only prompt at fan-out time: "any established relationships between characters to give the LLM upfront?"
- MYT-54 's cross-PC integration stage reads the established-relationships input + all PCs and writes cross-PC relationship edges + cross-references in facts.

MYT-53's `character_integration` stage is per-player and only handles PC↔world links. The data structures are designed so MYT-54 can layer cross-PC work on top without reshaping MYT-53's per-player output.

## Dev-tool surface

Tests the new routes against the live backend per the existing dev-tool conventions (`backend/dev-tool/AUTHORING.md`).

**New panel `character-creation`** (separate from `campaign-details`; the panel pattern is "event-driven" — binds to `mythrun.watchcampaign` for context, then fires fetches against the new routes):

- Per-member roster: name + concept_text status + grounding_text status + character_creation pipeline status.
- Live SSE updates as members submit, stages complete.
- Owner-only action buttons:
  - "Pick starting situation" — dropdown of three options (resolved from `GET /starting-situations`), POSTs `/starting-situation`.
  - "Start character creation" — POSTs `/start-character-creation`.
- Member submission flow exercised via the existing identity switcher: cycle dev-user-N, each POSTs `/characters` with their two-text pair.

**Coverage manifest:**

- 8 new routes registered in `BACKEND_ROUTES`.
- 1 new BullMQ job kind `character-creation` registered in `pipeline-jobs.ts`.
- Panel registered in `verify-registry.ts` with the appropriate interaction pattern (action-only + event-driven).

**XSS safety:** the panel renders user-submitted text (concept_text + situation_grounding_text). All text goes through `el.textContent`, never `innerHTML`. Same convention as the world-snapshot Glossary panel.

## Out of scope (deferred, named)

- **Phase 1 — pre-world-gen lobby retrofit of `POST /api/campaigns`.** Bead `myth-0b2r`. Picks up between MYT-53 and MYT-54.
- **Phase 5 — cross-PC integration + owner's established-relationships prompt + barrier-gated post-creation stage.** MYT-54.
- **Guided character creation** — D&D-Beyond-style step-by-step picker. Future bead (not yet filed); blocked on SRD reference data import (races, classes, backgrounds, spell lists, ability score generators). Forward-compat hooks live in MYT-53's POST body schema.
- **Concept media-inspirations** — pinned in the user's product vision but explicitly deferred. Players coordinate off-line.
- **Player session UX for mid-session late-joiners** — backend mechanism supports late character creation any time; the UX of "your party is mid-dungeon and a new player drops in" is a session-runtime concern.
- **Campaign status transition trigger** (`'setup'` → `'active'`) — happens at session start, out of scope here. Campaign stays in `'setup'` after character creation in MYT-53.

## Testing strategy

TDD per CLAUDE.md and superpowers. Three tiers:

### Unit-level

1. **`character-concepts` repo** (mocked Pool): UPSERT semantics, status transitions, 409 arms.
2. **Zod schemas** (`character-concept`, `character-sheet`, `character-integration`): bound rejection, enum rejection, required-field rejection.
3. **Route validation helpers**: situation-chosen gate, both-texts-present gate, concept-status gate.

### Handler-level (mocked SDK)

4. **`location-selection.ts`** handler: resolves `campaigns.starting_situation_index` to a location entity_id via `worlds.starting_situation_entries[index]`; validates the entity exists; emits a `stage-completed` event. Writes nothing — stage 4 re-derives the same id when it writes the deferred fact.
5. **`character-concept.ts`** handler: mocked Sonnet returns valid narrative-half payload; handler holds it for stage 3 (no DB writes yet — stage 3 owns the characters INSERT because `characters` has NOT NULL mechanicals).
6. **`character-sheet.ts`** handler: mocked Sonnet returns valid ability scores + sheet rows; handler INSERTs `characters` (narrative + mechanics together) + `campaign_characters` join, then bulk-inserts into 4 sub-tables. Re-run test: when characters row exists for `(campaign_id, user_id)`, handler UPDATE-not-INSERTs and TRUNCATEs sub-tables before re-INSERT (per the re-submit cleanup contract).
7. **`character-integration.ts`** handler: mocked Opus stream emits PC entity + relationships + facts; handler persists; emits SSE events. Tests the deferred-fact write (the "starts at $location" fact, re-derived from `campaigns.starting_situation_index` + `worlds.starting_situation_entries`). Re-run test: when `characters.entity_id` is already set, handler skips entity creation + TRUNCATEs PC-tagged relationships/facts before re-INSERT.

### Integration-level (real Postgres, mocked SDK)

8. **End-to-end per-player job** through all four stages. Uses real DB transactions.
9. **Parallel-job isolation**: two jobs running concurrently for different `user_id`s don't interfere on `pipeline_runs` claims.
10. **Late-joiner case**: triggers initial fan-out with 2 members, then 3rd member submits, triggers second fan-out, verifies only the new member's job runs.
11. **Status transitions on failure**: terminal error → `character_concepts.status='failed'`, error JSON populated, replay-resubmit works.

### Route-level

12. **POST `/characters`** validation arms: missing texts, situation not chosen, status conflicts, length bounds.
13. **POST `/starting-situation`** owner-only gate, lock when any concept is `'processing'`.
14. **POST `/start-character-creation`** fan-out logic, idempotency, late-joiner re-trigger.
15. **GET `/characters`** roster shape.

### Real-LLM E2E smoke (push-time, dev-tool-verifier subagent)

Per `feedback_dev_tool_e2e_smoke_required`:

- Drive 2-3 dev-users through the full flow: accept invite → submit concept+grounding → owner picks situation → owner triggers fan-out → wait for `stage-completed` events on all per-player jobs.
- Inspect DB: `characters` rows per user, `character_skills` / `_features` / `_equipment` / `_spells` populated, PC entities linked via `characters.entity_id`, PC↔world relationships present, `character_concepts.status='completed'` for all.
- No untrapped 5xx in backend logs.

Coverage threshold: 100% line + branch per pre-push gate.

## Observability

- `pipeline_runs.cost_usd` per stage (existing pattern). Per-player rows distinguished by `user_id`.
- Structured logs on stage completion: `{event: 'character.<stage>.completed', campaignId, userId, durationMs, costUsd}`.
- The existing campaign-scoped SSE channel carries per-player events; subscribers can route by `user_id` payload.
- No new metric backend.

## Rollout and migration sequencing

Single push, batched per `feedback_pushes_are_expensive`:

1. **Migration 016**: `character_concepts` table (with composite FK to `campaign_members`) + `campaigns.starting_situation_index` column + `worlds.starting_situation_entries` jsonb column + extend `entities.entity_type` CHECK to allow `'pc'`.
2. **`starting_situation` stage extension**: emit the structured `starting_situation_entries` array (in addition to the existing prose blob).
3. **`character-concepts` repo + tests**.
4. **Stage handlers** (location-selection, character-concept, character-sheet, character-integration) with mocked-SDK tests.
5. **`character-creation-processor`** + BullMQ job registration.
6. **Eight new route handlers** + tests.
7. **`GET /api/campaigns/:id`** response-shape extension to include `characters[]`.
8. **Contract registrations** (`pipeline-routes.ts`, `pipeline-jobs.ts`, `backend-routes.ts`).
9. **Dev-tool panel** + verify-registry entry + coverage manifest.
10. **Wiki update** (`docs/wiki/content/runtime/character-creation.html` new page) in the same push per `feedback_wiki_sync_is_part_of_close`.
11. **Real-LLM E2E smoke** before push (dev-tool-verifier subagent per the push-time hook).

## Risks and open items

1. **`starting_situation_entries` extraction.** The starting_situation stage currently writes prose. Extending it to also emit a structured array of three entries (with `index`, `locationEntityId`, `prose`) requires updating the stage's Zod schema, prompt, and persistence path. Risk: small backwards-compat break if any consumer of the prose blob also reads from the structured field expecting it to exist on already-generated worlds. Mitigation: default empty `[]`, and the `GET /starting-situations` endpoint 404s with `'world_not_ready'` if empty (a clear contract for clients).

2. **Cost overhead.** Per-player ~$0.16 × 5 players = ~$0.80 character-creation cost on top of ~$1 world-gen. Within budget. The new `sumCharacterCreationStageCosts` aggregation in `cost-cap.ts` (see §Cost-cap coverage) gates each per-player job against `settings.character_creation_cost_cap_usd` (default $5.00) so a runaway prompt-regression aborts cleanly rather than billing unboundedly.

3. **Stage-1-to-stage-4 location reference.** Stage 1 resolves the location entity_id and validates it exists; stage 4 re-derives the same id from the same source records (`campaigns.starting_situation_index` + `worlds.starting_situation_entries`) to write the "starts at $location" fact. No inter-stage handoff column is needed; the source records are immutable for the duration of a per-player job, and stage 1's existence-check covers the once-per-job drift case.

4. **Late-joiner fan-out and the existing world-gen pipeline phase.** A late joiner's `character_creation` job runs in the `campaign-setup` queue (not `world-gen`), so doesn't interfere with the world-gen pipeline. Their per-player rows in `pipeline_runs` are tagged with `user_id`, so the derive-phase logic (which already separates worldgen / charcreation / postcreation scopes per `derive-phase.ts`) handles them cleanly.

5. **Empty `character_concepts.guided_choices` semantically.** v1 ships with the field always `{}`. Risk that consumers read it as "guided mode" when it's empty. Mitigation: explicit "has-guided-choices" predicate in code, never check truthiness on the JSONB directly.

6. **Real-LLM smoke flakiness.** The smoke depends on Sonnet/Opus consistently producing valid character_concept + character_sheet + character_integration outputs. Less flaky than world-gen (smaller output, fewer cross-references), but still subject to the same wrapper bugs that surfaced during myth-pfke. The wrapper-fix from myth-pfke (commit c302ef3) addresses the worst of those.

## Open items (none blocking implementation)

None at this time. Brainstorm resolved scope split, lifecycle model, schema, the two-prompt model, starting-situation owner-only gating, late-joiner reframing, model tier per stage, and forward-compat reservations for guided mode. Plan-writing can proceed.
