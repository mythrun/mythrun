# MYT-52 — World Gen: Streaming Stages + Entity Events + Live Event Inspector

> **Linear:** [MYT-52](https://linear.app/mythrun/issue/MYT-52) (due 2026-05-14)
> **Parent specs:** `docs/specs/2026-04-13-world-campaign-pipeline.md` §3 + §8
> **Prior design specs:** `docs/superpowers/specs/2026-05-12-myt-50-pipeline-status-surface-design.md` (SSE wire), `docs/superpowers/specs/2026-05-12-myt-51-world-gen-non-streaming-design.md` (non-streaming pipeline foundation)
> **Status:** Design — pending implementation

## 0. Scope statement

Lands the streaming half of the world-gen pipeline. Implements three new streaming stages (`world_and_factions`, `locations_and_npcs`, `entity_relationships`) via `streamObject` + partial-JSON entity extraction. Adds a final non-streaming coherence-audit stage (`coherence_pass`) that fixes contradictions before the world is marked complete. Adds a structured-output repair chain (Haiku → Sonnet → BullMQ retry) that handles Zod-validation failures across all 7 stages without showing the user disappearing-faction UX. Replaces the previously-planned dev-tool live SVG graph with a wire-data inspector — the dev tool now exposes the SSE event stream as a chronological log + a current-entity inventory, deliberately not mimicking the future production frontend's rendering.

After this ticket ships, `POST /api/campaigns` produces a fully-populated world end-to-end: every `entities` / `prose_kernels` / `facts` / `relationships` / `entity_hierarchy` row, `worlds.world_overview` + `worlds.starting_situations`, plus random tables. `pipeline_runs` has 7 rows all `status='completed'`. `worlds.status='complete'`. The campaign is ready for MYT-53's character-creation phase.

---

## 1. Background

### What MYT-51 shipped

The non-streaming world-gen pipeline foundation: `world-gen-processor.ts`, BullMQ worker wiring, credit gate, per-world cost cap with refund, stage-claim idempotency, paint-job-validator chain (concept_intake's safety check), `concept_intake` stage (Sonnet), `starting_situation` stage (Sonnet), `random_tables` stage (Haiku), `resume` route, dev-tool create + status-watch panels, full 100% coverage gate. Stages 2 + 3 throw `stage_not_implemented` — the worker reaches them and marks the world as `failed`. The pipeline today gets one stage in before stopping.

### What MYT-50 shipped

The pipeline-status surface: `GET /api/campaigns/:id/status` (one-shot snapshot) + `GET /api/campaigns/:id/status/stream` (SSE), the Redis pub/sub bridge that forwards worker-published events to attached SSE clients, the `pipeline-events.ts` discriminated-union contract (11 event types declared, including the 5 entity-event arms used by MYT-52), and the status-panel in the dev tool (consumes phase / stage-* / cost-update events; silently ignores entity-* / edge-* / stage-reset / finalized while it waits for MYT-52).

### What this leaves for MYT-52

Four stages to implement (2, 3, the new stage 4 `entity_relationships`, and the new stage 7 `coherence_pass`), three streaming primitives (extractor, repair chain, repair prompt), five repo modules for entity persistence, one dev-tool panel for the data inspector, and the coverage manifest move. Zero new HTTP routes, zero new BullMQ job types, zero schema changes (the existing migration 001 already declared every table this ticket needs).

---

## 2. Design decisions

Numbered list of load-bearing decisions, with rationale. The implementation must follow these or surface a counter-proposal in advance.

### D1: Streaming primitive is `streamObject` + `partialObjectStream`; non-streaming stages stay on `generateText` + `Output.object`

Vercel AI SDK v6's `streamObject` is the canonical streaming-structured-output primitive. The `partialObjectStream` async iterator yields best-effort partial JSON trees as chunks arrive — exactly the shape the entity-extraction loop needs. Stages 2, 3, and 4-new (`entity_relationships`) use it. Stages 1, 5, 6, and 7-new (`coherence_pass`) stay non-streaming because their outputs are small and not entity-shaped (concept fields, location-hook list, random tables, patch list).

Why coherence_pass is non-streaming despite producing patches that map to entity-updated events: it's reconciliation, not generation. A patch list shouldn't trickle out one item at a time; it should arrive as a unit and apply in a coordinated burst. The client still sees the changes via `entity-updated` events — just all at once instead of streamed.

### D2: `maxRetries: 0` on streaming stages; `maxRetries: 3` on non-streaming stages

**Important clarification re: Vercel SDK behavior:** `streamObject`'s `maxRetries` does NOT cause re-rolls on validation failure. When Zod validation fails at stream end, `result.object` rejects with `TypeValidationError` (the SDK does not re-stream). `maxRetries` only governs HTTP-level retry on transient transport errors (429, 503, network drops) during request setup / mid-stream.

Why we set `maxRetries: 0` on streaming stages anyway:

1. **Predictable cost attribution.** `maxRetries: 0` means one stage attempt = exactly one `streamObject` call = exactly one cost charge against the per-world cost cap. With `maxRetries > 0`, a transient transport retry inside the SDK doubles the input-token bill (Anthropic bills failed requests' input tokens) but the SDK only reports usage for the successful final attempt — so the cost cap silently undercounts on transient-failure retry paths.
2. **All retry semantics are owned explicitly above the SDK.** The repair chain (D3) handles validation failures by calling a separate LLM (different model, different prompt). BullMQ stage retry handles persistent transport failures by re-running the whole stage. There's no third layer hidden inside the SDK doing its own thing.
3. **No entity-event pollution on transport retries.** If the SDK transparently retried mid-stream after a 503, the `partialObjectStream` accumulator could in principle see chunks from two streams. (Implementation-dependent — the SDK may or may not do this; setting `maxRetries: 0` removes the question.)

What we lose by `maxRetries: 0`: cheap recovery from transient transport failures (429 rate limit, 503 overload). Without it, those become stage failures → BullMQ retries the entire stage → new full `streamObject` call. Rare for Anthropic; the cost cap accommodates one full stage retry in its headroom.

Non-streaming stages keep `maxRetries: 3` (Vercel default behavior) because they don't have the entity-event-pollution risk and transient transport recovery is pure win. The asymmetry is intentional; comment in code so future contributors don't "normalize" them.

**Stage 7 specifically:** `coherence_pass` is non-streaming + has its own repair chain. Per the MYT-51 D6 pattern (paint-job-validator), it sets `maxRetries: 1` on its `generateText` call to avoid stacking SDK retries × repair tiers × BullMQ retries into a 12-call worst case. One SDK transport-retry attempt is enough; everything else is the repair chain.

### D3: Three-tier repair chain — Haiku → Sonnet → BullMQ stage retry

When a stage's full-tree Zod validation fails (streaming OR non-streaming), the worker invokes a separate LLM call asking it to repair the tree. Haiku tier first. If Haiku-repaired output also fails Zod, escalate to Sonnet. If Sonnet repair also fails, fall through to BullMQ stage retry which publishes `stage-reset { stage }` and re-runs the entire stage from scratch.

This restores the prototype's 3-tier prompt-repair chain that the parent pipeline spec §7 deferred ("not a launch dependency"). MYT-52 un-defers it because the UX cost of `stage-reset` is most visible here — entities visibly disappear from the live event log when re-rolling. Repair-then-reset shrinks the disappearing-entities case from "any Zod failure" down to "Sonnet couldn't fix it either" (genuinely catastrophic, near-zero rate).

**Trigger conditions:**
- Repair runs ONLY when the LLM call resolved cleanly with a tree-shaped object AND `safeParse` failed against that tree.
- If `streamObject` rejected (transport error, `finishReason: 'length'` truncation, `AI_NoObjectGeneratedError`), the repair chain is SKIPPED — there's no tree to repair, just a failed call. Stage handler propagates to BullMQ retry directly.

**Array-shape preservation (load-bearing):** The repair chain MUST preserve array length and element ordering. Repair fixes field-level shape mismatches only; it MUST NOT add or remove array entries.
- If a Zod `.min(N)` constraint would require the repair LLM to invent new entries, that's NOT a repair-chain case — fall through to BullMQ stage retry (the LLM just didn't produce enough content).
- If a Zod `.max(N)` constraint would require the repair LLM to drop entries, same — fall through to retry.
- The repair prompt explicitly instructs the LLM "preserve array length; only fix per-element field-shape mismatches." If the repaired tree has different array lengths from the original, the worker treats the repair as failed and escalates.
- This rule makes the `entity-added` events already emitted to the client safe: the client's entities will have field updates applied (via `entity-updated` patches; see below) but no entities will appear or disappear due to repair.

**Repair-time client sync:**
- After successful repair, the worker walks the diff between original tree and repaired tree.
- For each field that changed on an entity the client had already seen via `entity-added`, publish `entity-updated { synthKey, patch }` where patch is an RFC 7396 JSON Merge Patch over the prior snapshot.
- No `entity-added` events fire from repair (array length preserved by rule above).
- No `entity-removed` events fire from repair (array shape preserved).
- Client never sees entities disappear; field values just converge to the persisted shape.

**Cost attribution flow (mechanical, not log-derived):** The stage handler accumulates `result.usage` from EACH LLM call it makes — primary streaming/generateText call + Haiku repair call (if attempted) + Sonnet repair call (if attempted). The handler returns a single aggregated `StageCost { costUsd, inputTokens, outputTokens }` to `world-gen-processor`. `markStageCompleted` writes that aggregated value to `pipeline_runs.cost_usd`. The `wrapStream` log line emits per-LLM-call for ops visibility (CloudWatch / log search), but the durable cost-record is the stage's aggregated `pipeline_runs.cost_usd` row. Pattern mirrors `paint-job-validator.ts`'s existing `attempts × usage` aggregation.

### D4: New stage 4 — `entity_relationships`

Inserts between `locations_and_npcs` (stage 3) and `starting_situation` (now stage 5). Streams structured edges via `streamObject` on Sonnet. Reads all entities + prose_kernels + facts from stages 2+3, identifies relationships (including implicit ones — e.g., "the inn-keeper's son was lost to the war between the kingdoms" produces a `family_member` edge + a `historical_conflict` edge that no regex could catch), persists `relationships` rows + optional `entity_hierarchy` stragglers. Emits `edge-added` events live.

Stages 2 and 3 produce ZERO `relationships` rows. Their LLM outputs may *narratively describe* relationships in `prose_kernels`, but no structured edges land in the database. This is the cleanest split: entity authorship in 2+3, edge formalization in 4. ZFC win — instead of trying to parse edges from prose with regex/name-matching at stage-3-persist time, we delegate it to a Sonnet pass that has full context.

### D5: New stage 7 — `coherence_pass`

Runs LAST in world-gen, after random_tables. Non-streaming `generateText` + `Output.object` on Sonnet, with `maxRetries: 1` (per D2 rule for stages with their own repair chain). Reads the full world state (~10–14k tokens), identifies contradictions / typos / role-conflicts / factual inconsistencies, emits a list of patches.

**Transaction boundary:** the `generateText` call completes ENTIRELY before BEGIN. The LLM is not invoked again inside the transaction. Once the patch list parses successfully (post-Zod-validation, post-repair-chain if needed), BEGIN → apply every patch in order → COMMIT. This makes the apply path purely mechanical: no LLM nondeterminism after BEGIN.

**Retry semantics:** if COMMIT fails or stage 7 otherwise fails into BullMQ retry, the retry re-runs `generateText` from scratch against the world's CURRENT state (which may already reflect partial patches from a prior aborted attempt — though under D6's transaction shape that shouldn't happen since aborted COMMITs roll back). The LLM's new patch list is the canonical fix for whatever state currently exists. The spec accepts non-determinism across retries here; the contract is only "no contradictions the model could detect" at `phase: complete`, not "identical to a fresh-from-scratch run."

**Production FE rendering — coherence-pass invisibility contract (specified, not vibes):**
- The wire emits `stage-started` / `stage-completed` / `cost-update` / `entity-updated` / `entity-removed` / `edge-removed` events as normal for stage 7. The bridge forwards them verbatim. Dev tool renders them in the live event log.
- The **production frontend** filters as follows: `stage-started{stage: 'coherence_pass'}` and `stage-completed{stage: 'coherence_pass'}` are NOT rendered as user-visible stage transitions. `cost-update` events received between stage 6's `stage-completed` and `phase: complete` are NOT shown to the user (the cumulative cost displayed to the user freezes at the world_ready boundary). `entity-updated` patches for stage-7 (synthKeys belonging to entities created earlier) ARE applied to the local entity state but WITHOUT animation / flash / "this changed" indicator — they're silent state convergence.
- The contract: by the time `phase: complete` fires, the world IS coherent. The user is not alerted that auditing happened. Filtering responsibility is FE-side; the worker emits the same events for everyone.

**Coherence-pass `entity-updated` synthKey resolution:** the coherence-pass LLM emits patches keyed by real UUID (`entityId`, `factId`, `relationshipId`). To emit `entity-updated { synthKey, patch }` matching the wire contract, the worker maintains a `Map<entityUuid, synthKey>` populated during stages 2/3/4 from each `finalized { synthKey, entityId }` event (the worker is also the producer of those finalized events, so the map is local in-memory state, not derived from anything external). Stage 7 looks up the synthKey via this map before publishing `entity-updated`.

**Per-patch-kind wire emission:**
- `rename_entity` → `entity-updated { synthKey: <lookup>, patch: { name: <newName> } }`. ALSO triggers a follow-up `fix_prose` patch (if the LLM emitted one) for prose that mentions the old name; the entity's prose_kernel may also be updated via a sibling `fix_prose` patch.
- `fix_prose` → `entity-updated { synthKey: <lookup>, patch: { prose: <newProse> } }`.
- `fix_fact` → DB UPDATE only; no SSE event (facts are not exposed as standalone client-side entities; they're nested inside the entity's data payload). The next time the FE queries the entity from the DB it'll see the updated fact. Dev tool sees only the cost-update + stage-completed.
- `fix_relationship` → emits `edge-removed { synthKey, reason: 'coherence_deleted' }` followed by `edge-added { synthKey: <new>, ... }` with the updated fields. The old edge's synthKey is retired; a new synthKey is minted (the edge entity is logically replaced).
- `delete_relationship` → emits `edge-removed { synthKey: <lookup>, reason: 'coherence_deleted' }`. DB DELETE. No replacement.

Auto-fix only. No `warnings` arm in the structured output. Things the LLM can't confidently fix simply remain whatever they were — if those uncoherences matter, they'll surface via eval harness or manual playthrough later. Building a `world_warnings` table without a consumer is premature.

Single pass — no self-recursion. Running coherence twice rarely catches more and burns extra Sonnet cost. If a future ticket adds an explicit second-pass for paranoid cases, that's a deliberate design step, not an organic loop.

**Cost-cap policy if cap fires AT stage 7:** unlike stages 1–6 where cap-fire means refund + `world_gen_failed`, cap-fire at stage 7 specifically means the world is functionally complete; the coherence pass is best-effort polish. Mark `worlds.status = 'complete'` (NOT failed), do NOT refund (user got their world), log skipped coherence at WARN, emit `phase: complete` (NOT `world_gen_failed`). The world ships with whatever incoherences the prep generation produced — eval harness / users may surface them later.

### D6: Persistence at stream end in one transaction per stage

Streaming stages emit `entity-added` / `entity-updated` events live (client sees the live build), but no rows land in Postgres until the stream completes + Zod validates + (if needed) repair completes. Then: BEGIN, INSERT all entities + prose_kernels + facts + (for stage 3) entity_hierarchy + (for stage 4) relationships, COMMIT.

If the stream fails or repair exhausts before commit: no DB writes happened. BullMQ retries the stage from scratch. Client sees `stage-reset` event and drops the in-flight entities. Clean all-or-nothing per stage.

If COMMIT fails (DB blip): same as repair-exhaust — stage retries, client sees stage-reset. The cost is one extra stage's LLM spend; bounded by the per-world cost cap.

### D7: SynthKey scheme — `${stage}/${arrayPath}/${index}`

Examples: `world_and_factions/regions/0`, `world_and_factions/factions/2`, `locations_and_npcs/npcs/4`, `entity_relationships/relationships/12`. Stable across all events for the same array index in the same stream. Client uses synthKey as the internal node ID until `finalized` swaps it for the real UUID.

### D8: Stage 3 hierarchy resolution via LLM-emitted `parent_location` field + two-pass persist

Stage 3 location entries include `parent_location: string | null` — the name of the containing location (`null` for a region-root). At persist time, the worker:

1. Pass 1: insert all entities + prose + facts in their own indexed rows.
2. Pass 2: build a name → entity_id map over ALL entities for the world (stage-2 + stage-3 combined; one `SELECT` query), filtered to `entity_type IN ('location', 'faction')` so factions don't accidentally become location parents — see kind-filter rule below.
3. Pass 3: for each location with a non-null parent_location, resolve via the name map and insert `entity_hierarchy` rows.

Walks arbitrary depth correctly: a `The Silent Bowstring` (parent=Anul-dan) inside `Anul-dan` (parent=Eredil) inside `Eredil` (root) all resolve in one pass because Pass 2's name map contains all three names.

**Kind-filter for parent resolution:** parent_location resolution only matches entities with `entity_type='location'`. If the LLM emits a faction's name as a parent_location, the resolver treats it as unresolvable (log WARN + persist parentless). The schema's `entity_hierarchy.parent_entity_id` FK has no CHECK on entity_type, so this rule lives in application code — without it, a faction could silently become a location's structural parent (semantic corruption).

**Name-collision rule:** if multiple entities share the same name (e.g., a region "The Iron Coast" and a city also named "The Iron Coast"), the resolver prefers the entity created in the EARLIER stage (stage 2 > stage 3) and within a stage prefers `entity_type='location'` over other types. Ambiguity is logged at WARN level with both entity IDs. This rule makes the resolver deterministic without requiring globally-unique names from the LLM.

**Unresolvable `parent_location`** (LLM typo, hallucinated name, or kind mismatch): logged at WARN level, entity persists as parentless. Worker also emits `entity-updated { synthKey, patch: { parent_location: null } }` to bring the client's view into sync with what landed in DB (the entity was emitted via `entity-added` with the original `parent_location` value; the resolver's clearing of that field needs a wire-visible signal so the dev-tool inspector doesn't show a stale parent). Stage 4 may catch the missed containment as an `entity_hierarchy` straggler.

### D9: Stage 4 LLM operates on real UUIDs, not names

Unlike stages 2+3 (which operate on names because they're creating entities), stage 4 reads the already-persisted entity inventory and emits relationships referencing real `entity_id` UUIDs. The prompt receives an entity reference list (id + name + kind + brief description) at build time. The LLM's structured output emits `source_entity_id` + `target_entity_id` as UUIDs that the schema validates as `z.string().uuid()`.

**Hallucinated-UUID handling — pre-filter, not catch-and-skip:** The persister builds a `Set<entity_id>` from the inventory query BEFORE the INSERT batch. For each LLM-emitted relationship, validate both `source_entity_id` and `target_entity_id` are in the set. Invalid rows are logged at WARN, NOT included in the INSERT batch. This avoids the Postgres-transaction failure mode where a single FK violation (`23503`) aborts the entire transaction with `25P02 current transaction is aborted`, wiping the entire stage's output. Pre-filter at the application layer; never let an FK violation reach the DB.

Same pattern for `hierarchy_stragglers` (stage 4's optional entity_hierarchy inserts): pre-filter against the entity set + against existing `entity_hierarchy.child_entity_id` rows (stage 3 already wrote some; stage 4's straggler should not collide). Hierarchy collisions resolve as: **stage 3 wins** (it had `parent_location` context from the streaming prompt; stage 4's straggler is a fallback for stage 3's misses only). Collisions log WARN; stage 4's row is dropped.

**`relationships` retry idempotency:** the existing `relationships` table has no UNIQUE constraint on `(source_entity_id, target_entity_id, relationship_type)`. If the stage retries after a partial-failure where the COMMIT succeeded but `markStageCompleted` didn't (rare race: worker crash between COMMIT and the marker UPDATE), a retry would double-insert. To prevent this, stage 4's persister starts each run with `DELETE FROM relationships WHERE source_entity_id IN (SELECT id FROM entities WHERE world_id = $1)` — clearing any prior stage-4 output before re-writing. This is idempotent because stages 2+3 don't write to `relationships`, so a clean wipe-and-rewrite always lands in a known-correct state.

### D10: Edge ordering — all edges in stage 4 (deferred from stages 2+3)

Per parent spec §8's "deferred edge emission" Option 1, but pushed an entire stage later: no edges fire during stages 2 or 3. ALL `edge-added` events fire from stage 4 as the relationships stream extracts them. The client's graph (eventually — the dev tool doesn't render a graph, but future production frontends will) sees entities populate disconnected through stages 2+3, then connections form during stage 4. UX expression of the build sequence.

### D11: Cost cap stays at MYT-51's $10.00 default

**Correction from earlier draft:** the prior version of this design proposed bumping the cap from $2 → $3. That misquoted MYT-51's actual default. Per `backend/migrations/010_settings_world_gen_cost_cap.sql:9`, `settings.world_gen_cost_cap_usd` ships at `10.0`. The parent pipeline spec §3 frames $10 as a hard backstop (not a steady-state budget) and notes "a typical world gen is $3–5." MYT-52 keeps the $10 default unchanged.

Why not tighten to $3 (as the earlier draft suggested):
- Schema-max worlds (max regions × max factions × max facts) can produce stage 2 + stage 3 streaming outputs in the $0.80–$1.20 range each at Opus rates. A single BullMQ retry on stage 3 alone could push cumulative cost to ~$3.50 — over a $3 cap, refund fires on a world the LLM would otherwise have produced.
- Repair-chain Sonnet escalations on the larger stages can add $0.10–$0.20 each.
- The cap is the runaway-budget backstop, not the steady-state limit. The eval harness (future) will measure actual per-world cost and inform tightening.

Expected per-world happy-path cost (using `MODEL_PRICING` rates: Opus $5/M input, $25/M output; Sonnet $3/M input, $15/M output; Haiku $1/M input, $5/M output):

| Stage | Model | ~Input/Output tokens | Computed $ |
|---|---|---|---|
| 1 `concept_intake` | Sonnet (+ Sonnet judge) | 3k / 1k | $0.024 |
| 2 `world_and_factions` | Opus | 5k / 6k | $0.175 |
| 3 `locations_and_npcs` | Opus | 8k / 10k | $0.290 |
| 4 `entity_relationships` | Sonnet | 10k / 3k | $0.075 |
| 5 `starting_situation` | Sonnet | 6k / 1.5k | $0.040 |
| 6 `random_tables` | Haiku | 4k / 3k | $0.019 |
| 7 `coherence_pass` | Sonnet | 14k / 2k | $0.072 |
| **Sub-total happy path** | | | **~$0.70** |

The earlier $1.50 figure was wrong — actual happy-path cost is closer to **$0.70**, and the $10 cap leaves ~14× headroom for repair chains + BullMQ retries on schema-max worlds. The cost table in §7.1 derives these numbers from `MODEL_PRICING` directly (not hardcoded) so the spec can't drift from the source of truth.

**Cost-cap enforcement timing (corrects earlier draft):** the actual MYT-51 mechanism is POST-stage enforcement. After `markStageCompleted` writes `pipeline_runs.cost_usd`, the worker calls `sumCompletedStageCosts(pool, worldId)` and compares against `readCostCap(pool)`. If `cumulative > cap`, `markStageCappedAndRefund` fires (failure terminal stop, refund credit, `phase: world_gen_failed`). There is NO pre-stage check; a stage can overshoot the cap by up to its own cost ($0.30 max in the happy-path table) before the breaker fires. The earlier draft's reference to `peekCostCap` / `assertCostCap` helpers was wrong — those names don't exist. The actual helpers in `cost-cap.ts` are `readCostCap`, `sumCompletedStageCosts`, `issueCostCapRefund`. MYT-52 reuses them as-is.

### D12: Dev tool — live-events inspector, NO graph

Dropped the d3-force / SVG graph entirely. The dev tool is for the developer (Miklos) to inspect what data is arriving on the SSE wire — not to mimic the future production frontend's graph rendering. The graph is a production-frontend concern.

The new panel (`live-events-panel.ts`) is a chronological event log. Each event is a card showing the event type + key identifiers + truncated payload preview. Clicking a card expands it to show the full, pretty-JSON payload of that exact event. Filter chips toggle visibility per event type. A collapsed second section at the bottom shows a flat current-entity inventory (synthKey, kind, name, last-updated) — the only place the inspector approaches a graph-style mental model, and still as a list.

### D13: Smoke = plumbing, not LLM quality

One wire-level smoke run per merge (curl + SSE + psql, no browser automation per [`feedback_dev_tool_e2e_smoke_required`](../../../../.claude/projects/-Users-miklos-Desktop-Files-Mythrun-Code-mythrun/memory/feedback_dev_tool_e2e_smoke_required.md)). Asserts the system's contract (HTTP status codes, SSE event-shape sequence, non-zero persistence row counts, terminal `worlds.status='complete'`, cost under cap, no worker stack traces).

Smoke does NOT assert LLM behavior — no entity count thresholds, no "the coherence pass produced sensible patches" check, no specially-crafted-input runs designed to probe quality. Quality is the eval harness's concern, a separate future track. See [`feedback_smoke_vs_eval`](../../../../.claude/projects/-Users-miklos-Desktop-Files-Mythrun-Code-mythrun/memory/feedback_smoke_vs_eval.md).

### D14: Stages 2+3 may describe relationships in prose; stage 4 formalizes

Stages 2 and 3 produce `prose_kernels.content` that may freely narrate relationships between entities ("The Iron Coast and the Silver Brotherhood have been at odds since the third moon's wane"). No `relationships` rows are written. Stage 4's job is to read that prose + the entity inventory + the facts table and formalize the relationships — including implicit ones that no regex could extract.

This decision keeps stages 2+3 simple (they own one concern: emit entities). Stage 4 owns all edge work in one place, easier to test + harder to break.

### D15: Synthesized test fixtures, NOT recorded LLM output

Unit tests for `streaming-extractor.ts`, `structured-output-repair.ts`, and each stage handler use hand-synthesized fixtures (small async generators yielding controlled partial trees, hand-built bad-shape trees with known Zod errors). Recorded LLM output is NOT used — recordings tie tests to a specific run and invalidate on small prompt changes. Real-LLM validation lives entirely in the wire-level smoke (D13).

---

## 3. Stage-by-stage details

### 3.1 Stage 2: `world_and_factions` (streaming)

| Field | Value |
|---|---|
| Model | OPUS |
| Streaming | yes (`streamObject` + `partialObjectStream`) |
| `maxRetries` | 0 |
| Schema source | port from `/Personal/mythrun-v5/` prototype, adapt field bounds to production entities/prose/facts schema |
| Prompt template | `backend/src/llm/prompts/prep/world-and-factions.txt` |
| Persists | `entities` (entity_type='location' for regions, entity_type='faction'), `prose_kernels` (one per entity), `facts` (many per entity), `worlds.world_overview` |
| Emits | `stage-started` → many `entity-added` + `entity-updated` → `stage-completed` → `finalized` |
| SynthKey paths | `world_and_factions/regions/N`, `world_and_factions/factions/N` |

**Zod schema (sketch — port from prototype for actual bounds):**

```ts
export const WorldAndFactionsSchema = z.object({
  world_overview: z.string().min(60).max(2400),
  regions: z.array(z.object({
    name: z.string().min(1).max(200),
    prose: z.string().min(40).max(2400),
    facts: z.array(factSchema).min(2).max(12),
  })).min(3).max(8),
  factions: z.array(z.object({
    name: z.string().min(1).max(200),
    prose: z.string().min(40).max(2400),
    facts: z.array(factSchema).min(2).max(12),
  })).min(3).max(8),
})

const factSchema = z.object({
  topic: z.string().min(2).max(80),
  content: z.string().min(20).max(800),
  access_level: z.enum(['public', 'private', 'secret']),
  // NOTE: narrative_status is NOT emitted by the LLM. The persister stamps
  // `narrative_status='undelivered'` on every fact row at INSERT time
  // (play-runtime owns the transitions to 'delivered' / 'developed' /
  // 'resolved'). `source='prep'` is also stamped (matches schema default).
})
```

**Bounds rationale:** `min(3).max(8)` is tighter than the prototype's defaults; aims for "rich enough world to play in, not so many entities that prose budget runs out." Port the prototype's actual bounds during implementation if they differ; if they're identical, this is the answer.

**Prompt requirement (load-bearing):** the prompt template MUST instruct the LLM to emit `name` FIRST in each entity object (regions / factions). This ensures the streaming extractor's "name field closed" predicate fires early (per §4.1), enabling the live entity-added UX. Without name-first ordering, `entity-added` events would batch at end-of-stage instead of trickling live.

**`worlds.world_overview` persist:** the persister calls `worldsRepo.update(client, worldId, { worldOverview: tree.world_overview })` inside the stage-2 BEGIN/COMMIT transaction. This reuses MYT-51's existing `worldsRepo.update` helper (no new repo surface needed for this field).

**Extraction config passed to `runStreamingStage`:**

```ts
arrays: [
  { path: 'regions',  kind: 'location', role: 'entity' },
  { path: 'factions', kind: 'faction',  role: 'entity' },
]
```

### 3.2 Stage 3: `locations_and_npcs` (streaming)

| Field | Value |
|---|---|
| Model | OPUS |
| Streaming | yes |
| `maxRetries` | 0 |
| Schema source | prototype port |
| Prompt template | `backend/src/llm/prompts/prep/locations-and-npcs.txt` (rendered with stage 2's region + faction names + brief prose as context) |
| Persists | `entities` (entity_type='location' for POIs, entity_type='npc'), `prose_kernels`, `facts`, `entity_hierarchy` (locations parented to other locations via the two-pass resolver from D8) |
| Emits | `stage-started` → many `entity-added` + `entity-updated` → `stage-completed` → `finalized` |
| SynthKey paths | `locations_and_npcs/locations/N`, `locations_and_npcs/npcs/N` |

**Zod schema additions over stage 2** (port from prototype):

```ts
const locationSchema = z.object({
  name: z.string().min(1).max(200),
  prose: z.string().min(40).max(2400),
  facts: z.array(factSchema).min(2).max(12),
  parent_location: z.string().nullable(),  // name of containing location, or null for root
})
const npcSchema = z.object({
  name: z.string().min(1).max(200),
  prose: z.string().min(40).max(2400),
  facts: z.array(factSchema).min(2).max(12),
  home_location: z.string().nullable(),     // narrative reference, not persisted in entity_hierarchy
})

export const LocationsAndNpcsSchema = z.object({
  locations: z.array(locationSchema).min(5).max(20),
  npcs: z.array(npcSchema).min(5).max(20),
})
```

**Same narrative_status / source notes apply** — persister stamps `narrative_status='undelivered'` + `source='prep'` on every fact row; LLM does not emit either.

**Same name-first prompt rule applies** — the prompt template MUST instruct the LLM to emit `name` FIRST in each location and NPC object.

### 3.3 Stage 4: `entity_relationships` (streaming, NEW)

| Field | Value |
|---|---|
| Model | SONNET |
| Streaming | yes |
| `maxRetries` | 0 |
| Schema source | new — write fresh against the `relationships` table schema |
| Prompt template | `backend/src/llm/prompts/prep/entity-relationships.txt` (rendered with the full entity inventory: id + name + kind + brief description, plus the prose_kernels content for all entities) |
| Persists | `relationships`, optional `entity_hierarchy` stragglers (ON CONFLICT DO NOTHING per D9) |
| Emits | `stage-started` → many `edge-added` → `stage-completed` → `finalized` (mapping for the relationship synthKeys) |
| SynthKey paths | `entity_relationships/relationships/N` |

**Zod schema:**

```ts
export const EntityRelationshipsSchema = z.object({
  relationships: z.array(z.object({
    source_entity_id: z.string().uuid(),
    target_entity_id: z.string().uuid(),
    relationship_type: z.enum([
      // Authoritative closed set — keep in sync with prototype's enum if present.
      // Adding a new type requires updating this list + a new prompt example.
      'serves', 'opposed_to', 'allied_with', 'rival_of', 'controls', 'family_member',
      'mentors', 'employed_by', 'located_in', 'leads', 'member_of', 'rules',
      'former_servant_of', 'pursues', 'protects', 'betrayed_by',
    ]),
    description: z.string().min(10).max(600),
  })).min(5).max(80),
  hierarchy_stragglers: z.array(z.object({
    parent_entity_id: z.string().uuid(),
    child_entity_id: z.string().uuid(),
  })).max(20),
})
```

**relationship_type is a closed enum** (not free-string). Downstream Scribe / Session Runtime consumers can `switch` on it cleanly without natural-language interpretation. Adding a new type is a deliberate prompt + schema edit; the LLM is forced to map novel relationships to the closest existing type or skip them.

**Relationships min(5):** asserts the LLM actually produced something. A world with 30+ entities (typical after stages 2+3) but zero structured relationships is almost certainly a quality failure; min(5) makes that fail Zod and trigger repair-chain re-attempt with explicit "you must emit at least 5 relationships" prompt nudge.

Stage 4 emits `edge-added` events as relationships entries close — same extractor primitive as stages 2+3 but `role: 'edge'` instead of `role: 'entity'`. Per the post-design-review contract update, the event payload shape is `{ type: 'edge-added'; synthKey; from; to; relationship; description? }` (no `stage`/`kind`/`data` fields; consumers derive stage from synthKey prefix; `relationship` carries the enum string; `description` is the optional free-text rationale).

### 3.4 Stage 5: `starting_situation` (existing, unchanged)

No changes from MYT-51. Still Sonnet, still non-streaming, still persists `worlds.starting_situations`. Just runs LATER in the pipeline now (after stage 4) so it has relationship context to hook into. The prompt template may want a small revision to include the new relationship info — that's an optional polish, not required for MYT-52.

### 3.5 Stage 6: `random_tables` (existing, unchanged)

No changes. Still Haiku, still non-streaming. Runs after stage 5.

### 3.6 Stage 7: `coherence_pass` (non-streaming, NEW)

| Field | Value |
|---|---|
| Model | SONNET |
| Streaming | no (`generateText` + `Output.object`) |
| `maxRetries` | 3 (non-streaming pattern) |
| Schema source | new — patch discriminated union |
| Prompt template | `backend/src/llm/prompts/prep/coherence-pass.txt` (rendered with full world dump: entities + prose + facts + relationships, ~10–14k tokens) |
| Persists | UPDATEs to `entities.name` / `prose_kernels.content` / `facts.content` / `relationships.*`; DELETEs to `relationships`; no INSERTs except for the patch-applied UPDATEs which don't add rows |
| Emits | `stage-started` → many `entity-updated` (one per patch) → maybe `edge-added` (if a stale relationship is replaced) → `stage-completed` → `finalized { mapping: {} }` (no new entities) → `phase: complete` |
| SynthKey paths | reuses existing entity synthKeys from earlier stages; the `entity-updated` event references the real UUID resolved post-`finalized` from those earlier stages |

**Zod schema:**

```ts
export const CoherenceOutputSchema = z.object({
  patches: z.array(z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('fix_fact'),
      factId: z.string().uuid(),
      newContent: z.string().min(10).max(2000),
      rationale: z.string().min(20).max(400),
    }),
    z.object({
      kind: z.literal('fix_prose'),
      entityId: z.string().uuid(),
      newProse: z.string().min(40).max(2400),
      rationale: z.string().min(20).max(400),
    }),
    z.object({
      kind: z.literal('fix_relationship'),
      relationshipId: z.string().uuid(),
      newType: z.string().min(2).max(60).optional(),
      newDescription: z.string().min(10).max(600).optional(),
      rationale: z.string().min(20).max(400),
    }),
    z.object({
      kind: z.literal('rename_entity'),
      entityId: z.string().uuid(),
      newName: z.string().min(1).max(200),
      rationale: z.string().min(20).max(400),
    }),
    z.object({
      kind: z.literal('delete_relationship'),
      relationshipId: z.string().uuid(),
      rationale: z.string().min(20).max(400),
    }),
  ])).max(40),
})
```

**Apply-time skipping:** if a patch references a UUID that doesn't exist (LLM hallucinated an ID), the patch is logged at WARN level and skipped — the world isn't broken, the LLM was just imprecise. Other patches in the same batch still apply.

---

## 4. Shared primitives

### 4.1 `streaming-extractor.ts`

The reusable diff/emit loop used by stages 2, 3, and 4. Lives at `backend/src/llm/prep/streaming-extractor.ts`.

```ts
export interface StreamingExtractorConfig {
  readonly stage: WorldGenStage
  readonly campaignId: string
  readonly job: Job  // BullMQ job handle, for updateProgress heartbeat
  readonly redisRealtime: Redis
  readonly keyPrefix: string
  // Which array paths inside the partial tree yield entities vs edges,
  // and which entity kind each one represents.
  readonly arrays: ReadonlyArray<{
    readonly path: string  // dotted path within the tree, e.g. 'regions' or 'relationships'
    readonly kind: EntityKind | EdgeKind
    readonly role: 'entity' | 'edge'
  }>
}

export interface StreamingExtractorResult<T> {
  readonly finalTree: T
  readonly emittedSnapshots: Map<string, unknown>  // synthKey -> last-emitted state
}

export async function runStreamingStage<T>(
  partialObjectStream: AsyncIterable<DeepPartial<T>>,
  config: StreamingExtractorConfig,
): Promise<StreamingExtractorResult<T>> {
  // 1. Initialize accumulator + lastEmitted map
  // 2. for await each partial tree:
  //      walk each configured array path
  //      for each entry at index i:
  //        synthKey = `${stage}/${path}/${i}`
  //        if not yet emitted AND entry.name is non-empty AND at least one other field is present:
  //          publish entity-added (or edge-added) with full data
  //          mark emitted, save snapshot
  //        else if emitted AND snapshot grew:
  //          diff against snapshot
  //          publish entity-updated (or edge updated equivalent) with just the patch
  //          update snapshot
  //      heartbeat via job.updateProgress(chunkCount)
  // 3. return { finalTree, emittedSnapshots }
}
```

**Emit predicate** (the "name field closed" heuristic from parent spec §8): an entry is emittable when `entry.name` is a non-empty string AND at least one other field has begun (so we know we're past the `{ "name": "...",` boundary, not mid-write of the name). If the name later changes (rare — LLM revises a placeholder), an `entity-updated` patch carries the new name.

**Why name-first ordering matters (prompt requirement):** the `partialObjectStream` emits monotonically-accumulating partial trees. If the LLM emits `name` last in each object, the entry only becomes "emittable" near the end of that object — collapsing the live entity-added UX to a near-simultaneous burst with stage-completed. The streaming-stage prompts MUST instruct the LLM to emit `name` as the first field in each entity object so entity-added fires as early as possible. The wire smoke (§8 Layer 3) asserts the first `entity-added` arrives within 15s of `stage-started` to catch prompt regressions that break ordering.

**Heartbeat cadence:**
- Per partial-tree iteration: `job.updateProgress(chunkCount)` (cheap Redis SET).
- Additionally: wall-clock heartbeat every 15s while the stream is open (covers LLM mid-stream pauses where the SDK goes silent for extended TTFT spikes).
- Cross-reference: BullMQ's `stalledInterval` should be aligned with the `atomicClaimStage` 5-minute claim-reset window. The 15s wall-clock heartbeat keeps the job well within BullMQ's default 30s stalled threshold under any normal load.

**Repair-chain reconciliation (D3 + entity events):**

After the streaming portion completes, the worker calls `validateOrRepair`. The repaired tree's diff against the original tree is published as follows:

| Diff case | Wire event |
|---|---|
| Entity at synthKey/N has field changes (name, prose, facts) | `entity-updated { synthKey, patch }` with RFC 7396 merge patch |
| Repaired tree has MORE entries than original (array grew) | **Not allowed** — D3's preservation rule means the repair failed; escalate to BullMQ retry instead |
| Repaired tree has FEWER entries than original (array shrunk) | **Not allowed** — same |
| Hierarchy resolver clears a `parent_location` because unresolvable | `entity-updated { synthKey, patch: { parent_location: null } }` |

The `entity-removed` event arm (added to `pipeline-events.ts`) exists for the coherence-pass `delete_relationship` path and for any future stage that genuinely removes entities; it does NOT fire from the repair chain (per D3, repair never removes entries).

### 4.2 `structured-output-repair.ts`

The three-tier repair helper. Lives at `backend/src/llm/prep/structured-output-repair.ts`.

```ts
import { HAIKU, SONNET } from '../models.js'

export type RepairTier = typeof HAIKU | typeof SONNET

export interface RepairArgs<T> {
  readonly tree: unknown                  // the structurally-invalid output
  readonly schema: z.ZodType<T>           // the schema it should match
  readonly zodErrors: z.ZodError          // detailed validation errors
  readonly model: RepairTier              // tier to escalate to
  readonly stage: WorldGenStage           // for cost attribution
  readonly providerOptions: { mythrun: MythrunContext }
}

export async function repairStructuredOutput<T>(
  args: RepairArgs<T>,
): Promise<{ ok: true; tree: T } | { ok: false; errors: z.ZodError }>
```

**Prompt template** at `backend/src/llm/prompts/prep/repair.txt`:

```
You are repairing a structurally-invalid JSON object so it matches a strict
schema. Preserve semantic content — do NOT invent new entities or rewrite
existing content stylistically. Only fix what the validation errors point to.

Schema (JSON Schema notation):
{{schemaJson}}

The current object (failed validation):
{{currentTree}}

Validation errors:
{{zodErrorsFormatted}}

Return a corrected object that matches the schema, preserving as much of
the original content as possible.
```

**Stage handler integration** (sketch, shared across stages 2+3+4):

```ts
async function validateOrRepair<T>(
  tree: unknown,
  schema: z.ZodType<T>,
  ctx: { stage: WorldGenStage; providerOptions: MythrunCtxOpts; deps: WorkerDeps },
): Promise<T> {
  const direct = schema.safeParse(tree)
  if (direct.success) return direct.data

  const haiku = await repairStructuredOutput({ tree, schema, zodErrors: direct.error,
                                                 model: HAIKU, ...ctx })
  if (haiku.ok) {
    await publishUpdatedPatches(haiku.tree, tree, ctx)
    return haiku.tree
  }

  const sonnet = await repairStructuredOutput({ tree, schema, zodErrors: haiku.errors,
                                                  model: SONNET, ...ctx })
  if (sonnet.ok) {
    await publishUpdatedPatches(sonnet.tree, tree, ctx)
    return sonnet.tree
  }

  throw new LlmStructuredOutputError(
    `${ctx.stage}: repair chain exhausted; falling back to BullMQ retry`,
  )
}
```

`publishUpdatedPatches` walks the diff between the original tree and the repaired tree and emits `entity-updated` events for any field that changed in an entity that the client had already seen via `entity-added`. Keeps client state in sync with what actually lands in DB.

### 4.3 Repo modules (5 new)

Each follows the existing repo conventions: named exports (no `createXxxRepo` factory wrapper — every call site already holds a `PoolClient` from the stage's transaction, matching the `stripe-events.ts` shape rather than the `worlds.ts` factory shape), `ClientLike`-typed `query` argument, snake_case → camelCase via mappers, ON CONFLICT handling where the schema requires (`prose_kernels.entity_id UNIQUE`, `entity_hierarchy.child_entity_id UNIQUE`).

| File | Surface |
|---|---|
| `backend/src/repo/entities.ts` | `insert(client, { id, worldId, entityType, name })`, `findByWorldAndName(client, worldId, name)`, `listByWorld(client, worldId)` |
| `backend/src/repo/prose-kernels.ts` | `insert(client, { entityId, content })` — errors on entity_id conflict (used by stages 2+3 with fresh entities). Separate `updateByEntityId(client, entityId, { content })` for the coherence-pass `fix_prose` patch path (UPDATE WHERE entity_id = $1, single row). Do NOT use an upsert pattern that conflates "new entity" with "coherence overwrite." |
| `backend/src/repo/facts.ts` | `insertMany(client, rows)` where each row has `{ entityId, topic, accessLevel, content }`. The persister injects `narrativeStatus='undelivered'` + `source='prep'` as constants — these are NOT row-level args, just baked into the INSERT statement. Separate `updateContentById(client, factId, { content })` for the coherence-pass `fix_fact` patch path. |
| `backend/src/repo/relationships.ts` | `deleteByWorld(client, worldId)` (called at stage-4 start for retry-idempotency per D9), `insertMany(client, rows)`, `listByWorld(client, worldId)`, `updateById(client, id, { relationshipType?, description? })`, `deleteById(client, id)` |
| `backend/src/repo/entity-hierarchy.ts` | `insert(client, { parentEntityId, childEntityId })` — errors on UNIQUE collision (caller decides what to do). Stage 3's caller never expects a collision (fresh inserts). Stage 4's straggler caller pre-filters against `SELECT child_entity_id FROM entity_hierarchy WHERE child_entity_id = ANY($1)` and only INSERTs the deltas. |

---

## 5. World-gen processor updates

### 5.1 `WORLDGEN_STAGES` constant

```diff
 const WORLDGEN_STAGES = [
   'concept_intake',
   'world_and_factions',
   'locations_and_npcs',
+  'entity_relationships',
   'starting_situation',
   'random_tables',
+  'coherence_pass',
 ] as const
```

### 5.2 `dispatchStage` function

Three new arms — one per new stage (2 reused — `world_and_factions` + `locations_and_npcs` replace their MYT-51 stage_not_implemented stubs).

### 5.3 `derive-phase.ts` STAGE_ORDER

```diff
 export const STAGE_ORDER = [
   'concept_intake',
   'world_and_factions',
   'locations_and_npcs',
+  'entity_relationships',
   'starting_situation',
   'random_tables',
+  'coherence_pass',
 ]
```

`derivePhase` already classifies stages into worldgen/charcreation/postcreation scopes. The new stages are all worldgen, so the classifier needs an update — verify `stageScope('entity_relationships') === 'worldgen'` and `stageScope('coherence_pass') === 'worldgen'`.

---

## 6. Dev tool: live-events panel

**File:** `backend/dev-tool/src/components/live-events-panel.ts` (~280–350 LOC, pure DOM, no new deps)

**Mounts in:** `backend/dev-tool/src/main.ts` (one `mountLiveEventsPanel(parent)` call alongside the existing panels)

**Subscribes to:** the existing SSE stream via `openSse('/api/campaigns/:id/status/stream')`. When the user clicks Watch on a campaign in the My Campaigns panel, the status-panel AND the live-events-panel EACH open their own HTTP connection — the dev-tool's `openSse` is per-call, not multiplexed. Two panels = two server-side SSE connections fed by the same Redis pub/sub subscription on the worker side.

**Rate-limit implication:** the `/status/stream` route is rate-limited at 10 opens/min per user. Two panels per Watch click → effective ceiling of 5 watches/min per dev. Acceptable for dev-tool single-developer use. A future production frontend with multiple SSE-consuming panels will likely need a browser-side multiplexer; not in MYT-52 scope.

**Panel layout:**

```
┌─ Live SSE events ─────────────────────────────────────┐
│ [Filter: phase ✓] [stage ✓] [entity ✓] [edge ✓]     │
│ [other ✓] [☐ Auto-scroll] [Pause] [Clear]            │
│                                                         │
│ ┌─ Event log (scrollable, newest at bottom) ────────┐ │
│ │ [+0.0s] phase           world_gen                  │ │
│ │ [+0.4s] stage-started   concept_intake             │ │
│ │ [+8.2s] stage-completed concept_intake  $0.0145    │ │
│ │ [+9.1s] entity-added    wf/regions/0  location     │ │
│ │         name: "Eredil"                             │ │
│ │         ▶ click to expand                          │ │
│ │ [+10.2s] entity-updated wf/regions/0  (2 fields)   │ │
│ │ ...                                                 │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─ Current entity inventory (collapsed) ─────────────┐ │
│ │ ▶ 12 entities • 8 edges • cost $0.31              │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Event card behavior:**

| Event type | Compact line | Expanded |
|---|---|---|
| `phase` | the phase value | — |
| `stage-started` / `-completed` / `-failed` | stage name + duration + cost | error message if failed |
| `entity-added` | synthKey + kind + name | full data payload, pretty-JSON |
| `entity-updated` | synthKey + count of changed fields | the patch object, pretty-JSON |
| `edge-added` | synthKey + from→to + relationship_type | full edge payload |
| `stage-reset` | which stage | — |
| `finalized` | "N entities mapped" | the synthKey→UUID table |
| `cost-update` | cumulative $ | — |

**Truncation rule** (specified for all field types so the implementer doesn't pick three different conventions):

- **String fields:** first ~80 chars, suffix `…` if longer.
- **Object fields** (e.g., `entity-added.data`): render as `${primaryKey}: ${truncatedValue} (${otherKeyCount} other fields)` where `primaryKey` resolves in precedence order: `name` → `synthKey` → first key alphabetically. The `truncatedValue` follows the string-truncation rule.
- **Array fields:** render as `${field}: [${array.length}]`.
- **Expanded view (click to expand):** ALWAYS shows the full event payload as `JSON.stringify(event, null, 2)` — not just un-truncated fields, but the entire frame. The expand is "see exactly what came over the wire," not "see more of the same compact view."

This is a HARD requirement: the panel must stay scrollable on long worlds AND every event must be inspectable at full fidelity on click. Unit tests assert both behaviors (one per truncation type + one for expand fidelity).

**Auto-scroll:** on by default, pinned to bottom as new events arrive. Pause button stops auto-scroll AND new events keep arriving (just not scrolled to). Resume button re-engages auto-scroll.

**Filter chips:** click to hide events of that type. Filtered events still arrive in memory; the panel just doesn't render them. Re-clicking the chip re-shows them in their original chronological position.

**Current entity inventory:** a flat list of every entity the panel has seen, with the most recent state's name + synthKey + kind. Sorted by last-updated descending. Click a row to scroll the event log to the most recent event for that entity. The inventory section is collapsed by default (just shows the summary counts); clicking the header expands the full list.

**Inventory reducer** (specified — derived state from the event log, NOT a parallel accumulator):
- `entity-added` → insert a new row keyed by `synthKey`; store `data` as the entity's current state.
- `entity-updated` → merge the `patch` (RFC 7396 JSON Merge Patch) into the existing row's state; if `patch.name` is present, update the displayed name.
- `entity-removed` → delete the row for that synthKey.
- `edge-added` / `edge-removed` → tracked separately in the inventory's "edges" counter (not as inventory rows).
- `stage-reset { stage }` → delete every row whose synthKey starts with `${stage}/`.
- `finalized { synthKey, entityId }` → swap the inventory row's displayed-ID from synthKey to `entityId` (synthKey is still the row's internal key; displayed-ID becomes the real UUID).

The reducer is a pure function over the event log array; clearing the log clears the inventory implicitly.

**In-memory event cap:** 2000 events. On overflow, drop the oldest 100 events and insert one synthetic `[…N earlier events dropped]` placeholder card at the position of the oldest remaining event. Both the event log AND the inventory honor the cap (when an event is dropped, the inventory derivation re-runs against the remaining events — so an entity whose only event was the dropped one disappears from inventory too).

**`mythrun.closewatch` handling:** the panel listens for the identity-switch / explicit-close event. On fire: close the SSE stream, clear the event log array, clear the inventory derivation, reset filter chips to defaults, status text shows "(no campaign watched)." Mirrors the status-panel's existing closewatch pattern.

**No graph, no SVG, no force layout, no d3-force dep.**

---

## 7. Cost cap + error handling

### 7.1 Expected per-world cost (~$1.50 happy path; cap $3.00)

| Stage | Model | ~Input tokens | ~Output tokens | ~Cost |
|---|---|---|---|---|
| 1 `concept_intake` | Sonnet + Sonnet judge | 3k / 1k | | $0.015 |
| 2 `world_and_factions` | Opus | 5k / 6k | | $0.50 |
| 3 `locations_and_npcs` | Opus | 8k / 10k | | $0.80 |
| 4 `entity_relationships` | Sonnet | 10k / 3k | | $0.06 |
| 5 `starting_situation` | Sonnet | 6k / 1.5k | | $0.030 |
| 6 `random_tables` | Haiku | 4k / 3k | | $0.003 |
| 7 `coherence_pass` | Sonnet | 14k / 2k | | $0.08 |
| Repair (avg 10% hit, mostly Haiku) | | | | $0.02 |
| Headroom for one BullMQ retry on a streaming stage | | | | $0.50 |
| **Cap target** | | | | **$3.00** |

Cap stored at `settings.world_gen_cost_cap_usd`. MYT-52 ships a settings UPDATE bumping the default from $2.00 to $3.00. Existing per-stage `peekCostCap` + `assertCostCap` helpers (from MYT-51) handle the enforcement; new stages just use them.

### 7.2 Error handling matrix

**Prerequisite — BullMQ retry config:** the world-gen `Queue` constructed in `backend/src/server.ts` currently sets `removeOnComplete: { count: 0 }` + `removeOnFail: { count: 0 }` but **no `attempts` value**. BullMQ's default is `attempts: 1` (no retries). MYT-52 must add `defaultJobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 30000 } }` to the Queue construction so the "BullMQ retries the stage" paths below actually retry. This is a one-line wiring change at queue setup; the spec calls it out as a precondition rather than a separate feature.

| Failure | Source | Visible event | Recovery |
|---|---|---|---|
| Transient API (429/503/network) | `streamObject` / `generateText` rejects with `AI_APICallError` → mapped to `LlmRateLimitedError` / `LlmOverloadedError` / `LlmTimeoutError` | `stage-failed { errorCode: 'transient_api' }` → `stage-started` on BullMQ retry (attempt 2) | BullMQ retries the stage (max 2 attempts; failure on attempt 2 is terminal) |
| Stream-end Zod fail (tree exists but invalid) | `safeParse` returns failure on the assembled tree | None visible if repair succeeds; `entity-updated` patches if repaired tree differs from original | Haiku → Sonnet → BullMQ retry. Repair preserves array shape (D3); if min-floor or max-ceiling violations would require add/drop, repair-fails and falls through to retry. |
| Repair chain exhausted | Both Haiku and Sonnet repair fail safeParse | `stage-reset { stage }` published BEFORE re-throw → `stage-started` on BullMQ retry | BullMQ retries with fresh `streamObject` call |
| Max-tokens truncation | Vercel SDK reports `finishReason: 'length'`; partial tree available but incomplete | `stage-reset { stage }` (repair can't fabricate missing tail content) | BullMQ retries with fresh call |
| In-stream API error part | Vercel SDK emits `type: 'error'` part mid-stream; middleware maps to `LlmStructuredOutputError` | `stage-reset { stage }` | BullMQ retries |
| **Content-policy filter** (new) | Anthropic returns `stop_reason: 'content_filter'`; Vercel SDK surfaces as `finishReason.unified === 'content-filter'`. Middleware maps to new `LlmContentFilteredError`. | `stage-failed { errorCode: 'content_filtered' }` → `phase: world_gen_failed` | Terminal stop — NO retry (retry would hit the same filter on the same prompt). User must adjust the source concept text via a new campaign. Resume route returns 409 `content_filtered`. |
| Persistence COMMIT failure (DB blip) | pg error not in deadlock/serialization class | `stage-reset { stage }` published before re-throw → `stage-failed` | BullMQ retries the stage. Client sees `stage-reset` (no DB rows were committed); fresh re-stream produces fresh entities. |
| **pg deadlock / serialization failure** (new) | pg error code `40P01` (deadlock) or `40001` (serialization) on COMMIT | none if first attempt recovers; `stage-reset` + retry if both attempts fail | Retry the COMMIT only (NOT the whole stage) — 2 attempts with 5s fixed backoff per parent pipeline spec §6's retry policy table. If both COMMIT attempts fail, treat as persistence-failure (above). |
| Cost cap exceeded (post-stage check) | `sumCompletedStageCosts(pool, worldId) > readCostCap(pool)` AFTER `markStageCompleted` writes the row | `stage-failed { errorCode: 'world_gen_cost_cap_exceeded' }` → `phase: world_gen_failed` + credit refund | Terminal stop. Resume route returns 409 `world_gen_capped` if cap not raised. Stage 7 EXCEPTION: cap-fire at stage 7 marks world `complete` + skipped-coherence WARN log (per D5) instead of failing. |
| `parent_location` unresolved (stage 3) | name not found in entities table OR kind-filter rejects (faction emitted as parent) | `entity-updated { synthKey, patch: { parent_location: null } }` published to sync client state | Stage 4's relationship pass may catch it as a hierarchy straggler |
| Stage 4 hallucinated UUID | LLM emits a non-existent entity_id; pre-filter rejects | none (filtered out of INSERT batch + WARN log) | The relationship is genuinely lost; no recovery. Pre-filter pattern (D9) ensures the rest of the stage's INSERTs proceed cleanly. |
| Stage 7 patch refs unknown ID | LLM emits a non-existent factId/entityId/relationshipId | none (patch skipped + WARN log) | Patch is skipped, others apply |

**Note: SDK-internal retry cost under-counting (known limitation).** With non-streaming stages on `maxRetries: 3`, the Vercel SDK retries 429/503 internally with exponential backoff. Anthropic bills failed requests' input tokens, but the SDK only reports `usage` for the successful final attempt. The cost cap under-counts SDK-internal retry burn. Pre-existing issue from MYT-44/45; not addressed in MYT-52 (would require hooking each SDK attempt, not just final usage). Acceptable risk for non-streaming stages because they're the smaller-output ones.

### 7.3 `stage-reset` is the only state-dropping event

The client's reducer for `stage-reset` is: filter every entity/edge whose synthKey starts with `${event.stage}/`; discard. This is the only inversion in the entity/edge data flow. Unit-test target on the client side.

---

## 8. Testing strategy

### Layer 1 — Unit tests with hand-synthesized fixtures (CI-safe)

`backend/src/llm/prep/__tests__/streaming-extractor.test.ts` — feed canned `partialObjectStream` outputs as async generators; assert publish-call sequence, synthKey shape, heartbeat firing. ~20 tests.

`backend/src/llm/prep/__tests__/structured-output-repair.test.ts` — mock `ai` module (`vi.mock`); feed known-bad trees + Zod errors; assert Haiku/Sonnet escalation paths and `ok: false` exhaustion. Token usage attribution. ~10 tests.

`backend/dev-tool/src/components/__tests__/live-events-panel.test.ts` — synthesize SSE event frames; pipe through panel's event handler; assert DOM card shape, filter behavior, expand behavior. ~15 tests.

### Layer 2 — Stage handler integration tests with mocked LLM + real Postgres

`backend/src/llm/prep/stages/__tests__/world-and-factions.test.ts` (~12 tests)
`backend/src/llm/prep/stages/__tests__/locations-and-npcs.test.ts` (~12 tests)
`backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts` (~10 tests)
`backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts` (~10 tests)

Pattern (matches MYT-51's `concept-intake.test.ts`):
- `vi.mock('ai')` → `streamObject` returns a synthesized `partialObjectStream` + `result.object` promise
- Real Postgres (`guardTestDatabase` + DROP SCHEMA + runMigrations)
- Run the stage handler; assert DB state + event publishes + `pipeline_runs` row
- Cover: happy path, Zod-fail-with-Haiku-repair, Zod-fail-with-Sonnet-repair, repair-exhaustion → BullMQ failure, COMMIT failure → mocked pg client, stage-3 parent-resolution edge cases, stage-4 UUID-hallucination skip, stage-7 patch-ID-not-found skip

### Layer 3 — Wire-level smoke (real Anthropic, ONE run per merge)

Per `feedback_dev_tool_e2e_smoke_required` + `feedback_smoke_vs_eval`: curl + SSE + psql, no browser automation, plumbing only (not LLM quality).

```bash
export DEV_SUB='dev-user-1'; export BASE='http://127.0.0.1:3030'

# Grant credits
curl -fsS -X POST $BASE/api/dev/credits/grant \
  -H "x-mythrun-dev-sub: $DEV_SUB" -H 'Content-Type: application/json' \
  -d '{"creditType":"world_gen","amount":5}'

# Create campaign with a plain concept
CAMPAIGN_ID=$(curl -fsS -X POST $BASE/api/campaigns \
  -H "x-mythrun-dev-sub: $DEV_SUB" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke","world":{"kind":"new","source":{"mode":"freeform","concept":"A standard fantasy kingdom on the edge of an ancient forest."}}}' \
  | jq -r .campaignId)

# Watch the stream
curl -N -fsS $BASE/api/campaigns/$CAMPAIGN_ID/status/stream \
  -H "x-mythrun-dev-sub: $DEV_SUB"
```

**Assertions (all deterministic):**
- All HTTP calls return their contract codes (201, 200)
- SSE event sequence: each of 7 stages fires `stage-started` → `stage-completed` (or `stage-failed` on a real bug); ≥1 `entity-added` between stage 2's started/completed; `phase: world_ready` then `phase: complete` arrive; `event: close` terminates
- `pipeline_runs`: 7 rows for the world, all `status='completed'`, all with non-null `cost_usd` + token counts
- Persistence non-zero: `entities` > 0, `prose_kernels` > 0, `facts` > 0, `relationships` > 0, `entity_hierarchy` > 0 for the world
- `worlds.status='complete'`, `worlds.world_overview IS NOT NULL`, `worlds.starting_situations IS NOT NULL`
- `sum(cost_usd) < 3.00` for the world
- No unhandled-error stack traces in backend stderr during the run

**NOT asserted:** entity counts beyond "> 0", LLM-output quality, coherence-pass rationale sensibility, name/prose specifics. Quality assertions belong in the eval harness (separate future track).

Cost: one ~$1.50–$2.00 Anthropic-credit run per merge.

### Layer 4 — Coverage manifest update

**Correction from earlier draft:** the 5 entity-event arms are ALREADY in `coverage.events` today; they're ALSO redundantly listed in `coverage.exempt.events` (a leftover from MYT-50's "we'll cover them in MYT-52" carve-out). The actual MYT-52 work is:

- **DELETE** the 5 entries (`stage-reset`, `entity-added`, `entity-updated`, `edge-added`, `finalized`) from `coverage.exempt.events`. They stay in `coverage.events`. Plus ADD the 2 new arms (`entity-removed`, `edge-removed`) introduced by post-design-review contract additions.
- Remove the stale "live-graph in MYT-52" reason strings.
- `pnpm dev-tool:check` green after the delete.

**Important caveat:** `check-coverage.ts` is a string-presence test — it only verifies each contract-listed event is mentioned in `coverage.events` OR `coverage.exempt.events`. It does NOT verify that the rendering code actually handles those events. Real rendering coverage is enforced by `live-events-panel.test.ts` (Layer 1), which MUST include explicit per-arm test cases:
- `entity-added` arrival → renders an event card with the kind + name + truncated data
- `entity-updated` arrival → applies the patch to the inventory row and renders a card with field-change count
- `entity-removed` arrival → deletes the inventory row and renders a card
- `edge-added` arrival → renders a card with from→to + relationship
- `edge-removed` arrival → renders a card; inventory edge counter decrements
- `stage-reset` arrival → drops inventory rows by synthKey prefix and renders a card
- `finalized` arrival → swaps inventory display-ID from synthKey to entityId and renders a card

Each per-arm test is independently checked; the test file's coverage is enforced by the existing 100%-coverage gate.

---

## 9. Done-when checklist

**System:**
- [ ] 7-stage world-gen pipeline: `concept_intake` → `world_and_factions` ★ → `locations_and_npcs` ★ → `entity_relationships` ★ → `starting_situation` → `random_tables` → `coherence_pass`. `WORLDGEN_STAGES` constant + `STAGE_ORDER` in `derive-phase.ts` both reflect this order.
- [ ] Streaming stages (2, 3, 4-new) use `streamObject` with `maxRetries: 0`; entity extraction via the shared `streaming-extractor.ts`; persistence at stream end in one transaction per stage; `entity-added` / `entity-updated` / `edge-added` events published live; name-first prompt ordering enforced.
- [ ] Repair chain (`structured-output-repair.ts`): Haiku tier → Sonnet tier → BullMQ retry as last resort. Triggers on stage's Zod-validation failure when a tree exists; skipped when `streamObject` itself rejected (transport/truncation). Preserves array length + element ordering (D3); min-floor/max-ceiling violations escalate directly to BullMQ retry. Repair-changed fields produce `entity-updated` patches to sync client.
- [ ] Stage 4 `entity_relationships` reads entities + prose + facts; emits structured edges (incl. implicit ones) via `streamObject` on Sonnet; pre-filters hallucinated UUIDs before INSERT (D9); persists `relationships` (with `deleteByWorld` first for retry-idempotency) + optional `entity_hierarchy` stragglers. `relationship_type` is a closed enum.
- [ ] Stage 7 `coherence_pass` reads full world state; emits patches via non-streaming `generateText` + `Output.object` on Sonnet (`maxRetries: 1`); patches apply as DB UPDATEs + `entity-updated` / `entity-removed` / `edge-added` / `edge-removed` events. No warnings arm, no new schema. Production-FE invisibility contract (D5): FE filters coherence-pass events from user-visible rendering.
- [ ] BullMQ Queue construction in `server.ts` adds `defaultJobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 30000 } }` (precondition for §7.2's retry paths).
- [ ] `worlds.status='complete'` only after stage 7 finishes (or stage 7 cap-fires per D11 exception).
- [ ] Per-world cost cap stays at $10.00 (MYT-51's default, unchanged). Settings row NOT modified.

**Dev tool:**
- [ ] New `live-events-panel.ts` mounted in `main.ts`. Subscribes to SSE; shows chronological event log + current-entity inventory; cards truncate by truncation rule (D12 §6); click expands to full pretty-JSON payload via `JSON.stringify(event, null, 2)`. Filter chips per event type. Inventory reducer derives from event log (handles entity-added/updated/removed + edge-added/removed + stage-reset + finalized). 2000-event cap with FIFO eviction + placeholder card. `mythrun.closewatch` handler. No graph rendering, no SVG.
- [ ] `coverage.json` migration: DELETE 5 stale exempt entries (`stage-reset`, `entity-added`, `entity-updated`, `edge-added`, `finalized`) + ADD 2 new arms (`entity-removed`, `edge-removed`) to `events`. Stale "live-graph in MYT-52" reason strings removed. `pnpm dev-tool:check` green.
- [ ] `live-events-panel.test.ts` has explicit per-arm rendering tests for all 7 entity/edge event types (assertions described in §8 Layer 4).

**Quality gates:**
- [ ] `pnpm typecheck` green
- [ ] `pnpm lint` green (0 errors; warnings tolerated)
- [ ] `pnpm test:coverage` green (100% lines / branches / functions / statements on the include set)
- [ ] `pnpm wiki:check` green
- [ ] `pnpm dev-tool:check` green
- [ ] Pre-push hook's 4 gates pass on push attempt
- [ ] CI green on the pushed commit (Deploy + Auth Lint + Wiki + LLM price check all `success`); 10-min post-push CI-status hook reports no failures
- [ ] Layer 3 wire-level smoke per §8 completed: all 7 stages reach `status='completed'`, persistence rows present, cost under cap, no stack traces

**Documentation:**
- [ ] Design doc committed at this path
- [ ] Parent pipeline spec (`docs/specs/2026-04-13-world-campaign-pipeline.md`) §3 + §8 amended: new stage list with `entity_relationships` between 3 and 4-old + `coherence_pass` after 6-old; `maxRetries: 0` on streaming stages + repair chain noted in §8; cross-reference ordering passage marked obsolete (edges live in stage 4); §8 dev-tool section updated to "live-events inspector, no graph"
- [ ] MYT-50 design doc's `exempt.events` reasons referencing "live-graph in MYT-52" updated to reference the live-events panel
- [ ] Linear MYT-52 description rewritten to reflect: new stage order (4-new + 7-new), repair chain, no-graph dev tool, coherence pass
- [ ] Wiki pages updated (AUTHORING.md subagent dispatched as part of close-the-loop): `runtime/world-gen`, `runtime/dev-tool`, possibly a new `runtime/coherence-pass` page

**Contract:**
- [ ] `backend/src/contract/pipeline-events.ts`: 2 new event arms added (`entity-removed`, `edge-removed`); `edge-added` extended with optional `description?: string`; `PIPELINE_SSE_EVENTS` array updated (12 arms total: 6 lifecycle + 7 entity/edge minus the original 5 already-listed, plus 2 new = 13... wait, 6+7=13). Recount during impl: lifecycle (6) + entity-related (7: stage-reset, entity-added, entity-updated, entity-removed, edge-added, edge-removed, finalized) = 13 total arms.

**Schema:**
- [ ] **Zero schema changes.** Everything MYT-52 needs is already in migration 001. Persister stamps `narrative_status='undelivered'` + `source='prep'` on every facts row.

---

## 10. What's NOT in MYT-52

- No production frontend graph rendering — future ticket
- No eval harness — separate future project (per `feedback_smoke_vs_eval`)
- No auto-loop on coherence pass (single one-shot run)
- No human-review workflow for coherence findings (no warnings arm at all)
- No streaming on stages 1, 5, 6, 7 (concept_intake, starting_situation, random_tables, coherence_pass)
- No fork story (still deferred per parent spec §5)
- No world-scoped routes — campaign is still the user-facing unit
- No retroactive coverage-of-stages-1-5-6-7 by the repair chain (it WILL run on them, but the repair-chain wasn't designed specifically for them; the relevant test surface lives with those stages)
