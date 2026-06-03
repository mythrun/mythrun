# Session Prep — HTTP routes: trigger / list / read / reset (MYT-63) — Design

**Date:** 2026-06-02
**Linear:** MYT-63 (milestone: Session Prep Pipeline)
**Status:** design approved (verbally); pending spec review → implementation plan
**Depends on:** MYT-59/61 (`generateSessionPrep`, the session-prep worker + `session_preps` + the processor's idempotent resume), MYT-62 (the prep-status SSE + prep-prose stream — the *status/progress* surface; this issue adds the *CRUD/trigger* surface). **Reuses:** the world-gen producer pattern (`worldGenQueue`/`AppDeps`/`POST /api/campaigns`), `requireCampaignMember` auth, MYT-45 Redis rate limits. **Consumer (out of scope):** Session Runtime calls this surface (`/start` + the "prep exists for the next session" precondition are Session Runtime's, not here).

---

## 1. Overview

The four session-prep HTTP routes parked when session prep was cut from the World pipeline:

- `POST /api/campaigns/:campaignId/session-prep` — trigger generation (enqueue the job).
- `GET /api/campaigns/:campaignId/session-preps` — list a campaign's preps.
- `GET /api/campaigns/:campaignId/session-preps/:prepId` — read a single prep.
- `POST /api/campaigns/:campaignId/reset-prep` — reset a prep (so it can be regenerated).

The session-prep BullMQ queue is currently **worker-only** (server.ts builds it for shutdown bookkeeping; the API has no producer handle). This issue threads a producer queue into `AppDeps` so the trigger route can enqueue, adds the read/reset repo methods, and ships the four routes + their dev-tool panels.

## 2. Decisions locked (from brainstorming)

1. **HTTP routes never serve `sd_playbook`.** The persisted prep row carries `ft_context` (Fast-Thinker-safe) + `sd_playbook` (Slow-Thinker, may contain secrets). The read/list routes return `ft_context` + metadata ONLY — `sd_playbook` is never on the member/owner HTTP surface. Session Runtime (the Slow Thinker, same backend) reads it **in-process** via `repo.sessionPreps`; the dev-tool inspects it **live** via the MYT-62 prep-prose stream. This is the enforced-ignorance control for this issue (matches how the codebase already treats `sd_playbook` — never on a prod-reachable HTTP surface).
2. **Trigger is always-enqueue + 202, idempotent.** No pre-existence check; the MYT-61 processor's resume-no-op (claim `completed` → return; `insert` `ON CONFLICT DO NOTHING`) handles a duplicate. To regenerate, call `reset-prep` then trigger.
3. **Auth:** trigger + reset are **owner**-gated (generative / destructive campaign actions, mirroring resume/delete); list + read are **member**-gated.
4. **New plugin** `routes/session-preps.ts` (campaigns.ts is ~1200 lines; these four are a coherent unit). The routes are **NOT** `pipelineRoute` (they're CRUD, not the pipeline-status surface).

## 3. Producer queue threading (mirror `worldGenQueue`)

The pattern to mirror: `backend/src/routes/campaigns.ts:60-64` (`WorldGenQueueLike`), `app-deps.ts:23` (`worldGenQueue` field), `server.ts:107-146` (`buildWorldGenQueue` returns `{bullmqQueue, worldGenQueue-adapter}`), `app.ts:316` (forward into the plugin).

- **`SessionPrepQueueLike`** (new, in `routes/session-preps.ts` or a shared types module):
  ```
  add(name: 'session-prep', data: { campaignId: string; sessionNumber: number }, opts?: { jobId?: string }): Promise<unknown>
  ```
  Minimal structural interface (NOT BullMQ's full `Queue`), so tests inject a spy — exactly like `WorldGenQueueLike`.
- **`AppDeps.sessionPrepQueue: SessionPrepQueueLike`** (required — the trigger route 500s without it via a `requireSessionPrepRouteDeps()` guard, mirroring `requireCreateRouteDeps()` at `campaigns.ts:163-186`). The `app-deps.ts` model is `worldGenQueue` (required, `:23`). **Making it required ripples to every `AppDeps`-constructing site** (the plan must update these or they won't type-check): add a `noopSessionPrepQueue()` to `__tests__/helpers/stub-deps.ts` (mirror `noopWorldGenQueue`); add a `stubSessionPrepQueue()` to `server.ts`'s `fallbackStart` `stubDeps` (`server.ts:389` — mirror `stubWorldGenQueue` at `:341-348`, rejects on `.add()`, so the boot-gate-disabled binary still compiles); and update the inline `AppDeps` literals in `app-pipeline-contract.test.ts`, `contract/__tests__/backend-routes.test.ts` (this one boots the full app + registers the new plugin), `app.test.ts`, and the rate-limit/onboarding/invite tests. (The worker container — `worker.ts` — does NOT construct `AppDeps`, so it's unaffected.)
- **`buildSessionPrepQueue`** (`server.ts:275-285`) is extended to return `{ bullmqQueue, sessionPrepQueue }` (the raw `Queue` for shutdown drain — unchanged — plus the `SessionPrepQueueLike` adapter), mirroring `buildWorldGenQueue`. The adapter is passed into `buildApp({...})` (`server.ts:521-530`, which currently omits the queue) and forwarded in `app.ts` plugin registration.
- **jobId** = `sp-${campaignId}-${sessionNumber}` (BullMQ-side dedupe; matches the processor docstring). Payload `{ campaignId, sessionNumber }`. The session-prep queue's `removeOnComplete/removeOnFail: { count: 0 }` (server.ts:278-283) means a stale terminal job can't shadow a re-enqueue.
- The dedicated **worker container** (`worker.ts`) is unchanged — it's consumer-only and needs no producer handle.

## 4. The four routes — `backend/src/routes/session-preps.ts`

Registered in `app.ts` alongside the campaigns plugin (inherits the JWT + onboarded chain). `Params` carry `campaignId` (+ `prepId` on the read route). The plugin holds `repo = createRepo(opts.pool)` and asserts its deps.

### 4.1 `POST /api/campaigns/:campaignId/session-prep` — trigger
- `preHandler: requireCampaignMember(repo, 'owner')`; `config.rateLimit { max: 5, timeWindow: '1 minute', keyGenerator: (req) => req.user?.sub ?? req.ip }`.
- **Per-user keying detail:** rate-limit runs in the `onRequest` phase, BEFORE `requireOnboarded` attaches `request.dbUser` (a `preHandler`). So a `requireDbUser(req).id` keyGenerator would throw and silently fall back to `req.ip` (per-IP, mislabeled). Use `req.user?.sub` — the auth plugins (jwt/bypass) attach `request.user` at `onRequest`, so it IS available, giving genuine per-user keying (the `routes/users.ts` register precedent). `?? req.ip` is a defensive fallback only.
- Body (Zod): `{ sessionNumber?: number }` defaulting to `1` (MVP per MYT-59; a positive integer).
- Enqueue: `opts.sessionPrepQueue.add('session-prep', { campaignId, sessionNumber }, { jobId: \`sp-${campaignId}-${sessionNumber}\` })`.
- Respond **`202 Accepted`** with `{ campaignId, sessionNumber }`. (Progress is observed via the MYT-62 `GET …/prep-status` SSE.)
- No queue-depth admission check (deliberately omitted — session-prep is low-volume, one job per session trigger; unlike world-gen's burst profile. Noted as a YAGNI deferral.)

### 4.2 `GET /api/campaigns/:campaignId/session-preps` — list
- `preHandler: requireCampaignMember(repo)`; `config.rateLimit { max: 30, timeWindow: '1 minute' }` (default per-IP).
- `repo.sessionPreps.listFor(campaignId)` → `200 { preps: SafeSessionPrep[] }` (ordered by `sessionNumber`). **ft-safe projection** (§5).

### 4.3 `GET /api/campaigns/:campaignId/session-preps/:prepId` — read
- `preHandler: requireCampaignMember(repo)`; `config.rateLimit { max: 30, timeWindow: '1 minute' }`.
- `repo.sessionPreps.getById(prepId)`; **404** (`{ code: 'prep_not_found' }`) if absent OR `row.campaignId !== params.campaignId` (don't leak cross-campaign existence). → `200 SafeSessionPrep` (§5).

### 4.4 `POST /api/campaigns/:campaignId/reset-prep` — reset
- `preHandler: requireCampaignMember(repo, 'owner')`; `config.rateLimit { max: 5, timeWindow: '1 minute', keyGenerator: (req) => req.user?.sub ?? req.ip }` (same `onRequest`-phase reasoning as §4.1).
- Body (Zod): `{ sessionNumber?: number }` default `1`.
- In a transaction (`repo.transaction(async (tx) => …)` — both `sessionPreps` + `pipelineRuns` are on `bindTx`, so this commits atomically): `tx.sessionPreps.deleteFor(campaignId, sessionNumber)` + `tx.pipelineRuns.resetStage({ kind: 'campaign', campaignId, stage: \`session-prep:${sessionNumber}\` })`. Idempotent: resetting a non-existent prep is a no-op (still `200`). → `200 { campaignId, sessionNumber, reset: true }`.
- This makes a subsequent trigger regenerate cleanly: deleting the row clears the `ON CONFLICT DO NOTHING` block, and `resetStage` coerces the `session-prep:n` row to `pending` so `atomicClaimStage` re-arms it (verified: `claimCampaignStage`'s `ON CONFLICT … WHERE status IN ('pending','failed')` re-arms a `pending` row, and INSERTs fresh when none exists — both paths regenerate).

## 5. Enforced ignorance — the `SafeSessionPrep` projection

A dedicated response type with **no `sdPlaybook` field**:

```
interface SafeSessionPrep {
  id: string
  sessionNumber: number
  ftContext: string
  snapshotId: string | null
  createdAt: string   // ISO
}
```

**`toSafeSessionPrep(row: SessionPrepRow): SafeSessionPrep` MUST construct an explicit field-by-field object literal — NEVER a spread.** This is the load-bearing detail: unlike MYT-62's `ProseEvent` (a *disjoint* type, where the compiler rejects `publishEvent(prepDelta)` outright), `SafeSessionPrep` is a *projection of* the secret-bearing row, so under structural typing `const safe: SafeSessionPrep = { ...row }` type-checks AND carries `sdPlaybook` to the wire. This backend uses **no Fastify response schemas** (no schema-based allowlist strips extra fields at serialization — `reply.send` serializes every own-enumerable property), so the explicit literal is the *entire* runtime gate. Required form:

```
function toSafeSessionPrep(row: SessionPrepRow): SafeSessionPrep {
  return {
    id: row.id,
    sessionNumber: row.sessionNumber,
    ftContext: row.ftContext,
    snapshotId: row.snapshotId,
    createdAt: row.createdAt.toISOString(),   // SessionPrepRow.createdAt is Date
  }
}
```

The routes return `SafeSessionPrep` exclusively. The §10 test asserts (a) no response body contains a seeded `sd_playbook` sentinel AND (b) the response has **exactly** the five expected keys (`Object.keys(body).sort()` equals the allowlist) — so a future `{...row}` regression that adds `sdPlaybook` (even `null`) is caught structurally, not just by sentinel search.

We deliberately do **not** add a `bypass`-widening path (unlike world-snapshot) — the brainstorming decision is "never on the HTTP surface"; `sd_playbook` reaches Session Runtime in-process (`repo.sessionPreps.getBy`) and the dev-tool live (prep-prose). Note the resulting gap (out of scope, would be its own gated ticket): there is no way to read a *persisted* `sd_playbook` over any HTTP surface — the prep-prose stream is ephemeral (live deltas only, no replay). If post-hoc dev inspection of a stored playbook is ever needed, that's a future bypass-only dev *read* route with its own multi-layer gate, not a widening of these member/owner routes.

## 6. Repo additions

**`backend/src/repo/session-preps.ts`** (`sessionPrepsNs` binder — add to the canonical binder + the `repo`/`tx` namespaces):
- `listFor(campaignId: string): Promise<readonly SessionPrepRow[]>` — `SELECT … WHERE campaign_id = $1 ORDER BY session_number`.
- `getById(prepId: string): Promise<SessionPrepRow | null>` — `SELECT … WHERE id = $1`. (Existing `getBy(campaignId, sessionNumber)` stays.)
- `deleteFor(campaignId: string, sessionNumber: number): Promise<void>` — `DELETE … WHERE campaign_id = $1 AND session_number = $2`.

**`backend/src/repo/pipeline-runs.ts`** — add `resetStage` to BOTH the `PipelineRunsRepo` **interface** (`:83-166`, a typed interface — not just the binder body, or `tx.pipelineRuns.resetStage` won't type-check) AND the `pipelineRunsNs` body:
- `resetStage(args: { kind: 'campaign'; campaignId: string; stage: string }): Promise<void>` — coerce the matching row to `status='pending', started_at=NULL, completed_at=NULL, error=NULL` (mirror the `insertCharacterConceptSeedRow` reset SQL at `:456-467`; **do NOT touch `cost_usd`** — matching that precedent; the row is being re-armed, not erased as a spend record). Keyed on `campaign_id, stage, user_id IS NULL` (campaign-scoped). Idempotent (no matching row → 0 rows affected → no-op; keep it branchless — a bare `await c.query(...)` with no `rowCount` inspection — so it stays trivially 100%-covered). NOTE: unlike `claimStage`/`markStage*` (pool-bound BY DESIGN so recovery bookkeeping survives a stage-tx rollback, see `pipeline-runs.ts:410-415`), `resetStage` is a synchronous HTTP write meant to be atomic with the prep delete — composing it inside `repo.transaction` is correct; add a one-line comment saying so.

Note: `repo.sessionPreps` read methods do NOT gain a `bypass`/secret flag (decision §2 — `sd_playbook` is never projected over HTTP; Session Runtime reads the full row via the existing `getBy`).

## 7. Dev-tool panels

Per the dev-tool rule ("every backend route exercisable from the dev tool"), four single-purpose panels (the myth-mbdc one-route-per-panel convention), hosted on the **world page** (`PAGE_REGISTRY.world` — campaign-scoped, `requiresCampaign: true`, already hosts `world-snapshot`/`hierarchy`/`random-tables`). Do NOT add a new `WorkflowId`/page for these four (the `WorkflowId` union is a closed set of 6).
- `session-prep-trigger` (action-only) → `POST …/session-prep`.
- `session-prep-reset` (action-only) → `POST …/reset-prep`.
- `session-preps-list` (fetch-on-mount) → `GET …/session-preps`.
- `session-prep-view` (fetch-on-mount) → `GET …/session-preps/:prepId`.

Each panel moves in a **3-part lockstep** or a coverage invariant fails: (1) a `src/components/*.ts` module exporting `mount<Name>` (forward-coverage: every `mount*` module must be composed by a page or `EXEMPT_PANELS`); (2) a `PANEL_EXERCISES` entry mapping the panel id → its route; (3) the panel id in `PAGE_REGISTRY.world.panels[]` (the route-exhaustion invariant credits a route only if its exercising panel appears on a page). These are normal HTTP (not SSE) → real panels, NOT `EXEMPT_ROUTES`. Mirror existing action panels (`campaign-resume`/`campaign-archive`) + fetch panels (`my-campaigns`/`world-snapshot`); each sets the standard `data-state` markers.

## 8. Contracts & gates (lockstep)

- `backend/src/contract/backend-routes.ts` — add the 4 routes (campaign block). The drift test boots under bypass + diffs `printRoutes()`.
- `backend/dev-tool/verify-registry.ts` — add the 4 panels to `PANEL_EXERCISES` + `PAGE_REGISTRY.world.panels[]` (§7's 3-part lockstep). This is what covers the 4 routes against the `BACKEND_ROUTES` route-exhaustion invariant.
- **Do NOT touch `backend/dev-tool/coverage.json`** — its `routes[]` is validated against `PIPELINE_ROUTES` (not `BACKEND_ROUTES`); since these 4 routes are NOT `pipelineRoute`, adding them to `coverage.json routes[]` would fire the "in coverage but not in contract" removal warning. Correct precedent: `POST /api/campaigns/:campaignId/archive` is in `BACKEND_ROUTES` + `PANEL_EXERCISES` but absent from both `pipeline-routes.ts` AND `coverage.json routes[]`. `coverage.json` is untouched by MYT-63 (`session-prep` is already in `jobs`; no new events).
- **NOT** `pipeline-routes.ts` (the routes are not `pipelineRoute: true`), so **no `app-pipeline-contract.test.ts` mock churn** (the MYT-62 gotcha doesn't apply — verified: the forward-check `onRoute` hook early-returns when `pipelineRoute !== true`, and the reverse-check only iterates `PIPELINE_ROUTES`).

## 9. Error handling

- Trigger on a campaign whose world isn't ready → the route still enqueues; the processor's `getWorldId` guard surfaces a failed run (session-scoped, no `campaigns.setFailed`). The route's job is to enqueue, not to validate world-readiness (Session Runtime gates that).
- Reset with no existing prep → idempotent no-op (`200`).
- **Reset while a prep job is mid-run (accepted window):** since the trigger is always-enqueue with no `getJob` pre-check, a reset (delete row + resetStage) immediately followed by a re-trigger, *while* the `sp-<id>-<n>` job is still active, dedupes the re-`add()` against the in-flight job — so the re-trigger silently no-ops and the in-flight job's result stands. This is an accepted low-probability window (session-prep is owner-triggered + low-volume, and the in-flight job still produces a valid prep); we do NOT add a `getJob`/`remove` guard for it now (`SessionPrepQueueLike` stays `add`-only). If it ever matters, the fix is to mirror world-gen's `getJob`-then-409 defense (`campaigns.ts` resume path).
- Read with a `prepId` not belonging to the campaign → `404 prep_not_found` (don't distinguish "wrong campaign" from "absent" — avoids cross-campaign existence leaks).
- Missing `sessionPrepQueue` dep (shouldn't happen in a real boot) → `500` via the dep guard, mirroring `requireCreateRouteDeps`.
- **Enforced-ignorance operational invariants** (there is no Fastify-schema safety net — see §5): (a) the trigger (202) and reset (200) responses are **metadata-only** — they never echo a prep projection (safe or otherwise); (b) route handlers **never** put a prep row, `ftContext`, or `sdPlaybook` into an `Error` message or any 4xx/5xx body (the global handler serializes the error verbatim); (c) route handlers **log `id`/`sessionNumber` only** — never the row or its prose (the read/list handlers pull full rows incl. `sd_playbook` into memory, so a stray `request.log.info({ prep })` would write the secret to logs; mirror the processor's existing id-only logging discipline).

## 10. Testing (TDD)

- **Repo** (real-Postgres): `listFor` (ordered, empty), `getById` (hit/miss), `deleteFor` (removes the row, idempotent); `pipelineRuns.resetStage` (coerces `completed`→`pending`, idempotent on no row) + a round-trip: insert prep + complete stage → reset → `atomicClaimStage` re-arms (claim is not `completed`).
- **Routes** (real-Postgres + a `sessionPrepQueue` spy):
  - trigger: owner enqueues with jobId `sp-<id>-<n>` → 202; non-owner member → 403; non-member → 403; default sessionNumber=1.
  - list: member → 200 ordered `SafeSessionPrep[]`; **no `sdPlaybook` in the body** (seed a row with a secret sentinel, assert absent).
  - read: member → 200 `SafeSessionPrep` (no `sdPlaybook`); 404 for absent / wrong-campaign prepId.
  - reset: owner deletes + resets stage (assert the row is gone AND a subsequent trigger's claim re-arms); non-owner → 403; no-prep → 200 no-op.
  - **Enforced-ignorance assertion** (explicit, two-pronged): across list + read, the serialized response (a) never contains the seeded `sd_playbook` sentinel string, AND (b) has **exactly** the five `SafeSessionPrep` keys (`Object.keys(body).sort()` equals `['createdAt','ftContext','id','sessionNumber','snapshotId']`) — so a future `{...row}` spread regression adding `sdPlaybook` (even `null`, no sentinel) is caught structurally.
- **Producer wiring:** the trigger route, built the way `app.ts` builds it, enqueues onto the injected queue.
- **Dev-tool:** the 4 panels reach their `data-state` markers (`dev-tool:verify`); `dev-tool:check` green with the 4 routes covered by panels.
- **Smoke seam:** the real-LLM E2E (trigger → generate → list/read) is MYT-64; wire the seam, don't run it here.

## 11. References

- `backend/src/routes/campaigns.ts` (`WorldGenQueueLike` ≈L60, `requireCreateRouteDeps` ≈L163, the `POST /api/campaigns` enqueue ≈L537, `world-snapshot` owner-gating ≈L629/L660, rate-limit blocks).
- `backend/src/app-deps.ts` (`worldGenQueue`), `backend/src/server.ts` (`buildWorldGenQueue` ≈L107, `buildSessionPrepQueue` ≈L275, the `buildApp` call ≈L521), `backend/src/app.ts` (plugin registration ≈L316).
- `backend/src/auth/access-control.ts` (`requireCampaignMember(repo, role?)` ≈L49).
- `backend/src/repo/session-preps.ts` (`insert`/`existsFor`/`getBy`), `backend/src/repo/pipeline-runs.ts` (`atomicClaimStage`/`markStageCompleted`; `insertCharacterConceptSeedRow` reset-SQL precedent ≈L456), `backend/src/repo/types.ts` (`SessionPrepRow` ≈L344).
- `backend/src/contract/backend-routes.ts`, `backend/dev-tool/coverage.json`, `backend/dev-tool/verify-registry.ts`.
- Parked-route source: `docs/specs/2026-04-13-world-campaign-pipeline.md` §9 "API Routes" (≈L669).
- Enforced-ignorance precedent: MYT-62's `ProseEvent` quarantine; `world-snapshot-view.ts` tier projection (the pattern we DON'T fully adopt — §5).
