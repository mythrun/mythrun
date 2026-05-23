# MYT-54: Character integration — single-pass world weaving

## Lead

When the owner is satisfied that the right players have submitted character concepts, they hit "integrate characters." A single Opus call sees the full world plus every PC's structured concept output plus owner-provided pre-integration notes, and emits the integrated entities + relationships for the whole party in one structured response. Then `campaigns.status` flips to `active`.

This supersedes §4 ("Post-Creation Stages") and the multi-PC-related notes in §10 of `docs/specs/2026-04-13-world-campaign-pipeline.md`. Brainstorming on 2026-05-23 collapsed the original "fan-out barrier + `materialize_relationships` (no LLM) + `continuity_check` (Opus) + WorldFix operations engine" architecture. The no-LLM relationship-materialization step duplicated what the existing `entity_relationships` stage already does with an LLM (and violated ZFC). The continuity-check pass duplicated what character-integration is itself meant to do (resolve PCs against the world). One LLM pass with the whole party in context replaces both.

## Relationship to MYT-53 (stage-4 retirement)

MYT-53 shipped a per-player `character_integration` stage (stage 4 of its 4-stage per-player pipeline) that creates the PC `entities` row, sets `characters.entity_id`, and writes PC↔world facts + relationships at concept-completion time. **This stage is retired by this issue.** Concretely:

- MYT-53's per-player pipeline ends at `character_sheet` (stage 3). After stage 3, `character_concepts.status` flips to `'completed'`, which now means "sheet ready, awaiting cross-PC integration" — NOT "PC entity exists in the world."
- The shipped per-player `character_integration` stage code (`backend/src/llm/prep/stages/character-integration.ts`), prompt (`backend/src/llm/prompts/prep/character-integration.txt`), and schema (`backend/src/llm/schemas/character-integration.ts`) are **kept as starting points** for the MYT-54 rewrite — same stage NAME, same file paths, but the worker call site, prompt, and schema get rewritten for the whole-party shape. The single-PC version disappears.
- The per-player `pipeline_runs` rows previously written by MYT-53 stage 4 stop appearing. The new MYT-54 stage writes ONE `pipeline_runs` row per campaign with `user_id = NULL` (mirrors world-gen rows).
- `derive-phase.ts`'s `POSTCREATION_STAGES` constant gets replaced (the two old stage names — `materialize_relationships`, `continuity_check` — are gone). A single new value enters the relevant phase taxonomy; pick `'character_integration'` so the stage name is preserved, and add a corresponding phase `'integrating'` (or reuse `'post_creation'` — pick during planning).
- Anything in `backend/src/routes/campaigns.ts` (or elsewhere) that filters `character_concepts.status = 'completed'` to populate a "PCs in campaign" view must be amended to also include `'integrated'` once MYT-54 ships. Notable: the `GET /api/campaigns/:campaignId` characters[] field at `campaigns.ts:539`.

## Trigger and scope

In-scope:
- `POST /api/campaigns/:campaignId/finalize-character-creation` — owner-triggered.
- `GET /api/campaigns/:campaignId/character-creation-progress` — visible to all members.
- New column `campaigns.pre_integration_notes TEXT NULL`.
- Single `character_integration` job on the `campaign-setup` BullMQ queue (replaces the per-player stage; same name, new shape).
- Full rewrite of `backend/src/llm/prompts/prep/character-integration.txt` for whole-party single-pass shape, including owner notes.
- Full rewrite of `backend/src/llm/schemas/character-integration.ts` and `backend/src/llm/prep/stages/character-integration.ts`.
- Removal of MYT-53's per-player `character_integration` stage from `character-creation-processor.ts`'s stage list.
- Extract the world-dump assembly (`loadWorldInventory` + `renderWorldDump`) from `coherence-pass.ts` into a shared module so MYT-54 can reuse it.
- Update `backend/src/sse/derive-phase.ts`'s stage taxonomy.
- Update `backend/src/contract/pipeline-routes.ts` (the 2 new routes) and `backend/src/contract/pipeline-jobs.ts` (the new job-kind registration, if the existing `character-creation` kind doesn't cover this — the integration job is campaign-scoped, not player-scoped, so it likely needs a sibling kind `character-integration`).
- Update `backend/src/contract/backend-routes.ts` (2 new routes).
- Dev tool: two new panels (progress + finalize) plus PCs naturally appearing in existing graph panels.
- Migration `018_character_integration.sql` (017 is `entity_consolidation`).
- Cost-cap extension: amend `sumCharacterCreationStageCosts(campaignId)` to also include the new campaign-scoped row.
- Amend `GET /api/campaigns/:campaignId` characters[] filter to include `'integrated'`.
- Wiki page covering character integration.

Out of scope (deferred, named):
- Eval harness for prompt quality — ad-hoc scripts during dev. Separate ticket later.
- Per-PC retry UX after integration. Failed integration re-triggers from the campaign-scoped `pipeline_runs` claim; the dev tool's surface is the same generic "re-enqueue" affordance as other stages.
- Owner-defined PC↔PC relationships beyond a free-text prompt prelude. No structured table.
- Late-joiner reconciliation after `active`. Existing MYT-53 late-joiner path covers post-`active` concept submission but does NOT cross-weave with the already-integrated party — a noted gap, separate follow-up bead.
- `characters.entity_id` re-port semantics (clobbered when a character is ported into a second campaign). Acknowledged in parent pipeline spec; out of scope here.

## Goals and non-goals

Goal: from "owner finalizes" to `campaigns.status = 'active'` is one LLM call and one DB transaction, with the integration LLM seeing the entire party at once for maximum cross-PC coherence.

Non-goal: per-player integration LLM calls. Replaced by the single whole-party pass.

Non-goal: a structured PC↔PC relationship-definition UI. Free text suffices: "Player A and Player B are siblings; both estranged from their merchant father" goes verbatim into the prompt header.

## Architecture overview and data flow

```
Owner → POST /finalize-character-creation { pre_integration_notes: TEXT | null }
        ↓
        (route: transactional UPDATE + enqueue)
        ↓
campaign-setup queue: character-integration job { campaignId, ownerUserId }
        ↓
        worker
          1. Atomically claim pipeline_runs (campaign-scope, user_id=NULL, stage='character_integration')
          2. SELECT * FROM character_concepts WHERE campaign_id = $1 AND status = 'completed'
             (joined with users for display_name, with character_sheets for race/class/etc.)
          3. SELECT campaigns.pre_integration_notes + worlds.starting_situation_entries[index] FROM ...
          4. Load world dump via the shared assembly (extracted from coherence-pass)
          5. Render character-integration.txt with: worldDump + party (pre-rendered string) + preIntegrationNotes + startingSituationProse
          6. Opus generateObject(IntegrationResultSchema, maxRetries: 0, repairStrategy: 'sonnet')
          7. Validate the LLM output (worker-side invariants below)
          8. Single transaction:
             pass 1: INSERT entities (entity_type='pc') for each PC; collect UUIDs into displayName→entityId + userId→entityId maps
             pass 2: INSERT prose_kernels per PC; INSERT facts per PC (with seed access_level='public', narrative_status='undelivered'); INSERT relationships (PC↔NPC/faction/location resolved by name lookup; PC↔PC resolved by userId)
             pass 3: INSERT any newFacts on existing world entities (filtered against this world's entity inventory; unknowns dropped + logged)
             pass 4: UPDATE characters.entity_id (linked via userId); UPDATE character_concepts.status='integrated'; UPDATE campaigns.status='active'
          9. COMMIT
         10. UPDATE pipeline_runs row → completed (with token/cost accounting)
         11. SSE 'phase: complete' derives from campaigns.status='active' via existing derive-phase
```

### Why one pass, not many

A per-player integration call sees the world plus its own PC, never the other PCs. The original design accepted that gap and tried to repair it post-hoc with a `continuity_check` LLM pass — the same work as the integration pass, just with full visibility. So move the visibility into the integration pass directly, and the repair pass is unnecessary.

This also means PC↔PC relationships emerge naturally from the same call: when the LLM writes PC2's entity row knowing PC1 already exists, it can author the PC1↔PC2 relationship in the same output.

### Why a free-text "notes" field, not structured PC↔PC

The owner writes "Player A and Player B are siblings, both estranged from their merchant father." The LLM reads it as part of the prompt header. A structured table forces (PC_A, PC_B, relationship_type, description) tuples, which is more friction for an open-ended creative input. The LLM is good at free text.

### LLM call lives outside the DB transaction

The Opus call may take 30–120s for a party of 2–5. Holding a `PoolClient` for that long at the worker concurrency (campaign-setup = 5) exhausts the connection pool. The integration's transaction wraps only the post-LLM writes (steps 8–9 in the diagram). Same shape as `coherence-pass.ts`'s "Option A" trade-off.

## Schema

One migration: `018_character_integration.sql`.

```sql
ALTER TABLE campaigns ADD COLUMN pre_integration_notes TEXT
  CHECK (pre_integration_notes IS NULL OR length(pre_integration_notes) <= 4000);

-- Status lifecycle:
--   submitted  → player submitted concept
--   processing → MYT-53 per-player concept-refinement worker running
--   completed  → sheet ready, awaiting cross-PC integration (NEW semantic — previously meant "PC entity exists")
--   integrated → MYT-54 cross-PC integration committed this PC's entity + edges + facts
--   failed     → terminal failure (per-player concept job or integration)
ALTER TABLE character_concepts DROP CONSTRAINT IF EXISTS character_concepts_status_check;
ALTER TABLE character_concepts ADD CONSTRAINT character_concepts_status_check
  CHECK (status IN ('submitted', 'processing', 'completed', 'failed', 'integrated'));
```

No new table needed for PC↔PC relationships — they land in the existing `relationships` table with both `source_entity_id` and `target_entity_id` pointing at PC entities (entity_type='pc' already exists from migration 016).

The `relationships.relationship_type` column is currently a closed enum used by `entity_relationships`. PC↔PC and PC↔NPC integration may need types not in the existing enum (e.g., `'sibling_of'`, `'apprenticed_at'`). **Decision deferred to implementation**: either (a) widen the existing closed enum with the additional PC-flavored types and update `RELATIONSHIP_TYPES` in `entity-relationships.ts`, or (b) keep PC-flavored types as `'related_to'` with the nuance carried in `description`. Pick (a) if the existing enum lacks the basic types; pick (b) for everything else.

## Routes

### `GET /api/campaigns/:campaignId/character-creation-progress`

**Auth:** any campaign member. Use `requireCampaignMember(repo)` preHandler.

**Response (200):**
```json
{
  "campaignId": "...",
  "totalMembers": 4,
  "concepts": [
    { "userId": "...", "displayName": "Ada", "status": "completed",  "submittedAt": "2026-05-23T..." },
    { "userId": "...", "displayName": "Ben", "status": "processing", "submittedAt": "..." },
    { "userId": "...", "displayName": "Cee", "status": "submitted",  "submittedAt": "..." },
    { "userId": "...", "displayName": "Dee", "status": "failed",     "submittedAt": "...", "error": { ... } },
    { "userId": "...", "displayName": "Eve", "status": "integrated", "submittedAt": "..." }
  ],
  "missing": [
    { "userId": "...", "displayName": "Fey" }
  ]
}
```

- `concepts[]` covers every member with a row in `character_concepts`.
- `missing[]` covers members without a row.
- `status` enumerates the full 5-value lifecycle including `'integrated'`.
- `submittedAt` is ISO-8601 from `character_concepts.submitted_at`.
- `error` is whatever the per-player worker stored in `character_concepts.error` (pass-through; shape varies).
- The frontend uses this to decide whether to show "are you sure?" on the finalize button.

**Errors:**
- 403 `not_a_member`
- 404 `campaign_not_found`

### `POST /api/campaigns/:campaignId/finalize-character-creation`

**Auth:** owner only. Use `requireCampaignMember(repo, 'owner')` preHandler.
**Route audit:** add `config: { pipelineRoute: true }`.

**Body (Zod-validated at route boundary to match DB CHECK):**
```ts
z.object({
  pre_integration_notes: z.string().min(0).max(4000).nullable().optional(),
})
```
- `''`, `null`, and absent field are all normalized to `null` at the route boundary before write.

**Response (202):**
```json
{ "campaignId": "...", "jobId": "..." }
```
- `jobId` shape: `ci-${campaignId}`. Singleton per campaign (BullMQ dedup on jobId rejects owner double-clicks).

**Transactional behavior at the route layer:**

```
BEGIN;
  UPDATE campaigns
     SET pre_integration_notes = $1
   WHERE id = $2 AND status = 'setup'
  RETURNING id;
  -- empty result → 409 not_in_setup; ROLLBACK and return
  enqueue BullMQ job (idempotent on jobId);
  -- if enqueue throws → ROLLBACK
COMMIT;
```

(Pattern mirrors MYT-53's `start-character-creation` transactional enqueue.)

**Errors:**
- 403 `not_owner`
- 404 `campaign_not_found`
- 409 `not_in_setup` — `campaigns.status != 'setup'`
- 409 `no_completed_concepts` — zero rows with `status='completed'`

**Note: no 402/403 credit gate.** Character creation is cost-cap-bounded (per MYT-53's `character_creation_cost_cap_usd` setting at $5 default), not credit-gated. Runtime cost-cap exhaustion surfaces from the worker as a stage-failed event, not as an HTTP error. See "Cost cap" section below.

The route does **not** block on in-flight concept-refinement jobs. Owner intent overrides; the frontend's "are you sure?" handles the UX side. Concepts in `submitted` or `processing` state are excluded from the integration input (the worker filters on `status = 'completed'`).

## Worker — `campaign-setup` queue: `character-integration` job

Job payload:
```ts
type CharacterIntegrationJob = {
  campaignId: string
  ownerUserId: string  // FK to users.id, used for pipeline_runs row + cost attribution
}
```

### Step-by-step

1. **Atomically claim** the `pipeline_runs` row with `(campaign_id, stage='character_integration', user_id=NULL)`. Extend `atomicClaimStage`'s `ClaimRequest` discriminant if it lacks a `campaign` arm; current shape supports world-scoped + per-player. Idempotent re-entry: if the row is already at `completed`, the worker short-circuits to step 10.
2. **Load input** — single SELECT JOIN: `character_concepts cc JOIN campaign_members cm USING (campaign_id, user_id) JOIN users u ON cm.user_id = u.id LEFT JOIN characters ch ON ch.user_id = u.id AND ch.campaign_id = cc.campaign_id WHERE cc.campaign_id = $1 AND cc.status = 'completed'`. Pull each PC's `concept_text`, `situation_grounding_text`, `display_name`, the structured `CharacterConceptOutput` (from `character_sheets` or wherever MYT-53 persists it — verify path during planning), and any sheet-summary fields (race/class/background/HP/AC).
3. **Load owner notes + starting situation** — `SELECT campaigns.pre_integration_notes, worlds.starting_situation_entries, campaigns.starting_situation_index FROM campaigns JOIN worlds ON campaigns.world_id = worlds.id WHERE campaigns.id = $1`. Compute `startingSituationProse` from `starting_situation_entries[starting_situation_index].prose`.
4. **Load world dump** via the shared assembly (extracted from `coherence-pass.ts`). Must include entity UUIDs in the rendered form so the LLM can echo them as `targetId`.
5. **Pre-render the party block** in TypeScript as a plain string (no template-engine iteration). The existing prompt loader uses `String.replace('{{var}}', value)`; introduce no new templating dependency.
6. **Render `character-integration.txt`** with the substituted variables.
7. **Cost-cap pre-flight** — `sumCharacterCreationStageCosts(campaignId) + estimateIntegrationCost(party.length, worldDumpLen)` against the `character_creation_cost_cap_usd` setting. On exceedance, mark `pipeline_runs` row failed with code `character_creation_cost_cap_exceeded` and exit. Campaign stays in `setup`; owner can adjust.
8. **Opus `generateObject`** with `IntegrationResultSchema`. `maxRetries: 0`, `repairStrategy: 'sonnet'` (mirrors per-PC integration's tradeoff). Non-streaming.
9. **Worker-side invariant validation** on the parsed output:
   - `characters.length === party.length`.
   - The set of `characters[].userId` exactly matches the input party's user-id set (no duplicates, no extras, no missing).
   - Every `characters[].relationships[].targetId` resolves against the world's entity inventory (look up by UUID); unknown UUIDs dropped + logged as `event: 'integration.unresolved_target_uuid'`.
   - Every `characters[].relationships[].targetUserId` (PC↔PC arm) resolves against this party's userId set; unknown user-ids dropped + logged.
   - For PC↔PC relationships: if PC A emitted an edge to PC B, the worker mirrors it onto PC B if PC B's `relationships[]` doesn't already contain the symmetric edge. (Sole-canonical-emission approach: the LLM may emit only once; worker mirrors. This avoids partial-output asymmetry.)
   - Every `newFacts[].entityId` resolves against the world's entity inventory; unknowns dropped + logged.
   - On terminal validation failure (e.g., `characters.length !== party.length`), throw `LlmStructuredOutputError` to trigger the `repairStrategy: 'sonnet'` fixup.
10. **Single transaction** for all DB writes — see step 8 of the architecture overview. The transaction encloses ONLY the writes, NOT the LLM call.
11. **Mark `pipeline_runs` row completed** post-COMMIT with token + cost accounting (existing pattern).
12. **No explicit SSE emit needed** — `derive-phase.ts` flips to `'complete'` on `campaigns.status='active'`.

### Failure modes

- LLM call fails (network/API) → `pipeline_runs` row marked failed; campaign stays in `setup`. Owner can re-trigger finalize (idempotent via pipeline_runs claim; on re-trigger, the existing failed row is reset to running).
- LLM call succeeds but parse fails after repair → same as above.
- Worker-side invariant validation fails → throw `LlmStructuredOutputError` → repair → second invariant check → if still fails, mark `pipeline_runs` row failed, exit.
- DB transaction fails → rollback (atomic); same as LLM failure path.
- Cost cap exceeded at step 7 → mark `pipeline_runs` failed; exit; no LLM call made.
- Worker crashes mid-LLM (before transaction): the `pipeline_runs` row sits in `running`; the existing stuck-job recovery flips it to `failed` after the configured grace window. Re-trigger creates a fresh attempt.
- Worker crashes mid-transaction: COMMIT either fully landed or fully rolled back. Re-trigger re-runs from scratch.

## LLM contract

### Prompt template (`backend/src/llm/prompts/prep/character-integration.txt`)

Top-of-prompt layout (sketch; final wording iterates during eval):

```
You are integrating a party of player characters into an existing tabletop campaign world.

## Owner's notes on the party
<delimited owner-text block, treated as untrusted input>
{{preIntegrationNotes}}
</delimited>

## Starting situation (where the party begins)
{{startingSituationProse}}

## World vocabulary
{{worldVocabulary}}

## World dump (entities by real UUID — emit UUIDs verbatim in targetId)
{{worldDump}}

## The party
{{party}}

## What to produce
For each character, emit:
- A PC entity row (entity_type='pc') with name + prose_kernel.
- A facts array (starting facts about the PC).
- A relationships array — edges to NPCs, factions, locations, and OTHER PCs in this party.

The party MUST be coherent. Where owner notes specify a relationship, reflect it. PC↔PC relationships should be emitted ONCE per pair (the worker mirrors them); use the target PC's userId from the party block as targetUserId.

You may add facts to existing world entities ONLY when integrating a PC requires it (this PC knew NPC X from backstory). Do not invent new NPCs, locations, or factions — those exist already in the world dump.
```

The `{{party}}` placeholder receives a pre-rendered string assembled by the worker, e.g.:

```
### Ada (userId: 019e...)
- Race / Class / Background: Tiefling Rogue (Outlander)
- Concept: A merchant's daughter turned thief...
- Situation grounding: She's at the tavern because...
- Backstory summary: <from CharacterConceptOutput>

### Ben (userId: 019f...)
...
```

### Zod schema (`backend/src/llm/schemas/character-integration.ts`)

```ts
const PCIntegrationSchema = z.object({
  userId: z.string().uuid(),  // echo from input; worker validates against input set
  displayName: z.string(),    // prompt-readability only; not used for resolution
  entity: z.object({
    name: z.string().min(2).max(80),
    proseKernel: z.string().min(80).max(1200),
  }),
  facts: z.array(z.object({
    content: z.string().min(20).max(800),
    tags: z.array(z.string()).min(1).max(5),
    aboutEntityId: z.string().uuid().nullable(),  // null = about this PC themselves; cannot reference other PCs (use relationships[] for cross-PC content)
  })).min(1).max(10),
  relationships: z.array(z.discriminatedUnion('targetKind', [
    z.object({
      targetKind: z.literal('npc'),
      targetId: z.string().uuid(),
      type: z.string(),
      description: z.string().min(20).max(800),
    }),
    z.object({
      targetKind: z.literal('faction'),
      targetId: z.string().uuid(),
      type: z.string(),
      description: z.string().min(20).max(800),
    }),
    z.object({
      targetKind: z.literal('location'),
      targetId: z.string().uuid(),
      type: z.string(),
      description: z.string().min(20).max(800),
    }),
    z.object({
      targetKind: z.literal('pc'),
      targetUserId: z.string().uuid(),  // resolves to a PC in this same party
      type: z.string(),
      description: z.string().min(20).max(800),
    }),
  ])).min(0).max(10),
})

const IntegrationResultSchema = z.object({
  characters: z.array(PCIntegrationSchema),
  newFacts: z.array(z.object({
    entityId: z.string().uuid(),  // must resolve against this world's entity inventory at validation time
    content: z.string().min(20).max(800),
    tags: z.array(z.string()).min(1).max(5),
  })).optional(),
})
```

Notes:
- `relationships[].type` is intentionally an open string at the schema layer. The closed-enum decision (extend `RELATIONSHIP_TYPES` vs. carry nuance in `description`) is resolved at the persistence boundary (worker maps to whatever the closed enum requires).
- `aboutEntityId` on facts cannot reference other PCs — PC↔PC content goes through `relationships[]`. The prompt is explicit; the schema enforces by `.uuid().nullable()` against the world's existing entity set (validated worker-side).
- PC entity names: worker disambiguates if two emitted names collide in `entities(world_id, name)` UNIQUE — suffix with userId fragment if necessary.

### Persistence mapping

- `facts.content` ← schema `content`. `facts.topic` ← `tags[0] ?? 'backstory'`. `facts.access_level` ← `'public'`. `facts.narrative_status` ← `'undelivered'`.
- `prose_kernels.content` ← `entity.proseKernel`. (Note: MYT-53's per-player stage 4 did NOT write `prose_kernels` for PCs; MYT-54 does. No cleanup needed since there are no in-production PCs.)
- `relationships.source_entity_id` ← this PC's just-inserted entity id. `relationships.target_entity_id` ← resolved per `targetKind` (UUID for NPC/faction/location; resolved-from-userId for pc).
- `characters.entity_id` ← the just-inserted PC entity id (matched by userId).
- `character_concepts.status` ← `'integrated'`.
- `campaigns.status` ← `'active'`.

## Dev-tool surface

Two new panels self-register via `registerPanelMount`:

1. `GET /api/campaigns/:campaignId/character-creation-progress` — single-purpose panel, member-visible. Refresh button; renders `concepts[]` + `missing[]` tables + JSON disclosure.
2. `POST /api/campaigns/:campaignId/finalize-character-creation` — action panel, owner-only (panel-level gate). Textarea for `pre_integration_notes` + submit button. On 202, shows the job id and notes that the drawer will surface integration progress.

Existing panels need no schema changes:
- `world-snapshot-panel` will naturally show PC entities once written.
- `hierarchy-panel` will show PCs in their starting locations.
- `characters-roster-panel` already lists PCs from `characters` table.

`route-registry.ts` updated with the two new entries; `verify-registry.ts` updated; `BACKEND_ROUTES` in `backend/src/contract/backend-routes.ts` adds the two new routes.

## Cost cap

The MYT-53 cost-cap (`character_creation_cost_cap_usd` setting, default $5.00) covers the per-player concept-refinement pipeline. MYT-54's integration is a single Opus call estimated at $0.30–$1.20 (varies with party size + world dump size). Amend `sumCharacterCreationStageCosts(campaignId)` to include the campaign-scoped `character_integration` row (currently the filter is `WHERE campaign_id=$1 AND user_id IS NOT NULL`; widen to `WHERE campaign_id=$1 AND stage IN ('character_concept', 'character_sheet', 'character_integration')`). Worker step 7 enforces pre-flight.

## Testing strategy

- Unit: route handlers, request validation, worker invariant validation, the worker's DB-write order.
- Integration: real Postgres + Redis, full flow from `POST /finalize-character-creation` through `campaigns.status = 'active'` with a mocked Anthropic response.
- E2E smoke: extends the existing world-gen smoke pattern. Create a world → owner POST /start-character-creation → 3 dev users POST /characters → wait for `concepts.status='completed'` for all → owner POST /finalize-character-creation with sample notes → wait for SSE `complete` → verify in DB: `campaigns.status='active'`, N PC entities exist with type='pc', PC↔NPC and PC↔PC relationships present, `character_concepts.status='integrated'`, credit ledger debited via cost-cap counters.
- Sample-prompt eval: ad-hoc script under `tmp/character-integration-eval/` running the prompt against 3 fixture worlds × 2-5 PCs each. Iterate prompt until output coherence is good. Not a permanent harness.

## Observability

- One `pipeline_runs` row per integration job — existing pattern, campaign-scoped (user_id=NULL).
- Cost recorded in `credit_ledger` — existing pattern.
- SSE phase progression observable in the drawer (derive-phase taxonomy extended to surface `'integrating'` phase or reuse `'post_creation'` for the in-flight window).
- Backend logs follow existing structured-log shape; emit `event: 'integration.unresolved_target_uuid'`, `event: 'integration.unresolved_target_userid'`, `event: 'integration.unresolved_newfact_entity'` for dropped LLM emissions.

## Rollout and migration sequencing

1. Land migration 018 (column + status enum extension).
2. Extract `loadWorldInventory`/`renderWorldDump` from `coherence-pass.ts` into a shared module; update coherence-pass to import.
3. Land MYT-53 stage-4 retirement: amend `character-creation-processor.ts`'s stage list, remove the per-player `character_integration` references in tests, update `derive-phase.ts`'s stage taxonomy.
4. Land the new MYT-54 worker + rewritten prompt + schema.
5. Land routes + dev-tool panels.
6. Amend `GET /api/campaigns/:campaignId` characters[] filter to include `'integrated'`.
7. Sample-prompt iteration loop until output is good on 2–5 PC fixtures.
8. E2E smoke against staging.
9. Wiki page.

No backwards-compatibility concerns — no campaigns in production use either MYT-53 stage 4 or the post-creation stages.

## Open design decisions

- Whether to reuse `'post_creation'` phase name in `derive-phase.ts` for the in-flight integration window, or add a new `'integrating'` phase. Default: reuse `'post_creation'` to minimize surface area, since the meaning is the same.
- Whether to widen the closed `RELATIONSHIP_TYPES` enum with PC-flavored types (`'sibling_of'`, `'apprenticed_at'`) or carry nuance in `description`. Default: pick (b) for v1; widen the enum only if the existing types prove insufficient during eval.
- Path of `CharacterConceptOutput` persistence — read at planning time from `character-sheets` or wherever MYT-53 lands the structured output. The integration worker depends on this lookup.

## Source

- `backend/src/routes/campaign-characters.ts` (extend)
- `backend/src/llm/prep/stages/character-integration.ts` (rewrite)
- `backend/src/llm/prompts/prep/character-integration.txt` (rewrite)
- `backend/src/llm/schemas/character-integration.ts` (rewrite)
- `backend/src/llm/prep/character-creation-processor.ts` (retire stage 4 from list)
- `backend/src/llm/prep/stages/coherence-pass.ts` (extract world-dump assembly)
- `backend/src/llm/prep/world-dump.ts` (NEW — shared world-dump assembly)
- `backend/src/sse/derive-phase.ts` (taxonomy)
- `backend/src/contract/pipeline-routes.ts` + `pipeline-jobs.ts` + `backend-routes.ts` (registrations)
- `backend/src/routes/campaigns.ts` (amend characters[] filter at :539)
- `backend/migrations/018_character_integration.sql` (NEW)
