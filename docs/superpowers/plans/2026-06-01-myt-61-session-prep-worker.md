# Session Prep — Worker + Persistence + Cost-Record + Resume (MYT-61) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `generateSessionPrep` as a `session-prep` BullMQ job that persists `session_preps`, records cost in `pipeline_runs`, and is idempotent/resumable per `(campaign_id, session_number)`.

**Architecture:** A dedicated `session-prep` queue + single-processor Worker (mirrors `world-gen`). The processor mirrors `character-integration-processor`: `claimStage` (resume), `generateSessionPrep`, insert `session_preps`, `markStageCompleted` with cost. Per-session uniqueness via a new `UNIQUE(campaign_id, session_number)` + `pipeline_runs` `stage='session-prep:<n>'`. No leak guard (MYT-60 dropped), no cost cap (record only).

**Tech Stack:** TypeScript (strict), BullMQ, Vitest (real Postgres + `vi.spyOn` stage mock), Zod, pg.

**Spec:** `docs/superpowers/specs/2026-06-01-myt-61-session-prep-worker-design.md`.

---

## Before you start (confirm against source — don't guess)

1. **Cost helper.** Confirm `backend/src/billing/model-pricing.ts` exports `computeCostUsd(modelId: string, usage: { inputTokens; outputTokens; ... }): number` and that `paint-job-validator.ts` calls `computeCostUsd('claude-opus-4-7', usage)`. Use that exact call (do NOT invent Opus per-MTok constants). If there's an exported model-id constant for Opus, prefer it over the string.
2. **Worker entrypoints.** `session-prep`'s Worker must be registered in BOTH `src/worker.ts` (`main()`) and `src/server.ts` (the in-API worker) — the second was missed once before (see `worker.ts:69-73` comment). Grep both for the `world-gen` Worker registration and add a sibling.
3. Run from `backend/`. Work on `main`. `pnpm db:up` + `DATABASE_URL` set for the real-Postgres tests.

---

## File structure

- **Create** `backend/migrations/022_session_preps_unique.sql` — `UNIQUE (campaign_id, session_number)`.
- **Modify** `backend/src/db/__tests__/migrate-schema.test.ts` — version array + a focused constraint assertion.
- **Create** `backend/src/repo/session-preps.ts` — `sessionPrepsNs` binder; **Modify** `src/repo/index.ts` (wire) + `src/repo/types.ts` (`SessionPrepRow`).
- **Modify** `backend/src/contract/pipeline-jobs.ts` (add `'session-prep'`), `backend/src/worker/bullmq-config.ts` (queue + concurrency consts), `backend/dev-tool/coverage.json` (exempt entry).
- **Create** `backend/src/llm/prep/session-prep-processor.ts` — the processor; **Modify** `src/worker.ts` + `src/server.ts` (register the Worker + enqueue adapter).
- **Tests:** colocated `__tests__/` for the binder, the processor, and the migration.

Task order: **1 → 2 → 3 → 4** (Task 4 integrates 1–3).

---

## Task 1: Migration 022 — `UNIQUE (campaign_id, session_number)` on `session_preps`

**Files:** Create `backend/migrations/022_session_preps_unique.sql`; Modify `backend/src/db/__tests__/migrate-schema.test.ts`.

- [ ] **Step 1: failing test** — add to `migrate-schema.test.ts`: (a) append `'022_session_preps_unique.sql'` to the pinned migration-version array (the array near line ~658 — find it by the `021_` entry); (b) a focused block:

```ts
describe('migration 022 — session_preps uniqueness', () => {
  it('has a UNIQUE constraint on (campaign_id, session_number)', async () => {
    const { rows } = await pool.query(
      `SELECT conname, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'session_preps' AND c.contype = 'u'`,
    )
    expect(rows.some((r) => /UNIQUE \(campaign_id, session_number\)/.test(r.def as string))).toBe(true)
  })
})
```

- [ ] **Step 2: run → FAIL** `pnpm vitest run src/db/__tests__/migrate-schema.test.ts -t "session_preps uniqueness"` (no such constraint yet).

- [ ] **Step 3: write the migration** `022_session_preps_unique.sql` (named constraint = won't perturb the `idx_%` index-name assertion; idempotent):

```sql
-- backend/migrations/022_session_preps_unique.sql
-- MYT-61: session prep is one record per (campaign, session_number). The unique
-- constraint makes the worker's INSERT ... ON CONFLICT resume sound and prevents
-- duplicate preps for the same session. (002 only had a non-unique campaign index.)
ALTER TABLE session_preps DROP CONSTRAINT IF EXISTS session_preps_campaign_session_key;
ALTER TABLE session_preps ADD CONSTRAINT session_preps_campaign_session_key
  UNIQUE (campaign_id, session_number);
```

- [ ] **Step 4: run → PASS.** Then run the FULL `migrate-schema.test.ts` (it re-asserts the pinned arrays) — if the version array edit is missing/wrong it fails here. `pnpm typecheck`.

- [ ] **Step 5: commit** `git add backend/migrations/022_session_preps_unique.sql backend/src/db/__tests__/migrate-schema.test.ts && git commit -m "feat(myt-61): migration 022 — UNIQUE(campaign_id, session_number) on session_preps"`

---

## Task 2: `repo.sessionPreps` binder

**Files:** Create `backend/src/repo/session-preps.ts` + `__tests__/session-preps.test.ts`; Modify `src/repo/index.ts`, `src/repo/types.ts`.

- [ ] **Step 1: failing test** (`src/repo/__tests__/session-preps.test.ts`, real Postgres via test-scope; mirror an existing repo test's setup — `createTestPool` + `guardTestDatabase` + `runMigrations(REAL_MIGRATIONS_DIR)` + `makeTestScope`):

```ts
// setup: pool/scope/migrations per the repo test convention; seed a user + world + campaign
it('insert + existsFor + getBy; ON CONFLICT keeps one row', async () => {
  const repo = createRepo(pool)
  await repo.sessionPreps.insert({ campaignId, sessionNumber: 1, ftContext: 'FT', sdPlaybook: 'SD' })
  expect(await repo.sessionPreps.existsFor(campaignId, 1)).toBe(true)
  expect(await repo.sessionPreps.existsFor(campaignId, 2)).toBe(false)
  const row = await repo.sessionPreps.getBy(campaignId, 1)
  expect(row?.ftContext).toBe('FT'); expect(row?.sdPlaybook).toBe('SD')
  // ON CONFLICT DO NOTHING — second insert is a no-op, not an error, keeps the first
  await repo.sessionPreps.insert({ campaignId, sessionNumber: 1, ftContext: 'FT2', sdPlaybook: 'SD2' })
  expect((await repo.sessionPreps.getBy(campaignId, 1))?.ftContext).toBe('FT')
})
```

- [ ] **Step 2: run → FAIL** (module/binder missing).

- [ ] **Step 3: implement.** In `types.ts` add `export interface SessionPrepRow { id: string; campaignId: string; sessionNumber: number; ftContext: string; sdPlaybook: string; snapshotId: string | null; createdAt: Date }` (name it `…Row` to avoid clashing with the LLM-output `SessionPrep` in `stages/session-prep.ts`). Create `session-preps.ts` following the `factsNs` canonical pattern (namespace fn over `ClientLike`; `uuidv7` from `./uuidv7.js`):

```ts
import type { ClientLike } from './_types.js'
import { uuidv7 } from './uuidv7.js'
import type { SessionPrepRow } from './types.js'

export function sessionPrepsNs(c: ClientLike) {
  return {
    insert: async (input: {
      campaignId: string; sessionNumber: number; ftContext: string; sdPlaybook: string
    }): Promise<void> => {
      await c.query(
        `INSERT INTO session_preps (id, campaign_id, session_number, ft_context, sd_playbook)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (campaign_id, session_number) DO NOTHING`,
        [uuidv7(), input.campaignId, input.sessionNumber, input.ftContext, input.sdPlaybook],
      )
    },
    existsFor: async (campaignId: string, sessionNumber: number): Promise<boolean> => {
      const { rowCount } = await c.query(
        `SELECT 1 FROM session_preps WHERE campaign_id = $1 AND session_number = $2`,
        [campaignId, sessionNumber],
      )
      return (rowCount ?? 0) > 0
    },
    getBy: async (campaignId: string, sessionNumber: number): Promise<SessionPrepRow | null> => {
      const { rows } = await c.query(
        `SELECT id, campaign_id, session_number, ft_context, sd_playbook, snapshot_id, created_at
         FROM session_preps WHERE campaign_id = $1 AND session_number = $2`,
        [campaignId, sessionNumber],
      )
      const r = rows[0]
      return r ? { id: r.id, campaignId: r.campaign_id, sessionNumber: r.session_number,
        ftContext: r.ft_context, sdPlaybook: r.sd_playbook, snapshotId: r.snapshot_id, createdAt: r.created_at } : null
    },
  }
}
```
Wire in `index.ts`: import `sessionPrepsNs`, add `sessionPreps: sessionPrepsNs(c),` inside `bindTx(c)` (gives both `repo.sessionPreps` and `tx.sessionPreps`). No back-compat delegation const needed (no legacy callers).

- [ ] **Step 4: run → PASS.** `pnpm typecheck && pnpm lint`.
- [ ] **Step 5: commit** `feat(myt-61): repo.sessionPreps binder (insert/existsFor/getBy)`.

---

## Task 3: `session-prep` job + queue + dev-tool coverage

**Files:** Modify `src/contract/pipeline-jobs.ts`, `src/worker/bullmq-config.ts`, `backend/dev-tool/coverage.json`. Test: a contract/registry test.

- [ ] **Step 1: failing test** — assert `PIPELINE_JOBS` includes `'session-prep'` (add to the existing pipeline-jobs/contract test if present, else a small new test) AND run `pnpm dev-tool:check` (it will FAIL: `session-prep` in contract jobs but not in coverage).

- [ ] **Step 2: implement.**
  - `pipeline-jobs.ts`: add `'session-prep'` to `PIPELINE_JOBS`.
  - `bullmq-config.ts`: add `export const QUEUE_SESSION_PREP = 'session-prep' as const` and `export const CONCURRENCY_SESSION_PREP = 3`.
  - `coverage.json`: add to `exempt.jobs`: `"session-prep": "No dev-tool live-events driver yet — the driver is MYT-62; session-prep is enqueued by the play-runtime and exercised E2E via the MYT-64 smoke. (MYT-61)"` (reason must be ≥20 chars + name the ticket).

- [ ] **Step 3: run → PASS** (`dev-tool:check` green; contract test green). `pnpm typecheck`.
- [ ] **Step 4: commit** `feat(myt-61): register session-prep job + queue consts + dev-tool exempt`.

---

## Task 4: `session-prep-processor.ts` + worker wiring

**Files:** Create `backend/src/llm/prep/session-prep-processor.ts` + `__tests__/session-prep-processor.test.ts`; Modify `src/worker.ts`, `src/server.ts`.

- [ ] **Step 1: failing tests** (real Postgres + `vi.spyOn(sessionPrepStage, 'generateSessionPrep')`; mirror `character-integration-processor.test.ts` setup + `makeJob`/`makeDeps`). Cases:
  - **happy:** no existing prep → `generateSessionPrep` called → `session_preps` row present (ft/sd) → `pipeline_runs` row `stage='session-prep:1'`, `status='completed'`, `cost_usd` ≈ computed (toBeCloseTo, 6) → a `stage-completed` event published.
  - **resume:** pre-seed a `completed` `pipeline_runs` row for `(campaign, 'session-prep:1')` → processor no-ops, `generateSessionPrep` NOT called, 0 events.
  - **non-terminal fail:** `generateSessionPrep` rejects with a non-terminal error (e.g. `LlmRateLimitedError`) → `.rejects` (rethrown for BullMQ retry) → `pipeline_runs` `failed` → event `terminal:false`; campaign NOT set failed.
  - **terminal fail:** rejects with a terminal error (e.g. `LlmStructuredOutputError`) → `.resolves.toBeUndefined()` (no retry) → `pipeline_runs` `failed` → event `terminal:true`; **campaign NOT set failed** (a prep failure is session-scoped, unlike character-integration).
  - **ON CONFLICT:** running the happy path twice for the same `(campaign, 1)` keeps exactly one `session_preps` row, no error.

- [ ] **Step 2: run → FAIL** (processor missing).

- [ ] **Step 3: implement** `session-prep-processor.ts` (mirror `character-integration-processor.ts`; cost via `billing/model-pricing`; resolve `worldId` from the campaign):

```ts
import type { Pool } from 'pg'
import type { Job } from 'bullmq'
import { createRepo } from '../../repo/index.js'
import { generateSessionPrep } from './stages/session-prep.js'
import { computeCostUsd } from '../../billing/model-pricing.js'
import { isTerminalError } from '../errors.js'
import { atomicClaimStage } from './world-gen-processor.js' // the pool-bound claim shim (or repo.pipelineRuns.claimStage)

export interface SessionPrepJobPayload { readonly campaignId: string; readonly sessionNumber: number }
export interface SessionPrepProcessorDeps {
  readonly pool: Pool
  readonly publishEvent: (campaignId: string, event: unknown) => Promise<void>
}

export async function processSessionPrepJob(
  deps: SessionPrepProcessorDeps,
  job: Pick<Job<SessionPrepJobPayload>, 'data'>,
): Promise<void> {
  const { campaignId, sessionNumber } = job.data
  const stage = `session-prep:${sessionNumber}`
  const claim = await atomicClaimStage(deps.pool, { kind: 'campaign', campaignId, stage })
  if (claim === 'completed' || claim === 'lost-race') return

  const repo = createRepo(deps.pool)
  try {
    const worldId = await repo.campaigns.getWorldId(campaignId)
    if (!worldId) throw new Error(`session-prep: no world for campaign ${campaignId}`)
    const result = await generateSessionPrep(repo, { campaignId, worldId, sessionNumber })
    await repo.sessionPreps.insert({
      campaignId, sessionNumber, ftContext: result.ft_context, sdPlaybook: result.sd_playbook,
    })
    const costUsd = computeCostUsd('claude-opus-4-7', {
      inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0,
    })
    await repo.pipelineRuns.markStageCompleted({ kind: 'campaign', campaignId, stage, costUsd })
    await deps.publishEvent(campaignId, { type: 'stage-completed', stage, costUsd })
  } catch (err) {
    const terminal = isTerminalError(err)
    const message = err instanceof Error ? err.message : String(err)
    await repo.pipelineRuns.markStageFailed({ kind: 'campaign', campaignId, stage, error: message })
    // NOTE: unlike character-integration, do NOT call repo.campaigns.setFailed — a prep
    // failure is session-scoped; the campaign stays active.
    await deps.publishEvent(campaignId, { type: 'stage-failed', stage, message, terminal })
    if (!terminal) throw err // rethrow → BullMQ retry; terminal → return cleanly
  }
}

export function createSessionPrepProcessor(deps: SessionPrepProcessorDeps) {
  return (job: Job<SessionPrepJobPayload>) => processSessionPrepJob(deps, job)
}
```
(Confirm `repo.campaigns.getWorldId` exists — the research saw `getWorldId(id): Promise<string|null>`; if not, use `getWorldAndSituationIndex(id)` → `.world_id`.)

**Worker wiring** — in `src/worker.ts` `main()` and `src/server.ts`, alongside the world-gen Worker, add (using the same `connection`/deps built at boot):
```ts
const sessionPrepWorker = new BullmqWorker(
  QUEUE_SESSION_PREP, createSessionPrepProcessor({ pool, publishEvent }),
  { connection: redisBatch, concurrency: CONCURRENCY_SESSION_PREP },
)
```
Add `sessionPrepWorker` to the shutdown/close set wherever the other workers are closed. Build the matching `Queue` + thin adapter (mirroring `server.ts:120-133`, same `defaultJobOptions`) so the trigger (MYT-63) can enqueue with `jobId = \`sp-${campaignId}-${sessionNumber}\``.

- [ ] **Step 4: run → PASS** all processor cases. `pnpm typecheck && pnpm lint`.
- [ ] **Step 5: commit** `feat(myt-61): session-prep processor + worker/queue wiring`.

---

## Final verification

```bash
cd backend && pnpm typecheck && pnpm lint && pnpm vitest run src/llm/prep src/repo src/db && pnpm dev-tool:check
```
Real-LLM E2E smoke is **MYT-64**, not here.

## Notes / decisions baked in (from the API-mapping research)

- **`pipeline_runs` stage is `session-prep:<n>`** (encodes session number) because the claim/mark API keys on `(campaign, stage)` and would otherwise collide across sessions. Resume = `claimStage`→'completed'; the `session_preps` UNIQUE + `ON CONFLICT` is the durable artifact guarantee.
- **Cost recorded, not capped** — `cost_usd` only via `computeCostUsd('claude-opus-4-7', usage)` (the `paint-job-validator` precedent). No token columns (the campaign claim shape doesn't carry them; not worth a union extension), no settings row, no refund.
- **A failed prep does not fail the campaign** (no `setFailed`) — session-scoped.
- **Dedicated `session-prep` queue + Worker**, wired in both `worker.ts` and `server.ts`.
