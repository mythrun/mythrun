# Session Prep — Core Generation Stage (MYT-59) — Design

**Date:** 2026-06-01 (rev. after blind review — Tarot round)
**Linear:** MYT-59 (milestone: Session Prep Pipeline)
**Status:** design approved + blind-reviewed; pending implementation plan
**Blocks:** MYT-60 (leak guard), MYT-61 (worker/persistence), MYT-62 (streaming/SSE/dev-tool), MYT-63 (routes), MYT-64 (smoke)

---

## 1. Overview

Session prep is a **single Opus call** over the campaign's world state that produces two prose-markdown documents for the next session:

- **`ft_context`** — the Fast Thinker's opening context (what the player-facing DM is allowed to know).
- **`sd_playbook`** — the Slow Thinker's per-turn stage-direction playbook (secrets, revelation conditions, pacing — never shown to the FT or players).

The **output schema (`{ft_context, sd_playbook}`) and the `session_preps` table columns** (`migrations/001_initial_schema.sql:322-330`: `campaign_id, session_number, ft_context, sd_playbook, snapshot_id`) match the validated prototype 1:1. **Everything else is adapted, not ported** — the serializer and prompt move from the prototype's campaign-keyed, synchronous, single-PC, `public/private/secret` world to production's **world-keyed, async, multiplayer-party, `known/discoverable/secret`** model. Treat the prototype (`Personal/mythrun-v5/docs/plans/2026-03-12-session-prep-design.md` + `backend/src/prep/stages/session-prep.ts`) as the **behavioral reference** (the two-doc split, depth markers, Three-Clue Rule), not a code port.

MYT-59 builds **session 1**, designed forward-compatible with session N (§8).

## 2. Scope boundary

**MYT-59 delivers** the production design spec (this doc) + the **pure generation stage**: serialize world state → one Opus `streamObject` call → return `{ft_context, sd_playbook, usage}` in memory. Plus the prompt template, the Zod schema, the async world-state serializer, unit tests, and the §11 circular-reference fix.

**Out of this issue** (consumes MYT-59's output):
- Persistence into `session_preps`, the BullMQ job, per-prep cost cap, idempotent resume → **MYT-61**.
- The runtime Haiku leak guard → **MYT-60**.
- Streaming to the dev-tool / phase-level `prep-status` SSE → **MYT-62**.
- The **four routes** → **MYT-63**: `POST /api/campaigns/:id/session-prep`, `GET …/session-preps`, `GET …/session-preps/:prepId`, `POST …/reset-prep` (enumerated in World & Campaign Pipeline §"API Routes", lines 670-673). Note `reset-prep` interacts with MYT-61's idempotent resume — MYT-61 decides overwrite-vs-version semantics.
- Real-LLM constructed-state smoke + wiki → **MYT-64**.
- `POST /api/sessions/:campaignId/start` invocation + the "prep exists for the next session" precondition → **Session Runtime milestone**.

## 3. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Party knowledge | One `## The Party` block (each PC: sheet, personality, session-start *known* facts). FT sees the union; table play is shared. | Schema is party-level (one prep per `campaign_id+session_number`); leak-safe. **No asymmetric per-PC secrets in v1** (see §5). |
| Invention | Allowed, **prep-doc-local** — invented content lives in `ft_context`/`sd_playbook` only, not persisted; "must not contradict existing world state." | Faithful to the prototype (sparse world). Scribe persists later (Session Runtime). |
| Session scope | **Session 1 only**, forward-compatible with session N (§8). | Session-N inputs need the Scribe + World Observer, which aren't built. |
| Generation | `streamObject` (structured `{ft_context, sd_playbook}`) on **OPUS**, options-object call (§4.2). | Schema-validated + repair + whole-stream timeout; `partialObjectStream` exposes the fields for MYT-62 (with a stage-specific handler — §4.2). |
| Access tiers | **`known` is the only FT-safe tier.** Both `discoverable` and `secret` are hard exclusions from `ft_context`, at **both fact and entity granularity** (§5). | Production model (`migration 014`); `discoverable` = clue content that must be earned in play. |
| `snapshot_id` | **null** for session 1. | World-snapshot *writer* is Session-Runtime territory; the column is the session-N seam (§8). |

## 4. Components (file structure)

### 4.1 World-state serializer — `backend/src/llm/prep/serialize-world-state-for-prep.ts`

`serializeWorldStateForPrep(repo, { campaignId, worldId, sessionNumber, priorSessionContext? }): Promise<string>` — **async**, returns the omniscient world state as markdown for the Opus prompt.

It does **not** reinvent world serialization. It composes:
- `repo.campaigns.getById(campaignId)` → resolve `campaign.world_id` (entities/facts/prose are **world-scoped**, not campaign-scoped).
- `repo.worldInventory.load(worldId)` — the canonical omniscient read (entities + facts + prose + relationships at **all** access tiers; this is the prep-side read that intentionally bypasses the player allowlist). Reuse/extend **`renderWorldDump(inv)`** (`src/llm/prep/world-dump.ts`) for the markdown form — it already renders each entity with its `[access_level: …]` marker.
- World-level prose (tone, era, themes, `world_overview`, `key_tensions`) from the **`worlds`** row (NOT `campaigns` — the campaign row is thin).
- **The party:** `repo.characters.listForCampaign(campaignId)` (the owner is a member with a character — `reference_campaign_owner_is_member`). For each PC, its session-start known facts = the **`known`-tier facts on the PC's linked entity** (`characters.entity_id`), written by character-integration via `insertIntegrationFact` (hardcoded `known`). There is **no `starting_facts` field** — it's the `known`-fact subset on the PC entity.
- **The chosen starting situation:** resolve `campaigns.starting_situation_index` → `worlds.starting_situation_entries[index]` (see `repo.campaigns.getWorldAndSituationIndex` and the resolution at `character-integration.ts:279`). Serialize **only the chosen** situation for session 1's `## The Situation`; unchosen entries may be passed to the playbook as latent hooks (optional).

The serializer takes the world-state source as a **bound function** (§8), defaulting to `() => repo.worldInventory.load(worldId)`.

### 4.2 Generation stage — `backend/src/llm/prep/stages/session-prep.ts`

`generateSessionPrep(...)`: loads the template, calls `streamObject` on OPUS, returns `{ ft_context, sd_playbook, usage }`. Exact call (mirrors the established stage pattern, e.g. `locations-and-npcs.ts:311`):

```
streamObject({
  model: OPUS,                         // config constant, never hardcoded
  schema: sessionPrepSchema,
  prompt,
  temperature: 0.7,                    // creative prose prep; matches the prose-generating stages
  maxRetries: 0,                       // repair chain + BullMQ stage retry own recovery
  maxOutputTokens: 16384,              // SEE §9 — requires adding this field to the wrapper
  timeoutMs: <explicit, the largest in the codebase — sized to the two-doc Opus call>,
  repairStrategy: 'haiku-then-sonnet',
  callSite: 'session-prep',
  schemaName: 'SessionPrepSchema',
  providerOptions: { mythrun: { campaignId, worldId, stage: 'session_prep' } },
})
```

`sessionPrepSchema = z.object({ ft_context: z.string().min(<floor>), sd_playbook: z.string().min(<floor>) })` — `min` is a **presence/length floor, not a completeness check** (see §9). Exported from the stage file (matches sibling stages).

**No in-prose delineator.** The two documents are the two **structured-output fields** the model fills (`ft_context`, `sd_playbook`); the JSON schema does the separation. The template describes what each field must contain — it must NOT instruct a `===STAGE_DIRECTION_PLAYBOOK===` separator. (That separator was the prototype's mechanism for a single *text* completion; it is obsolete under `streamObject`'s structured schema and would be inert/harmful here.)

**Streaming for MYT-62:** session prep does **not** reuse `runStreamingStage` (it's array-keyed for entity/edge events and would emit nothing for a two-string object). MYT-62 consumes `result.partialObjectStream` / `result.textStream` directly with a stage-specific handler, surfacing the accumulating `ft_context` then `sd_playbook` fields. (Honest tradeoff vs. delimiter-split text: structured output keeps validation + repair; readable streaming requires this bespoke consumer rather than the existing extractor.)

### 4.3 Prompt template — `backend/src/llm/prompts/prep/session-prep.txt`

Ported from the prototype template: two-document framing + audience separation, the **depth-marker protocol**, the **Three-Clue Rule** + revelation-list format, NPC knowledge-boundary requirements, **hard-exclusion rules** for `ft_context` (§5), **party** adaptation, **invention-permitted-but-must-not-contradict**, the **length constraint** (prototype: `ft_context` ~2-3k words; `sd_playbook` ~1-2k and always shorter), and the Session-1 / Session-N conditional framing (§8).

### 4.4 Shared-layer prerequisite (`ai.ts`)

Add `maxOutputTokens?: number` to `StreamObjectOpts` (and the `generateObject` opts) and forward it to `sdkStreamObject`/`sdkGenerateObject`; extend the `stage` label set (`VALID_STAGES` / `WorldGenStage`) with a `session_prep` member so repair-path logs aren't mislabeled `concept_intake`. Both are small shared-layer changes with their own tests — call them out as explicit tasks (§9, §10).

## 5. The two documents

**`ft_context`** (Fast-Thinker-facing): `## The World` · `## The Party` (each PC: name/class/level/key stats, personality, session-start *known* facts) · `## Where You Are` · `## The Situation` (the chosen `starting_situation_entries[index]`) · `## People You Know` / `## People You Don't Know (Yet)` (depth markers) · `## Factions` · `## Places of Interest` (clue markers) · `## Encounters & Set Pieces` (dramatic setup, no DCs) · `## DM Guidance`.

**Hard exclusions from `ft_context` (the enforced-ignorance boundary):**
- **Fact level:** no `discoverable` or `secret` facts (only `known`). `discoverable` = clue content that must be earned in play.
- **Entity level:** a `secret` entity (hidden NPC/faction/location) must NOT appear in `ft_context` at all — not even named, not even as a depth-marked stub; it is **playbook-only**. A `discoverable` entity may appear as a depth-marked stub but without its `discoverable`/`secret` facts. Only `known` entities populate the FT sections.
- Revelation conditions, NPC knowledge of events they weren't present for, any playbook content.

**`sd_playbook`** (Slow-Thinker-only): `## Session Goals` · `## NPC Secrets & Revelation Conditions` · `## Revelation List (Three Clue Rule)` · `## NPC Knowledge Boundaries` (+ roll triggers) · `## Encounter Notes` · `## Pacing Guidance` · `## Hooks & Threads`. Carries every `discoverable`/`secret` fact and every hidden entity.

**No asymmetric per-PC secrets in v1.** All PC facts are stored `known` (`insertIntegrationFact` hardcodes it), so the data cannot express "known to PC-A, secret from the party," and the shared `ft_context` would expose any such fact to the whole table. v1 therefore treats all PC known-facts as table-shared. If per-PC asymmetric knowledge is ever wanted, it requires a schema/integration change (per-fact access on PC facts) — out of scope here; file as a precondition if pursued.

## 6. Data flow

`campaignId (status='active')`
→ `repo.campaigns.getById` → `world_id`
→ `repo.worldInventory.load(world_id)` (omniscient, all tiers) + `worlds` row prose + party (`characters.listForCampaign`, each PC's `known` facts) + chosen `starting_situation_entries[index]`
→ `renderWorldDump`-based markdown serialization
→ `streamObject(OPUS, sessionPrepSchema, prompt, …)` (§4.2)
→ `{ ft_context, sd_playbook }` + usage
→ **return** (no DB write, no leak gating, no SSE — all downstream).

## 7. Enforced ignorance

Primary enforcement is **prompt-level**: the template's fact- and entity-level hard-exclusion rules + depth-marker protocol (§5) instruct the Slow Thinker to keep all non-`known` content out of `ft_context`. The **runtime guard is MYT-60** — a Haiku **semantic** classifier (NOT a substring matcher; ZFC forbids pattern-matching on LLM output) that checks `ft_context` against the set of all `discoverable`+`secret` **facts** and the names/existence of all `discoverable`+`secret` **entities**, before `ft_context` reaches the live Fast Thinker. MYT-59 owns producing a clean `ft_context` and carrying the exclusion instructions in the template. Hard boundary (CLAUDE.md §1).

**MYT-59 ↔ MYT-60 window:** until MYT-60 lands, the only consumer of `ft_context` is the dev-tool / smoke path (MYT-62/64); no live Fast-Thinker call reads it (the `/start` invocation is Session Runtime). The absence of a runtime guard in this window is therefore safe by construction.

## 8. Forward-compatibility (Session N)

Session-1-only is a scope limit, not an architecture limit:

- **`sessionNumber` is a first-class parameter** in the serializer, prompt, and generation function.
- **Swappable world-state source.** The serializer accepts a source function `() => Promise<WorldInventory>`. Session 1 binds it to live `repo.worldInventory.load(worldId)`. Session N binds a future **snapshot loader** — a function-binding change, genuinely additive. **The snapshot *writer* is Session-Runtime territory and does not exist yet**; `session_preps.snapshot_id` (FK → the `world_snapshots` labeled-save table — distinct from the runtime `world-snapshot-view` composition) is the dormant seam.
- **Optional `priorSessionContext` slot.** A separate, optional section for session-N inputs (previous-session summaries from `sessions.summary`/`sessions.st_running_summary` — both exist; faction advances; thread list; player-interest signals). Absent at session 1.
- **Prompt template keeps the Session-1 / Session-N conditional framing** with graceful empty handling.
- **Entity-selection seam.** The serializer takes the entity set, so a context-budget selection filter can slot in for large worlds — not built now.

No session-N *inputs* are gathered in MYT-59 (they need the Scribe + World Observer); the shape just accepts them.

## 9. Error handling

- **Truncation is the dominant failure mode.** The two prose docs are the largest single output in the system. The `streamObject` wrapper currently has no output-token budget, so an explicit `maxOutputTokens` (≥16k, per the prototype) MUST be added (§4.4) and pinned; **verify the provider default during implementation — do not rely on it.** `min(<floor>)` is a presence/length check only and will NOT catch a mid-document truncation; truncation safety depends on the `maxOutputTokens` budget being correct, and a complete real-LLM assertion is the MYT-64 smoke.
- **Schema failure / repair.** For a two-prose-string schema the only realistic Zod failure is empty/short output; the generic repair driver (which re-emits the whole tree through a smaller model) would *fabricate* the docs rather than fix them. Therefore the meaningful recovery here is **BullMQ stage retry of the whole Opus call (MYT-61)**, not in-call repair; `repairStrategy` is set for consistency but should rarely fire once `maxOutputTokens` is correct. Never persist a partial prep.
- **Whole-stream timeout** (`myth-4omh`) covers the entire (multi-minute) stream, not just first-byte; set an **explicit** `timeoutMs` sized to the slowest call (don't inherit the 8-min default).
- **Empty party** is impossible (gated by `status='active'`, which character-integration sets only after every PC is integrated — `character-integration.ts`); assert defensively.

## 10. Testing (TDD)

Unit (mocked `streamObject`; real-LLM smoke is MYT-64):
- **Serializer:** a campaign with a party of N → `world_id` resolved from the campaign; `worldInventory.load` composed; all N PCs serialized with their **`known`**-tier facts (assert they survive the read — the wrong-tier filter would drop them); all access tiers present in the omniscient input; the **chosen** `starting_situation_entries[index]` (not all three); region→location hierarchy preserved; serializer is `async`.
- **`generateSessionPrep`:** mocked `streamObject` → both docs non-empty + usage accumulates; assert the call passes `OPUS`, `maxOutputTokens`, an explicit `timeoutMs`, `repairStrategy`, and `providerOptions.mythrun.stage='session_prep'`. (Repair *behavior* is the wrapper's own tests, not re-tested here.)
- **Template:** rendered template carries the fact- and entity-level hard-exclusion instructions, the length constraint, and the Session-1/Session-N conditional slots.
- **Shared-layer:** `maxOutputTokens` is forwarded by the `streamObject` wrapper; `session_prep` is a valid stage label.

## 11. Circular-reference fix (implementation task)

Update the two production specs that defer session-prep ownership to each other, naming **Session Prep Pipeline** as owner:
- `docs/specs/2026-04-13-world-campaign-pipeline.md` §"Session Prep (Streaming) — Out of This Milestone" (line 635) and the parked-route list (lines 670-673) — reconcile route ownership to MYT-63.
- `docs/specs/2026-04-13-multiplayer-session-runtime.md` dependency line (7) + the "session prep exists for the next session number" precondition (96).

## 12. References

- Prototype (behavioral reference): `Personal/mythrun-v5/docs/plans/2026-03-12-session-prep-design.md`, `backend/src/prep/stages/session-prep.ts`, `prep/session-prep/serialize-world-state.ts`
- Production: `migrations/001_initial_schema.sql:322` (`session_preps`), `migrations/014_access_tier_rework.sql` (tiers), `migrations/016` (`starting_situation_entries`)
- Repo/LLM: `src/repo/world-inventory.ts` (`load`), `src/llm/prep/world-dump.ts` (`renderWorldDump`), `src/repo/world-snapshot-view.ts:65` (the `['known']` player filter), `src/repo/facts.ts:19` (`AccessLevel`) + `:123` (`insertIntegrationFact` → `known`), `src/repo/entities.ts` (`listByWorld`), `src/llm/ai.ts:590` (`streamObject`), `src/llm/prep/stages/locations-and-npcs.ts:311` (the call pattern to mirror)
- Production specs: World & Campaign Pipeline §"Session Prep"; Multiplayer Session Runtime; UX Design; Backend Core.
