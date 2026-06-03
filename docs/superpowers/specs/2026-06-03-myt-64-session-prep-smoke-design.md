# Session Prep — first-real-LLM smoke + reusable fixture toolkit + staging gate (MYT-64) — Design

**Date:** 2026-06-03
**Linear:** MYT-64 (milestone: Session Prep Pipeline)
**Status:** design approved (verbally); pending spec review → implementation plan
**Depends on:** MYT-59 (`generateSessionPrep` stage), MYT-61 (worker + processor + idempotent resume), MYT-62 (prep-status / prep-prose SSE), MYT-63 (the trigger/list/read/reset HTTP routes), MYT-55 (the staging prep-pipeline smoke + its in-VPC ECS task). **myth-4omh** already wired the per-call Opus timeout the hardening section references.

---

## 1. Overview

Every prior session-prep ticket built and CI'd against a **mocked** LLM (`session-prep.test.ts` + `session-prep-processor.test.ts` both `vi.mock('../../../ai.js')`). No script drives `generateSessionPrep`, and MYT-55's `prep-pipeline.ts` is the *world-gen* pipeline. **MYT-64 is the first time `generateSessionPrep`'s real Opus call fires** — which is where prompt-template drift and too-tight Zod schemas surface (cf. the myth-tt2g prompt-template bug a real-LLM smoke caught).

The genuinely-new risk is therefore the prompt + schema of the real Opus call — not the HTTP/queue plumbing (MYT-63 route tests + BullMQ generic delivery already cover that). This issue ships:

1. A **reusable smoke-fixture toolkit** — the standard for "capture a real DB graph, replay it into mythrun_test for a smoke." First of many (combat states, active sessions will follow).
2. A **`ready-to-play-campaign` fixture** — captured organically from one real local pipeline run.
3. A **local session-prep smoke** — constructed-direct: load the fixture, invoke the processor with real Opus, assert plumbing.
4. A **staging gate** — extend MYT-55's smoke to also exercise session-prep, in the existing ECS task.
5. **Hardening verification** — confirm the already-built timeout / resume / partial-generation safety holds under the real-LLM run.
6. **Wiki** — finish the `runtime/session-prep` page (created in MYT-63) with a smoke runbook.

**Explicitly out of scope:** leak-cleanliness assertions. There is no runtime leak guard (the per-doc guard was descoped); leak quality is eval / red-team territory, not a plumbing smoke. The smoke asserts presence/length floors only (`ft_context ≥ 200`, `sd_playbook ≥ 100` chars — the schema floor).

## 2. Decisions locked (from brainstorming)

1. **Both surfaces:** a local smoke now (fast first-real-LLM validation) + a staging gate (durable, CI-runnable-on-staging realism via the existing ECS task). The staging LLM/worker/network/secrets surface is already validated by MYT-55 + the green MYT-63 Deploy, so the local smoke carries the new-risk load and the staging gate carries the full-wire realism.
2. **Organic seed:** the fixture is captured from a *real* pipeline run (world-gen → characters → situation → finalize → active), not hand-authored. The smoke replays the captured fixture rather than re-running the upstream pipeline each time.
3. **mythrun_test only.** All automated runs (smoke + the toolkit's own tests) hit `mythrun_test`. `mythrun_dev` is the developer's manual playground and is never touched by automation. (Extends `reference_tests_target_mythrun_test_db` to smokes.) Consequence: the local smoke is **self-contained** — it does NOT reuse `pnpm dev` (which is mythrun_dev); it invokes the processor directly against a mythrun_test pool.
4. **Reusable toolkit, not a one-off.** The capture/load engine + manifest convention are the deliverable standard; the ready-to-play campaign is its first fixture. v1 keeps it minimal: fixed IDs + delete-then-load, `schemaVersion` as a diagnostic breadcrumb (not a hard gate). ID-remapping is deferred (YAGNI until a smoke needs concurrent runs).
5. **Local smoke is constructed-direct.** It invokes `processSessionPrepJob` directly with real Opus + recording publishers — NOT a booted server+worker. The HTTP-trigger→enqueue path is covered by MYT-63 route tests; BullMQ delivery is generic; the staging gate exercises the full HTTP+queue+SSE wire. Local isolates the new LLM path.
6. **Hardening is verification, not new code** — unless the smoke surfaces a gap. Timeout (`session-prep.ts:73` → `SESSION_PREP_TIMEOUT_MS`, myth-4omh), resume (MYT-61 claim-`completed`→no-op + `ON CONFLICT DO NOTHING`), and partial-generation (the `session_preps` insert runs *after* `generateSessionPrep` returns — a mid-stream failure persists nothing → clean BullMQ retry) are already in place. Confirm + document; add code only if the smoke breaks them.

## 3. The reusable smoke-fixture toolkit

Lives at `backend/scripts/smoke/fixtures/`. Three pieces:

### 3.1 Fixture format
One JSON file per fixture (`<name>.json`):
```
{
  "name": "ready-to-play-campaign",
  "capturedAt": "<ISO>",
  "schemaVersion": "<latest migration filename at capture time>",
  "rootCampaignId": "<the campaign id the graph is scoped to>",
  "tables": [ { "name": "worlds", "rows": [ {...}, ... ] }, ... ]   // FK-dependency order
}
```
`tables` is ordered parents-before-children so the loader inserts top-to-bottom and deletes bottom-to-top. Rows are the raw column→value objects (snake_case DB columns); JSON-serializable types (timestamps as ISO strings, `jsonb` as nested JSON, `uuid`/`numeric` as strings).

### 3.2 Per-fixture manifest (`<name>.manifest.ts`)
The only per-fixture authoring. Declares, in FK-dependency order, each table + the root-scoped WHERE filter that selects its rows for the given `rootCampaignId`/`worldId`:
```
export const READY_TO_PLAY_MANIFEST: FixtureManifest = {
  name: 'ready-to-play-campaign',
  // resolves worldId from the campaign, then filters each table to the graph
  tables: [
    // `shared: true` rows are pre-seeded in mythrun_test (globalSetup) — the loader
    // INSERTs them ON CONFLICT DO NOTHING and NEVER deletes them. A real ready-to-play
    // campaign has owner + N players, so this selects ALL member/character users, not
    // just the owner (single-owner would FK-violate on the players' member/character rows).
    { name: 'users', shared: true,
      filter: (ids) => ({ sql: 'id IN (SELECT user_id FROM campaign_members WHERE campaign_id = $1)', params: [ids.campaignId] }) },
    { name: 'worlds',          filter: (ids) => ({ sql: 'id = $1', params: [ids.worldId] }) },
    { name: 'stat_blocks',     filter: (ids) => ({ sql: 'world_id = $1', params: [ids.worldId] }) },
    { name: 'entities',        filter: (ids) => ({ sql: 'world_id = $1', params: [ids.worldId] }) },
    { name: 'facts',           filter: (ids) => ({ sql: 'entity_id IN (SELECT id FROM entities WHERE world_id = $1)', params: [ids.worldId] }) },
    { name: 'relationships',   filter: (ids) => ({ sql: 'source_entity_id IN (SELECT id FROM entities WHERE world_id = $1)', params: [ids.worldId] }) },
    { name: 'prose_kernels',   filter: (ids) => ({ sql: 'entity_id IN (SELECT id FROM entities WHERE world_id = $1)', params: [ids.worldId] }) },
    { name: 'entity_hierarchy',filter: (ids) => ({ sql: 'parent_entity_id IN (SELECT id FROM entities WHERE world_id = $1)', params: [ids.worldId] }) },
    { name: 'campaigns',       filter: (ids) => ({ sql: 'id = $1', params: [ids.campaignId] }) },
    { name: 'campaign_members',filter: (ids) => ({ sql: 'campaign_id = $1', params: [ids.campaignId] }) },
    { name: 'characters',      filter: (ids) => ({ sql: 'id IN (SELECT character_id FROM campaign_characters WHERE campaign_id = $1)', params: [ids.campaignId] }) },
    { name: 'campaign_characters', filter: (ids) => ({ sql: 'campaign_id = $1', params: [ids.campaignId] }) },
  ],
}
```
**The table set above is corrected against the real schema** (round-1 review found the draft listed two non-tables): there is **no `world_inventory` table** — `repo.worldInventory.load` is a composition over `entities`/`prose_kernels`/`facts`/`relationships` (`repo/world-inventory.ts`), so capturing those rows IS the world inventory; and **`starting_situation_entries` is a JSONB column on `worlds`** (migration 016), not a table — it rides the captured `worlds` row (alongside `vocabulary_registry`), and `campaigns.starting_situation_index` rides the captured `campaigns` row. `campaign_characters` (the join `characters.listForCampaign` requires since migration 009) is a **first-class table**, loaded after both `characters` and `campaigns`. The authoritative read set is `serialize-world-state-for-prep.ts` (worlds + entities + prose_kernels + facts + relationships + entity_hierarchy + stat_blocks + the party via characters/campaign_characters + known-tier facts); the plan pins the final set + the exact FK columns against it at capture. The fixture's seed campaign MUST be **unforked** (`worlds.source_world_id`/`campaigns.source_world_id` NULL) so the graph is self-contained — an organic §4 run satisfies this.

### 3.3 Engine (`capture.ts` + `load.ts`)
- **`capture.ts <fixtureName> <rootCampaignId>`** — a one-time dev CLI. Resolves the root ids (campaign → world), runs each manifest table's filter `SELECT *`, assembles the JSON (stamping `schemaVersion` = the latest migration filename), writes `fixtures/<name>.json`. Run AFTER driving the real pipeline once. **Targets whatever DB its `DATABASE_URL` points at** (the capture is a manual dev step; the operator points it at the DB holding the freshly-built campaign).
- **`loadFixture(pool, name)`** — the reusable engine every smoke calls. Reads `<name>.json`; **delete** each NON-shared table bottom-to-top (`DELETE … WHERE` by the fixture's own ids — so re-runs are idempotent and the load never collides with a prior run's rows). **Shared rows are NEVER deleted** (`shared: true` tables, e.g. `users` — those are globalSetup-seeded dev users; deleting them would wipe the shared seed + cascade `credit_ledger`, corrupting mythrun_test for every other test file). Then **insert** each table top-to-bottom (column list from the row keys, `$n` params; `shared` tables use `ON CONFLICT DO NOTHING`).
- **JSON↔column typing:** the loader casts `object`/`array` row values to `::jsonb` on insert — `pg` sends a JS object as a text param, which fails the `jsonb_typeof` CHECK on `jsonb` columns (e.g. `worlds.starting_situation_entries`/`vocabulary_registry`, `character_concepts.guided_choices`) without the cast. `uuid`/`numeric`/`timestamptz` survive as string literals. (The manifest carries no per-column types, so the loader keys off the JS value shape.)
- **Schema-drift behavior** (the `schemaVersion` is a diagnostic breadcrumb, not a gate): add-nullable column → **works** (JSON omits it → DB default/NULL); add-NOT-NULL-no-default → **breaks** (INSERT fails — regenerate); column drop or rename → **breaks** (JSON key has no column — regenerate); CHECK-tighten → may break on old captured data (regenerate). On any INSERT failure the loader throws quoting captured `schemaVersion` vs. current + "regenerate via `capture.ts`."

The engine is generic; nothing in it is session-prep-specific.

## 4. The `ready-to-play-campaign` fixture

Capture procedure (one-time, documented in the smoke's header + the wiki runbook):
1. Bring up the stack against a capture DB (a throwaway or mythrun_test) with a real Anthropic key.
2. Drive the full pipeline to `campaign.status='active'`: create campaign (freeform concept) → world-gen completes → pick starting situation (index 0) → submit one or more character concepts → finalize-character-creation → wait for `active`. (Mirror the steps MYT-55's `prep-pipeline.ts` already performs.)
3. `pnpm tsx scripts/smoke/fixtures/capture.ts ready-to-play-campaign <campaignId>`.
4. Commit `fixtures/ready-to-play-campaign.json` + the manifest.

The captured graph must contain enough that `serializeWorldStateForPrep` yields a non-trivial prompt: the world overview, populated entities/facts/prose_kernels/relationships, ≥1 character with a known-tier fact, and a chosen `starting_situation_index`. A real pipeline run satisfies this by construction.

## 5. Local session-prep smoke — `scripts/smoke/session-prep.ts`

`pnpm smoke:session-prep` (a committed smoke script like `smoke:phantom-reconciliation` / `smoke:entity-consolidation-flow`). **DB-targeting differs from those two on purpose:** they build their pool from `loadEnv().databaseUrl` (= `DATABASE_URL` = **mythrun_dev**); this smoke must hit **mythrun_test**, and `loadEnv()`/`config/env.ts` does NOT expose `DATABASE_URL_TEST` (that redirect lives only in vitest's `setup-env.ts`). So the smoke constructs its pool from `process.env.DATABASE_URL_TEST` **directly** and re-applies the `/^mythrun_test(_.+)?$/` name guard (mirror `setup-env.ts`'s fence) so it can never touch dev/prod. Real Anthropic key from `.env.development`.

**Preconditions:** mythrun_test must be migrated (`pnpm db:migrate:test`, or a prior `pnpm test` run — a `tsx` smoke does NOT get vitest's `global-setup` schema bootstrap). Do NOT run this smoke concurrently with `pnpm test` — both target mythrun_test and would collide (cf. `reference_parallel_worktree_db_collision`).

Flow (constructed-direct):
1. `loadFixture(pool, 'ready-to-play-campaign')` into mythrun_test → yields the fixture's `campaignId` + `worldId`.
2. Construct `SessionPrepProcessorDeps`: `pool` (mythrun_test); `publishEvent` + `publishProse` are **recording stubs** that push each event into arrays. No Redis needed: `makePipelinePublishers.publishEvent` is a pure `JSON.stringify` pass-through to Redis, so the recorded objects ARE the payloads the SSE would carry — observed at the publish source. (What the stub does NOT exercise — by design, deferred to the §6 staging gate — is the subscriber's `PIPELINE_SSE_EVENTS` channel-filter + the JSON round-trip.)
3. `await processSessionPrepJob(deps, { data: { campaignId, sessionNumber: 1 } })` — runs the REAL `generateSessionPrep` (Opus, **~$0.30–0.60/call**, 9-min timeout, haiku-then-sonnet repair on a Zod miss), persists to `session_preps`, publishes `prep-started` / `prep-ready`. (Cost is bounded: output is hard-capped at `MAX_OUTPUT_TOKENS=16384` = $0.41 max at Opus's $25/Mtok output, plus ~$0.05–0.20 input for the world dump. This call is the authoritative per-prep cost number — the smoke reports `costUsd`, which feeds the §6 cap decision.)
4. **Assert** (root-cause + fail loudly on any miss, never report success on failure):
   - recorded `PipelineEvent`s include `{type:'prep-started', sessionNumber:1}` then `{type:'prep-ready', sessionNumber:1, costUsd>0}` in order;
   - the `session_preps` row exists with **both docs present, non-empty, and distinct** (`ft_context !== sd_playbook`). NOTE the `≥200`/`≥100` floors are the Zod schema's own (`session-prep.ts:20-21`): the persisted object is already validated, so a length re-check is near-tautological — it only proves the persistence round-trip survived. The substantive content check is presence + distinctness; the prose-quality bar is eval, not this smoke.
   - `pipeline_runs` `session-prep:1` (campaign-scoped, `user_id IS NULL`) = `completed` with `cost_usd > 0`.
   - **Soft/diagnostic (warn, do NOT fail):** ≥1 `prep-delta` per field. The deltas come from `partialObjectStream` (the FIRST attempt); the haiku-then-sonnet repair runs inside `await result.object` AFTER the stream, so a first attempt that fails Zod but repairs successfully can yield a valid prep with few/no deltas for the repaired field. Hard-failing on delta count would false-fail exactly the repair path this ticket exists to exercise. Log the delta counts; only the hard asserts above gate the run.
5. On PASS: delete the fixture's non-shared rows (the loader's delete pass) + report cost. On FAIL: leave state, print ids + the failed assertion, exit 1.

**Killed-mid-run caveat:** a clean stage failure marks `pipeline_runs` `failed` (re-runnable immediately); but a *process kill* mid-Opus leaves the row `running`, and `claimStage`'s stuck-reset only re-claims after `INTERVAL '5 minutes'` — inside that window a re-run's claim returns `lost-race` and the processor no-ops. After a killed run, wait 5 min or manually reset the `session-prep:1` row before re-running. Worker/Redis not required (direct invocation). The smoke is **manual** (real LLM cost) — not wired into CI.

## 6. Staging gate — extend `scripts/smoke/prep-pipeline.ts`

MYT-55's smoke already reaches `campaign.status='active'` (world complete + characters finalized + situation picked) per concept; it is HTTP-poll-based (`pollFor` helper) with no SSE consumer today. Append, per campaign, after the active barrier:
1. `POST /api/campaigns/:campaignId/session-prep` (owner auth) → assert `202 { campaignId, sessionNumber: 1 }`.
2. Observe the player-facing `prep-status` SSE (`GET /api/campaigns/:campaignId/prep-status`) until `prep-ready` (or `prep-failed`), bounded ~10 min (single Opus call). This is the staging gate's value-add over the local smoke — the real publish→Redis→subscriber→SSE wire. **It is NET-NEW code:** `prep-pipeline.ts` has no SSE reader and no `waitFor` (only `pollFor` polling); and native `EventSource` can't set the `Authorization: Bearer` header this route needs (`requireCampaignMember`), so it's a `fetch` + `ReadableStream.getReader()` reader with the header (the dev-tool's `sse-client.ts openSse()` is the in-repo precedent; cf. `reference_eventsource_cant_set_headers`). **Completion-race guard:** the route writes a one-shot `snapshot: {status: ready|generating}` frame on connect and does NOT replay `prep-ready`; if the prep already completed (fast finish, or an idempotent re-entry that re-emits nothing), the live event never arrives. Treat the initial `snapshot: ready` — or a post-attach `sessionPreps.existsFor(campaignId, 1)` check — as terminal success, else the loop burns the full budget on an already-done prep. Tee the stream to a log.
3. Assert the `session_preps` row for `(campaignId, 1)` exists with both docs non-empty + distinct; `pipeline_runs` `session-prep:1` = `completed`.
4. Fold these into the existing three-layer assertion contract + the PASS-cascade-delete. `session_preps.campaign_id` is `ON DELETE CASCADE` (migration 001), so it cleans up with the campaign — but `characters` do NOT cascade from campaigns (migration 009 decoupled them; the file already deletes them manually), so the cleanup correctness rides on the existing teardown, unchanged.

**Infra: no new task-def / IAM / ECS task** — it runs in the existing `mythrun-staging-smoke-prep-pipeline` task. **Whether the two budget env vars need a bump is a measure-first decision, not a guess** (an earlier draft wrongly asserted "+$3–6 → cap definitely trips"; that was built on a bad per-call estimate — see §5, a real session-prep is ~$0.30–0.60):
- **`SMOKE_COST_CAP_USD`** is `"5.00"` (`infra/environments/staging/main.tf`), enforced campaign-summed; the cost query already folds campaign-scoped `session-prep:1` rows in. The added spend is ~$0.30–0.60 × 3 campaigns ≈ **+$1–2**. Whether that fits the $5 cap depends on the existing 3-campaign world-gen + character spend (unknown precisely here — the staging smoke already reports it). **The plan: (a) take the real per-call cost from the local smoke, (b) read the existing smoke's actual total from a recent staging run, (c) bump `SMOKE_COST_CAP_USD` ONLY if (existing + ~$1–2) exceeds it.** Likely a small bump or none.
- **`SMOKE_WALL_CLOCK_BUDGET_MS`** is `2100000` (35 min). The per-campaign critical path gains up to the ~10-min prep wait (campaigns run in parallel → +~10 min to the slowest chain, not ×3). Same measure-first call: reassess against a real run, raise only if it's tight.
If either bump is needed, it's a one-line Terraform value change (no resource change) + a `Deploy` to roll the task-def env (cf. `reference_tf_ci_taskdef_split`). If neither is needed, the staging extension is genuinely infra-free.

## 7. Hardening — verification

Confirm under the real-LLM run, document in the wiki, add code ONLY on a surfaced gap:
- **Opus timeout** — `session-prep.ts:73` passes `timeoutMs: SESSION_PREP_TIMEOUT_MS` (9 min) to the streamed call; the myth-4omh AbortSignal bounds a stalled socket. Already wired.
- **Resume** — the processor's `atomicClaimStage` returns `completed`→no-op on BullMQ retry, and `sessionPreps.insert` is `ON CONFLICT (campaign_id, session_number) DO NOTHING`. Re-entry is safe. Already in place (MYT-61).
- **Partial generation** — `generateSessionPrep` returns the two docs only after `await result.object`; the processor's `repo.sessionPreps.insert` + `markStageCompleted` run *after* that. A mid-stream failure (timeout, transport) throws before any persist → no `session_preps` row, `pipeline_runs` marked `failed`, BullMQ retries cleanly. No partial row is possible. Already safe by construction.

If the smoke shows any of these false, that's a real bug → fix in this issue (root-cause first, per the standing rule).

## 8. Wiki

`runtime/session-prep.html` exists (MYT-63 added the HTTP-surface section + redrew the diagram). MYT-64:
- Add an **"Operating this piece"** runbook: "Run the session-prep smoke" (the `pnpm smoke:session-prep` local flow + the capture procedure for regenerating the fixture) and "Regenerate the ready-to-play fixture."
- Confirm the narrative reflects that the LLM path is now smoke-validated (mental-model test); accept-drift if the prose still matches, else a light edit.
- The reusable fixture toolkit is dev tooling, not the served system — it does NOT get a wiki page (per `feedback_tooling_not_on_linear` adjacency; the smoke runbook on the session-prep page references it).

## 9. Testing

- **Toolkit** (`capture` round-trip + `loadFixture`): real-PG unit tests in mythrun_test. The toolkit lives in `scripts/smoke/fixtures/` (dev tooling, alongside the other smoke scripts), so vitest's `parallel` project RUNS its `__tests__/` (a failing toolkit test fails the suite) but it is NOT under the `src/**`-only 100% coverage gate — same posture as the existing `scripts/smoke/*.ts`. Test `loadFixture` is idempotent (load twice → one graph), inserts in FK order (no FK violation), honors `onConflict` for shared tables, **leaves `shared: true` rows untouched on the delete pass** (the data-corruption guard — a pre-seeded user the fixture references must survive load+cleanup), casts `jsonb` values correctly, and throws the regenerate-hint on a simulated breaking-schema row. `capture` is exercised by a round-trip (seed a tiny graph → capture → load → assert row parity). Because the fixture's IDs are fixed (not scope-branded), these tests delete their own fixed-ID graph in `afterAll` (scope-equivalent teardown) so they don't pollute mythrun_test for other files.
- **Smokes**: manual, real-LLM, not CI (cost). The local smoke is the dev-run gate for "session-prep LLM works"; the staging extension is the pre-launch gate.
- **No mocked-LLM duplication**: the existing `session-prep.test.ts` (mocked) stays as the fast unit gate; MYT-64 adds the real-LLM exercise on top, it doesn't replace.

## 10. References

- `backend/src/llm/prep/stages/session-prep.ts` (`generateSessionPrep`, the floor schema, `SESSION_PREP_TIMEOUT_MS`), `serialize-world-state-for-prep.ts` (the read set: world + party + chosen situation).
- `backend/src/llm/prep/session-prep-processor.ts` (`processSessionPrepJob`, `SessionPrepProcessorDeps`, the `session-prep:${n}` stage, idempotent resume).
- `backend/scripts/smoke/prep-pipeline.ts` (MYT-55 — the staging smoke to extend; reaches `campaign.status='active'` at step 8), `entity-consolidation-flow.ts` / `phantom-reconciliation.ts` (the committed-smoke-script pattern + package scripts).
- `backend/src/contract/pipeline-events.ts` (`PipelineEvent` `prep-started`/`prep-ready`/`prep-failed`; `ProseEvent` `prep-delta`).
- migration set under `backend/migrations/` (the FK graph + table columns the manifest pins).
- `docs/wiki/content/runtime/session-prep.html` (the page to finish).
