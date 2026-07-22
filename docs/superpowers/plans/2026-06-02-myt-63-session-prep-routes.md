# Session Prep — HTTP routes: trigger / list / read / reset (MYT-63) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Commit discipline (Mythrun):** implementer subagents do NOT `git add`/`git commit`/`git push`. Each task's final "Commit" step is executed by the CONTROLLER, serially, after the two-stage (spec + code-quality) review passes. Hold all pushes until the issue is fully done (final verification → wiki subagent → single push).

**Goal:** Ship the four parked session-prep HTTP routes (trigger / list / read / reset) plus their producer-queue threading, repo methods, and dev-tool panels — with `sd_playbook` structurally barred from the HTTP surface.

**Architecture:** A new `routes/session-preps.ts` Fastify plugin holds the four routes (campaigns.ts is already ~1200 lines). The session-prep BullMQ queue — currently worker-only — gets a producer adapter threaded through `AppDeps` (mirroring `worldGenQueue`) so the trigger route can enqueue. Read/list responses go through an explicit `SafeSessionPrep` projection that omits `sd_playbook` (the entire runtime gate — this backend has no Fastify response schemas). Reset deletes the prep row and re-arms the `session-prep:<n>` pipeline_runs stage atomically in one transaction.

**Tech Stack:** Node 24 + Fastify + TypeScript (strict) + Postgres (`pg`) + BullMQ + Zod + Vitest. Dev-tool is a Vite SPA mirroring each backend route as a JSDOM-testable panel.

**Spec:** `docs/superpowers/specs/2026-06-02-myt-63-session-prep-routes-design.md` (committed `f4ad73d`).

---

## File Structure

**Create:**
- `backend/src/routes/session-preps.ts` — the four-route plugin (`SessionPrepQueueLike`, `SafeSessionPrep`, `toSafeSessionPrep`, `sessionPrepsPlugin`). Built incrementally: Task 3 adds the queue interface only; Task 4 adds the projection + plugin.
- `backend/src/routes/__tests__/session-preps.test.ts` — route integration tests (real-PG + queue spy + enforced-ignorance assertions).
- `backend/dev-tool/src/components/session-prep-trigger-panel.ts` / `session-prep-reset-panel.ts` / `session-preps-list-panel.ts` / `session-prep-view-panel.ts` — the four panels.
- `backend/dev-tool/src/components/__tests__/session-prep-trigger-panel.test.ts` / `session-prep-reset-panel.test.ts` / `session-preps-list-panel.test.ts` / `session-prep-view-panel.test.ts` — JSDOM panel tests.

**Modify:**
- `backend/src/repo/session-preps.ts` — `listFor` / `getById` / `deleteFor` (+ extract `mapSessionPrepRow`).
- `backend/src/repo/pipeline-runs.ts` — `resetStage` on the `PipelineRunsRepo` interface AND `pipelineRunsNs` body.
- `backend/src/app-deps.ts` — required `sessionPrepQueue` field.
- `backend/src/server.ts` — extend `buildSessionPrepQueue` to return `{ bullmqQueue, sessionPrepQueue }`; add `stubSessionPrepQueue()`; thread into `buildApp` + `fallbackStart` stubDeps; update the shutdown call site.
- `backend/src/app.ts` — register `sessionPrepsPlugin`.
- `backend/src/contract/backend-routes.ts` — the four route strings.
- `backend/dev-tool/src/pages/world-page.ts` — four new `SECTIONS` entries.
- `backend/dev-tool/verify-registry.ts` — four `PANEL_EXERCISES` entries + four ids in `PAGE_REGISTRY.world.panels[]`.
- `backend/src/repo/__tests__/session-preps.test.ts`, `backend/src/repo/__tests__/pipeline-runs.test.ts` — new repo tests.
- The AppDeps-literal sites (Task 3, full list inline).

**Do NOT touch:** `backend/dev-tool/coverage.json` (its `routes[]` is `PIPELINE_ROUTES`-keyed; these four are NOT `pipelineRoute`; `session-prep` is already in `jobs[]`). `backend/src/contract/pipeline-routes.ts` (routes are not `pipelineRoute: true` → no `app-pipeline-contract.test.ts` mock churn). `backend/src/worker.ts` / `worker/*` (consumer-only; no producer handle needed). The session-prep processor (`llm/prep/session-prep-processor.ts`) — already correct; it writes stage `session-prep:${sessionNumber}`, which `resetStage` re-arms.

**Sequencing note (read before starting):** Adding the four routes to `BACKEND_ROUTES` (Task 4) makes the dev-tool `verify-registry.test.ts` route-exhaustion invariant RED until the panels land (Task 5). The BACKEND (vitest) suite is green at the end of Task 4 (the `backend-routes.test.ts` printRoutes-drift test passes because the plugin registers exactly the four declared routes). The DEV-TOOL (vitest) suite goes green at the end of Task 5. There is no push between Task 4 and Task 5, so this transient is invisible to CI. Run the BACKEND suite as Task 4's gate and the DEV-TOOL suite as Task 5's gate.

---

## Task 1: Repo — `sessionPreps.listFor` / `getById` / `deleteFor`

**Files:**
- Modify: `backend/src/repo/session-preps.ts`
- Test: `backend/src/repo/__tests__/session-preps.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/repo/__tests__/session-preps.test.ts`, inside the existing `describe('sessionPreps repo', …)` block (after the existing `it('getBy returns null …')`), reusing its `beforeEach`-seeded `campaignId`:

```ts
  describe('listFor / getById / deleteFor (MYT-63)', () => {
    it('listFor returns rows ordered by session_number; empty when none', async () => {
      const repo = createRepo(pool)
      expect(await repo.sessionPreps.listFor(campaignId)).toEqual([])
      await repo.sessionPreps.insert({ campaignId, sessionNumber: 2, ftContext: 'FT2', sdPlaybook: 'SD2' })
      await repo.sessionPreps.insert({ campaignId, sessionNumber: 1, ftContext: 'FT1', sdPlaybook: 'SD1' })
      const rows = await repo.sessionPreps.listFor(campaignId)
      expect(rows.map((r) => r.sessionNumber)).toEqual([1, 2])
      expect(rows[0]?.ftContext).toBe('FT1')
      expect(rows[0]?.sdPlaybook).toBe('SD1') // repo row still carries the secret; the HTTP projection strips it (Task 4)
    })

    it('getById returns the row by id, null on miss', async () => {
      const repo = createRepo(pool)
      await repo.sessionPreps.insert({ campaignId, sessionNumber: 1, ftContext: 'FT', sdPlaybook: 'SD' })
      const id = (await repo.sessionPreps.listFor(campaignId))[0]?.id
      if (id === undefined) throw new Error('expected a seeded prep')
      const row = await repo.sessionPreps.getById(id)
      expect(row?.id).toBe(id)
      expect(row?.campaignId).toBe(campaignId)
      expect(await repo.sessionPreps.getById(uuidv7())).toBeNull()
    })

    it('deleteFor removes the row; idempotent on a missing row', async () => {
      const repo = createRepo(pool)
      await repo.sessionPreps.insert({ campaignId, sessionNumber: 1, ftContext: 'FT', sdPlaybook: 'SD' })
      await repo.sessionPreps.deleteFor(campaignId, 1)
      expect(await repo.sessionPreps.existsFor(campaignId, 1)).toBe(false)
      await expect(repo.sessionPreps.deleteFor(campaignId, 1)).resolves.toBeUndefined()
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/repo/__tests__/session-preps.test.ts`
Expected: FAIL — `repo.sessionPreps.listFor is not a function` (and `getById`, `deleteFor`).

- [ ] **Step 3: Implement the three methods + extract `mapSessionPrepRow`**

In `backend/src/repo/session-preps.ts`, add a module-local mapper above `sessionPrepsNs` (DRY — `getBy`/`listFor`/`getById` share it):

```ts
function mapSessionPrepRow(r: SessionPrepDbRow): SessionPrepRow {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    sessionNumber: r.session_number,
    ftContext: r.ft_context,
    sdPlaybook: r.sd_playbook,
    snapshotId: r.snapshot_id,
    createdAt: r.created_at,
  }
}
```

Refactor the existing `getBy` to use it:

```ts
    getBy: async (campaignId: string, sessionNumber: number): Promise<SessionPrepRow | null> => {
      const { rows } = await c.query<SessionPrepDbRow>(
        `SELECT id, campaign_id, session_number, ft_context, sd_playbook, snapshot_id, created_at
         FROM session_preps WHERE campaign_id = $1 AND session_number = $2`,
        [campaignId, sessionNumber],
      )
      const r = rows[0]
      return r ? mapSessionPrepRow(r) : null
    },
```

Add the three new methods inside the returned object (after `getBy`):

```ts
    listFor: async (campaignId: string): Promise<readonly SessionPrepRow[]> => {
      const { rows } = await c.query<SessionPrepDbRow>(
        `SELECT id, campaign_id, session_number, ft_context, sd_playbook, snapshot_id, created_at
         FROM session_preps WHERE campaign_id = $1 ORDER BY session_number`,
        [campaignId],
      )
      return rows.map(mapSessionPrepRow)
    },
    getById: async (prepId: string): Promise<SessionPrepRow | null> => {
      const { rows } = await c.query<SessionPrepDbRow>(
        `SELECT id, campaign_id, session_number, ft_context, sd_playbook, snapshot_id, created_at
         FROM session_preps WHERE id = $1`,
        [prepId],
      )
      const r = rows[0]
      return r ? mapSessionPrepRow(r) : null
    },
    deleteFor: async (campaignId: string, sessionNumber: number): Promise<void> => {
      await c.query(`DELETE FROM session_preps WHERE campaign_id = $1 AND session_number = $2`, [
        campaignId,
        sessionNumber,
      ])
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/repo/__tests__/session-preps.test.ts`
Expected: PASS (all, including the pre-existing `getBy` tests still green after the refactor).

- [ ] **Step 5: Commit** (controller, after review)

```bash
git add backend/src/repo/session-preps.ts backend/src/repo/__tests__/session-preps.test.ts
git commit -m "feat(myth): sessionPreps.listFor/getById/deleteFor repo methods (MYT-63)"
```

---

## Task 2: Repo — `pipelineRuns.resetStage`

**Files:**
- Modify: `backend/src/repo/pipeline-runs.ts` (interface `:83-166` + binder body)
- Test: `backend/src/repo/__tests__/pipeline-runs.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a `describe('resetStage (MYT-63)', …)` block inside the top-level `describe('pipeline-runs repo', …)` in `backend/src/repo/__tests__/pipeline-runs.test.ts`, reusing the file's `insertCampaign()` helper:

```ts
  describe('resetStage (MYT-63)', () => {
    it("coerces a completed campaign-scoped stage row back to 'pending', cost_usd intact", async () => {
      const { campaignId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, completed_at, cost_usd, error, user_id)
         VALUES ($1, $2, 'session-prep:1', 'completed', now(), now(), 0.42, NULL, NULL)`,
        [uuidv7(), campaignId],
      )
      await repo.resetStage({ kind: 'campaign', campaignId, stage: 'session-prep:1' })
      const row = await pool.query<{
        status: string
        started_at: Date | null
        completed_at: Date | null
        cost_usd: string | null
      }>(
        `SELECT status, started_at, completed_at, cost_usd FROM pipeline_runs
          WHERE campaign_id = $1 AND stage = 'session-prep:1' AND user_id IS NULL`,
        [campaignId],
      )
      expect(row.rows[0]?.status).toBe('pending')
      expect(row.rows[0]?.started_at).toBeNull()
      expect(row.rows[0]?.completed_at).toBeNull()
      expect(Number(row.rows[0]?.cost_usd)).toBeCloseTo(0.42) // spend record preserved
    })

    it('is idempotent when no matching row exists (no-op, resolves undefined)', async () => {
      const { campaignId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await expect(
        repo.resetStage({ kind: 'campaign', campaignId, stage: 'session-prep:9' }),
      ).resolves.toBeUndefined()
    })

    it('round-trip: reset a completed stage → claimStage re-claims (not a completed skip)', async () => {
      const { campaignId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await repo.claimStage({ kind: 'campaign', campaignId, stage: 'session-prep:1' })
      await pool.query(
        `UPDATE pipeline_runs SET status='completed', completed_at=now()
          WHERE campaign_id=$1 AND stage='session-prep:1' AND user_id IS NULL`,
        [campaignId],
      )
      // Without reset a re-claim returns 'completed' (idempotent skip). After
      // reset, the next trigger's claim must re-arm the row → 'claimed'.
      await repo.resetStage({ kind: 'campaign', campaignId, stage: 'session-prep:1' })
      expect(await repo.claimStage({ kind: 'campaign', campaignId, stage: 'session-prep:1' })).toBe(
        'claimed',
      )
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/repo/__tests__/pipeline-runs.test.ts -t resetStage`
Expected: FAIL — `repo.resetStage is not a function`.

- [ ] **Step 3: Add `resetStage` to the interface AND the binder**

In `backend/src/repo/pipeline-runs.ts`, add to the `PipelineRunsRepo` interface (after `markStageFailed`, before `sumCostForWorld`):

```ts
  /**
   * MYT-63 reset-prep: re-arm a campaign-scoped stage row (user_id IS NULL) back
   * to 'pending' so a subsequent atomicClaimStage re-claims it — the reset-prep
   * counterpart to insertCharacterConceptSeedRow's re-arm. Coerces
   * status='pending', started_at/completed_at/error to NULL; leaves cost_usd
   * intact (the row is being re-armed, not erased as a spend record). Branchless +
   * idempotent (no matching row → 0 rows updated → no-op). The `kind` discriminant
   * mirrors ClaimRequest for forward-consistency (only 'campaign' is supported).
   *
   * Composable, and UNLIKE claimStage/markStage* (pool-bound BY DESIGN so recovery
   * bookkeeping survives a stage-tx rollback), resetStage is MEANT to run inside
   * repo.transaction — atomic with the session_preps delete in POST /reset-prep.
   */
  readonly resetStage: (args: {
    kind: 'campaign'
    campaignId: string
    stage: string
  }) => Promise<void>
```

Add to the `pipelineRunsNs` binder body (after `markStageFailed`, before `sumCostForWorld`):

```ts
    async resetStage(args: { kind: 'campaign'; campaignId: string; stage: string }): Promise<void> {
      // UPDATE-only re-arm. Branchless (no rowCount inspection) so it stays
      // trivially 100%-covered; idempotent (0 rows on no match). Does NOT touch
      // cost_usd — matches insertCharacterConceptSeedRow's reset SQL.
      await c.query(
        `UPDATE pipeline_runs
            SET status = 'pending', started_at = NULL, completed_at = NULL, error = NULL
          WHERE campaign_id = $1 AND stage = $2 AND user_id IS NULL`,
        [args.campaignId, args.stage],
      )
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/repo/__tests__/pipeline-runs.test.ts -t resetStage`
Expected: PASS (3/3).

- [ ] **Step 5: Commit** (controller, after review)

```bash
git add backend/src/repo/pipeline-runs.ts backend/src/repo/__tests__/pipeline-runs.test.ts
git commit -m "feat(myth): pipelineRuns.resetStage re-arm for reset-prep (MYT-63)"
```

---

## Task 3: Producer queue threading + `AppDeps` ripple

This task makes `AppDeps.sessionPrepQueue` a **required** field (mirroring `worldGenQueue`), which forces every `AppDeps`-constructing site to supply it. No new behavior is added; the field is unconsumed until Task 4 registers the plugin. **TDD note:** this is a type-driven wiring ripple — the type system + the existing app-boot suite ARE the test. Verification is `pnpm typecheck` (exit 0) + `pnpm test` (the AppDeps-literal + app-boot tests stay green). There is no new dedicated test; the producer-enqueue behavior is tested at the route level in Task 4.

**Files (in order):**

- [ ] **Step 1: Create `backend/src/routes/session-preps.ts` with the queue interface only**

```ts
// backend/src/routes/session-preps.ts
//
// MYT-63: session-prep CRUD/trigger HTTP routes (trigger / list / read / reset).
// This task (T3) lands the producer queue surface only; the four routes +
// the SafeSessionPrep projection land in T4 below the interface.
//
// Enforced ignorance: the HTTP surface NEVER serves sd_playbook (see
// SafeSessionPrep in T4). The persisted prep row carries ft_context (FT-safe)
// + sd_playbook (Slow-Thinker, may contain secrets); only Session Runtime reads
// sd_playbook in-process via repo.sessionPreps, and the dev-tool inspects it live
// via the MYT-62 prep-prose stream.

// Minimal producer surface for the session-prep BullMQ queue. Declared here
// (not BullMQ's Queue class) so AppDeps + tests inject a hand-rolled spy —
// exactly like WorldGenQueueLike (routes/campaigns.ts).
export interface SessionPrepQueueLike {
  add(
    name: 'session-prep',
    data: { campaignId: string; sessionNumber: number },
    opts?: { jobId?: string },
  ): Promise<unknown>
}
```

- [ ] **Step 2: Add the required field to `AppDeps`**

In `backend/src/app-deps.ts`, add the import + field:

```ts
import type { SessionPrepQueueLike } from './routes/session-preps.js'
```
```ts
  sessionPrepQueue: SessionPrepQueueLike // required — mirrors worldGenQueue (boot invariant)
```

- [ ] **Step 3: Extend `buildSessionPrepQueue`, add `stubSessionPrepQueue`, thread into boot + shutdown (`server.ts`)**

Replace `buildSessionPrepQueue` (`server.ts:275-285`) with the adapter-returning form (mirror `buildWorldGenQueue`):

```ts
function buildSessionPrepQueue(redisBatch: Redis): {
  bullmqQueue: Queue
  sessionPrepQueue: SessionPrepQueueLike
} {
  const bullmqQueue = new Queue(QUEUE_SESSION_PREP, {
    connection: redisBatch,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: { count: 0 },
      removeOnFail: { count: 0 },
    },
  })
  const sessionPrepQueue: SessionPrepQueueLike = {
    add: (name, data, opts) => bullmqQueue.add(name, data, opts),
  }
  return { bullmqQueue, sessionPrepQueue }
}
```

Add the import at the top of `server.ts` (near the other route-type imports):

```ts
import type { SessionPrepQueueLike } from './routes/session-preps.js'
```

Add a stub (near `stubWorldGenQueue` `:341-348`) — the boot-gate-disabled binary still constructs `AppDeps`:

```ts
function stubSessionPrepQueue(): SessionPrepQueueLike & BullMqQueueShutdown {
  return {
    add: () => Promise.reject(new Error('queue unavailable: BOOT_GATE_ENABLED is off')),
    close: () => Promise.resolve(),
  }
}
```

Update the construction + `buildApp` call (`server.ts:519`/`:521-533`). The current line `const sessionPrepQueue = buildSessionPrepQueue(rTBRef)` now destructures:

```ts
    const { bullmqQueue: bullmqSessionPrepQueue, sessionPrepQueue } = buildSessionPrepQueue(rTBRef)
```

Add `sessionPrepQueue` to the `buildApp({...})` literal (next to `characterCreationQueue`):

```ts
        worldGenQueue,
        characterCreationQueue,
        sessionPrepQueue,
```

Update the shutdown wiring call site: the `withSessionPrepShutdown(innerShutdown, sessionPrepWorker, sessionPrepQueue)` call (`server.ts:569-571`) currently passes the raw `Queue`. It must now pass the raw bullmq handle `bullmqSessionPrepQueue` (the shutdown contract drains the BullMQ queue, not the adapter):

```ts
    const withSessionPrep = withSessionPrepShutdown(innerShutdown, sessionPrepWorker, bullmqSessionPrepQueue)
```
(Adjust to the exact existing variable name at the call site; the change is `sessionPrepQueue` → `bullmqSessionPrepQueue` in that one shutdown call.)

Add the field to the `fallbackStart` `stubDeps` literal (`server.ts:~389-413`):

```ts
  const stubSessionPrep = stubSessionPrepQueue()
  const stubDeps: AppDeps = {
    // …existing fields…
    worldGenQueue: stubQueue,
    characterCreationQueue: stubCharacterQueue,
    sessionPrepQueue: stubSessionPrep,
  }
```

- [ ] **Step 4: Add `noopSessionPrepQueue()` to the test helper**

In `backend/src/__tests__/helpers/stub-deps.ts`, add (mirror `noopWorldGenQueue`):

```ts
export function noopSessionPrepQueue(): SessionPrepQueueLike {
  return {
    add: (): Promise<unknown> => Promise.resolve(undefined),
  }
}
```
Add the import:
```ts
import type { SessionPrepQueueLike } from '../../routes/session-preps.js'
```
And add the field to the `makeStubDeps()` returned `AppDeps` literal:
```ts
    sessionPrepQueue: noopSessionPrepQueue(),
```

- [ ] **Step 5: Add `sessionPrepQueue` to every other `AppDeps`-constructing literal**

For each file below: if it already imports from the stub-deps helper, add `sessionPrepQueue: noopSessionPrepQueue()` (and add `noopSessionPrepQueue` to that import). If it builds a fully-inline `AppDeps` literal, add the inline form `sessionPrepQueue: { add: () => Promise.resolve(undefined) }`.

Files (verified break sites — each constructs an `AppDeps`):
- `backend/src/__tests__/app.test.ts` (local `makeStubDeps`, inline literal)
- `backend/src/__tests__/app-pipeline-contract.test.ts` (local `makeStubDeps` L77-91, inline literal)
- `backend/src/contract/__tests__/backend-routes.test.ts` (local `makeStubDeps` L140-154, inline literal — this one boots the full app)
- `backend/src/__tests__/app-pipeline-forward-check.test.ts` (local `makeStubDeps` L54-69, inline literal)
- `backend/src/__tests__/shutdown.test.ts` (`makeBuildAppDeps` L15+, inline literal)
- `backend/src/__tests__/pipeline-cross-process.test.ts` (`depsA`/`depsB` inline literals)
- `backend/src/__tests__/invite-flow.test.ts` (uses `noopWorldGenQueue()` → use `noopSessionPrepQueue()`)
- `backend/src/__tests__/onboarding.test.ts` (uses `noopWorldGenQueue()`)
- `backend/src/__tests__/onboarding-trial.test.ts` (uses `noopWorldGenQueue()`)
- `backend/src/__tests__/rate-limit-per-sub.test.ts` (uses `noopWorldGenQueue()`)
- `backend/src/__tests__/rate-limit-cross-worker.test.ts` (`depsA`/`depsB`, `noopWorldGenQueue()`)
- `backend/src/routes/__tests__/prep-prose.test.ts` (inline literal + `makeStubDepsForRealMode` L204)
- `backend/src/routes/__tests__/campaigns-status.test.ts` (uses `noopWorldGenQueue()`)
- `backend/src/routes/__tests__/prep-status.test.ts` (uses `noopWorldGenQueue()`)
- `backend/src/routes/__tests__/health-ready-edge.test.ts` (`buildDeps`, `noopWorldGenQueue()`)

(The campaigns route tests `campaigns-list/-delete/-snapshot/-details/-create/-resume.test.ts` build the campaigns **plugin Opts**, NOT `AppDeps` — they do NOT break and need no change.)

- [ ] **Step 6: Verify typecheck + full suite green**

Run: `pnpm typecheck` → exit 0 (authoritative over any injected stale "cannot find module" diagnostics).
Run: `pnpm test` → all green (especially `backend-routes.test.ts`, `app.test.ts`, `app-pipeline-contract.test.ts`, the rate-limit/onboarding/invite tests).
Run: `pnpm lint` → clean.

- [ ] **Step 7: Commit** (controller, after review)

```bash
git add backend/src/routes/session-preps.ts backend/src/app-deps.ts backend/src/server.ts \
  backend/src/__tests__/helpers/stub-deps.ts backend/src/__tests__/ \
  backend/src/contract/__tests__/backend-routes.test.ts backend/src/routes/__tests__/
git commit -m "feat(myth): thread session-prep producer queue through AppDeps (MYT-63)"
```

---

## Task 4: `SafeSessionPrep` + the four routes + `app.ts` registration + `backend-routes.ts`

**Files:**
- Modify: `backend/src/routes/session-preps.ts` (add projection + plugin)
- Modify: `backend/src/app.ts` (register plugin)
- Modify: `backend/src/contract/backend-routes.ts` (four route strings)
- Test: `backend/src/routes/__tests__/session-preps.test.ts` (new)

- [ ] **Step 1: Write the failing route tests**

Create `backend/src/routes/__tests__/session-preps.test.ts` (harness mirrors `campaign-characters.test.ts`):

```ts
// backend/src/routes/__tests__/session-preps.test.ts
//
// MYT-63 route integration tests: trigger / list / read / reset. Real Postgres
// (FK + unique constraints fire genuinely), bypass auth + requireOnboarded so
// request.dbUser is populated for requireCampaignMember, raw-INSERT fixtures
// keyed off TestScope. The session-prep queue is a vi.fn() spy.
//
// Enforced ignorance: list + read responses MUST NOT carry sd_playbook. The
// assertions check (a) no seeded sentinel in the serialized body AND (b) the
// body has EXACTLY the five SafeSessionPrep keys — so a future {...row} spread
// regression that adds sdPlaybook (even null, no sentinel) is caught structurally.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { createRepo } from '../../repo/index.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { requireOnboarded } from '../../auth/require-onboarded.js'
import { sessionPrepsPlugin, type SessionPrepQueueLike } from '../session-preps.js'
import { cleanupTestScope, makeTestScope, type TestScope } from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const SECRET = 'SECRET_PLAYBOOK_DO_NOT_LEAK'
const SAFE_KEYS = ['createdAt', 'ftContext', 'id', 'sessionNumber', 'snapshotId']

interface SeededUser {
  readonly userId: string
  readonly devSub: string
}

async function seedUser(pool: Pool, scope: TestScope, index: number): Promise<SeededUser> {
  const userId = uuidv7()
  const devSub = scope.userSub(index)
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, devSub, scope.displayName(index), scope.username(index)],
  )
  return { userId, devSub }
}

async function seedCampaignOwnedBy(
  pool: Pool,
  scope: TestScope,
  owner: SeededUser,
  index: number,
): Promise<{ campaignId: string; worldId: string }> {
  const worldId = uuidv7()
  const campaignId = uuidv7()
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'a long enough concept', 'complete')`,
    [worldId, owner.userId, scope.worldName(index)],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES ($1, $2, $3, $4, 'setup')`,
    [campaignId, worldId, owner.userId, scope.campaignName(index)],
  )
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted) VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaignId, owner.userId],
  )
  return { campaignId, worldId }
}

async function addMember(pool: Pool, campaignId: string, user: SeededUser): Promise<void> {
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted) VALUES ($1, $2, $3, 'player', true)`,
    [uuidv7(), campaignId, user.userId],
  )
}

interface QueueSpy {
  readonly queue: SessionPrepQueueLike
  readonly add: ReturnType<typeof vi.fn>
}
function createQueueSpy(): QueueSpy {
  const add = vi.fn().mockResolvedValue({ id: 'stub-job' })
  const queue: SessionPrepQueueLike = {
    add: (name, data, opts) => add(name, data, opts) as Promise<unknown>,
  }
  return { queue, add }
}

async function buildTestApp(pool: Pool, queue?: SessionPrepQueueLike): Promise<FastifyInstance> {
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(bypassPlugin)
  await app.register(requireOnboarded, { pool })
  await app.register(sessionPrepsPlugin, { pool, sessionPrepQueue: queue })
  await app.ready()
  return app
}

describe('sessionPrepsPlugin (MYT-63)', () => {
  let pool: Pool
  let app: FastifyInstance
  let queueSpy: QueueSpy
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('sp-routes')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')
    await cleanupTestScope(pool, scope)
    queueSpy = createQueueSpy()
    app = await buildTestApp(pool, queueSpy.queue)
  })
  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  describe('POST /session-prep (trigger, owner)', () => {
    it('202 — owner enqueues with jobId sp-<id>-<n>; default sessionNumber=1', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/session-prep`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: {},
      })
      expect(res.statusCode).toBe(202)
      expect(res.json()).toEqual({ campaignId, sessionNumber: 1 })
      expect(queueSpy.add).toHaveBeenCalledWith(
        'session-prep',
        { campaignId, sessionNumber: 1 },
        { jobId: `sp-${campaignId}-1` },
      )
    })

    it('403 — non-member', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const stranger = await seedUser(pool, scope, 1)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/session-prep`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': stranger.devSub },
        payload: {},
      })
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('not_campaign_member')
    })

    it('403 — non-owner member (player)', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const player = await seedUser(pool, scope, 1)
      await addMember(pool, campaignId, player)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/session-prep`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': player.devSub },
        payload: { sessionNumber: 2 },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('not_campaign_owner')
    })
  })

  describe('GET /session-preps (list, member) + GET /:prepId (read, member)', () => {
    it('200 — member lists ordered SafeSessionPrep[]; no sd_playbook, exact keys', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const player = await seedUser(pool, scope, 1)
      await addMember(pool, campaignId, player)
      const repo = createRepo(pool)
      await repo.sessionPreps.insert({ campaignId, sessionNumber: 2, ftContext: 'FT2', sdPlaybook: SECRET })
      await repo.sessionPreps.insert({ campaignId, sessionNumber: 1, ftContext: 'FT1', sdPlaybook: SECRET })

      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/session-preps`,
        headers: { 'x-mythrun-dev-sub': player.devSub },
      })
      expect(res.statusCode).toBe(200)
      expect(res.body).not.toContain(SECRET)
      const body = res.json<{ preps: Record<string, unknown>[] }>()
      expect(body.preps.map((p) => p.sessionNumber)).toEqual([1, 2])
      for (const p of body.preps) expect(Object.keys(p).sort()).toEqual(SAFE_KEYS)
    })

    it('200 — read returns SafeSessionPrep; no sd_playbook, exact keys', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const repo = createRepo(pool)
      await repo.sessionPreps.insert({ campaignId, sessionNumber: 1, ftContext: 'FT', sdPlaybook: SECRET })
      const prepId = (await repo.sessionPreps.listFor(campaignId))[0]?.id
      if (prepId === undefined) throw new Error('expected a seeded prep')

      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/session-preps/${prepId}`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      expect(res.body).not.toContain(SECRET)
      expect(Object.keys(res.json<Record<string, unknown>>()).sort()).toEqual(SAFE_KEYS)
    })

    it('404 — read an absent prepId', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/session-preps/${uuidv7()}`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(404)
      expect(res.json<{ code: string }>().code).toBe('prep_not_found')
    })

    it('404 — read a prepId that belongs to a different campaign (no cross-campaign leak)', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId: campA } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const { campaignId: campB } = await seedCampaignOwnedBy(pool, scope, owner, 1)
      const repo = createRepo(pool)
      await repo.sessionPreps.insert({ campaignId: campB, sessionNumber: 1, ftContext: 'FT', sdPlaybook: SECRET })
      const otherPrepId = (await repo.sessionPreps.listFor(campB))[0]?.id
      if (otherPrepId === undefined) throw new Error('expected a seeded prep')
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campA}/session-preps/${otherPrepId}`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('POST /reset-prep (owner)', () => {
    it('200 — owner deletes the prep + re-arms the stage; a later claim re-claims', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const repo = createRepo(pool)
      await repo.sessionPreps.insert({ campaignId, sessionNumber: 1, ftContext: 'FT', sdPlaybook: SECRET })
      // Simulate a completed stage so the re-arm is observable.
      await repo.pipelineRuns.claimStage({ kind: 'campaign', campaignId, stage: 'session-prep:1' })
      await pool.query(
        `UPDATE pipeline_runs SET status='completed', completed_at=now()
          WHERE campaign_id=$1 AND stage='session-prep:1' AND user_id IS NULL`,
        [campaignId],
      )

      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/reset-prep`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { sessionNumber: 1 },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ campaignId, sessionNumber: 1, reset: true })
      expect(await repo.sessionPreps.existsFor(campaignId, 1)).toBe(false)
      expect(await repo.pipelineRuns.claimStage({ kind: 'campaign', campaignId, stage: 'session-prep:1' })).toBe('claimed')
    })

    it('200 — reset with no existing prep is an idempotent no-op', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/reset-prep`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: {},
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ campaignId, sessionNumber: 1, reset: true })
    })

    it('403 — non-owner member', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const player = await seedUser(pool, scope, 1)
      await addMember(pool, campaignId, player)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/reset-prep`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': player.devSub },
        payload: {},
      })
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('not_campaign_owner')
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/routes/__tests__/session-preps.test.ts`
Expected: FAIL — `sessionPrepsPlugin` is not exported (and the routes 404).

- [ ] **Step 3: Add the projection + plugin to `routes/session-preps.ts`**

Append below the `SessionPrepQueueLike` interface (from Task 3):

```ts
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'
import { createRepo } from '../repo/index.js'
import { requireCampaignMember } from '../auth/access-control.js'
import type { SessionPrepRow } from '../repo/types.js'

export interface Opts {
  readonly pool: Pool
  // Optional + a request-time guard, mirroring campaigns.ts's worldGenQueue:
  // AppDeps makes it required (boot invariant) and app.ts forwards it
  // unconditionally, but the plugin tolerates a missing queue for the
  // read/reset-only paths — only the trigger route 500s without it.
  readonly sessionPrepQueue?: SessionPrepQueueLike
}

interface Params {
  readonly campaignId: string
}
interface PrepParams {
  readonly campaignId: string
  readonly prepId: string
}

// MVP: session 1 only (MYT-59 scope). Body default for trigger + reset.
const SessionPrepBodySchema = z.object({
  sessionNumber: z.number().int().positive().default(1),
})

// Enforced ignorance: the HTTP surface NEVER serves sd_playbook. This is the
// ENTIRE runtime gate — the backend uses no Fastify response schemas, so
// reply.send serializes every own-enumerable property. toSafeSessionPrep MUST
// build an explicit field-by-field literal, NEVER `{ ...row }` (a spread
// type-checks under structural typing AND carries sd_playbook to the wire).
export interface SafeSessionPrep {
  id: string
  sessionNumber: number
  ftContext: string
  snapshotId: string | null
  createdAt: string
}

export function toSafeSessionPrep(row: SessionPrepRow): SafeSessionPrep {
  return {
    id: row.id,
    sessionNumber: row.sessionNumber,
    ftContext: row.ftContext,
    snapshotId: row.snapshotId,
    createdAt: row.createdAt.toISOString(),
  }
}

// FastifyPluginAsync requires an async shape; the body has no top-level await.
// eslint-disable-next-line @typescript-eslint/require-await, max-lines-per-function
export const sessionPrepsPlugin: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)

  function requireSessionPrepRouteDeps(): { sessionPrepQueue: SessionPrepQueueLike } {
    /* c8 ignore start — boot-time invariant: AppDeps.sessionPrepQueue is
       required and app.ts forwards it unconditionally, so this never throws in
       a real boot. Mirrors requireCreateRouteDeps (campaigns.ts). */
    if (!opts.sessionPrepQueue) {
      throw new Error(
        'sessionPrepsPlugin: POST /session-prep requires sessionPrepQueue in Opts (wired by app.ts)',
      )
    }
    /* c8 ignore stop */
    return { sessionPrepQueue: opts.sessionPrepQueue }
  }

  // Per-user rate-limit key: rate-limit runs at onRequest, BEFORE requireOnboarded
  // attaches request.dbUser (a preHandler). request.user (sub) IS attached at
  // onRequest by the jwt/bypass plugins — use it for genuine per-user keying.
  // ?? req.ip is a defensive fallback only (the routes/users.ts register precedent).
  const perUserKey = (req: FastifyRequest): string => req.user?.sub ?? req.ip

  // 4.1 POST /session-prep — trigger (owner)
  app.post<{ Params: Params; Body: z.infer<typeof SessionPrepBodySchema> }>(
    '/api/campaigns/:campaignId/session-prep',
    {
      preHandler: requireCampaignMember(repo, 'owner'),
      config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: perUserKey } },
    },
    async (req, reply) => {
      const parsed = SessionPrepBodySchema.safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send({ code: 'bad_body' })
      const { sessionPrepQueue } = requireSessionPrepRouteDeps()
      const { campaignId } = req.params
      const { sessionNumber } = parsed.data
      await sessionPrepQueue.add(
        'session-prep',
        { campaignId, sessionNumber },
        { jobId: `sp-${campaignId}-${String(sessionNumber)}` },
      )
      return reply.code(202).send({ campaignId, sessionNumber })
    },
  )

  // 4.2 GET /session-preps — list (member)
  app.get<{ Params: Params }>(
    '/api/campaigns/:campaignId/session-preps',
    {
      preHandler: requireCampaignMember(repo),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const rows = await repo.sessionPreps.listFor(req.params.campaignId)
      return reply.code(200).send({ preps: rows.map(toSafeSessionPrep) })
    },
  )

  // 4.3 GET /session-preps/:prepId — read (member)
  app.get<{ Params: PrepParams }>(
    '/api/campaigns/:campaignId/session-preps/:prepId',
    {
      preHandler: requireCampaignMember(repo),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const row = await repo.sessionPreps.getById(req.params.prepId)
      // 404 for absent OR cross-campaign — don't leak cross-campaign existence.
      if (row === null || row.campaignId !== req.params.campaignId) {
        return reply.code(404).send({ code: 'prep_not_found' })
      }
      return reply.code(200).send(toSafeSessionPrep(row))
    },
  )

  // 4.4 POST /reset-prep — reset (owner)
  app.post<{ Params: Params; Body: z.infer<typeof SessionPrepBodySchema> }>(
    '/api/campaigns/:campaignId/reset-prep',
    {
      preHandler: requireCampaignMember(repo, 'owner'),
      config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: perUserKey } },
    },
    async (req, reply) => {
      const parsed = SessionPrepBodySchema.safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send({ code: 'bad_body' })
      const { campaignId } = req.params
      const { sessionNumber } = parsed.data
      // Atomic: delete the prep row + re-arm the session-prep:<n> stage so a
      // subsequent trigger regenerates cleanly. Both binders are on bindTx.
      await repo.transaction(async (tx) => {
        await tx.sessionPreps.deleteFor(campaignId, sessionNumber)
        await tx.pipelineRuns.resetStage({
          kind: 'campaign',
          campaignId,
          stage: `session-prep:${String(sessionNumber)}`,
        })
      })
      return reply.code(200).send({ campaignId, sessionNumber, reset: true })
    },
  )
}
```

(Hoist the imports to the top of the file with the Task-3 header; do not duplicate the `SessionPrepQueueLike` interface.)

- [ ] **Step 4: Register the plugin in `app.ts`**

Add the import near the other route imports:
```ts
import { sessionPrepsPlugin } from './routes/session-preps.js'
```
Register it after `campaignCharactersPlugin` (it inherits the JWT + onboarded + access-control chain like the other campaign-scoped plugins). `deps.sessionPrepQueue` is required in `AppDeps`, so pass it directly:
```ts
  await app.register(sessionPrepsPlugin, {
    pool: deps.pg,
    sessionPrepQueue: deps.sessionPrepQueue,
  })
```

- [ ] **Step 5: Add the four routes to `backend-routes.ts`**

In `backend/src/contract/backend-routes.ts`, inside the `// Campaigns (pipeline + non-pipeline)` block, add (the printRoutes-drift test boots under bypass and diffs registered routes against this list — these must match the plugin's registrations exactly):
```ts
  { method: 'POST', path: '/api/campaigns/:campaignId/session-prep' },
  { method: 'GET', path: '/api/campaigns/:campaignId/session-preps' },
  { method: 'GET', path: '/api/campaigns/:campaignId/session-preps/:prepId' },
  { method: 'POST', path: '/api/campaigns/:campaignId/reset-prep' },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run src/routes/__tests__/session-preps.test.ts` → PASS (all).
Run: `pnpm vitest run src/contract/__tests__/backend-routes.test.ts` → PASS (printRoutes drift consistent).
Run: `pnpm typecheck` → exit 0. `pnpm lint` → clean.
Run: `pnpm test` (BACKEND suite) → green. (The DEV-TOOL suite is intentionally RED here — route-exhaustion; recovered in Task 5. Do NOT push.)

Coverage check (scoped, fast — per `feedback_scoped_coverage_for_iteration`):
`pnpm vitest run src/routes/__tests__/session-preps.test.ts --coverage --coverage.include='src/routes/session-preps.ts'` → 100% (the `requireSessionPrepRouteDeps` throw arm is `c8 ignore`d; everything else is exercised).

- [ ] **Step 7: Commit** (controller, after review)

```bash
git add backend/src/routes/session-preps.ts backend/src/app.ts \
  backend/src/contract/backend-routes.ts backend/src/routes/__tests__/session-preps.test.ts
git commit -m "feat(myth): session-prep trigger/list/read/reset routes + SafeSessionPrep projection (MYT-63)"
```

---

## Task 5: Dev-tool panels (4) + `world-page` + `verify-registry`

**Files:**
- Create: 4 panel components + 4 JSDOM tests (paths in File Structure)
- Modify: `backend/dev-tool/src/pages/world-page.ts`, `backend/dev-tool/verify-registry.ts`

- [ ] **Step 1: Write the failing JSDOM panel tests**

Create `backend/dev-tool/src/components/__tests__/session-prep-trigger-panel.test.ts` (mirror `campaign-archive-panel.test.ts` — same JSDOM bootstrap; replace the import + mount name, and the success status is **202**):

```ts
// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
vi.mock('../../api-client.js', () => ({ apiCall: vi.fn() }))
import { apiCall } from '../../api-client.js'
import { setActiveCampaignId } from '../../shell/active-campaign.js'
import { mountSessionPrepTriggerPanel } from '../session-prep-trigger-panel.js'

const apiCallMock = vi.mocked(apiCall)
interface GlobalDom { document?: Document; window?: Window; localStorage?: Storage; HTMLElement?: typeof HTMLElement; CustomEvent?: typeof CustomEvent }
const g = globalThis as unknown as GlobalDom
let saved: GlobalDom = {}
let dom: JSDOM
beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  saved = { document: g.document, window: g.window, localStorage: g.localStorage, HTMLElement: g.HTMLElement, CustomEvent: g.CustomEvent }
  g.document = dom.window.document; g.window = dom.window as unknown as Window
  g.localStorage = dom.window.localStorage; g.HTMLElement = dom.window.HTMLElement; g.CustomEvent = dom.window.CustomEvent
})
afterAll(() => { g.document = saved.document; g.window = saved.window; g.localStorage = saved.localStorage; g.HTMLElement = saved.HTMLElement; g.CustomEvent = saved.CustomEvent })
function makeParent(): HTMLElement { const p = dom.window.document.createElement('div'); dom.window.document.body.appendChild(p); return p }
beforeEach(() => { dom.window.document.body.replaceChildren(); apiCallMock.mockReset(); dom.window.localStorage.clear() })
afterEach(() => { setActiveCampaignId(null) })

describe('mountSessionPrepTriggerPanel', () => {
  it('returns a PanelHandle in the parent with data-state ready', () => {
    const parent = makeParent()
    const handle = mountSessionPrepTriggerPanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })
  it('unmount removes the panel', () => {
    const parent = makeParent()
    mountSessionPrepTriggerPanel(parent).unmount()
    expect(parent.children.length).toBe(0)
  })
  it('transitions to ready on 202', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({ status: 202, ok: true, body: { campaignId: 'camp-1', sessionNumber: 1 }, latencyMs: 9 })
    const parent = makeParent()
    const handle = mountSessionPrepTriggerPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })
  it('transitions to error on non-2xx', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({ status: 403, ok: false, body: { code: 'not_campaign_owner' }, latencyMs: 9 })
    const parent = makeParent()
    const handle = mountSessionPrepTriggerPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
  })
})
```

Create the other three tests by the same template:
- `session-prep-reset-panel.test.ts` → `mountSessionPrepResetPanel`, success status **200**.
- `session-preps-list-panel.test.ts` → `mountSessionPrepsListPanel`, success body `{ preps: [] }` (status 200); it's fetch-on-mount + a Refresh button (assert via the button click like `world-snapshot-panel.test.ts`).
- `session-prep-view-panel.test.ts` → `mountSessionPrepViewPanel`, success body a single SafeSessionPrep `{ id:'p1', sessionNumber:1, ftContext:'x', snapshotId:null, createdAt:'2026-01-01T00:00:00.000Z' }` (status 200).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter ./backend/dev-tool vitest run src/components/__tests__/session-prep-*.test.ts` (or the repo's dev-tool test command, e.g. `pnpm dev-tool:test`).
Expected: FAIL — the four `mount*` modules don't exist.

- [ ] **Step 3: Implement the four panels**

`backend/dev-tool/src/components/session-prep-trigger-panel.ts` (action-only, mirrors `campaign-archive-panel.ts`; adds a `sessionNumber` input; success status is **202**):

```ts
// backend/dev-tool/src/components/session-prep-trigger-panel.ts
//
// MYT-63 — POST /api/campaigns/:campaignId/session-prep. Action: enqueue the
// session-prep job for a session number (default 1). 202 = accepted.
import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import { buildSplitView, type PanelHandle } from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body as { code: unknown }).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountSessionPrepTriggerPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/campaigns/:campaignId/session-prep',
  })

  const label = document.createElement('label')
  label.style.fontSize = '12px'
  label.style.color = 'var(--fg-muted)'
  label.textContent = 'session number'
  const input = document.createElement('input')
  input.type = 'number'
  input.min = '1'
  input.value = '1'
  input.style.marginLeft = '6px'
  input.style.width = '64px'
  label.appendChild(input)
  actionEl.appendChild(label)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Enqueue prep'
  submitBtn.style.marginLeft = '8px'
  actionEl.appendChild(submitBtn)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not yet submitted)'
  feedbackEl.appendChild(idle)
  setState('ready')

  async function submit(): Promise<void> {
    const id = getActiveCampaignId()
    if (id === null) {
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent = '(no active campaign — pick one from My campaigns)'
      feedbackEl.appendChild(m)
      return
    }
    setState('loading')
    feedbackEl.replaceChildren()
    submitBtn.disabled = true
    const sessionNumber = Number(input.value) || 1
    const res = await apiCall(`/api/campaigns/${id}/session-prep`, {
      method: 'POST',
      body: JSON.stringify({ sessionNumber }),
    })
    submitBtn.disabled = false
    if (res.status !== 202) {
      setState('error')
      renderErrorBlock(feedbackEl, { status: res.status, code: readCode(res.body), message: 'Trigger failed', raw: res.body })
      return
    }
    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `${String(res.status)} accepted`
    feedbackEl.appendChild(summary)
    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => { void submit() }
  submitBtn.addEventListener('click', onClick)
  return {
    root,
    unmount: () => {
      submitBtn.removeEventListener('click', onClick)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('POST', '/api/campaigns/:campaignId/session-prep', mountSessionPrepTriggerPanel)
```

`session-prep-reset-panel.ts` — identical structure; title `POST /api/campaigns/:campaignId/reset-prep`, button `Reset prep`, endpoint `/reset-prep`, success status check `res.status !== 200`, summary `reset`, and:
```ts
registerPanelMount('POST', '/api/campaigns/:campaignId/reset-prep', mountSessionPrepResetPanel)
```

`session-preps-list-panel.ts` — fetch-on-mount with a Refresh button (mirror `world-snapshot-panel.ts`'s buildSplitView + button + `setState`, fetch-on-mount by calling `void refresh()` before returning):

```ts
// backend/dev-tool/src/components/session-preps-list-panel.ts
//
// MYT-63 — GET /api/campaigns/:campaignId/session-preps. Lists SafeSessionPrep
// rows (no sd_playbook on this surface). Fetch-on-mount + Refresh.
import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import { buildSplitView, type PanelHandle } from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface SafePrep { id: string; sessionNumber: number; ftContext: string; snapshotId: string | null; createdAt: string }

export function mountSessionPrepsListPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/campaigns/:campaignId/session-preps',
  })
  const refreshBtn = document.createElement('button')
  refreshBtn.textContent = 'Refresh'
  actionEl.appendChild(refreshBtn)

  async function refresh(): Promise<void> {
    const id = getActiveCampaignId()
    if (id === null) {
      setState('ready')
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent = '(no active campaign — pick one from My campaigns)'
      feedbackEl.appendChild(m)
      return
    }
    setState('loading')
    feedbackEl.replaceChildren()
    const res = await apiCall<{ preps: SafePrep[] }>(`/api/campaigns/${id}/session-preps`)
    if (res.status !== 200) {
      setState('error')
      renderErrorBlock(feedbackEl, { status: res.status, code: 'list_failed', message: 'List failed', raw: res.body })
      return
    }
    setState('ready')
    const preps = res.body?.preps ?? []
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `${String(preps.length)} prep(s)`
    feedbackEl.appendChild(summary)
    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => { void refresh() }
  refreshBtn.addEventListener('click', onClick)
  void refresh() // fetch-on-mount
  return {
    root,
    unmount: () => {
      refreshBtn.removeEventListener('click', onClick)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('GET', '/api/campaigns/:campaignId/session-preps', mountSessionPrepsListPanel)
```

`session-prep-view-panel.ts` — like the list panel, but with a `prepId` text input + Fetch button; endpoint `/api/campaigns/${id}/session-preps/${prepId}`; success `res.status !== 200` (404 → error). Register:
```ts
registerPanelMount('GET', '/api/campaigns/:campaignId/session-preps/:prepId', mountSessionPrepViewPanel)
```

- [ ] **Step 4: Compose the panels on the world page**

In `backend/dev-tool/src/pages/world-page.ts`, add the four imports + four `SECTIONS` entries (after `random-tables`):
```ts
import { mountSessionPrepTriggerPanel } from '../components/session-prep-trigger-panel.js'
import { mountSessionPrepResetPanel } from '../components/session-prep-reset-panel.js'
import { mountSessionPrepsListPanel } from '../components/session-preps-list-panel.js'
import { mountSessionPrepViewPanel } from '../components/session-prep-view-panel.js'
```
```ts
  { id: 'session-prep-trigger', mount: mountSessionPrepTriggerPanel },
  { id: 'session-prep-reset', mount: mountSessionPrepResetPanel },
  { id: 'session-preps-list', mount: mountSessionPrepsListPanel },
  { id: 'session-prep-view', mount: mountSessionPrepViewPanel },
```

- [ ] **Step 5: Wire the registry (`verify-registry.ts`)**

Add to `PANEL_EXERCISES` (each panel → its route):
```ts
  'session-prep-trigger': [{ method: 'POST', path: '/api/campaigns/:campaignId/session-prep' }],
  'session-prep-reset': [{ method: 'POST', path: '/api/campaigns/:campaignId/reset-prep' }],
  'session-preps-list': [{ method: 'GET', path: '/api/campaigns/:campaignId/session-preps' }],
  'session-prep-view': [{ method: 'GET', path: '/api/campaigns/:campaignId/session-preps/:prepId' }],
```
Add the four ids to `PAGE_REGISTRY.world.panels[]` (after `'random-tables'`):
```ts
      'session-prep-trigger',
      'session-prep-reset',
      'session-preps-list',
      'session-prep-view',
```

- [ ] **Step 6: Run the dev-tool tests to verify they pass**

Run the four panel tests → PASS.
Run `verify-registry.test.ts` → PASS (forward-coverage: each new `mount*` is composed by the world page; route-exhaustion: the four new `BACKEND_ROUTES` entries are now credited via PANEL_EXERCISES; PANEL_EXERCISES-completeness: each new panel id maps to a route).
Run the full dev-tool suite + `pnpm dev-tool:check` (typecheck/lint for the dev-tool package) → green.

- [ ] **Step 7: Commit** (controller, after review)

```bash
git add backend/dev-tool/src/components/session-prep-*.ts backend/dev-tool/src/components/session-preps-list-panel.ts \
  backend/dev-tool/src/components/__tests__/session-prep-*.test.ts \
  backend/dev-tool/src/pages/world-page.ts backend/dev-tool/verify-registry.ts
git commit -m "feat(myth): dev-tool panels for session-prep routes (MYT-63)"
```

---

## Task 6: Full verification + smoke seam

**Files:** none (verification only).

- [ ] **Step 1: Run the whole gate**

Run, all from repo root:
- `pnpm typecheck` → exit 0
- `pnpm lint` → clean
- `pnpm test` → BACKEND suite green (incl. `backend-routes.test.ts` drift, `session-preps.test.ts` enforced-ignorance, the AppDeps-literal tests)
- `pnpm dev-tool:check` → green (route-exhaustion + forward-coverage + the four panel tests)

- [ ] **Step 2: Confirm enforced-ignorance end-to-end (structural)**

Confirm `toSafeSessionPrep` is an explicit literal (no `{ ...row }`), the list/read tests assert both no-sentinel AND exact-five-keys, and the trigger/reset responses are metadata-only (`{ campaignId, sessionNumber, … }`, never a prep projection). Confirm no route handler logs a prep row / `ftContext` / `sdPlaybook` (id + sessionNumber only).

- [ ] **Step 3: Smoke seam (do NOT run here)**

The real-LLM E2E (trigger → generate → list/read against a real Anthropic key + real BullMQ) is **MYT-64**. This task only wires the seam — do not run a real-LLM smoke in MYT-63. Note in the close-out that the dev-tool-verifier (live backend on :3030) + the wiki subagent + the single push are the controller's close-out steps, not plan tasks.

---

## Self-Review (controller, before dispatching Task 1)

- **Spec coverage:** §2 decisions (HTTP never serves sd_playbook → Task 4 SafeSessionPrep; trigger always-enqueue+202 → Task 4; owner/member gating → Task 4; new plugin, not pipelineRoute → Task 4 + "Do NOT touch"). §3 producer threading → Task 3. §4.1–4.4 routes → Task 4. §5 SafeSessionPrep explicit-literal + exact-keys test → Task 4. §6 repo (sessionPreps + resetStage) → Tasks 1–2. §7 dev-tool 4 panels 3-part lockstep → Task 5. §8 contracts (backend-routes yes, coverage.json/pipeline-routes no) → Task 4 + "Do NOT touch". §9 error handling (404 cross-campaign, idempotent reset, metadata-only, no-secret-in-logs) → Task 4 + Task 6. §10 tests → each task's TDD step. §11 references → grounded against the actual code (processor stage string `session-prep:${sessionNumber}` confirmed; `ClaimRequest` `'campaign'` variant confirmed; `insertCharacterConceptSeedRow` reset SQL confirmed). All covered.
- **Placeholder scan:** none — every code step has complete code or an explicit "mirror file X, change A/B/C" delta with the concrete values.
- **Type consistency:** `SessionPrepQueueLike.add('session-prep', { campaignId, sessionNumber }, { jobId })` is identical across the type (Task 3), the spy (Task 4 test), and the call site (Task 4 route). `resetStage({ kind: 'campaign', campaignId, stage })` is identical across interface, binder, route, and tests. `SafeSessionPrep`'s five keys match the `SAFE_KEYS` assertion. jobId format `sp-${campaignId}-${sessionNumber}` matches the processor docstring and the trigger route. Stage string `session-prep:${sessionNumber}` matches the processor (`llm/prep/session-prep-processor.ts:72`).
