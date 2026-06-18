# MYT-74c — Campaign Wiki + Tier Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** at session end the reconciler promotes the `discoverable`/`secret` canon facts the party discovered up to `known` (as a third branch of the match it already does), and a new member-readable, narrow `known`-tier endpoint serves the campaign wiki.

**Architecture:** Extend 74a's reconcile pipeline with a `promotions: string[]` plan field (candidate fact ids the reconciler matched to a working-set item and judged should become public). The validator confines it to live candidate ids; the commit flips those facts + their owning entities to `known` inside the existing transaction (a metadata flip — no supersede, no re-embed). Separately, a purpose-built `campaignWikiView` + `GET /api/campaigns/:campaignId/wiki` serve a narrow `known`-tier projection (no `concept`, no prose kernels, no stat blocks).

**Tech Stack:** Node 24 + TS strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Postgres, Anthropic via `llm/ai.ts` (`generateObject`), Zod, Fastify. Spec: `docs/superpowers/specs/2026-06-17-myt-74c-campaign-wiki-promotion-design.md`.

---

## Context primer (cross-cutting invariants every implementer needs)

Read this even if your task is one file.

1. **Promotion is a branch of the reconcile match.** The reconciler (Opus, `runSessionReconciler`) already retrieves canon candidates (with ids + tiers, via `renderCandidates`) and decides match/mint/supersede per working-set item. 74c adds: a working-set item that **matches an existing non-`known` candidate fact** → emit that fact's id in `plan.promotions` (don't also mint/supersede). The commit flips those facts to `known`. No new discovery signal, no registry.

2. **Enforced ignorance (the hard boundary).** The wiki read is `known`-only, no-bypass, member-scoped, and **purpose-built narrow** — it must NOT serve the owner's raw `concept`, prose kernels, or stat blocks (those are owner-only-snapshot content). Promotion of a secret is structurally gated: a secret reaches the working set only when the ST sanctioned surfacing it, and promotion only fires on a working-set match. Logs/alerts carry COUNTS only (`promotions.length`), never fact ids/content — mirror the 74a reconcile log discipline.

3. **The repo namespace pattern.** Repos are composable binders: `factsNs(c)` / `entitiesNs(c)` / `worldsNs(c)` return method objects capturing a `ClientLike c` (a pool OR a tx client) so the SAME body serves `repo.facts.X` and `tx.facts.X`. New methods go on the namespace + (where a top-level `export const facts = {…}` / `entities = {…}` re-export exists) on that pool-bound surface too. `AccessLevel = 'known' | 'discoverable' | 'secret'` from `repo/facts.ts`.

4. **Idempotency.** The reconcile commit's LAST in-tx statement is `tx.sessions.markReconciled(sessionId)` (conditional; 0 → roll the whole tx back). Promotion runs INSIDE that tx (before the gate), so a re-run rolls back the promotions too. The promote UPDATEs are additionally self-idempotent (`AND access_level <> 'known'`).

5. **Exact contracts (current `main`, verified):**
   - `ReconcilePlanSchema` (`llm/schemas/session-reconcile.ts`): flat `z.object` root, NO `.refine`, `.min(1)` floors, NO `.max()`. Fields today: `entities[], facts[], relationships[]`. `type ReconcilePlan = z.infer<…>`.
   - `validateReconcilePlan(plan, ctx)` (`session/reconcile/validate.ts`): `ValidateCtx = {workingSet, liveCandidateEntityIds: ReadonlySet<string>, liveFactIds: ReadonlySet<string>}`; returns `{ok:true, map}` or `{ok:false, reason: ValidateRejectReason}`. The reason is a STRUCTURAL code only.
   - `applyReconcileCommit(repo, args)` (`session/reconcile/commit.ts`): runs `repo.transaction(async tx => …)`; steps 1-7 (resolve map → mint entities → append/supersede facts + embeddings → relationships → hierarchy → `markTouchedByPlay` → `markReconciled` gate). `ROLLBACK` sentinel from `repo/index.js`. `ReconcileCommitArgs = {plan, map, workingSet, worldId, sessionId, factEmbeddings}`.
   - `session/session-reconcile.ts`: `const EMPTY_PLAN: ReconcilePlan = { entities: [], facts: [], relationships: [] }` (line ~170); the success log `deps.logger.info({sessionId, campaignId, entityOps: plan.entities.length, factOps: plan.facts.length}, 'reconcile_committed')` (line ~304); the reject log `deps.logger.error({sessionId, reason: v.reason, entityOps: plan.entities.length, factOps: plan.facts.length}, 'reconcile_plan_rejected')` (line ~280).
   - `factsNs(c)` (`repo/facts.ts`): `insertReconciled({entityId, topic, content, accessLevel}) → Promise<string>`; `setSuperseded(old, new) → Promise<number>`; `listByEntities(entityIds, {accessLevels, liveOnly?}) → Promise<readonly FactRow[]>` (default liveOnly true). `FactRow` has `{id, entityId, topic, accessLevel, content, …}`.
   - `entitiesNs(c)` (`repo/entities.ts`): `listByWorld(worldId, {accessLevels?}) → Promise<readonly Entity[]>` (`Entity` has `{id, name, entityType, accessLevel, …}`); `markTouchedByPlay(ids) → Promise<number>` (`UPDATE entities SET encountered=true, modified_by_play=true, updated_at=now() WHERE id = ANY($1)`); top-level `export const entities = {…}`.
   - `worldsNs(c)` (`repo/worlds.ts`): `getSnapshotSummary(id) → Promise<WorldSummary | null>` (SQL `SELECT id, name, concept, tone, themes, era, vocabulary_registry FROM worlds WHERE id=$1`; parses `vocabulary_registry` via `VocabularyRegistrySchema`). `WorldSummary` (in `worlds.ts`) INCLUDES `concept`. `VocabularyRegistry` from `llm/schemas/vocabulary-registry.js` has `.entries` (each `{access_level, …}`) + `.adjacent_franchises`.
   - `relationshipsNs(c)` (`repo/relationships.ts`): `listAmong(entityIds) → Promise<readonly RelationshipRow[]>` (DB-filtered to pairs both in the set).
   - `worldSnapshotView.fetch(client, worldId, {bypass}) → WorldSnapshot` (`repo/world-snapshot-view.ts`): the OWNER-only composition (filters `vocabularyRegistry.entries` by accessLevels at lines 81-89; keeps `adjacent_franchises`). DO NOT reuse for the wiki — it carries `concept` + kernels + statblocks. Model the new narrow view on its shape but compose only the safe subset.
   - `routes/campaigns.ts`: the `GET …/world-snapshot` handler (~line 620) — `app.get<{Params: Params}>('/api/campaigns/:campaignId/world-snapshot', { config: { rateLimit: {max:30, timeWindow:'1 minute'}, pipelineRoute: true }, preHandler: requireCampaignMember(repo, 'owner') }, async (request, reply) => {…})`. It resolves the campaign, gates on `pipelineRunsRepo.isStageCompleted(worldId, 'entity_relationships')` → `409 snapshot_not_ready`, then `worldSnapshotView.fetch`. `requireCampaignMember(repo)` (NO role) = any accepted member. `repo.campaigns.getWorldId(campaignId) → Promise<string | null>`. The member-poll `status` route keys its rate-limit per-user (`keyGenerator`) — mirror that for the wiki.
   - `OPUS`/`generateObject` etc. unchanged. Tests: scoped fixtures (`createTestPool`/`makeTestScope`/`cleanupTestScope`/`guardTestDatabase`) → real PG `mythrun_test`; LLM-boundary mocked by stubbing the wrapper. Lint gotcha: `String(n)` in template literals; verify lint via `pnpm --filter @mythrun/backend lint` (= `eslint src`), not per-file.

6. **No migration.** `access_level` CHECK already permits `'known'` (migration 014). Promotion is an `UPDATE`; the wiki is a read.

---

## File map / wave table

| Task | Files | Wave | Deps |
|---|---|---|---|
| T1 schema: `promotions` + `.default([])` | `llm/schemas/session-reconcile.ts` | A | — |
| T2 facts repo: `promoteToKnown` | `repo/facts.ts` | A | — |
| T3 entities repo: `promoteToKnown` | `repo/entities.ts` | A | — |
| T4 worlds repo: `getWikiSummary` (narrow, no concept) | `repo/worlds.ts` | A | — |
| T5 reconciler prompt: promotion section + skeleton + 2×2 | `prompts/session/session-reconciler.txt` | A | — |
| T6 validator: `dangling_promotion` | `session/reconcile/validate.ts` | B | T1 |
| T7 commit: promote step | `session/reconcile/commit.ts` | B | T1,T2,T3 |
| T8 worker: `EMPTY_PLAN` + log counts | `session/session-reconcile.ts` | B | T1 |
| T9 campaign-wiki-view | `repo/campaign-wiki-view.ts` | B | T4 |
| T10 route: `GET …/wiki` | `routes/campaigns.ts` | C | T9 |
| T11 controller: leak-matrix + real-LLM smoke + sweep + wiki + push + Linear | `session/__tests__/wiki-promotion-leak.test.ts`, `scripts/smoke/myt-74c-promotion-smoke.ts` | D | all |

**Wave A** (T1-T5): parallel-safe (disjoint files). **Wave B** (T6-T9): parallel-safe after A (disjoint files). **Wave C** (T10): after T9. **Wave D**: controller-run.

The wiki read lives in a new `repo/campaign-wiki-view.ts` (a focused sibling of `world-snapshot-view.ts`) so the narrow player composition has one clear home, distinct from the owner-only snapshot.

---

## T1 — Schema: `promotions` + `.default([])`

**Files:** Modify `backend/src/llm/schemas/session-reconcile.ts`; Test `backend/src/llm/schemas/__tests__/session-reconcile.test.ts`.

- [ ] **Write the failing test** (extend the existing schema test): a plan with `promotions: ['f1','f2']` parses and `.promotions` round-trips; a plan OMITTING `promotions` parses and `.promotions === []` (the `.default([])`); a 2000-char fact `content` still parses (no `.max` regression).
```ts
it('accepts promotions and defaults it to []', () => {
  const withProm = ReconcilePlanSchema.parse({ entities: [], facts: [], relationships: [], promotions: ['f1', 'f2'] })
  expect(withProm.promotions).toEqual(['f1', 'f2'])
  const without = ReconcilePlanSchema.parse({ entities: [], facts: [], relationships: [] })
  expect(without.promotions).toEqual([])
})
```
- [ ] **Run** to verify it fails: `pnpm vitest run src/llm/schemas/__tests__/session-reconcile.test.ts` → FAIL (`promotions` missing / undefined).
- [ ] **Implement** — add the field to `ReconcilePlanSchema` (after `relationships`):
```ts
  /** MYT-74c — ids of EXISTING candidate facts (discoverable/secret) the
   *  reconciler MATCHED to a working-set item this session and judged should
   *  become public → promote to `known`. Each must be a live candidate factId
   *  (validator-enforced). `.default([])` so an absent field / EMPTY_PLAN is [],
   *  never a terminal repair failure. NEVER a fact also being superseded. */
  promotions: z.array(z.string()).default([]),
```
- [ ] **Run** to verify it passes + typecheck: `pnpm vitest run src/llm/schemas/__tests__/session-reconcile.test.ts` → PASS; `pnpm --filter @mythrun/backend typecheck`.
- [ ] **Commit:** `feat(MYT-74c): reconcile plan promotions field (T1)`

---

## T2 — facts repo: `promoteToKnown`

**Files:** Modify `backend/src/repo/facts.ts`; Test `backend/src/repo/__tests__/facts-promote.test.ts`.

- [ ] **Write the failing test** (real PG, scoped — seed a world+entity+facts like the existing facts tests):
```ts
it('flips discoverable/secret live facts to known, returns distinct entity ids, idempotent', async () => {
  // seed: one entity E with two live facts (discoverable f1, secret f2) + one already-known f3
  const flipped = await repo.facts.promoteToKnown([f1, f2, f3])
  expect(flipped).toEqual([entityId]) // distinct; f3 already known → not returned
  const live = await repo.facts.listByEntities([entityId], { accessLevels: ['known', 'discoverable', 'secret'] })
  expect(live.filter((f) => f.accessLevel !== 'known')).toHaveLength(0)
  expect(await repo.facts.promoteToKnown([f1])).toEqual([]) // already known → no-op
})
it('never promotes a superseded fact', async () => {
  // seed f_old superseded_by f_new; promoteToKnown([f_old]) returns [] and leaves f_old untouched
  expect(await repo.facts.promoteToKnown([fOld])).toEqual([])
})
```
- [ ] **Run** to verify it fails: `pnpm vitest run src/repo/__tests__/facts-promote.test.ts` → FAIL (`promoteToKnown` not a function).
- [ ] **Implement** on `factsNs(c)` (near `setSuperseded`):
```ts
    /** MYT-74c — promote discovered facts to `known` (a metadata flip; content
     *  unchanged → no supersede, no re-embed). Skips already-known + superseded
     *  facts (idempotent, never resurrects dead canon). Returns the DISTINCT
     *  owning entity ids actually flipped, so the caller can promote those
     *  entities too (the wiki filters entities by tier before facts). */
    promoteToKnown: async (factIds: readonly string[]): Promise<readonly string[]> => {
      if (factIds.length === 0) return []
      const result = await c.query<{ entity_id: string }>(
        `UPDATE facts SET access_level = 'known'
          WHERE id = ANY($1) AND access_level <> 'known' AND superseded_by IS NULL
          RETURNING entity_id`,
        [factIds],
      )
      return [...new Set(result.rows.map((r) => r.entity_id))]
    },
```
  If `repo/facts.ts` has a top-level `export const facts = {…}` re-export surface used by callers, add a `promoteToKnown` passthrough there too (mirror `listByEntities`). The commit (T7) calls it via `tx.facts.promoteToKnown`, which `factsNs` already serves.
- [ ] **Run** to verify it passes + typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74c): facts.promoteToKnown — tier flip returning distinct entity ids (T2)`

---

## T3 — entities repo: `promoteToKnown`

**Files:** Modify `backend/src/repo/entities.ts`; Test `backend/src/repo/__tests__/entities-promote.test.ts`.

- [ ] **Write the failing test** (real PG): seed two entities (discoverable + secret); `promoteToKnown([id1, id2])` returns 2 and both read back `access_level='known'`; an already-known entity is a no-op (not counted); empty array → 0.
- [ ] **Run** to verify it fails → FAIL.
- [ ] **Implement** on `entitiesNs(c)` (near `markTouchedByPlay`):
```ts
    /** MYT-74c — promote entities to `known` (deterministic "entity follows fact":
     *  the commit promotes the owning entities of any promoted facts so the wiki,
     *  which filters entities by tier first, doesn't orphan the now-known facts).
     *  Idempotent (skips already-known). Returns rowCount. */
    promoteToKnown: async (entityIds: readonly string[]): Promise<number> => {
      if (entityIds.length === 0) return 0
      const result = await c.query(
        `UPDATE entities SET access_level = 'known', updated_at = now()
          WHERE id = ANY($1) AND access_level <> 'known'`,
        [entityIds],
      )
      /* c8 ignore next — `?? 0` falsy arm: pg always returns a numeric rowCount on UPDATE. */
      return result.rowCount ?? 0
    },
```
  If `repo/entities.ts` has a top-level `export const entities = {…}` re-export used by callers, add a passthrough (mirror `markTouchedByPlay`).
- [ ] **Run** to verify it passes + typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74c): entities.promoteToKnown (T3)`

---

## T4 — worlds repo: `getWikiSummary` (narrow, no concept)

**Files:** Modify `backend/src/repo/worlds.ts`; Test `backend/src/repo/__tests__/worlds-wiki-summary.test.ts`.

The wiki must not serve the owner's raw freeform `concept`. `getWikiSummary` is the allowlist projection for the player surface — name/tone/themes/era + the vocabulary registry, NO `concept`.

- [ ] **Write the failing test** (real PG): seed a world with a `concept`; `getWikiSummary(worldId)` returns `{id, name, tone, themes, era, vocabularyRegistry}` and the object has NO `concept` key; returns `null` for an unknown id.
```ts
it('returns the narrow wiki summary without concept', async () => {
  const s = await repo.worlds.getWikiSummary(worldId)
  expect(s).not.toBeNull()
  expect('concept' in (s as object)).toBe(false)
  expect(s?.name).toBe(seededName)
  expect(await repo.worlds.getWikiSummary(uuidv7())).toBeNull()
})
```
- [ ] **Run** to verify it fails → FAIL.
- [ ] **Implement** — add the `WikiWorldSummary` type + `getWikiSummary` to `worldsNs(c)` (model on `getSnapshotSummary`, drop `concept`):
```ts
// Narrow PLAYER-facing world projection (MYT-74c). Like WorldSummary but WITHOUT
// `concept` — the owner's raw freeform world seed, which can carry plot and must
// not reach a player wiki. One home for the column list, like getSnapshotSummary.
export interface WikiWorldSummary {
  readonly id: string
  readonly name: string
  readonly tone: string | null
  readonly themes: string | null
  readonly era: string | null
  readonly vocabularyRegistry: VocabularyRegistry
}
```
```ts
    getWikiSummary: async (id: string): Promise<WikiWorldSummary | null> => {
      const result = await c.query<{
        id: string; name: string; tone: string | null; themes: string | null
        era: string | null; vocabulary_registry: unknown
      }>(
        `SELECT id, name, tone, themes, era, vocabulary_registry
           FROM worlds WHERE id = $1`,
        [id],
      )
      const row = result.rows[0]
      if (row === undefined) return null
      return {
        id: row.id, name: row.name, tone: row.tone, themes: row.themes, era: row.era,
        vocabularyRegistry: VocabularyRegistrySchema.parse(row.vocabulary_registry),
      }
    },
```
- [ ] **Run** to verify it passes + typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74c): worlds.getWikiSummary — narrow player projection (no concept) (T4)`

---

## T5 — Reconciler prompt: promotion section + skeleton + 2×2

**Files:** Modify `backend/src/llm/prompts/session/session-reconciler.txt` (no separate test — the prompt is exercised by the T11 smoke; mocked unit tests don't catch prompt drift, per `feedback_prompt_schema_co_evolution`).

- [ ] **Read** the current template to find (a) its rule about omitting facts that restate a live candidate (the "don't duplicate" rule) and (b) the JSON response skeleton at the foot (e.g. `Respond as JSON: { "entities": [...], "facts": [...], "relationships": [...] }`).
- [ ] **Add the promotion section** (the 2×2 decision), worded for the model:
```
PROMOTION (making discovered facts public).
The candidate facts are shown with their factId and accessLevel. For each working-set
item, after you decide match/mint/supersede, decide promotion:
- If it MATCHES an existing candidate fact that is `discoverable` or `secret` (the same
  underlying fact — the party surfaced it this session), put that factId in `promotions`.
  Do NOT also emit it as a new fact.
- If it matches an existing `known` candidate fact, omit it (already public).
- If it is NEW (no candidate match), mint it at its tier as usual.
- If it REFINES/CONTRADICTS an existing fact, supersede as usual — and do NOT also
  promote the superseded fact.
A `secret` candidate has a matching working-set item ONLY when the Slow Thinker
sanctioned its reveal this session; that is the only basis on which you may promote a
secret. Emit [] when nothing was promoted.
```
- [ ] **Update the JSON response skeleton** at the foot of the template to include the new array, e.g. `…"relationships": [...], "promotions": ["<factId>", ...] }`.
- [ ] **Verify** the template still loads: `pnpm vitest run` any existing reconciler test that calls `loadPrompt('session','session-reconciler', …)` (or a quick `tsx -e` that calls `loadPrompt`), confirming no missing-placeholder error.
- [ ] **Commit:** `feat(MYT-74c): reconciler prompt — promotion section + JSON skeleton (T5)`

---

## T6 — Validator: `dangling_promotion`

**Files:** Modify `backend/src/session/reconcile/validate.ts`; Test extend `backend/src/session/reconcile/__tests__/validate.test.ts`.

- [ ] **Write the failing test:** a plan with `promotions:[id]` where `id ∈ liveFactIds` → `{ok:true}`; a plan with `promotions:[id]` where `id ∉ liveFactIds` → `{ok:false, reason:'dangling_promotion'}`; a valid promotion does NOT trip `tier_downgrade`; assert the reason string contains no fact content.
```ts
it('rejects a promotion id not among live candidate facts', () => {
  const r = validateReconcilePlan(
    { entities: [], facts: [], relationships: [], promotions: ['ghost'] },
    { workingSet: [], liveCandidateEntityIds: new Set(), liveFactIds: new Set(['real']) },
  )
  expect(r).toEqual({ ok: false, reason: 'dangling_promotion' })
})
```
- [ ] **Run** to verify it fails → FAIL (no `dangling_promotion`).
- [ ] **Implement:** add `'dangling_promotion'` to the `ValidateRejectReason` union, and after the relationships loop (before `return {ok:true, map}`):
```ts
  // 6. Promotions: every promoted id must be a live candidate fact.
  for (const id of plan.promotions) {
    if (!ctx.liveFactIds.has(id)) return { ok: false, reason: 'dangling_promotion' }
  }
```
- [ ] **Run** to verify it passes + typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74c): reconcile validator — dangling_promotion (T6)`

---

## T7 — Commit: promote step

**Files:** Modify `backend/src/session/reconcile/commit.ts`; Test extend `backend/src/session/reconcile/__tests__/commit.test.ts`.

- [ ] **Write the failing test** (real PG, real repo): seed an entity E (`access_level='discoverable'`) with a live fact f (`access_level='secret'`); run `applyReconcileCommit(repo, {plan: {entities:[], facts:[], relationships:[], promotions:[f]}, map: new Map(), workingSet: [], worldId, sessionId, factEmbeddings: []})` on a not-yet-reconciled session → `{committed:true}`; f reads back `access_level='known'`, E reads back `access_level='known'`. A second apply (session already reconciled) → `{committed:false}`, no change. A promotion of a fact superseded earlier → no-op.
- [ ] **Run** to verify it fails → FAIL (promotions not applied).
- [ ] **Implement** — add the step inside the `repo.transaction` body, AFTER step 6 (`markTouchedByPlay`) and BEFORE step 7 (the `markReconciled` gate):
```ts
    // 6b. MYT-74c — promote matched discovered facts (+ their owning entities) to
    //     `known`. Metadata flip: no supersede, no re-embed. promoteToKnown returns
    //     the distinct owning entity ids actually flipped; promote those too so the
    //     wiki (entity-tier-filtered) doesn't orphan the now-known facts.
    if (plan.promotions.length > 0) {
      const promotedEntityIds = await tx.facts.promoteToKnown(plan.promotions)
      if (promotedEntityIds.length > 0) await tx.entities.promoteToKnown(promotedEntityIds)
    }
```
- [ ] **Run** to verify it passes + typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74c): reconcile commit — promote matched facts + their entities to known (T7)`

---

## T8 — Worker: `EMPTY_PLAN` + log counts

**Files:** Modify `backend/src/session/session-reconcile.ts`; Test extend `backend/src/session/__tests__/session-reconcile.test.ts`.

- [ ] **Write the failing test:** the empty-working-set path still commits (the `EMPTY_PLAN` literal must satisfy the schema with `promotions`); a clean commit's success log includes `promotions` as a count (assert the logger arg has `promotions` of type number, and NO fact ids/content in any logger arg).
- [ ] **Run** to verify it fails → FAIL (TS: `EMPTY_PLAN` missing `promotions` / no `promotions` in log).
- [ ] **Implement:**
  - Update the literal: `const EMPTY_PLAN: ReconcilePlan = { entities: [], facts: [], relationships: [], promotions: [] }`.
  - Add `promotions: plan.promotions.length` to the `reconcile_committed` success log and the `reconcile_plan_rejected` reject log (counts only).
- [ ] **Run** to verify it passes + typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74c): reconcile worker — EMPTY_PLAN promotions + structural promotion log count (T8)`

---

## T9 — campaign-wiki-view

**Files:** Create `backend/src/repo/campaign-wiki-view.ts`; Test `backend/src/repo/__tests__/campaign-wiki-view.test.ts`.

A focused sibling of `world-snapshot-view.ts` composing ONLY the narrow player-safe `known`-tier subset (D8): narrow summary (no concept) + known entities (name+type) + their known facts + known-tier relationships. NO prose kernels, NO stat blocks.

- [ ] **Write the failing test** (real PG): seed a world with a `known` entity (+ a `known` fact) and a `secret` entity (+ a `secret` fact) + a relationship between them. `campaignWikiView.fetch(pool, worldId)` returns: the narrow summary (no `concept` key); ONLY the known entity (id+name+entityType); ONLY the known fact; the relationship is excluded (one endpoint is secret-tier, filtered out of the entity set); no `proseKernels`/`statBlocks` keys on the result.
- [ ] **Run** to verify it fails → FAIL (module missing).
- [ ] **Implement:**
```ts
// backend/src/repo/campaign-wiki-view.ts
//
// MYT-74c — the PLAYER campaign-wiki read. A purpose-built narrow `known`-tier
// projection, distinct from the owner-only worldSnapshotView: it serves the
// narrow wiki world summary (no `concept`), known entities (name + type), their
// known facts, and known-tier relationships among them. NO prose kernels, NO
// stat blocks — those are owner-snapshot content, not player-wiki content.
import type { ClientLike } from './_types.js'
import { entities } from './entities.js'
import { facts } from './facts.js'
import { relationships } from './relationships.js'
import { worldsNs, type WikiWorldSummary } from './worlds.js'
import type { FactRow } from './facts.js'
import type { RelationshipRow } from './relationships.js'

export interface WikiEntity {
  readonly id: string
  readonly name: string
  readonly entityType: string
}
export interface CampaignWiki {
  readonly world: WikiWorldSummary
  readonly entities: readonly WikiEntity[]
  readonly facts: readonly FactRow[]
  readonly relationships: readonly RelationshipRow[]
}

async function fetch(client: ClientLike, worldId: string): Promise<CampaignWiki> {
  const summary = await worldsNs(client).getWikiSummary(worldId)
  if (summary === null) throw new Error(`campaign-wiki-view: world ${worldId} not found`)
  // Filter the vocabulary registry to known-tier entries (mirror world-snapshot-view).
  const world: WikiWorldSummary = {
    ...summary,
    vocabularyRegistry: {
      entries: summary.vocabularyRegistry.entries.filter((e) => e.access_level === 'known'),
      adjacent_franchises: summary.vocabularyRegistry.adjacent_franchises,
    },
  }
  const entityRows = await entities.listByWorld(client, worldId, { accessLevels: ['known'] })
  const entityIds = entityRows.map((e) => e.id)
  const [factRows, relationshipRows] = await Promise.all([
    facts.listByEntities(client, entityIds, { accessLevels: ['known'], liveOnly: true }),
    relationships.listAmong(client, entityIds),
  ])
  return {
    world,
    entities: entityRows.map((e) => ({ id: e.id, name: e.name, entityType: e.entityType })),
    facts: factRows,
    relationships: relationshipRows,
  }
}

export const campaignWikiView = { fetch } as const
```
  Verify the exact call shape of `entities.listByWorld` / `facts.listByEntities` / `relationships.listAmong` against the top-level re-exports (`world-snapshot-view.ts` calls them as `entities.listByWorld(client, worldId, …)` — match that signature; adapt if the top-level export takes `(client, …)`).
- [ ] **Run** to verify it passes + typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74c): campaignWikiView — narrow known-tier player composition (T9)`

---

## T10 — Route: `GET /api/campaigns/:campaignId/wiki`

**Files:** Modify `backend/src/routes/campaigns.ts`; Test extend `backend/src/routes/__tests__/campaigns-snapshot.test.ts` (or the campaigns route test that covers `world-snapshot`).

- [ ] **Write the failing tests:** `GET /api/campaigns/:id/wiki` as a non-owner member → `200` with the narrow wiki (no `concept`, no `proseKernels`/`statBlocks` keys; only known entities/facts); a non-member → `403`; before stage 4 (`isStageCompleted` false) → `409 wiki_not_ready`; an unknown campaign (`getWorldId` → null) → `404 campaign_not_found`.
- [ ] **Run** to verify it fails → FAIL (route 404 — not registered).
- [ ] **Implement** — register the route near the `world-snapshot` handler. Model the config/preHandler on it, but: member auth (no `'owner'`), the new `wiki_not_ready`/`404` codes, per-USER rate-limit (mirror the `status` route's `keyGenerator`), and `campaignWikiView`:
```ts
import { campaignWikiView } from '../repo/campaign-wiki-view.js'
// …
app.get<{ Params: Params }>(
  '/api/campaigns/:campaignId/wiki',
  {
    config: {
      // Member-read surface (every party member, likely UI-fanned) → per-user key,
      // 60/min — the `status` member-poll precedent, not the owner snapshot's 30/IP.
      rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: /* mirror the status route's per-user keyGenerator */ },
      pipelineRoute: true,
    },
    preHandler: requireCampaignMember(repo),
  },
  async (request, reply) => {
    const worldId = await repo.campaigns.getWorldId(request.params.campaignId)
    if (worldId === null) return reply.code(404).send({ code: 'campaign_not_found' })
    const ready = await pipelineRunsRepo.isStageCompleted(worldId, 'entity_relationships')
    if (!ready) return reply.code(409).send({ code: 'wiki_not_ready' })
    const wiki = await campaignWikiView.fetch(pool, worldId)
    return reply.send(wiki)
  },
)
```
  Verify the exact in-scope names against the existing `world-snapshot` handler: the pool/client passed to the view (`pool` vs a repo client), `pipelineRunsRepo`, `requireCampaignMember`, `Params`, and the `status` route's `keyGenerator` shape (copy it verbatim). Use whatever the sibling handlers use.
- [ ] **Run** to verify it passes + typecheck + `pnpm --filter @mythrun/backend lint`. PASS.
- [ ] **Commit:** `feat(MYT-74c): GET /api/campaigns/:id/wiki — member-readable known-tier campaign wiki (T10)`

---

## T11 — Controller: leak-matrix + real-LLM smoke + close

**Controller-run.** Files: Create `backend/src/session/__tests__/wiki-promotion-leak.test.ts`; Create `backend/scripts/smoke/myt-74c-promotion-smoke.ts` + the `smoke:promotion` package script.

- [ ] **Leak matrix** (`wiki-promotion-leak.test.ts`, real PG + forced/mocked plan — break-it-to-prove-it):
  - (a) the validator rejects a `dangling_promotion` (not committed);
  - (b) the commit promotes a matched `discoverable` fact + its entity to known; an un-promoted `secret` fact + entity stay secret (the over-promotion guard);
  - (c) `campaignWikiView.fetch` returns the promoted fact but NOT the still-secret fact, NOT the owner's `concept`, and NO prose-kernel/stat-block keys;
  - (d) the reconcile worker's reject/success logs on a `dangling_promotion` / a promotion carry the `promotions` COUNT only — assert NO fact content/ids in any logger arg (stringify the logger calls + assert a seeded secret-content sentinel is absent).
- [ ] **Run:** `pnpm vitest run src/session/__tests__/wiki-promotion-leak.test.ts`.
- [ ] **Gated real-LLM smoke** (`myt-74c-promotion-smoke.ts`, gated on the ANTHROPIC key, seeds + tears down a scratch world/campaign/session in `mythrun_dev`, modeled on `myt-74a-reconcile-smoke.ts`): seed canon with a `discoverable` fact about an entity + a `secret` fact (+ a second untouched secret); build a working set whose items MATCH the discoverable fact and the first secret (simulating the ST-sanctioned surfacing); run the REAL Opus reconciler → assert the plan's `promotions` includes the matched discoverable + secret fact ids (not the untouched secret); apply the commit → assert those facts + entities read back `known`, the untouched secret stays `secret`; then `campaignWikiView.fetch` returns the promoted facts and NOT the untouched secret nor the `concept`. Inspect at the WIRE level (PG rows + the view payload). Log (don't assert) the promotion-judgment quality.
- [ ] **Controller sweep:** full `pnpm --filter @mythrun/backend lint` (eslint src — 0 errors) + scoped coverage on every new/modified file. Then full `pnpm --filter @mythrun/backend test:coverage` (100% gate). **Watch for the `migrate-schema.test.ts` pin** — 74c adds no migration, so that pin shouldn't drift, but confirm the full suite is green (per `reference_migrate_schema_pin_per_migration`).
- [ ] **Wiki:** dispatch the `docs/wiki/AUTHORING.md` subagent for MYT-74c (the Runtime "session-reconcile" page gains the promotion branch; a Data/Runtime "campaign wiki" read page; the access-tier promotion state-machine) — content sync, BEFORE the push, committed locally (no push by the subagent).
- [ ] **Push (single):** commit T11, then `git push origin main` (the pre-push gate runs typecheck + lint + test:coverage + wiki:check; `dev-tool:verify` triggers only on `dev-tool/**` or `contract/(backend-routes|pipeline-routes).ts` — `routes/campaigns.ts` is neither, so it skips). Then leave Linear **MYT-74 open** (74d remains) + `bd close` the T11 bead.
- [ ] **Commit:** `test(MYT-74c): promotion leak-matrix + real-LLM wiki/promotion smoke (T11)`

---

## Self-review

**Spec coverage:** §1.1 schema→T1; §1.2 prompt→T5; §1.3 validator→T6; §1.4 commit + repos→T2/T3/T7; §1.5 worker→T8; §2 wiki read→T4 (narrow summary) + T9 (view) + T10 (route); §5 enforced ignorance→T4/T9/T10 (narrow/no-bypass) + T8 (log counts) + T11 (leak matrix); §6 testing→per-task + T11; §7 forward-assumption→respected (no marketplace work); D8→T4/T9 (no concept/kernels/statblocks). ✓

**Placeholder scan:** schemas/SQL/signatures given in full. The "verify the exact in-scope names / keyGenerator against the sibling handler" notes in T9/T10 are grounded-named seams (the MYT-72/73/74a/b idiom) — named, not a substitute for code; the route's exact `pool`/`keyGenerator`/`pipelineRunsRepo` references must match the live sibling handler. ✓

**Type consistency:** `promotions: string[]` (T1) consumed by T6 (validator), T7 (commit), T8 (worker logs); `facts.promoteToKnown → entityIds` (T2) consumed by T7; `entities.promoteToKnown` (T3) consumed by T7; `WikiWorldSummary`/`getWikiSummary` (T4) consumed by T9; `campaignWikiView.fetch` (T9) consumed by T10; `dangling_promotion` (T6) consistent with the validator's reason union. ✓
