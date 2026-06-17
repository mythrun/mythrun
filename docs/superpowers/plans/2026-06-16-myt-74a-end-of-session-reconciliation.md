# MYT-74a — End-of-Session Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** at session end, commit the working set to durable, tier-preserving, append-only canon — and build the session-end lifecycle that triggers it.

**Architecture:** A new `session-reconcile` BullMQ worker (modeled on `scribe-worker.ts`) runs off the hot path: deterministic candidate retrieval (`findSimilarEntities`) → ONE holistic Opus reconciliation plan → structural+policy validation → a transactional multi-substrate commit (entities + append-only facts + supersede pointers + relationship/hierarchy edges + pgvector) → working-set `clear()`. The session-end lifecycle (an `end_session` WS frame + a budget-100% auto-end) quiesces in-flight work, flips status, enqueues reconcile, and a session-start interlock blocks a new session on the same campaign until reconcile completes.

**Tech Stack:** Node 24 + TS strict, Postgres + pgvector, Redis + BullMQ, Anthropic via `llm/ai.ts` (`generateObject` + repair + `redactRawText`), Voyage embeddings, Zod, prompts as `.txt` via `loadPrompt`. Spec: `docs/superpowers/specs/2026-06-16-myt-74a-end-of-session-reconciliation-design.md`.

---

## Context primer (cross-cutting invariants every implementer needs)

Read this even if your task is one file.

1. **The flow.** A session ends (player `end_session` OR token budget hits 100%) → the lifecycle quiesces (drains the final turn + its trailing Scribe/ST-eval jobs), flips `sessions.status='ended'` + `ended_at`, and enqueues ONE `session-reconcile` job (`jobId=reconcile-{sessionId}`). The reconcile worker (off hot path) loads the working set, retrieves canon candidates, runs ONE Opus call producing a structured **plan**, validates it (structural + policy), commits it in ONE transaction, sets `sessions.reconciled_at` **conditionally**, and `clear()`s the working set. Canon is NEVER written elsewhere.

2. **ZFC.** Mechanical retrieve → LLM judgment → mechanical commit. `findSimilarEntities` retrieves candidates; the Opus reconciler makes ALL match/mint/contradiction judgments and emits a plan; deterministic code validates (structural + the tier/attribution **policy** floors — the ZFC exception) and commits. No similarity-threshold auto-match.

3. **Append-only facts (migration 027).** `facts` gains `superseded_by UUID REFERENCES facts(id) ON DELETE SET NULL` + `superseded_at TIMESTAMPTZ`. Live canon = `superseded_by IS NULL`. A correction APPENDS a new fact and points the old one's `superseded_by` at it (+ NULLs the old embedding so it leaves the HNSW index). `facts.content` is immutable. EVERY canon fact reader filters `superseded_by IS NULL` via a `liveOnly` flag (default true): `world-retrieval.searchFacts`, `world-retrieval.listFactsToEmbed`, `facts.listByEntities` (covers the GET /active snapshot + `world-snapshot-view` + the reconciler's own candidate read), `world-inventory.load`'s facts query.

4. **Enforced ignorance — the real leak surface is logs/alerts, NOT the player stream.** The validated plan legitimately contains secret prose (a `secret` fact's content IS the secret). `redactRawText:true` covers only the raw/repair channel. So: the plan object is NEVER logged or broadcast, and every alert payload (validator-reject, terminal-failure) carries STRUCTURAL facts only (op counts, the rejected op's kind+index, ids, sessionId) — never `content`/`description` prose or the working-set/candidate snapshot. Mirror MYT-73's scribe-leak posture.

5. **Tier + attribution are POLICY (mechanical, not prompt-trust).** Each plan `fact` carries `subjectName` (the carried-through working-set key — NOT the model-rephrasable entity `name`) and `claimedBy`. The validator REJECTS the plan if (a) a fact's `accessLevel` is weaker than its working-set item's `tier` (per-fact tier floor), or (b) a fact whose item is `provenance:attributed` has `claimedBy: null`. Reject-not-edit.

6. **Idempotency is a conditional-update mutex.** The commit's last statement is `UPDATE sessions SET reconciled_at = now() WHERE id = $1 AND reconciled_at IS NULL`; 0 rows updated → another execution already reconciled → roll back, `clear()`, exit. A plain `SET` is NOT a guard. `jobId` dedup + a `lockDuration` above the worst-case Opus+Voyage wall-clock make a second execution rare; the conditional makes a slip correct.

7. **Exact contracts (current `main`, verified):**
   - `entities` HAS `encountered`/`modified_by_play` columns (default false), `access_level`, `created_in`. No setter method exists → T6 adds `markTouchedByPlay`.
   - `facts.listByEntities(entityIds, {accessLevels})` is on `factsNs`; `InsertFactInput = {entityId, topic, accessLevel, content}`; inserts bake `narrative_status='undelivered'`. The reconcile append needs `source` + `narrative_status='delivered'` + `topic` (NOT NULL).
   - `relationships.insertIntegrationEdge({sourceEntityId, targetEntityId, relationshipType, description})` mints id, leaves `synth_key` NULL (use this for session edges — no synth_key to invent).
   - `entityHierarchy.insert({parentEntityId, childEntityId})`.
   - `sessions.getById(id)` EXISTS; `sessions.update(id, {status, endedAt, ...})` exists (COALESCE — null = unchanged).
   - `findSimilarEntities(worldId, text, {limit, entityType?}) → EntityCandidate[]` (THROWS on failure). `EntityCandidate = {entityId, name, entityType, score}`.
   - `generateObject({model, schema, schemaName, prompt, callSite, repairStrategy, timeoutMs, maxOutputTokens, redactRawText, abortSignal?}) → {output, usage, repairAttempted}`.
   - `loadPrompt('session', name, vars)`; templates at `backend/src/llm/prompts/session/*.txt`.
   - `OPUS`/`HAIKU`/`SONNET` from `llm/models.js` (never hardcode ids).
   - Worker builder model: `scribe-worker.ts` `buildScribeWorker(redisBatch, redisRealtime, redisKeyPrefix, pool, embedder, logger)` + the narrow-repo + `typeof`-injected-LLM-fn deps pattern. (`session-suspend.ts` has NO worker builder — model the builder on scribe.)
   - Migration runner auto-discovers `migrations/*.sql`, wraps each in a tx (NO `BEGIN`/`COMMIT`, NO `CONCURRENTLY` in the file). Next = `027`. Backend tests target `mythrun_test`; run `pnpm db:migrate:test` after T1.
   - Tests: scoped fixtures (`createTestPool`/`makeTestScope`/`cleanupTestScope`/`guardTestDatabase`), real PG → `mythrun_test`. LLM-boundary: `vi.mock('../../llm/session-reconciler.js')` (mock the wrapper module, not `'ai'`); the worker injects `runReconciler` as a `typeof` dep so it's unit-testable with a recording fake. Redis: ioredis-mock.

8. **Verification discipline.** `pnpm --filter @mythrun/backend typecheck` is authoritative over injected diagnostics. Verify lint via `pnpm --filter @mythrun/backend lint` (= `eslint src`), NOT per-file (type-aware rules only fire over the whole tree). Scoped coverage during iteration: `pnpm vitest run <test> --coverage --coverage.include='<src>'`. 100% coverage gate at the pre-push.

---

## File map / wave table

| Task | Files | Wave | Deps |
|---|---|---|---|
| T1 migration 027 | `migrations/027_fact_supersede.sql` | A | — |
| T2 plan schema | `llm/schemas/session-reconcile.ts` | A | — |
| T3 reconciler LLM call + prompt | `llm/session-reconciler.ts` + `prompts/session/session-reconciler.txt` | A | T2 |
| T4 reconcile validator | `session/reconcile/validate.ts` | A | T2 |
| T5 facts repo: append + supersede + liveOnly | `repo/facts.ts` | B | T1 |
| T6 entities repo: markTouchedByPlay | `repo/entities.ts` | B | T1 |
| T7 read-path liveOnly ripple | `repo/world-retrieval.ts`, `repo/world-inventory.ts` | B | T1 |
| T8 sessions repo: reconciled_at + conditional gate | `repo/sessions.ts` (+ `repo/types.ts`) | B | T1 |
| T9 commit applier | `session/reconcile/commit.ts` | C | T4,T5,T6,T8 |
| T10 reconcile worker (queue + processor + builder) | `session/session-reconcile.ts` | C | T3,T9 |
| T11 lifecycle: end_session frame + ending gate + cancelSuspend | `contract/session-events.ts`, `routes/ws-session.ts`, `session/session-end.ts` | D | T10 |
| T12 budget-100% auto-end | `session/turn-worker.ts` | D | T11 |
| T13 start interlock + worker wiring | `routes/sessions.ts`, `worker.ts` | D | T10,T11 |
| T14 controller: leak-matrix + real-LLM smoke + sweep + wiki + push + Linear Done | `session/__tests__/reconcile-leak.test.ts`, `scripts/smoke/myt-74a-reconcile-smoke.ts` | E | all |

**Wave A** (T1–T4) is parallel-safe (disjoint files). **Wave B** (T5–T8) is parallel-safe after T1 (disjoint repo files). **Wave C**: T9 then T10 (T10 imports T9). **Wave D**: T11→T12→T13 touch different files but share the lifecycle; run T11, then T12 + T13 (T13's interlock is independent of T12). **Wave E**: controller-run.

The reconcile engine lives in a new `session/reconcile/` directory (validate.ts, commit.ts) so each file is focused and the worker (`session-reconcile.ts`) is thin orchestration.

---

## T1 — Migration 027 (append-only facts + reconciled_at)

**Files:** Create `backend/migrations/027_fact_supersede.sql`; Test `backend/src/db/__tests__/migration-027.test.ts`.

- [ ] **Write the migration:**
```sql
-- 027_fact_supersede.sql — MYT-74a §3
-- Append-only fact log: a correction APPENDS a new fact and points the old
-- one's superseded_by at it (content is never edited). Live canon =
-- superseded_by IS NULL. ON DELETE SET NULL is deliberate: entities→facts is
-- ON DELETE CASCADE, and a world-regen wipe deleting an entity whose superseded
-- fact is pointed-to by a live fact would otherwise FK-abort the cascade under
-- the bare NO ACTION default.
-- Plus sessions.reconciled_at: the end-of-session reconcile completion marker
-- (the conditional-update idempotency gate; tri-state with ended_at).
ALTER TABLE facts
  ADD COLUMN superseded_by UUID REFERENCES facts(id) ON DELETE SET NULL,
  ADD COLUMN superseded_at TIMESTAMPTZ;

CREATE INDEX idx_facts_live_by_entity
  ON facts (entity_id, access_level)
  WHERE superseded_by IS NULL;

ALTER TABLE sessions
  ADD COLUMN reconciled_at TIMESTAMPTZ;
```
- [ ] **Write the test** `migration-027.test.ts` (real PG, scoped): after migrate, `facts` has `superseded_by`/`superseded_at` columns; the self-FK exists with `ON DELETE SET NULL` (query `information_schema` / `pg_constraint` `confdeltype = 'n'`); `sessions` has `reconciled_at`; inserting two facts and setting `f1.superseded_by = f2.id` then `DELETE FROM facts WHERE id = f2.id` leaves `f1.superseded_by = NULL` (not an FK abort).
- [ ] **Run:** `pnpm db:migrate:test` (applies 027 to `mythrun_test`), then `pnpm vitest run src/db/__tests__/migration-027.test.ts`. Expected: PASS.
- [ ] **Commit:** `feat(MYT-74a): migration 027 — append-only facts (superseded_by) + sessions.reconciled_at (T1)`

---

## T2 — The reconcile plan schema

**Files:** Create `backend/src/llm/schemas/session-reconcile.ts`; Test `backend/src/llm/schemas/__tests__/session-reconcile.test.ts`.

- [ ] **Write the schema** (flat root, no `.refine`, no `.max()` on free-prose):
```ts
import { z } from 'zod'

export const ReconcilePlanSchema = z.object({
  entities: z.array(
    z.object({
      op: z.enum(['match', 'mint']),
      subjectName: z.string().min(1),
      canonEntityId: z.string().nullable(),   // set when op='match'
      name: z.string().min(1),                // canonical name
      entityType: z.enum(['npc', 'location', 'faction', 'item']),
      accessLevel: z.enum(['known', 'discoverable', 'secret']),
    }),
  ),
  facts: z.array(
    z.object({
      subjectName: z.string().min(1),         // the carried-through working-set key (§5 floor join)
      topic: z.string().min(1),               // facts.topic is NOT NULL; model-emitted
      content: z.string().min(1),             // attribution baked in for attributed items; NO .max()
      accessLevel: z.enum(['known', 'discoverable', 'secret']),
      claimedBy: z.string().nullable(),       // NPC name for an attributed claim, else null
      supersedesFactId: z.string().nullable(),
    }),
  ),
  relationships: z.array(
    z.object({
      fromSubjectName: z.string().min(1),
      toSubjectName: z.string().min(1),
      relationshipType: z.string().min(1),
      description: z.string().min(1),
    }),
  ),
})
export type ReconcilePlan = z.infer<typeof ReconcilePlanSchema>
```
- [ ] **Write the test:** accepts a full valid plan (one mint entity, one match entity, one fact with `claimedBy`, one relationship); accepts empty arrays (`{entities:[],facts:[],relationships:[]}`); rejects an entity with an unknown `entityType`; rejects a fact missing `topic`; a stray extra key on a fact is stripped (`.parse` drops it — assert the parsed fact has no extra key). NO `.max` rejection (a 2000-char `content` parses).
- [ ] **Run:** `pnpm vitest run src/llm/schemas/__tests__/session-reconcile.test.ts`; `pnpm --filter @mythrun/backend typecheck`. PASS.
- [ ] **Commit:** `feat(MYT-74a): reconcile plan schema (T2)`

---

## T3 — The reconciler LLM call + prompt

**Files:** Create `backend/src/llm/session-reconciler.ts`; Create `backend/src/llm/prompts/session/session-reconciler.txt`; Test `backend/src/llm/__tests__/session-reconciler.test.ts`.

- [ ] **Write the prompt** `session-reconciler.txt` (placeholders `{{workingSet}}`, `{{candidates}}`, `{{worldTone}}`). It must instruct: you are the end-of-session reconciler; decide match vs mint per subject; attach facts (emit `topic`; for an attributed item set `claimedBy` to the NPC and phrase `content` as "<NPC> claims …"; NEVER weaken a tier — keep each fact's `accessLevel` ≥ its working-set item's tier); resolve a contradiction with canon by either absorb (canonize the improvised version) or supersede (append the corrected fact and set `supersedesFactId` to the contradicted live fact id); OMIT any restatement that already matches a live candidate fact (no duplicate facts); emit ONLY the structured plan. (Carry the identical "never reveal a secret in player-facing content beyond what's already canon" framing as st-lookup-vet; reconciler may write secret-tier facts but tags them `secret`.)
- [ ] **Write the failing test** (`vi.mock('ai')` returning a controlled plan):
```ts
import { describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import { runSessionReconciler } from '../session-reconciler.js'
vi.mock('ai', async (orig) => ({ ...(await orig<typeof import('ai')>()), generateText: vi.fn() }))
const mock = vi.mocked(ai.generateText)
it('returns the validated plan + usage + repairAttempted', async () => {
  mock.mockResolvedValueOnce({
    output: { entities: [], facts: [], relationships: [] },
    finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  } as never)
  const r = await runSessionReconciler({ workingSet: 'WS', candidates: 'C', worldTone: 'grim' })
  expect(r.result).toEqual({ entities: [], facts: [], relationships: [] })
  expect(r.repairAttempted).toBe(false)
})
```
- [ ] **Implement** (mirror `secret-tripwire.ts` / `retcon-author.ts`):
```ts
import { generateObject, type LanguageModelUsage } from './ai.js'
import { OPUS } from './models.js'
import { loadPrompt } from './prompts.js'
import { ReconcilePlanSchema, type ReconcilePlan } from './schemas/session-reconcile.js'

const RECONCILE_TIMEOUT_MS = 120_000
const RECONCILE_MAX_OUTPUT_TOKENS = 8_000

export interface SessionReconcilerInput {
  readonly workingSet: string   // rendered working-set items block
  readonly candidates: string   // rendered candidate entities + their live facts block
  readonly worldTone: string
  readonly abortSignal?: AbortSignal
}
export interface SessionReconcilerOutput {
  readonly result: ReconcilePlan
  readonly usage: LanguageModelUsage
  readonly repairAttempted: boolean
}
export async function runSessionReconciler(input: SessionReconcilerInput): Promise<SessionReconcilerOutput> {
  const r = await generateObject({
    model: OPUS,
    schema: ReconcilePlanSchema,
    schemaName: 'ReconcilePlanSchema',
    prompt: loadPrompt('session', 'session-reconciler', {
      workingSet: input.workingSet,
      candidates: input.candidates,
      worldTone: input.worldTone,
    }),
    callSite: 'session-reconciler',
    repairStrategy: 'sonnet',
    timeoutMs: RECONCILE_TIMEOUT_MS,
    maxOutputTokens: RECONCILE_MAX_OUTPUT_TOKENS,
    redactRawText: true,
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
  })
  return { result: r.output, usage: r.usage, repairAttempted: r.repairAttempted }
}
```
- [ ] **Run:** `pnpm vitest run src/llm/__tests__/session-reconciler.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74a): session-reconciler Opus call + prompt (T3)`

---

## T4 — The reconcile validator

**Files:** Create `backend/src/session/reconcile/validate.ts`; Test `backend/src/session/reconcile/__tests__/validate.test.ts`.

The validator is pure (no I/O): it takes the plan + the working set + the loaded live candidate facts and returns either `{ok:true, map}` (the `subjectName→entityId` resolution map for the commit) or `{ok:false, reason}` (a STRUCTURAL reason — never secret prose).

- [ ] **Write the types + failing tests first.** Cover every arm: a valid plan → `{ok:true}` + a map resolving every fact/relationship subject; a `match` with a `canonEntityId` not in the candidate id set → `{ok:false, reason:'dangling_match'}`; an illegal `entityType` can't occur (Zod) so skip; a `fact.subjectName` resolving to no entity op AND no live-canon entity → `dangling_fact_subject`; a relationship endpoint resolving to nothing → `dangling_relationship_endpoint`; a `supersedesFactId` not in the live-fact id set → `supersede_target_not_live`; a fact whose working-set item is `secret` but `accessLevel:'known'` → `tier_downgrade`; a fact whose working-set item is `attributed` but `claimedBy:null` → `attribution_dropped`. Assert: NO `reason` string contains any fact `content` (structural only).
- [ ] **Implement** `validateReconcilePlan(plan, ctx)` where `ctx = { workingSet: WorkingSetItem[]; liveCandidateEntityIds: Set<string>; liveFactIds: Set<string> }`. Build the `subjectName→entityId` map from match ids + a placeholder for mints (mints resolve at commit to a fresh uuid, so the map marks mint subjects as `{mint:true}`); resolve each fact/relationship subject through map ∪ existing-canon (an entity op OR an id resolvable from a prior canon entity — for v1 require it be in the plan's entity ops, else dangling). Tier floor: join each fact to its working-set item by `subjectName` (first item with that subjectName), reject if `tierRank(fact.accessLevel) < tierRank(item.tier)` (rank known<discoverable<secret). Attribution: reject if the item's `provenance.kind==='attributed'` and `fact.claimedBy===null`. Return the resolution structure on success.
- [ ] **Run:** `pnpm vitest run src/session/reconcile/__tests__/validate.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74a): reconcile plan validator — structural + tier/attribution policy (T4)`

---

## T5 — facts repo: append + supersede + liveOnly read flag

**Files:** Modify `backend/src/repo/facts.ts`; Test `backend/src/repo/__tests__/facts-supersede.test.ts`.

- [ ] **Write failing tests** (real PG, scoped): `insertReconciled({entityId, topic, content, accessLevel, claimedBy})` writes `source='session'`, `narrative_status='delivered'`, and the claim attribution; `setSuperseded(oldId, newId)` sets `superseded_by`/`superseded_at` AND NULLs the old row's `embedding`; `listByEntities(ids, {accessLevels})` with default `liveOnly` hides a superseded fact and shows its replacement; `listByEntities(ids, {accessLevels, liveOnly:false})` shows both.
- [ ] **Implement on `factsNs(c)`:**
  - `insertReconciled(input: { entityId, topic, content, accessLevel, claimedBy: string|null })` → `Promise<string>` (mints id; SQL `INSERT INTO facts (id, entity_id, topic, access_level, content, narrative_status, source) VALUES ($1,$2,$3,$4,$5,'delivered','session')`; returns id). (Attribution lives in `content` per D6; `claimedBy` is carried for the validator + optionally logged structurally — it is NOT a column, so it is not written here. Keep the param so the commit can assert it was set, but document that the structural enforcement happened in T4's validator.) — **Simplify: drop `claimedBy` from the repo input; the validator already enforced it; the repo just writes content/topic/access.** Final signature: `insertReconciled({ entityId, topic, content, accessLevel }) → Promise<string>`.
  - `setSuperseded(oldFactId: string, newFactId: string)` → `Promise<number>`: `UPDATE facts SET superseded_by=$2, superseded_at=now(), embedding=NULL, embedded_at=NULL WHERE id=$1 AND superseded_by IS NULL` (the `AND superseded_by IS NULL` makes a double-supersede a no-op).
  - `listByEntities(entityIds, opts)` — add `liveOnly?: boolean` to opts (default `true`): append `AND superseded_by IS NULL` to the WHERE when `liveOnly !== false`.
- [ ] **Run:** `pnpm vitest run src/repo/__tests__/facts-supersede.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74a): facts repo — insertReconciled + setSuperseded + liveOnly read (T5)`

---

## T6 — entities repo: markTouchedByPlay

**Files:** Modify `backend/src/repo/entities.ts`; Test `backend/src/repo/__tests__/entities-touched.test.ts`.

- [ ] **Write failing test** (real PG): seed two entities; `markTouchedByPlay([id1, id2])` sets `encountered=true` + `modified_by_play=true` on both; an empty array is a no-op (returns 0).
- [ ] **Implement on `entitiesNs(c)`:** `markTouchedByPlay(entityIds: readonly string[])` → `Promise<number>`: if empty return 0; `UPDATE entities SET encountered=true, modified_by_play=true, updated_at=now() WHERE id = ANY($1)` returning rowCount.
- [ ] **Run:** `pnpm vitest run src/repo/__tests__/entities-touched.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74a): entities repo — markTouchedByPlay (T6)`

---

## T7 — read-path liveOnly ripple

**Files:** Modify `backend/src/repo/world-retrieval.ts`, `backend/src/repo/world-inventory.ts`; Test `backend/src/repo/__tests__/world-retrieval-supersede.test.ts`.

- [ ] **Write failing tests** (real PG): seed a world + entity + a live fact + a superseded fact (embed both). `searchFacts(worldId, vec, 10)` returns only the live fact. `listFactsToEmbed(worldId, false)` excludes the superseded fact. `worldInventory.load(worldId).factsById` excludes the superseded fact.
- [ ] **Implement:**
  - `world-retrieval.ts` `searchFacts`: add `AND f.superseded_by IS NULL` to the WHERE (after `f.embedding IS NOT NULL`).
  - `world-retrieval.ts` `listFactsToEmbed`: add `AND f.superseded_by IS NULL` to the WHERE.
  - `world-inventory.ts` `load` facts query: add `AND f.superseded_by IS NULL` to the WHERE.
  (These four canon readers + T5's `listByEntities` complete the §3 reader set. No flag needed on these three — they are unconditionally live-only; a history reader is out of scope.)
- [ ] **Run:** `pnpm vitest run src/repo/__tests__/world-retrieval-supersede.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74a): read-path liveOnly filter across canon fact readers (T7)`

---

## T8 — sessions repo: reconciled_at + the conditional gate

**Files:** Modify `backend/src/repo/sessions.ts`, `backend/src/repo/types.ts`; Test `backend/src/repo/__tests__/sessions-reconcile.test.ts`.

- [ ] **Write failing tests** (real PG): `markReconciled(sessionId)` on a session with `reconciled_at IS NULL` returns `1` and sets `reconciled_at`; a second `markReconciled` returns `0` (already set — the conditional gate); `getById` reflects `reconciledAt`.
- [ ] **Implement:**
  - `repo/types.ts`: add `reconciledAt: Date | null` to `Session`.
  - `sessions.ts` `toSession` mapper: map `reconciled_at` → `reconciledAt`.
  - `sessions.ts` `markReconciled(id: string)` → `Promise<number>`: `UPDATE sessions SET reconciled_at = now() WHERE id = $1 AND reconciled_at IS NULL` returning rowCount. (This is the §4 conditional mutex; the commit calls it as its last in-tx statement and rolls back on 0.)
- [ ] **Run:** `pnpm vitest run src/repo/__tests__/sessions-reconcile.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74a): sessions repo — reconciledAt + markReconciled conditional gate (T8)`

---

## T9 — The commit applier

**Files:** Create `backend/src/session/reconcile/commit.ts`; Test `backend/src/session/reconcile/__tests__/commit.test.ts`.

The commit applier takes a VALID plan + its resolution map + the loaded working set and applies it inside ONE transaction (`repo.transaction`). It returns `{committed: true}` or `{committed: false}` (the conditional gate lost). It does NOT call the LLM and does NOT embed (the worker embeds before BEGIN and passes vectors in).

- [ ] **Write failing tests** (real PG, real repo): given a plan with one mint entity + one fact + one match entity + a supersede + a relationship + a `parentName` hierarchy edge + precomputed embeddings, `applyReconcileCommit(repo, {plan, map, workingSet, sessionId, embeddings})` mints the entity (`created_in='session:<id>'`), appends the fact (live, `source='session'`), sets the supersede pointer + NULLs the old embedding, writes the relationship (integration edge, synth_key NULL), writes the hierarchy edge, calls `markTouchedByPlay`, writes the new fact's embedding, and `markReconciled` returns 1 → `{committed:true}`. A second apply (reconciled_at already set) → `markReconciled` returns 0 → the tx rolls back, `{committed:false}`, no duplicate rows.
- [ ] **Implement** `applyReconcileCommit(repo, args)` (full structural code — mint entities resolving the map's mint-subjects to fresh `uuidv7()`s, resolve fact/rel/hierarchy subjects through the completed map, `tx.facts.insertReconciled`, `tx.facts.setSuperseded`, `tx.facts.updateEmbedding`, `tx.relationships.insertIntegrationEdge`, `tx.entityHierarchy.insert`, `tx.entities.insert` + `tx.entities.markTouchedByPlay`, and FINALLY `tx.sessions.markReconciled(sessionId)` → if `0`, throw a `RollbackSignal`/return a sentinel so `repo.transaction` rolls back and `applyReconcileCommit` returns `{committed:false}`). Embeddings are passed in (Voyage call happened before BEGIN). Use the repo's `expectCommitted`/rollback-sentinel idiom (verify against `repo/index.ts`).
- [ ] **Run:** `pnpm vitest run src/session/reconcile/__tests__/commit.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74a): multi-substrate reconcile commit applier (transactional, conditional gate) (T9)`

---

## T10 — The reconcile worker (queue + processor + builder)

**Files:** Create `backend/src/session/session-reconcile.ts`; Test `backend/src/session/__tests__/session-reconcile.test.ts`.

Models on `scribe-worker.ts`: a queue const + payload, a narrow `ReconcileRepo`, `typeof`-injected `runReconciler`, `processReconcileJob(deps, job)` (TOTAL — never throws out), and `buildReconcileWorker(redisBatch, redisRealtime, redisKeyPrefix, pool, embedder, logger)`.

- [ ] **Write failing tests** (deps injected; no broker): `processReconcileJob` on a job whose session already has `reconciled_at` set (via a fake repo) → early-out, no LLM call, working set NOT loaded. A clean job → retrieve (fake `findSimilarEntities`) → `runReconciler` fake returns a plan → validate → embed (fake embedder) → `applyReconcileCommit` (fake returning `{committed:true}`) → `workingSet.clear` called. A plan that fails validation → `logger.error` with a STRUCTURAL payload (assert NO fact content in any logger arg), no commit, no clear. The session-end leak posture (alert payload structural-only) is asserted here.
- [ ] **Implement** the queue (`QUEUE_SESSION_RECONCILE='session-reconcile'`, `RECONCILE_JOB_NAME`, `ReconcileJobPayload={campaignId, sessionId, worldId}`, `enqueueReconcile(queue, payload)` with `jobId: reconcile-${sessionId}`), the `ReconcileProcessorDeps` (narrow repo with `sessions.getById`/`markReconciled` + the candidate reads + the commit + `findSimilarEntities` + `runReconciler` typeof + `workingSet` + `embedder` + `lock` + `logger`), `processReconcileJob` (acquire lock → on-entry `getById` reconciled_at check → load working set → retrieve candidates (batched) → render → `runReconciler` → `validateReconcilePlan` (reject → structural alert + return) → embed plan-fact contents before commit → `applyReconcileCommit` → on `{committed:true}` `workingSet.clear`; release lock in finally), and `buildReconcileWorker` (lockDuration sized ≥ RECONCILE_TIMEOUT + Voyage headroom, e.g. 180_000; concurrency 1).
- [ ] **Run:** `pnpm vitest run src/session/__tests__/session-reconcile.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74a): session-reconcile worker — retrieve→reconcile→validate→commit→clear (T10)`

---

## T11 — Lifecycle: end_session frame + ending gate + cancelSuspend

**Files:** Modify `backend/src/contract/session-events.ts`, `backend/src/routes/ws-session.ts`; Create `backend/src/session/session-end.ts`; Test `backend/src/session/__tests__/session-end.test.ts` + a ws-session test extension.

- [ ] **Write failing tests:** `session-end.ts` `endSession(deps, {campaignId, sessionId, worldId})` sets the `ending` flag, `cancelSuspend`, acquires + holds the lock to quiesce, flips `sessions.update({status:'ended', endedAt})`, enqueues ONE reconcile job (`jobId=reconcile-{sessionId}`), and is idempotent on an already-ending/ended session (a second call no-ops). The ws-session inbound gate drops `player_message` frames once `ending` is set.
- [ ] **Implement:** add `end_session` to `CLIENT_FRAME_TYPES` + the `ClientFrame` union + `classifyClientFrame` in `contract/session-events.ts`; in `ws-session.ts` `handleInbound`, add an `if (frame.type === 'end_session')` branch calling `endSession(...)`, and a top-of-try gate that drops inbound when the `ending` flag (a Redis key `session:{cId}:ending`) is set; write `session/session-end.ts` (the orchestration: ending-flag SET-NX for idempotency, `cancelSuspend`, lock-quiesce, status flip, `enqueueReconcile`, broadcast `session_end`). Close-then-flip: close WS after the status flip is enqueued. (Drain of the final turn's trailing Scribe/ST-eval jobs: acquiring the per-session lock fences the in-flight turn; the trailing post-turn jobs are awaited via a short bounded poll on the queues OR — simpler v1 — the lock-hold + a fixed grace; verify the exact drain mechanism against the queues' `getJobCounts` during implementation, but the lock-fence is the load-bearing part.)
- [ ] **Run:** `pnpm vitest run src/session/__tests__/session-end.test.ts src/routes/__tests__/ws-session.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74a): session-end lifecycle — end_session frame + ending gate + cancelSuspend + reconcile enqueue (T11)`

---

## T12 — Budget-100% auto-end

**Files:** Modify `backend/src/session/turn-worker.ts`; Test extend `backend/src/session/__tests__/turn-worker.test.ts`.

- [ ] **Write failing test:** in the turn worker's post-flush phase, when the session's cumulative usage crosses 100% of the budget (the `st-config` session-bound proxy), `endSession` is enqueued exactly once (a fake spy), gated so it doesn't fire twice across turns (idempotent via the `ending` flag).
- [ ] **Implement:** after the flushed-success block (next to the ST-eval enqueue), read the cumulative usage; if `>= budget` and not already ending, call the end path (enqueue an `end_session`-equivalent via the session-end orchestration). Reuse the `ending` flag for idempotency. Wire the dep through `TurnProcessorDeps` + `buildSessionTurnWorker`.
- [ ] **Run:** `pnpm vitest run src/session/__tests__/turn-worker.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74a): budget-100% auto-end (turn-worker post-flush) (T12)`

---

## T13 — Start interlock + worker wiring

**Files:** Modify `backend/src/routes/sessions.ts`, `backend/src/worker.ts`; Test extend `backend/src/routes/__tests__/sessions.test.ts` + `backend/src/__tests__/worker.test.ts`.

- [ ] **Write failing tests:** `POST /:campaignId/start` returns `409 reconcile_pending` when the campaign's most-recent session is `ended_at IS NOT NULL AND reconciled_at IS NULL`; succeeds when the prior session is reconciled (or none exists). `worker.main()` registers a `session-reconcile` worker (count bumps; assert a `'session-reconcile'`-named worker).
- [ ] **Implement:** in `handleSessionStart`, after the `session_already_active` check, add: load the most-recent session (`sessions.listByCampaign` first, or a new `getMostRecentByCampaign`); if it is ended-but-unreconciled → `reply.code(409).send({ code: 'reconcile_pending' })`. In `worker.ts`, construct `buildReconcileWorker(redisBatch, redisRealtime, env.redisKeyPrefix, pg, embedder, logger)`, add it to the `workers[]` array + the started-event queues + a `closeWithDeadline` in shutdown.
- [ ] **Run:** `pnpm vitest run src/routes/__tests__/sessions.test.ts src/__tests__/worker.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74a): start interlock (reconcile_pending) + reconcile worker wiring (T13)`

---

## T14 — Controller: leak-matrix + real-LLM smoke + close

**Controller-run** (like MYT-73's T12). Files: Create `backend/src/session/__tests__/reconcile-leak.test.ts`; Create `backend/scripts/smoke/myt-74a-reconcile-smoke.ts` + the `smoke:reconcile` package script.

- [ ] **Leak matrix** (`reconcile-leak.test.ts`, real PG + forced/mocked LLM, break-it-to-prove-it) — the §5/§9 cases: (a) a plan that downgrades a `secret`-tier item's fact to `known` → the validator **rejects** it (not committed); (b) a plan that drops an `attributed` item's `claimedBy` → **rejected**; (c) a secret-bearing plan driven down the validator-reject + terminal-failure arms → the secret is absent from the alert payload and every `logger` arg; (d) after a commit, the superseded fact is filtered from every reader (`searchFacts`, `listByEntities`/snapshot, `listFactsToEmbed`, `world-inventory.load`); (e) a committed `secret` fact reads back as `access_level='secret'` (never downgraded).
- [ ] **Run:** `pnpm vitest run src/session/__tests__/reconcile-leak.test.ts`.
- [ ] **Gated real-LLM smoke** (`myt-74a-reconcile-smoke.ts`, gated on ANTHROPIC + VOYAGE keys, seeds + tears down a scratch world in `mythrun_dev`, modeled on `myt-73-scribe-smoke.ts`): seed a world + a working set (an FT-delta fact about a new entity + an attributed NPC-claim + a fact contradicting a seeded canon fact + a sub-faction with `parentName`) → run reconcile against **real Opus + real Voyage** → assert: the new entity minted, the attributed claim canonized with attribution in content, the contradiction superseded (chain intact, old embedding NULL), the hierarchy edge written, tiers preserved, and read-after-commit (the new fact `searchFacts`-findable; the superseded one not). Inspect at the WIRE level (PG rows, the working set cleared, logs). Secret never leaks.
- [ ] **Controller sweep:** full `pnpm --filter @mythrun/backend lint` (eslint src — 0 errors) + scoped coverage on every new/modified file. Then full `pnpm --filter @mythrun/backend test:coverage` (100% gate).
- [ ] **Wiki:** dispatch the `docs/wiki/AUTHORING.md` subagent for MYT-74a (a Runtime "session end / reconciliation" page) — content sync.
- [ ] **Push (single):** commit T14, then `git push origin main` (the pre-push gate runs typecheck + lint + test:coverage + wiki:check; confirm no dev-tool:verify trigger — this diff touches no dev-tool/contract-route surface beyond `session-events.ts`, which IS a dev-tool:verify trigger → start `pnpm dev` on :3030 before the push, or confirm the trigger list). Then flip Linear **MYT-74 → Done** (note: 74a is the first of four pieces — leave MYT-74 open if 74b–d are tracked under it; otherwise flip when the epic completes — confirm with the user) + `bd close` the T14 bead.
- [ ] **Commit:** `test(MYT-74a): enforced-ignorance leak matrix + real-LLM reconcile smoke (T14)`

---

## Self-review

**Spec coverage:** §1 lifecycle→T11/T12/T13; §2 reconcile pass→T3/T4/T9/T10; §3 fact log→T1/T5/T7; §4 idempotency→T8/T9/T10; §5 enforced ignorance→T4 (validator floors) + T10/T14 (log-surface) + §9 leak matrix→T14; §6 schema/prompt→T2/T3; §7 edges→T4/T9; §8 contracts→all; §10 out-of-scope→respected (no 74b/c/d work). ✓

**Placeholder scan:** schemas/signatures/SQL given in full; the few "verify against the real interface during implementation" notes (the repo rollback-sentinel idiom in T9; the trailing-job drain mechanism in T11; the `session-events.ts` dev-tool:verify trigger in T14) are the MYT-72/73 idiom — named, grounded, not a substitute for code. ✓

**Type consistency:** `ReconcilePlan` (T2) consumed in T3/T4/T9; `validateReconcilePlan` map (T4) consumed in T9; `insertReconciled`/`setSuperseded`/`listByEntities{liveOnly}` (T5) consumed in T9/T7; `markReconciled` (T8) the conditional gate in T9/T10; `markTouchedByPlay` (T6) in T9; `enqueueReconcile`/`ReconcileJobPayload` (T10) in T11/T12/T13; `endSession` (T11) in T12/T13. ✓ **Spec correction folded in:** `entities.encountered`/`modified_by_play` DO exist (the spec's §2.4 flags are real columns) — set via T6's `markTouchedByPlay`, not the shared insert.
