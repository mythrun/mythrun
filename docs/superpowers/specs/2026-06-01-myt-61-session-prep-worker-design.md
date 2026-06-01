# Session Prep — Worker Wiring + Persistence + Cost Recording + Resume (MYT-61) — Design

**Date:** 2026-06-01
**Linear:** MYT-61 (milestone: Session Prep Pipeline)
**Status:** design approved; pending implementation plan
**Depends on:** MYT-59 (`generateSessionPrep`, shipped). **Related:** MYT-62 (dev-tool driver), MYT-63 (trigger route), Session Runtime (`/start` invocation).

---

## 1. Overview

Wire MYT-59's `generateSessionPrep(repo, { campaignId, worldId, sessionNumber }) → { ft_context, sd_playbook, usage }` into the existing BullMQ worker (MYT-49), persist the result into `session_preps`, record the per-prep cost in `pipeline_runs`, and make the job **idempotent / resumable** keyed on `(campaign_id, session_number)`.

There is **no leak guard** — MYT-60 was descoped (see MYT-59 spec §7). MYT-61 wires the bare `generateSessionPrep`.

## 2. Scope boundary

**MYT-61 delivers:** the `session-prep` BullMQ job + processor, the `session_preps` UNIQUE constraint migration, the `repo.sessionPreps` binder, cost recording in `pipeline_runs`, and the dev-tool coverage entry.

**Out of scope (siblings):** the trigger route `POST /api/campaigns/:id/session-prep` → **MYT-63**; the dev-tool live-events driver + `prep-status` SSE → **MYT-62**; the `/start` invocation + "prep exists for next session" precondition → **Session Runtime**; the real-LLM E2E smoke → **MYT-64**. For MYT-61, the job is enqueued directly (by tests).

## 3. Job + payload

Add `'session-prep'` to `PIPELINE_JOBS` (`src/contract/pipeline-jobs.ts`). Job payload: **`{ campaignId: string; sessionNumber: number }`** — the processor resolves `worldId` from the campaign (`repo.campaigns.getWorldId`/`getWorldAndSituationIndex`), single source of truth (matches the serializer). Enqueued onto the existing pipeline queue (reuse MYT-49 worker infra + `job-context.ts`).

## 4. Processor — `src/llm/prep/session-prep-processor.ts`

Mirrors `character-integration-processor.ts`. Flow:

1. **Resume check (idempotency):** `repo.sessionPreps.existsFor(campaignId, sessionNumber)` → if true, **no-op return** (the prep already exists; nothing to do).
2. Resolve `worldId` from the campaign.
3. Claim/open a `pipeline_runs` row: `stage='session-prep'`, `status='running'`, `campaign_id`, `world_id`.
4. `generateSessionPrep(repo, { campaignId, worldId, sessionNumber })`.
5. **Persist:** `repo.sessionPreps.insert({ campaignId, sessionNumber, ftContext, sdPlaybook, snapshotId: null })` with `ON CONFLICT (campaign_id, session_number) DO NOTHING` (defends a concurrent double-enqueue — the loser no-ops).
6. **Finalize cost:** write the per-tier `cost_usd` (+ `input_tokens`/`output_tokens` if the binder shape carries them) into the `pipeline_runs` row; `status='completed'`.
7. **On generation error:** mark `pipeline_runs` `status='failed'` (+ `error`); leave no `session_preps` row → a BullMQ retry / re-enqueue safely regenerates (idempotency holds via the unique constraint + step-1 existence check).

`snapshot_id` is `null` for session 1 (the snapshot writer is Session-Runtime territory — MYT-59 §8 seam).

## 5. Migration — UNIQUE `(campaign_id, session_number)` on `session_preps`

Today `session_preps` has only the non-unique `idx_session_preps_campaign` (migration 002). Add a new migration creating `UNIQUE (campaign_id, session_number)` (a unique index or table constraint). This is what makes the existence-check + `ON CONFLICT` resume sound and prevents duplicate preps for the same session.

## 6. `repo.sessionPreps` binder (new)

None exists (no inserts happened until this milestone). Add, following the data-layer conventions (canonical binder over `ClientLike`, wired into `repo`/`tx` namespaces, named exports):
- `insert(input: { campaignId; sessionNumber; ftContext; sdPlaybook; snapshotId: string | null }): Promise<void>` — `INSERT … ON CONFLICT (campaign_id, session_number) DO NOTHING`, id via `uuidv7()`.
- `existsFor(campaignId: string, sessionNumber: number): Promise<boolean>`.
- `getBy(campaignId: string, sessionNumber: number): Promise<SessionPrep | null>` (for MYT-63's read routes later; cheap to add now).

## 7. Cost recording (no cap)

The prep's cost is **recorded, not capped** (the structural bound is MYT-59's `maxOutputTokens`; there is no credit debited here to gate or refund). Record it in `pipeline_runs` (`stage='session-prep'`) via the existing `repo.pipeline-runs` binder. The campaign-scoped claim shape records `cost_usd`; if input/output token granularity is wanted, use/extend the shape that carries tokens. **No `session_prep_cost_cap_usd` settings row, no `CostCapExceededError`, no refund** — explicitly unlike world-gen (MYT-51).

## 8. Resume model — no `status` column on `session_preps`

`session_preps` gets **no status column**. Job status (pending/running/completed/failed) lives in the `pipeline_runs` row; the `session_preps` row exists **iff** the prep succeeded. Resume = the step-1 existence check. This is simpler than world-gen's `worlds.status` and correct for a single-call artifact: a failed job leaves no `session_preps` row, so a re-enqueue regenerates cleanly.

## 9. Dev-tool coverage

Adding `'session-prep'` to `PIPELINE_JOBS` triggers the `backend/dev-tool/coverage.json` gate (`verify-registry.test.ts` requires every job have a driver or exempt entry). Add `'session-prep'` as **exempt** (the real dev-tool live-events driver is MYT-62) so `pnpm dev-tool:check` stays green. MYT-62 replaces the exempt entry with the driver.

## 10. Error handling

- **Generation failure** (LLM error/timeout from `generateSessionPrep`) → `pipeline_runs` `failed` + `error`; no `session_preps` row; BullMQ retry re-runs idempotently.
- **Concurrent double-enqueue** → both may pass the existence check; the `ON CONFLICT DO NOTHING` insert makes the second a no-op (no duplicate, no error). The `pipeline_runs` rows are per-attempt (acceptable).
- **Campaign/world missing** → `generateSessionPrep`/the resolver throws (guarded; campaign must be `status='active'` to have a world). Surfaces as a failed run.

## 11. Testing (TDD)

Processor tests (mocked `generateSessionPrep` + real-Postgres repo via `test-scope`):
- **Resume:** a pre-existing `session_preps` row → processor no-ops, `generateSessionPrep` NOT called.
- **Happy path:** no row → `generateSessionPrep` called → `session_preps` row inserted with both docs → `pipeline_runs` row `completed` with `cost_usd` recorded.
- **Generation error:** `generateSessionPrep` throws → `pipeline_runs` `failed`, no `session_preps` row.
- **Double-enqueue / ON CONFLICT:** inserting twice for the same `(campaign, session_number)` keeps one row, no error.
Plus: the migration's unique constraint (migrate-schema test), the `repo.sessionPreps` binder (insert/existsFor/getBy), and the `PIPELINE_JOBS` + `coverage.json` exempt entry (dev-tool registry test passes).

## 12. References

- `src/llm/prep/stages/session-prep.ts` (`generateSessionPrep`, MYT-59), `src/llm/prep/character-integration-processor.ts` (processor pattern to mirror).
- `migrations/001_initial_schema.sql:322` (`session_preps`), `:286` (`pipeline_runs`); `migrations/002_indexes.sql:23` (the non-unique campaign index).
- `src/repo/pipeline-runs.ts` (cost-recording binder), `src/repo/index.ts` (`Repo` type, binder wiring), `src/contract/pipeline-jobs.ts` (`PIPELINE_JOBS`).
- `backend/dev-tool/coverage.json` + `dev-tool/__tests__/verify-registry.test.ts` (the coverage gate).
- NOT used: `src/llm/prep/cost-cap.ts` (world-gen cap — deliberately not mirrored; see §7).
