# MYT-74b — Post-Session Analysis + Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** turn "the session is over" into a live FT farewell plus a durable, compact record (summary + emerging threads + a structured handoff with verbatim NPC-voice excerpts) that lets the next session's prep open exactly where this one left off — with NPC characterization preserved across the gap.

**Architecture:** The 74a `endSession` is re-shaped from "finalize inline" to "begin ending → enqueue a player-less **farewell turn**." The turn worker renders the farewell (silent-consume direction seam) and, in its `finally`/terminal path, runs the **unconditional finalize** (flip `status='ended'`, enqueue reconcile + a new `session-analysis` job, broadcast `session_end`); a `QueueEvents` backstop covers the `maxStalledCount` terminal. The `session-analysis` worker (Opus, off the hot path) reads the transcript tail + `sd_playbook` + the Redis running summary, emits `{summary, emergingThreads, handoff}`, mechanically verifies every verbatim excerpt against non-correction/farewell transcript rows, and persists to the session row. The next prep consumes the handoff: prior summaries + the handoff anchor feed the prep prompt, and the verbatim NPC voice + location atmosphere are **deterministically concatenated onto `ft_context` after generation** (never paraphrased through the prep LLM).

**Tech Stack:** Node 24 + TS strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Postgres, Redis + BullMQ, Anthropic via `llm/ai.ts` (`generateObject` + repair + `redactRawText`), Zod, prompts as `.txt` via `loadPrompt('session', name, vars)`. Spec: `docs/superpowers/specs/2026-06-17-myt-74b-post-session-analysis-handoff-design.md`.

---

## Context primer (cross-cutting invariants every implementer needs)

Read this even if your task is one file.

1. **The end flow (the re-shape).** A session ends (player `end_session` frame, already wired in 74a's WS route → `endSession`; OR the budget-100% auto-end in the turn worker → `endSession`). The NEW `endSession` does NOT finalize: it claims the once-only `ending` flag (SET-NX), `cancelSuspend`s, and **enqueues a player-less `farewell` turn** (`jobId = farewell-{sessionId}`). The turn worker renders the farewell, then in its `finally`/terminal path runs **`finalizeEndedSession`** (flip `status='ended'` + `ended_at`, `enqueueReconcile` + **`enqueuePostSessionAnalysis`**, broadcast `session_end`). **The finalize runs whether or not the farewell render succeeds** — it is the load-bearing fix for the Eddystone-C1 showstopper (a thrown/timed-out farewell must never leave a session permanently un-ended). A `QueueEvents('session-turn')` backstop finalizes a farewell that terminally failed via `maxStalledCount` (no `'failed'` JS event fires there).

2. **The farewell is a player-less turn — exactly the MYT-73 correction pattern.** `endSession` runs in BOTH the API server (no FastThinker) and the turn worker (budget auto-end), so the farewell CANNOT be a synchronous FT render inside `endSession`. It is enqueued as a turn with `trigger.kind: 'farewell'` and rendered by the turn worker (where the FT lives). A `farewell` joins `correction` under a shared **`isPlayerless`** predicate that gates: no watermark advance (fresh-run AND converge arms), no budget auto-end re-trigger, no Scribe/working-set enqueue. UNLIKE correction (the open `[[DM CORRECTION:]]` marker), the farewell uses the **silent-consume `[DM direction: …]` seam** — it is consumed silently and rendered in the FT's own voice.

3. **Idempotency is structural, on every surface.** `finalizeEndedSession` is called from up to two places per terminal turn (the happy `finally` and the `QueueEvents` backstop) → it MUST be idempotent: `sessions.markEnded` is a conditional flip (`WHERE status <> 'ended'`, returns rowCount) so the `session_end` broadcast fires exactly once; `enqueueReconcile`/`enqueuePostSessionAnalysis` use per-session `jobId`s so a re-enqueue collapses at the broker. The analysis worker's write is a conditional gate (`UPDATE … WHERE summary IS NULL`). The `ending` flag (SET-NX) makes the explicit-frame-vs-budget race produce exactly one farewell.

4. **`trigger.kind` on transcript rows (migration 028 — the security boundary).** The voice-excerpt selection must STRUCTURALLY exclude `correction`/`farewell` rows (a MYT-73 retcon line re-injected into `ft_context` hands the FT a pointer to the secret the retcon buried — the Fastnet/Pharos-C1 showstopper). The `[[DM CORRECTION:]]` marker does NOT survive into persisted `content`, and `message_type` is the row KIND (`dm_text`/`player_message`/…), not the trigger — so there is no way to derive a row's trigger from existing columns. Migration 028 adds `session_messages.trigger_kind TEXT` (NULL for player + pre-migration rows). It is threaded `appendDmTurn(triggerKind)` ← `SessionController.triggerKind` ← the turn worker's `job.data.trigger.kind`. The analysis reads it per-row; the **containment verifier** filters on it. This is a hard boundary, not a heuristic.

5. **Enforced ignorance — two structural defenses + a log-surface rule.** The analysis Opus call holds the `sd_playbook` + the (secret-adjacent) running summary, so `redactRawText: true`. But `redactRawText` covers ONLY the raw/repair channel — NOT the validated output and NOT the worker's own logs. So: the worker NEVER logs `summary`/`handoff`/excerpt content; every diagnostic payload is STRUCTURAL-ONLY (counts, ids, the reason). The verbatim voice/atmosphere excerpts are secret-free **enforced structurally, not "by construction"**: (a) **source exclusion** — the containment verifier ignores `correction`/`farewell` rows (§4); (b) **containment verification** — every emitted `voice[]`/`atmosphere` string is mechanically confirmed to appear (normalized) in a NON-excluded transcript row before storage/injection; a non-locatable excerpt is dropped + warned (handles a fabricated or altered "verbatim" quote too). `repairAttempted === true` voids the verbatim guarantee (a repair model may rewrite `voice[]`), so the verifier re-runs over the (possibly repaired) output unconditionally — it always runs.

6. **Verbatim end-to-end; no summarizing step.** Extract verbatim (the analysis quotes, never paraphrases) → store verbatim (handoff JSON) → **inject verbatim into the next `ft_context` by deterministic concatenation in the prep PROCESSOR** (a fixed "Returning characters / places" section appended to `result.ft_context` AFTER generation + Zod validation, BEFORE `sessionPreps.insert`) → the FT reads `ft_context` unchanged each turn. The voice excerpts AND the location atmosphere snippets both ride this deterministic seam — NEITHER goes through the paraphrasing prep prompt. Only the NPC `state` + the prior summaries are digestible prep-prompt input.

7. **Storage (no schema change beyond 028).** `summary` → `sessions.summary` (TEXT) holding `JSON.stringify({summary, emergingThreads})` — `emergingThreads` is SECRET-FREE and stored WITH the summary, NOT in the secret-aware `handoff` blob. `handoff` → `sessions.handoff` (TEXT) holding `JSON.stringify(SessionHandoff)` — documented **prep-only / secret-cleared**. Read side: `safeParse`; a malformed/legacy value degrades to "no handoff"/"no summary" (never throws mid-prep), same tolerance as a null running summary.

8. **Exact contracts (current `main`, verified):**
   - `session_messages` columns: `id, session_id, seq, user_id, message_type TEXT, content TEXT, created_at, turn_id UUID, turn_ordinal SMALLINT`. NO `trigger_kind` yet (T1 adds it). Migration counter at **027**; next is **028**. The migration runner auto-discovers `migrations/*.sql`, wraps each in a tx (NO `BEGIN`/`COMMIT` in the file). Backend tests target `mythrun_test`; run `pnpm db:migrate:test` after T1.
   - `appendDmTurn({sessionId, turnId, rows:{kind,content}[], seqs})` writes `message_type=row.kind` via ONE multi-VALUES INSERT, `ON CONFLICT (turn_id, turn_ordinal) … DO NOTHING`. The single-row `append(...)` (player rows) is a separate method — it leaves `trigger_kind` NULL.
   - `SessionController`: `persistTurn()` calls `this.deps.transcript.appendDmTurn({sessionId, turnId, rows, seqs})`. `SessionControllerDeps` carries worker-resolved deps (`pendingDirection?`, `standingDirective?`, …). `TranscriptStore.appendDmTurn` is the narrow type.
   - `TurnJobPayload`: `{campaignId, sessionId, turnId, triggerMessages, maxConsumedSeq, trigger:{kind:'explicit'|'solo'|'auto'|'correction', classification?}, correctionText?}`. `enqueueTurn(queue, payload)` adds NO jobId. The correction turn (turn-worker.ts:405) sets `pendingDirection = '[[DM CORRECTION: <Z>]]'`; the silent-consume seam is the raw direction text (the controller/FT-prompt wraps `[DM direction: …]`).
   - turn-worker.ts: `processTurnJob` computes `isCorrection` at the fresh-run arm (line ~405); the converge branch (line ~338→340) calls `setRespondedSeq` UNCONDITIONALLY; the fresh-run watermark/budget/scribe arms gate on `!isCorrection` (lines ~486/510/527); the `finally` (lines ~555-605) runs on every path (heartbeat clear → lock release → `clearResponding` → explicit-drain enqueue → post-turn re-mature). The budget auto-end (lines ~510-520) calls `deps.endSession({campaignId, sessionId, worldId})`. `worldId` is resolved only in the fresh-run arm (line ~424) via `resolveWorldId({sessionState, repo}, campaignId, sessionId)` (blob-cached, re-callable). The `worker.on('failed')` listener (lines ~842-854) publishes the terminal `turn_error` (attempts-exhaustion ONLY).
   - `session-turn-queue-events.ts`: `buildSessionTurnQueueEvents(redisBatch, redisRealtime, redisKeyPrefix, logger)` subscribes `QueueEvents('session-turn')`'s broker `failed` stream; `handleFailed(jobId)` fetches the job (`Job.fromId`) and publishes the terminal `turn_error`. This is THE surface that sees the `maxStalledCount` terminal.
   - `session-end.ts` (74a): `endSession(deps, {campaignId, sessionId, worldId})` — `EndSessionDeps = {sessionState:{tryMarkEnding,isEnding}, suspendQueue, reconcileQueue, lock, sessions:{update,getById}, publish, logger}`. It flips status + enqueues reconcile + broadcasts inline today (this plan moves all three out).
   - `session-reconcile.ts`: `buildReconcileWorker(redisBatch, redisRealtime, redisKeyPrefix, pool, embedder, logger)`; `enqueueReconcile(queue, {campaignId, sessionId, worldId})` with `jobId=reconcile-${sessionId}`; `ReconcileQueueLike = {add}`. The MODEL for the analysis worker (concurrency 1, lockDuration 180s, maxStalledCount 1).
   - `makeSessionState(redis, keyPrefix)`: `loadTurnState(campaignId) → {summary, usage}` reads the Redis `:summary` key (the ST running summary; `setRunningSummary` is its only writer). `tryMarkEnding`/`isEnding` (SET-NX `:ending`, ~1h TTL). `triggerState.respondedSeq(campaignId)` returns the current watermark.
   - `repo.sessions`: `getById`, `getMostRecentByCampaign`, `markReconciled` (conditional), `update(id, {status?, endedAt?, summary?, stRunningSummary?, handoff?})` (COALESCE). `Session` has `sessionNumber, status:'active'|'ended'|'crashed', endedAt, summary:string|null, stRunningSummary, handoff:string|null, reconciledAt`.
   - `repo.sessionPreps.getBy(campaignId, sessionNumber) → {sdPlaybook, ftContext, …} | null`. `repo.characters.listSessionParticipantCharacters(sessionId) → {userId, name}[]`.
   - `generateSessionPrep(repo, {campaignId, worldId, sessionNumber, onProseDelta?}) → {ft_context, sd_playbook, usage}` (uses `streamObject`; calls `serializeWorldStateForPrep(repo, {campaignId, sessionNumber})` with NO priorSessionContext today). `processSessionPrepJob` payload `{campaignId, sessionNumber}`; the seam is between `generateSessionPrep` (line 119) and `repo.sessionPreps.insert({campaignId, sessionNumber, ftContext: result.ft_context, sdPlaybook: result.sd_playbook})` (lines 129-134).
   - `serializeWorldStateForPrep`: `PriorSessionContext = {previousSummaries: readonly string[]}`; the render block is lines 92-96 (`## Prior Sessions`); never populated today. `SerializeArgs.priorSessionContext?`.
   - `server-queues.ts`: `buildSessionReconcileQueue(redisBatch)` → `{bullmqQueue, sessionReconcileQueue}` (`attempts:5`, exp backoff 30s, `removeOnComplete/removeOnFail: true`). The MODEL for `buildSessionAnalysisQueue`.
   - `generateObject({model, schema, schemaName, prompt, callSite, repairStrategy, timeoutMs, maxOutputTokens, redactRawText, abortSignal?}) → {output, usage, repairAttempted}`. `OPUS` from `llm/models.js` (never hardcode ids).
   - `worker.ts`: builds each worker, registers in the health `workers[]`, the `worker.started` queues log, and a `closeWithDeadline` per worker in shutdown; the `sessionTurnEvents` subscriber has its own `.close()`.

9. **Verification discipline.** `pnpm --filter @mythrun/backend typecheck` is authoritative over injected diagnostics. Verify lint via `pnpm --filter @mythrun/backend lint` (= `eslint src`), NOT per-file. Scoped coverage during iteration: `pnpm vitest run <test> --coverage --coverage.include='<src>'`. 100% coverage gate at the pre-push. Tests use scoped fixtures (`createTestPool`/`makeTestScope`/`cleanupTestScope`/`guardTestDatabase`) against real PG → `mythrun_test`; ioredis-mock for Redis; LLM boundary mocked by stubbing the wrapper module (`runPostSessionAnalysis`), not `'ai'`.

---

## File map / wave table

| Task | Files | Wave | Deps |
|---|---|---|---|
| T1 migration 028 (trigger_kind) | `migrations/028_session_messages_trigger_kind.sql` | A | — |
| T2 analysis schema + handoff types | `llm/schemas/post-session-analysis.ts` | A | — |
| T3 farewell trigger kind + payload + enqueue | `session/turn-queue.ts` | A | — |
| T4 start-guard: 409 session_ending | `routes/sessions.ts` | A | — |
| T5 analysis Opus call + prompt | `llm/post-session-analysis.ts` + `prompts/session/post-session-analysis.txt` | B | T2 |
| T6 containment verifier (pure) | `session/analysis/containment.ts` | B | T2 |
| T7 sessions repo: markEnded + writeAnalysis + getPriorContextForPrep | `repo/sessions.ts` | B | T1,T2 |
| T8 transcript repo + controller triggerKind thread | `repo/session-messages.ts`, `repo/mappers.ts`, `repo/types.ts`, `session/session-controller.ts` | B | T1 |
| T9 analysis worker (queue + processor + builder) | `session/post-session-analysis.ts` | C | T5,T6,T7,T8 |
| T10 prep consumption (serialize + stage + processor + helper) | `llm/prep/serialize-world-state-for-prep.ts`, `llm/prep/stages/session-prep.ts`, `llm/prep/prior-session-context.ts`, `llm/prep/session-prep-processor.ts` | C | T2,T7 |
| T11 session-end re-shape: endSession + finalizeEndedSession | `session/session-end.ts` | D | T3,T7,T9 |
| T12 turn-worker: farewell render + isPlayerless gates + unconditional finalize | `session/turn-worker.ts` | E | T8,T11 |
| T13 QueueEvents backstop finalize | `session/session-turn-queue-events.ts` | E | T11 |
| T14 worker + queue wiring | `worker.ts`, `server-queues.ts` | F | T9,T11,T13 |
| T15 controller: leak-matrix + real-LLM smoke + sweep + wiki + push + Linear | `session/__tests__/analysis-leak.test.ts`, `scripts/smoke/myt-74b-analysis-smoke.ts` | G | all |

**Wave A** (T1-T4): parallel-safe (disjoint files). After T1: `pnpm db:migrate:test`.
**Wave B** (T5-T8): parallel-safe after A (disjoint files; T5/T6 need T2, T7 needs T1+T2, T8 needs T1).
**Wave C** (T9, T10): parallel-safe (disjoint files).
**Wave D** (T11): single task.
**Wave E** (T12, T13): parallel-safe (disjoint files; both need T11).
**Wave F** (T14): single task (wires the worker + queue + the backstop's finalize closure).
**Wave G** (T15): controller-run.

The analysis engine lives in a new `session/analysis/` dir + a thin `session/post-session-analysis.ts` worker (mirrors `session/reconcile/` + `session/session-reconcile.ts`). The prep prior-context parse lives in a small pure `llm/prep/prior-session-context.ts` so it is testable in isolation.

---

## T1 — Migration 028: session_messages.trigger_kind

**Files:** Create `backend/migrations/028_session_messages_trigger_kind.sql`; Test `backend/src/db/__tests__/migration-028.test.ts`.

- [ ] **Write the migration:**
```sql
-- 028_session_messages_trigger_kind.sql — MYT-74b §5
-- The originating turn trigger kind on each DM-authored row, so the post-session
-- analysis can STRUCTURALLY exclude correction/farewell rows from NPC voice-excerpt
-- selection. This is an enforced-ignorance boundary: a MYT-73 retcon line (or a
-- farewell wind-down line) re-injected into the next session's ft_context would hand
-- the FastThinker a pointer to the secret the retcon spent an Opus call to bury. The
-- [[DM CORRECTION:]] marker does NOT survive into persisted content, and message_type
-- is the row KIND (dm_text/player_message/…) not the trigger, so neither is derivable —
-- the trigger kind must be recorded explicitly.
--
-- NULL for player rows (the single-row append path) + all pre-migration rows. The
-- CHECK pins the closed set of turn-trigger kinds (co-evolves with TurnJobPayload.trigger.kind).
ALTER TABLE session_messages
  ADD COLUMN trigger_kind TEXT
    CHECK (trigger_kind IS NULL OR trigger_kind IN ('explicit', 'solo', 'auto', 'correction', 'farewell'));
```
- [ ] **Write the test** `migration-028.test.ts` (real PG, scoped): after migrate, `session_messages` has a `trigger_kind` column (query `information_schema.columns`); inserting a row with `trigger_kind='farewell'` succeeds; inserting `trigger_kind='bogus'` raises a `23514` check-violation; `trigger_kind` defaults to NULL on an insert that omits it.
- [ ] **Run:** `pnpm db:migrate:test` (applies 028 to `mythrun_test`), then `pnpm vitest run src/db/__tests__/migration-028.test.ts`. Expected: PASS.
- [ ] **Commit:** `feat(MYT-74b): migration 028 — session_messages.trigger_kind (T1)`

---

## T2 — The analysis schema + SessionHandoff types

**Files:** Create `backend/src/llm/schemas/post-session-analysis.ts`; Test `backend/src/llm/schemas/__tests__/post-session-analysis.test.ts`.

Flat root, `.min(1)` floors on prose, **no `.max()` on string content** (free prose — voice excerpts + summary). Array-length `.max()` IS used (and wanted) on the verbatim-injected arrays so the `ft_context` section can't bloat the FT's static budget (§3).

- [ ] **Write the schema:**
```ts
import { z } from 'zod'

/** A major NPC's cross-session continuity record. `state` is model-authored
 *  disposition (feeds the prep PROMPT, paraphrasable). `voice` is ≈2 VERBATIM
 *  late-session relational transcript excerpts (deterministically injected into the
 *  next ft_context, NEVER paraphrased) — array bounded so the injected section is
 *  small; NO .max() on the strings themselves. */
export const NpcHandoffSchema = z.object({
  name: z.string().min(1),
  state: z.string().min(1),
  voice: z.array(z.string().min(1)).max(4),
})

export const PartyMemberHandoffSchema = z.object({
  characterName: z.string().min(1),
  location: z.string().min(1),
  condition: z.string().min(1),
})

export const KeyLocationHandoffSchema = z.object({
  name: z.string().min(1),
  atmosphere: z.string().min(1), // verbatim sensory snippet; deterministically injected
})

export const SessionHandoffSchema = z.object({
  party: z.array(PartyMemberHandoffSchema),
  timeOfDay: z.string().min(1),
  unresolvedThreads: z.array(z.string().min(1)),
  npcs: z.array(NpcHandoffSchema).max(8),
  keyLocations: z.array(KeyLocationHandoffSchema).max(8),
})

/** The Opus call's structured output. `summary`/`emergingThreads` are SECRET-FREE
 *  (player-witnessed only — a prompt-enforced quality property); `handoff` MAY be
 *  secret-aware (prep-only). */
export const PostSessionAnalysisSchema = z.object({
  summary: z.string().min(1),
  emergingThreads: z.array(z.string().min(1)),
  handoff: SessionHandoffSchema,
})

export type NpcHandoff = z.infer<typeof NpcHandoffSchema>
export type SessionHandoff = z.infer<typeof SessionHandoffSchema>
export type PostSessionAnalysis = z.infer<typeof PostSessionAnalysisSchema>
```
- [ ] **Write the test:** accepts a full valid object (one party member, two unresolved threads, one NPC with two voice excerpts, one keyLocation); accepts empty arrays for `party`/`emergingThreads`/`npcs`/`keyLocations`; rejects an `npcs` array of length 9 (the `.max(8)` arm); rejects a `voice` array of length 5; rejects an empty-string `summary`; a 4000-char `summary` parses (NO string `.max`); a stray extra key on `handoff` is stripped (`.parse` drops it).
- [ ] **Run:** `pnpm vitest run src/llm/schemas/__tests__/post-session-analysis.test.ts`; `pnpm --filter @mythrun/backend typecheck`. PASS.
- [ ] **Commit:** `feat(MYT-74b): post-session-analysis schema + SessionHandoff types (T2)`

---

## T3 — farewell trigger kind + payload + enqueue

**Files:** Modify `backend/src/session/turn-queue.ts`; Test `backend/src/session/__tests__/turn-queue.test.ts` (extend, or create if absent).

- [ ] **Write the failing test:** `enqueueFarewellTurn(queue, payload)` calls `queue.add('turn', payload, { jobId: 'farewell-<sessionId>' })` (assert the jobId via a recording fake `add`); a payload with `trigger.kind: 'farewell'` + `farewellText` + `worldId` type-checks; `FAREWELL_DIRECTION` is a non-empty string.
- [ ] **Implement** — add `'farewell'` to the union, the two optional payload fields, the constant, and the enqueue:
```ts
  readonly trigger: {
    readonly kind: 'explicit' | 'solo' | 'auto' | 'correction' | 'farewell'
    readonly classification?: {
      readonly intent: 'reactive' | 'proactive'
      readonly complexity: 'low' | 'high'
      readonly confidence: number
    }
  }
  // … existing correctionText? stays …
  /** MYT-74b §1 — the silent-consume direction the FT delivers on a `farewell`
   *  turn (the end-of-session send-off). Present ONLY on a farewell turn; the
   *  worker fuses it via the SINGLE-bracket `[DM direction: …]` seam (NOT the
   *  open `[[DM CORRECTION:]]` marker) — consumed silently, rendered in the FT's
   *  own voice. A farewell carries `triggerMessages: []` and a `maxConsumedSeq`
   *  equal to the current responded watermark (player-less — it must not advance
   *  past unresponded player seqs). */
  readonly farewellText?: string
  /** MYT-74b §1 — the campaign's world id, carried on the FAREWELL payload so the
   *  turn worker's finally (and the QueueEvents backstop) can run the finalize
   *  (enqueue reconcile, which needs worldId) WITHOUT re-resolving it. Present
   *  only on a farewell turn; normal turns resolve worldId in their fresh-run arm. */
  readonly worldId?: string
```
```ts
/** MYT-74b §1.2 — the fixed farewell direction. ZFC: the send-off is a static
 *  cue; the FT authors the prose. Silent-consume (single bracket), so the FT
 *  renders it in its own voice rather than quoting a marker. */
export const FAREWELL_DIRECTION =
  'The session is winding down. Bring the scene to a natural close: narrate where ' +
  'each character ends up and give the table a quiet moment of closure. Do not start ' +
  'new threads or introduce new conflict.'

/** Enqueue ONE player-less farewell turn. `jobId` is per-session
 *  (`farewell-${sessionId}`) — a broker-level dedup backstop beyond the `ending`
 *  flag, so an explicit-end / budget-end race that slips the flag still collapses
 *  to one farewell. */
export function enqueueFarewellTurn(queue: TurnQueueLike, payload: TurnJobPayload): Promise<unknown> {
  return queue.add(TURN_JOB_NAME, payload, { jobId: `farewell-${payload.sessionId}` })
}
```
- [ ] **Run:** `pnpm vitest run src/session/__tests__/turn-queue.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74b): farewell trigger kind + payload + enqueueFarewellTurn (T3)`

---

## T4 — Start-guard: 409 session_ending

**Files:** Modify `backend/src/routes/sessions.ts`; Test extend `backend/src/routes/__tests__/sessions.test.ts`.

The status flip now lands at finalize (after the farewell render), so during the render the most-recent session is still `status='active'` with `endedAt IS NULL` — the 74a `reconcile_pending` interlock (keys on `endedAt`) does NOT catch it. The `ending` flag closes that window (§1 Interlock window C3): a `/start` while `ending` is set returns `409 session_ending`.

- [ ] **Write the failing test:** `POST /:campaignId/start` returns `409 { code: 'session_ending' }` when `sessionState.isEnding(campaignId)` is true (inject a fake/seed the Redis `:ending` flag), even though no row is yet `ended`. When `isEnding` is false the existing path runs (no regression to the `reconcile_pending` / success cases).
- [ ] **Implement:** in `handleSessionStart`, immediately AFTER the existing `reconcile_pending` interlock (line ~279) — so the strict ordering is `campaign_not_active → prep_not_ready → session_already_active → reconcile_pending → session_ending`:
```ts
  // Precondition 5 (MYT-74b §1 C3): a session-end is in progress. The status flip
  // lands at finalize (AFTER the farewell render), so during the render the row is
  // still 'active' with ended_at NULL — the reconcile_pending interlock can't see
  // it. The `ending` flag (SET-NX, ~1h TTL) fences this window: a new /start must
  // wait until the farewell renders + the finalize flips + reconcile clears.
  if (await sessionState.isEnding(campaignId)) {
    return reply.code(409).send({ code: 'session_ending' })
  }
```
Wire `sessionState` into `handleSessionStart` if it is not already in scope (the route already constructs `makeSessionState` for `resetSessionSpend` on `/start` — reuse that instance; verify the exact variable name in `routes/sessions.ts` and thread it like the other deps). The code string is a plain literal (like `reconcile_pending`) — no contract-union change.
- [ ] **Run:** `pnpm vitest run src/routes/__tests__/sessions.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74b): 409 session_ending start-guard (T4)`

---

## T5 — The analysis Opus call + prompt

**Files:** Create `backend/src/llm/post-session-analysis.ts`; Create `backend/src/llm/prompts/session/post-session-analysis.txt`; Test `backend/src/llm/__tests__/post-session-analysis.test.ts`.

- [ ] **Write the prompt** `post-session-analysis.txt` (placeholders `{{transcript}}`, `{{runningSummary}}`, `{{sdPlaybook}}`, `{{participants}}`). It must instruct (the §6 rules):
  - You are the post-session analyst. Produce THREE things: a `summary`, `emergingThreads`, and a `handoff`.
  - `summary` (2-4 sentences) + `emergingThreads`: ONLY what the players witnessed this session. NEVER reveal or hint at any secret from the stage-direction playbook or the running summary that the session did not surface to the players.
  - `handoff.party`: each PC's exact end-of-session location + condition. `handoff.timeOfDay`: the in-world time at session end. `handoff.unresolvedThreads`: open threads ranked by urgency.
  - `handoff.npcs` (MAJOR NPCs only, at most ~6): each NPC's current `state` (disposition toward the party) AND a `voice` array of **≈2 VERBATIM transcript excerpts** — quote EXACTLY, never paraphrase, never invent. Choose excerpts that show **how the NPC treats / feels about / acts around the PCs**, preferring **late-session** lines (the relationship as it has EVOLVED). NEVER pick a generic first-impression or stereotype line (e.g. a gruff "coin first, stories after" — that flattens the character and resets development). NEVER quote a `[[DM CORRECTION:]]` retcon line or the farewell wind-down.
  - `handoff.keyLocations` (major locations, at most ~6): a VERBATIM sensory `atmosphere` snippet per location, quoted exactly from the transcript.
  - Emit ONLY the structured object.
- [ ] **Write the failing test** (`vi.mock('./ai.js')` returning a controlled object — mock the wrapper, mirroring the reconciler test):
```ts
import { describe, expect, it, vi } from 'vitest'
import { runPostSessionAnalysis } from '../post-session-analysis.js'

vi.mock('../ai.js', async (orig) => ({
  ...(await orig<typeof import('../ai.js')>()),
  generateObject: vi.fn(),
}))
const ai = await import('../ai.js')
const mock = vi.mocked(ai.generateObject)

it('returns the validated analysis + usage + repairAttempted', async () => {
  const out = {
    summary: 'The party reached the harbor.',
    emergingThreads: ['Who burned the dock?'],
    handoff: { party: [], timeOfDay: 'dusk', unresolvedThreads: [], npcs: [], keyLocations: [] },
  }
  mock.mockResolvedValueOnce({ output: out, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, repairAttempted: false } as never)
  const r = await runPostSessionAnalysis({ transcript: 'T', runningSummary: 'S', sdPlaybook: 'P', participants: 'Aria, Bram' })
  expect(r.result).toEqual(out)
  expect(r.repairAttempted).toBe(false)
})
```
- [ ] **Implement** (mirror `session-reconciler.ts`):
```ts
import { generateObject, type LanguageModelUsage } from './ai.js'
import { OPUS } from './models.js'
import { loadPrompt } from './prompts.js'
import { PostSessionAnalysisSchema, type PostSessionAnalysis } from './schemas/post-session-analysis.js'

// Pinned (§2): an Opus call over a bounded transcript tail is multi-second; the
// worst-case handoff (many NPCs × voice arrays) needs a high output ceiling.
const ANALYSIS_TIMEOUT_MS = 120_000
const ANALYSIS_MAX_OUTPUT_TOKENS = 8_000

export interface PostSessionAnalysisInput {
  readonly transcript: string      // rendered bounded transcript tail (§2 input-size bound)
  readonly runningSummary: string  // the ST running summary ('' when absent)
  readonly sdPlaybook: string      // the prep playbook ('' when absent)
  readonly participants: string    // the PC roster
  readonly abortSignal?: AbortSignal
}
export interface PostSessionAnalysisOutput {
  readonly result: PostSessionAnalysis
  readonly usage: LanguageModelUsage
  readonly repairAttempted: boolean
}
export async function runPostSessionAnalysis(
  input: PostSessionAnalysisInput,
): Promise<PostSessionAnalysisOutput> {
  const r = await generateObject({
    model: OPUS,
    schema: PostSessionAnalysisSchema,
    schemaName: 'PostSessionAnalysisSchema',
    prompt: loadPrompt('session', 'post-session-analysis', {
      transcript: input.transcript,
      runningSummary: input.runningSummary,
      sdPlaybook: input.sdPlaybook,
      participants: input.participants,
    }),
    callSite: 'post-session-analysis',
    repairStrategy: 'sonnet',
    timeoutMs: ANALYSIS_TIMEOUT_MS,
    maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS,
    redactRawText: true,
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
  })
  return { result: r.output, usage: r.usage, repairAttempted: r.repairAttempted }
}
```
- [ ] **Run:** `pnpm vitest run src/llm/__tests__/post-session-analysis.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74b): post-session-analysis Opus call + prompt (T5)`

---

## T6 — The verbatim-containment verifier (pure)

**Files:** Create `backend/src/session/analysis/containment.ts`; Test `backend/src/session/analysis/__tests__/containment.test.ts`.

Pure, no I/O, security-critical (§5). Drops any `voice[]`/`atmosphere` excerpt not provably a verbatim copy of a NON-correction/farewell transcript row, returning the sanitized handoff + STRUCTURAL drop counts (never the dropped content).

- [ ] **Write the failing tests:** a voice excerpt that matches a normal (`triggerKind:'auto'` or NULL) row verbatim is KEPT; an excerpt that matches ONLY a `correction` row is DROPPED (`droppedVoice` increments) — the §5 source-exclusion; a fabricated excerpt matching NO row is DROPPED; whitespace/case differences are tolerated (`'  Coin First.  '` matches a row `'coin first.'`); an empty-string excerpt is dropped (defensive); a keyLocation whose `atmosphere` isn't locatable is removed entirely (`droppedAtmosphere` increments) while a locatable one stays; an NPC keeps its `state` even when all its `voice` excerpts drop (voice → `[]`, npc retained). Assert the result NEVER includes a dropped string.
- [ ] **Implement:**
```ts
import type { SessionHandoff } from '../../llm/schemas/post-session-analysis.js'

/** A transcript row as the verifier needs it: the prose + its originating trigger
 *  kind (NULL for player + pre-028 rows). */
export interface AnalysisTranscriptRow {
  readonly content: string
  readonly triggerKind: string | null
}

/** Rows whose prose must NEVER seed a verbatim excerpt (§5): a MYT-73 retcon
 *  ([[DM CORRECTION:]]) line points at the buried secret; a farewell line is
 *  meta-closure, not characterization. */
const EXCLUDED_TRIGGER_KINDS = new Set(['correction', 'farewell'])

/** Normalize for containment: collapse runs of whitespace + lowercase. The
 *  verbatim guarantee is "this excerpt is a copy of a player-witnessed,
 *  non-correction line" — whitespace/case drift from JSON re-emission is
 *  tolerated; a semantic (non-substring) difference is not. */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

export interface ContainmentResult {
  readonly handoff: SessionHandoff
  readonly droppedVoice: number
  readonly droppedAtmosphere: number
}

/** Mechanically verify every NPC voice excerpt + location atmosphere snippet is a
 *  verbatim substring of a NON-correction/farewell transcript row; drop the rest.
 *  Returns the sanitized handoff + drop COUNTS (structural only — the worker logs
 *  the counts, never the content). */
export function verifyHandoffContainment(
  handoff: SessionHandoff,
  rows: readonly AnalysisTranscriptRow[],
): ContainmentResult {
  const haystack = rows
    .filter((r) => r.triggerKind === null || !EXCLUDED_TRIGGER_KINDS.has(r.triggerKind))
    .map((r) => normalize(r.content))
  const contains = (excerpt: string): boolean => {
    const needle = normalize(excerpt)
    return needle.length > 0 && haystack.some((h) => h.includes(needle))
  }

  let droppedVoice = 0
  const npcs = handoff.npcs.map((npc) => {
    const voice = npc.voice.filter((v) => contains(v))
    droppedVoice += npc.voice.length - voice.length
    return { ...npc, voice }
  })

  let droppedAtmosphere = 0
  const keyLocations = handoff.keyLocations.filter((loc) => {
    const ok = contains(loc.atmosphere)
    if (!ok) droppedAtmosphere += 1
    return ok
  })

  return { handoff: { ...handoff, npcs, keyLocations }, droppedVoice, droppedAtmosphere }
}
```
- [ ] **Run:** `pnpm vitest run src/session/analysis/__tests__/containment.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74b): verbatim-containment verifier — correction/farewell source exclusion (T6)`

---

## T7 — sessions repo: markEnded + writeAnalysis + getPriorContextForPrep

**Files:** Modify `backend/src/repo/sessions.ts`; Test `backend/src/repo/__tests__/sessions-analysis.test.ts`.

- [ ] **Write the failing tests** (real PG, scoped):
  - `markEnded(id)` on an `active` session returns `1` and sets `status='ended'` + `endedAt`; a second `markEnded` returns `0` (the conditional flip — idempotent finalize); `getById` reflects `status='ended'`.
  - `writeAnalysis(id, {summary, emergingThreads, handoff})` on a session with `summary IS NULL` returns `1`; the `summary` column round-trips as `{summary, emergingThreads}` JSON; the `handoff` column round-trips as the `SessionHandoff` JSON; a second `writeAnalysis` returns `0` (the gate); `getById().summary` is the JSON wrapper string.
  - `getPriorContextForPrep(campaignId, 20)` returns ended sessions with a non-null summary, NEWEST first; an `active` (or summary-null) session is excluded; the cap bounds the row count.
- [ ] **Implement on `sessionsNs(c)`** (import `SessionHandoff` from `../llm/schemas/post-session-analysis.js`):
```ts
    /** MYT-74b §1 — conditional end flip for the unconditional finalize. Sets
     *  status='ended' + ended_at=now() only when not already ended, returning the
     *  rowCount (1 first, 0 thereafter). The turn-worker finally AND the QueueEvents
     *  backstop both call this; the 0-on-repeat makes the session_end broadcast
     *  fire exactly once. Separate from the COALESCE `update` so the conditional is
     *  a single statement (no SELECT-then-UPDATE race). */
    markEnded: async (id: string): Promise<number> => {
      const result = await c.query(
        `UPDATE sessions SET status = 'ended', ended_at = now() WHERE id = $1 AND status <> 'ended'`,
        [id],
      )
      return result.rowCount ?? 0
    },

    /** MYT-74b §2/§3 — persist the post-session analysis. CONDITIONAL on
     *  summary IS NULL so a BullMQ retry / concurrent execution is idempotent
     *  (0 rows ⇒ already written). `summary` stores {summary, emergingThreads}
     *  (secret-free) as JSON; `handoff` stores the SessionHandoff JSON
     *  (prep-only / secret-cleared). Returns rowCount (1 on the winning write). */
    writeAnalysis: async (
      id: string,
      input: { summary: string; emergingThreads: readonly string[]; handoff: SessionHandoff },
    ): Promise<number> => {
      const result = await c.query(
        `UPDATE sessions SET summary = $2, handoff = $3 WHERE id = $1 AND summary IS NULL`,
        [
          id,
          JSON.stringify({ summary: input.summary, emergingThreads: input.emergingThreads }),
          JSON.stringify(input.handoff),
        ],
      )
      return result.rowCount ?? 0
    },

    /** MYT-74b §4 — the prep's prior-context read. Returns prior ENDED sessions
     *  with a written analysis (summary IS NOT NULL), NEWEST first, capped to
     *  `limit`. The caller (the prep processor) safeParses each row's summary
     *  wrapper + the latest row's handoff (degrading malformed/legacy to nothing).
     *  NOT reconcile-gated: the handoff is transcript-derived narrative state,
     *  independent of canon commit — the prep consumes it even if reconcile is
     *  still pending. Raw column strings are returned; the processor owns parsing. */
    getPriorContextForPrep: async (
      campaignId: string,
      limit: number,
    ): Promise<readonly { sessionNumber: number; summaryJson: string; handoffJson: string | null }[]> => {
      const result = await c.query<{ session_number: number; summary: string; handoff: string | null }>(
        `SELECT session_number, summary, handoff
           FROM sessions
          WHERE campaign_id = $1 AND status = 'ended' AND summary IS NOT NULL
          ORDER BY session_number DESC
          LIMIT $2`,
        [campaignId, limit],
      )
      return result.rows.map((r) => ({
        sessionNumber: r.session_number,
        summaryJson: r.summary,
        handoffJson: r.handoff,
      }))
    },
```
- [ ] **Run:** `pnpm vitest run src/repo/__tests__/sessions-analysis.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74b): sessions repo — markEnded + writeAnalysis + getPriorContextForPrep (T7)`

---

## T8 — Transcript repo + controller triggerKind thread

**Files:** Modify `backend/src/repo/session-messages.ts`, `backend/src/repo/mappers.ts`, `backend/src/repo/types.ts`, `backend/src/session/session-controller.ts`; Test `backend/src/repo/__tests__/session-messages-analysis.test.ts` + extend `backend/src/session/__tests__/session-controller.test.ts`.

Threads `trigger_kind` end-to-end at the repo+controller layer and adds the analysis transcript read. (The turn worker passes `job.data.trigger.kind` into the controller in T12.)

- [ ] **Write the failing tests:**
  - (`session-messages-analysis.test.ts`, real PG) `appendDmTurn({..., triggerKind:'farewell'})` writes `trigger_kind='farewell'` on every row of the turn; `appendDmTurn` with no `triggerKind` writes NULL; `listForAnalysis(sessionId, 100)` returns rows seq-ASC with `{seq, messageType, content, triggerKind}`, capped to the last N (insert N+5 rows, assert the OLDEST 5 are dropped and order is ascending).
  - (`session-controller.test.ts`) a controller constructed with `triggerKind:'farewell'` passes `triggerKind:'farewell'` into `transcript.appendDmTurn` (assert via a recording fake transcript); a controller with no `triggerKind` omits it (the appendDmTurn call has no `triggerKind` key — exactOptionalPropertyTypes).
- [ ] **Implement:**
  - `repo/types.ts` — add `readonly triggerKind: string | null` to the `SessionMessage` interface.
  - `repo/mappers.ts` `toSessionMessage` — map `triggerKind: row.trigger_kind ?? null` (and add `trigger_kind: string | null` to `SessionMessageDbRow`).
  - `repo/session-messages.ts` — extend `appendDmTurn`'s input + SQL (shared param, like `turn_id`):
```ts
    appendDmTurn: async (input: {
      sessionId: string
      turnId: string
      rows: readonly { kind: string; content: string }[]
      seqs: readonly number[]
      /** MYT-74b §5 — the originating turn trigger kind, written onto every row of
       *  this turn (shared, like turn_id) so the post-session analysis can
       *  structurally exclude correction/farewell rows. Omitted → NULL. */
      triggerKind?: string
    }): Promise<void> => {
      if (input.rows.length !== input.seqs.length) {
        throw new Error(
          `sessionMessages.appendDmTurn: rows/seqs length mismatch (${String(input.rows.length)} vs ${String(input.seqs.length)})`,
        )
      }
      if (input.rows.length === 0) return

      // $1 = session_id, $2 = turn_id, $3 = trigger_kind — all shared across rows.
      const values: unknown[] = [input.sessionId, input.turnId, input.triggerKind ?? null]
      const tuples = input.rows.map((row, i) => {
        const base = values.length
        values.push(uuidv7(), input.seqs[i], row.kind, row.content, i)
        return `($${String(base + 1)}, $1, $${String(base + 2)}, NULL, $${String(base + 3)}, $${String(base + 4)}, $2, $${String(base + 5)}, $3)`
      })

      await c.query(
        `INSERT INTO session_messages
           (id, session_id, seq, user_id, message_type, content, turn_id, turn_ordinal, trigger_kind)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (turn_id, turn_ordinal) WHERE turn_id IS NOT NULL DO NOTHING`,
        values,
      )
    },

    /** MYT-74b §2 — the post-session analysis transcript read: the LAST `limit`
     *  rows in seq-ASC order, projecting the trigger_kind the containment verifier
     *  filters on. Bounds the Opus call's input on the largest (budget-auto-ended)
     *  sessions; the late tail is where voice/affect lives (§D5). */
    listForAnalysis: async (
      sessionId: string,
      limit: number,
    ): Promise<readonly { seq: number; messageType: string; content: string; triggerKind: string | null }[]> => {
      const result = await c.query<{ seq: number; message_type: string; content: string; trigger_kind: string | null }>(
        `SELECT seq, message_type, content, trigger_kind FROM (
           SELECT seq, message_type, content, trigger_kind
             FROM session_messages WHERE session_id = $1
            ORDER BY seq DESC LIMIT $2
         ) sub ORDER BY seq ASC`,
        [sessionId, limit],
      )
      return result.rows.map((r) => ({
        seq: r.seq,
        messageType: r.message_type,
        content: r.content,
        triggerKind: r.trigger_kind,
      }))
    },
```
  - `session/session-controller.ts` — add `readonly triggerKind?: string` to `SessionControllerDeps`; add `triggerKind?: string` to the `TranscriptStore.appendDmTurn` input type; in `persistTurn`, thread it (exactOptionalPropertyTypes-safe spread):
```ts
    await this.deps.transcript.appendDmTurn({
      sessionId: this.sessionId,
      turnId: this.turnId,
      rows,
      seqs,
      ...(this.deps.triggerKind !== undefined ? { triggerKind: this.deps.triggerKind } : {}),
    })
```
- [ ] **Run:** `pnpm vitest run src/repo/__tests__/session-messages-analysis.test.ts src/session/__tests__/session-controller.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74b): session_messages trigger_kind write + listForAnalysis + controller thread (T8)`

---

## T9 — The analysis worker (queue + processor + builder)

**Files:** Create `backend/src/session/post-session-analysis.ts`; Test `backend/src/session/__tests__/post-session-analysis.test.ts`.

Mirrors `session-reconcile.ts`: a queue const + payload + `enqueuePostSessionAnalysis` (jobId dedup) + a narrow repo + `typeof`-injected `runAnalysis`/`verify` + `processPostSessionAnalysisJob` (THROWS on transient → BullMQ retries; idempotent via the gate) + `buildPostSessionAnalysisWorker`.

- [ ] **Write the failing tests** (deps injected; no broker):
  - A job whose session already has `summary` set (fake repo) → early-out, no LLM call, no `listForAnalysis`.
  - A clean job → `listForAnalysis` → `loadTurnState` (running summary) → `runAnalysis` fake returns an analysis whose handoff has one locatable + one fabricated voice excerpt → `verify` drops the fabricated one → `writeAnalysis` receives the SANITIZED handoff (assert the fabricated excerpt is absent) and the `{summary, emergingThreads}`.
  - The structural-only log: drive a drop (`droppedVoice > 0`) → assert the warn payload carries the COUNT, and assert NO `logger` arg contains any voice/summary/handoff content.
  - A missing running-summary key (loadTurnState → `summary:''`) is tolerated (passed as `''`).
  - `runAnalysis` throwing (transient) → `processPostSessionAnalysisJob` rethrows (BullMQ retry).
- [ ] **Implement:**
```ts
// backend/src/session/post-session-analysis.ts
//
// MYT-74b §2 — the POST-SESSION ANALYSIS worker. Off the hot path, enqueued at
// finalize alongside reconcile. Reads ONLY durable inputs (safe after WS close):
// the player-facing transcript tail (with trigger_kind), the prep sd_playbook, and
// the Redis running summary. ONE Opus call → {summary, emergingThreads, handoff};
// the verbatim voice/atmosphere excerpts are mechanically verified against
// non-correction/farewell rows before persistence. NOT total: THROWS on transient
// failure so BullMQ retries (the conditional writeAnalysis gate keeps it idempotent).
//
// ENFORCED IGNORANCE (load-bearing): the call holds the secret playbook + the
// secret-adjacent running summary → redactRawText. The worker NEVER logs the
// summary/handoff/excerpt content; every diagnostic is STRUCTURAL-ONLY (counts/ids).

import { Worker as BullmqWorker, type Job, type Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import type { Pool } from 'pg'

import { createRepo } from '../repo/index.js'
import { makeSessionState, type SessionState } from '../redis/session-state.js'
import { runPostSessionAnalysis } from '../llm/post-session-analysis.js'
import { verifyHandoffContainment, type AnalysisTranscriptRow } from './analysis/containment.js'
import type { SessionHandoff } from '../llm/schemas/post-session-analysis.js'

/** §2 input-size bound: the last N transcript rows feed the Opus call (the late
 *  tail carries the bulk of voice/affect — §D5). Sized so the largest
 *  (budget-auto-ended) session never overflows Opus context. */
const ANALYSIS_TRANSCRIPT_TAIL = 160

/** Worker lock duration ≥ the Opus timeout + headroom (mirrors reconcile). */
const ANALYSIS_LOCK_DURATION_MS = 180_000

interface MinimalLogger {
  info: (o: Record<string, unknown> | string, m?: string) => void
  warn: (o: Record<string, unknown> | string, m?: string) => void
  error: (o: Record<string, unknown> | string, m?: string) => void
}

// ── Queue + producer ────────────────────────────────────────────────────────

export const QUEUE_SESSION_ANALYSIS = 'session-analysis' as const
export const ANALYSIS_JOB_NAME = 'analysis' as const

export interface AnalysisJobPayload {
  readonly campaignId: string
  readonly sessionId: string
}

export interface AnalysisQueueLike {
  add: Queue<AnalysisJobPayload>['add']
}

/** Enqueue ONE post-session analysis. `jobId` is per-session
 *  (`analysis-${sessionId}`) so a double-finalize collapses to one job. */
export function enqueuePostSessionAnalysis(
  queue: AnalysisQueueLike,
  payload: AnalysisJobPayload,
): Promise<unknown> {
  return queue.add(ANALYSIS_JOB_NAME, payload, { jobId: `analysis-${payload.sessionId}` })
}

// ── Processor deps (narrow, injected) ────────────────────────────────────────

export interface AnalysisRepo {
  readonly sessions: {
    getById(id: string): Promise<{ sessionNumber: number; summary: string | null } | null>
    writeAnalysis(
      id: string,
      input: { summary: string; emergingThreads: readonly string[]; handoff: SessionHandoff },
    ): Promise<number>
  }
  readonly sessionPreps: {
    getBy(campaignId: string, sessionNumber: number): Promise<{ sdPlaybook: string } | null>
  }
  readonly sessionMessages: {
    listForAnalysis(
      sessionId: string,
      limit: number,
    ): Promise<readonly { seq: number; messageType: string; content: string; triggerKind: string | null }[]>
  }
  readonly characters: {
    listSessionParticipantCharacters(sessionId: string): Promise<readonly { name: string }[]>
  }
}

export interface AnalysisProcessorDeps {
  readonly repo: AnalysisRepo
  readonly sessionState: Pick<SessionState, 'loadTurnState'>
  runAnalysis: typeof runPostSessionAnalysis
  verify: typeof verifyHandoffContainment
  readonly logger: MinimalLogger
}

/** Render the transcript tail for the prompt: one labeled line per row. */
export function renderTranscriptTail(
  rows: readonly { messageType: string; content: string }[],
): string {
  return rows.map((r) => `[${r.messageType}] ${r.content}`).join('\n')
}

export async function processPostSessionAnalysisJob(
  deps: AnalysisProcessorDeps,
  job: { data: AnalysisJobPayload },
): Promise<void> {
  const { campaignId, sessionId } = job.data

  const session = await deps.repo.sessions.getById(sessionId)
  if (session === null) {
    deps.logger.warn({ sessionId }, 'analysis_session_missing')
    return
  }
  // Idempotent re-entry: a prior execution already wrote the analysis.
  if (session.summary !== null) {
    deps.logger.info({ sessionId, campaignId }, 'analysis_already_done')
    return
  }

  const rows = await deps.repo.sessionMessages.listForAnalysis(sessionId, ANALYSIS_TRANSCRIPT_TAIL)
  const prep = await deps.repo.sessionPreps.getBy(campaignId, session.sessionNumber)
  const sdPlaybook = prep?.sdPlaybook ?? ''
  // The ST running summary lives on the Redis :summary key (NOT the suspend-
  // overloaded st_running_summary column). Missing key → '' (transcript-only).
  const { summary: runningSummary } = await deps.sessionState.loadTurnState(campaignId)
  const participants = await deps.repo.characters.listSessionParticipantCharacters(sessionId)

  const { result } = await deps.runAnalysis({
    transcript: renderTranscriptTail(rows),
    runningSummary,
    sdPlaybook,
    participants: participants.map((p) => p.name).join(', '),
  })

  // §5 — verify EVERY voice/atmosphere excerpt against non-correction/farewell
  // rows (runs unconditionally — repair may have rewritten voice[]). A non-locatable
  // excerpt is dropped; the drop COUNTS are logged, never the content.
  const verifyRows: AnalysisTranscriptRow[] = rows.map((r) => ({ content: r.content, triggerKind: r.triggerKind }))
  const { handoff, droppedVoice, droppedAtmosphere } = deps.verify(result.handoff, verifyRows)
  if (droppedVoice > 0 || droppedAtmosphere > 0) {
    deps.logger.warn(
      { sessionId, campaignId, droppedVoice, droppedAtmosphere },
      'analysis_excerpts_dropped_not_in_transcript',
    )
  }

  const wrote = await deps.repo.sessions.writeAnalysis(sessionId, {
    summary: result.summary,
    emergingThreads: result.emergingThreads,
    handoff,
  })
  deps.logger.info(
    { sessionId, campaignId, wrote, npcs: handoff.npcs.length, locations: handoff.keyLocations.length },
    wrote > 0 ? 'analysis_written' : 'analysis_gate_lost',
  )
}

// ── Worker builder ────────────────────────────────────────────────────────────

export function buildPostSessionAnalysisWorker(
  redisBatch: Redis,
  redisRealtime: Redis,
  redisKeyPrefix: string,
  pool: Pool,
  logger: MinimalLogger,
): BullmqWorker<AnalysisJobPayload> {
  const repo = createRepo(pool)
  const sessionState = makeSessionState(redisRealtime, redisKeyPrefix)
  const deps: AnalysisProcessorDeps = {
    repo,
    sessionState,
    runAnalysis: runPostSessionAnalysis,
    verify: verifyHandoffContainment,
    logger,
  }
  return new BullmqWorker<AnalysisJobPayload>(
    QUEUE_SESSION_ANALYSIS,
    (job: Job<AnalysisJobPayload>) => processPostSessionAnalysisJob(deps, job),
    {
      connection: redisBatch,
      concurrency: 1,
      lockDuration: ANALYSIS_LOCK_DURATION_MS,
      stalledInterval: ANALYSIS_LOCK_DURATION_MS,
      maxStalledCount: 1,
    },
  )
}
```
- [ ] **Run:** `pnpm vitest run src/session/__tests__/post-session-analysis.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74b): post-session-analysis worker — read→analyze→verify→persist (T9)`

---

## T10 — Prep consumption (serialize + stage + processor + prior-context helper)

**Files:** Modify `backend/src/llm/prep/serialize-world-state-for-prep.ts`, `backend/src/llm/prep/stages/session-prep.ts`, `backend/src/llm/prep/session-prep-processor.ts`; Create `backend/src/llm/prep/prior-session-context.ts`; Tests: `backend/src/llm/prep/__tests__/prior-session-context.test.ts`, extend `serialize-world-state-for-prep.test.ts` + `session-prep-processor.test.ts`.

The producer→consumer close: prior summaries + the handoff anchor feed the prep prompt; the verbatim voice + atmosphere are deterministically appended to `ft_context` in the processor (§4/§6).

- [ ] **Write the failing tests:**
  - (`prior-session-context.test.ts`) `buildPriorSessionContext(rows)` over rows newest-first: `previousSummaries` is the parsed summaries in CHRONOLOGICAL (oldest→newest) order; `latestHandoff` is the safeParsed handoff of the NEWEST row; a malformed `summaryJson` is skipped (not thrown); a malformed/`null` `latestHandoffJson` degrades to `latestHandoff: undefined`; empty input → `{previousSummaries:[]}` (no `latestHandoff` key).
  - (`serialize-world-state-for-prep.test.ts`) with `priorSessionContext.latestHandoff` set, the rendered doc contains a `## Where We Left Off` block with each party position, the time of day, the unresolved threads, AND each NPC `name` + `state`; with no `priorSessionContext` the block is absent (cold-start, no regression).
  - (`session-prep-processor.test.ts`) the processor calls `getPriorContextForPrep`, builds the context, threads it into `generateSessionPrep`, and — given a `latestHandoff` with an NPC `voice` excerpt + a keyLocation `atmosphere` — the persisted `ftContext` (assert on the `sessionPreps.insert` arg via a fake repo) ENDS WITH a deterministic "Returning characters / places" section containing the voice + atmosphere strings BYTE-IDENTICAL; with no handoff the inserted `ftContext` equals the generated one unchanged.
- [ ] **Implement** the pure helper `prior-session-context.ts`:
```ts
import { SessionHandoffSchema, type SessionHandoff } from '../schemas/post-session-analysis.js'
import type { PriorSessionContext } from './serialize-world-state-for-prep.js'

interface PriorRow {
  readonly sessionNumber: number
  readonly summaryJson: string
  readonly handoffJson: string | null
}

/** Parse the repo's NEWEST-first prior rows into the prep's PriorSessionContext.
 *  `previousSummaries` is chronological (oldest→newest, "the story so far" reads
 *  forward); `latestHandoff` is the newest row's handoff. All parsing is tolerant
 *  (safeParse) — a malformed/legacy value degrades to omission, never a throw. */
export function buildPriorSessionContext(rows: readonly PriorRow[]): PriorSessionContext {
  // rows are newest-first; reverse for chronological summaries.
  const chronological = [...rows].reverse()
  const previousSummaries: string[] = []
  for (const r of chronological) {
    try {
      const parsed: unknown = JSON.parse(r.summaryJson)
      const summary = (parsed as { summary?: unknown }).summary
      if (typeof summary === 'string' && summary.length > 0) previousSummaries.push(summary)
    } catch {
      // malformed/legacy summary wrapper → skip this entry (never throw mid-prep)
    }
  }

  const latestRaw = rows[0]?.handoffJson ?? null
  let latestHandoff: SessionHandoff | undefined
  if (latestRaw !== null) {
    try {
      const parsed = SessionHandoffSchema.safeParse(JSON.parse(latestRaw))
      if (parsed.success) latestHandoff = parsed.data
    } catch {
      // malformed JSON → no handoff (degrade)
    }
  }

  return { previousSummaries, ...(latestHandoff !== undefined ? { latestHandoff } : {}) }
}
```
- [ ] **Implement** the `serialize-world-state-for-prep.ts` widening + render. Widen the interface + render a `## Where We Left Off` block (the handoff's NPC `state` is digestible prep input — the verbatim `voice` is NOT rendered here; it rides the processor's deterministic injection):
```ts
import type { SessionHandoff } from '../schemas/post-session-analysis.js'

export interface PriorSessionContext {
  readonly previousSummaries: readonly string[]
  /** MYT-74b §4 — the latest ended session's handoff. Renders the opening-scene
   *  anchor (party positions, time, threads, NPC dispositions) into the prep
   *  prompt. The verbatim voice/atmosphere are NOT rendered here — they are
   *  deterministically appended to ft_context by the processor (§6). */
  readonly latestHandoff?: SessionHandoff
}
```
After the existing `## Prior Sessions` block (lines 92-96), add:
```ts
  const handoff = args.priorSessionContext?.latestHandoff
  if (handoff) {
    lines.push('## Where We Left Off')
    lines.push(`Time of day: ${handoff.timeOfDay}`)
    if (handoff.party.length > 0) {
      lines.push('Party positions:')
      for (const p of handoff.party) lines.push(`- ${p.characterName}: ${p.location} (${p.condition})`)
    }
    if (handoff.unresolvedThreads.length > 0) {
      lines.push('Unresolved threads (most urgent first):')
      for (const t of handoff.unresolvedThreads) lines.push(`- ${t}`)
    }
    if (handoff.npcs.length > 0) {
      lines.push('Returning NPCs — current disposition toward the party:')
      for (const n of handoff.npcs) lines.push(`- ${n.name}: ${n.state}`)
    }
    lines.push('')
  }
```
- [ ] **Implement** `stages/session-prep.ts`: thread `priorSessionContext` through. Add `readonly priorSessionContext?: PriorSessionContext` to `GenerateSessionPrepArgs` (import the type), and pass it into the `serializeWorldStateForPrep` call:
```ts
  const worldState = await serializeWorldStateForPrep(repo, {
    campaignId: args.campaignId,
    sessionNumber: args.sessionNumber,
    ...(args.priorSessionContext !== undefined ? { priorSessionContext: args.priorSessionContext } : {}),
  })
```
- [ ] **Implement** `session-prep-processor.ts`: fetch prior context, build it, thread it into `generateSessionPrep`, and deterministically append the verbatim section to `result.ft_context` before `insert`. Add a pure injector helper in the same file (or `prior-session-context.ts`) and the cap constant:
```ts
import { buildPriorSessionContext } from './prior-session-context.js'
import type { SessionHandoff } from '../schemas/post-session-analysis.js'

/** Campaign-length cap on prior summaries fed to the prep prompt (long campaigns
 *  must not blow the prompt budget). */
const PRIOR_SUMMARY_CAP = 20

/** §6 deterministic verbatim injection. Build the fixed "Returning characters /
 *  places" section from the handoff's voice + atmosphere excerpts. Returns '' when
 *  there is nothing to inject (no handoff, or every excerpt was dropped by the
 *  containment verifier). NEVER paraphrased — concatenated verbatim. */
export function buildReturningVoicesSection(handoff: SessionHandoff | undefined): string {
  if (!handoff) return ''
  const lines: string[] = []
  for (const npc of handoff.npcs) {
    if (npc.voice.length === 0) continue
    lines.push(`${npc.name}:`)
    for (const v of npc.voice) lines.push(`- "${v}"`)
  }
  const locLines: string[] = []
  for (const loc of handoff.keyLocations) locLines.push(`- ${loc.name}: "${loc.atmosphere}"`)
  if (lines.length === 0 && locLines.length === 0) return ''
  const out: string[] = [
    '',
    '## Returning characters and places — keep these voices and atmospheres consistent',
    'These are verbatim moments from the previous session. Stay true to how these',
    'characters speak and how these places feel.',
    '',
  ]
  if (lines.length > 0) out.push('Voices:', ...lines, '')
  if (locLines.length > 0) out.push('Places:', ...locLines)
  return out.join('\n')
}
```
Then in `processSessionPrepJob`, between `getWorldId` and `generateSessionPrep`, fetch + build the context; thread it into the stage; append the section before insert:
```ts
    const priorRows = await repo.sessions.getPriorContextForPrep(campaignId, PRIOR_SUMMARY_CAP)
    const priorSessionContext = buildPriorSessionContext(priorRows)
    const result = await generateSessionPrep(repo, {
      campaignId,
      worldId,
      sessionNumber,
      priorSessionContext,
      onProseDelta: (field, text) => {
        void deps.publishProse(campaignId, { type: 'prep-delta', field, text }).catch(() => undefined)
      },
    })
    // §6 — deterministically append the verbatim voice/atmosphere section AFTER
    // generation + Zod validation, BEFORE insert. The prep authored the scene
    // around it; this section is never digestible prep-LLM input.
    const ftContext = result.ft_context + buildReturningVoicesSection(priorSessionContext.latestHandoff)
    await repo.sessionPreps.insert({
      campaignId,
      sessionNumber,
      ftContext,
      sdPlaybook: result.sd_playbook,
    })
```
- [ ] **Run:** `pnpm vitest run src/llm/prep/__tests__/prior-session-context.test.ts src/llm/prep/__tests__/serialize-world-state-for-prep.test.ts src/llm/prep/__tests__/session-prep-processor.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74b): prep consumes handoff — prior summaries + anchor + deterministic ft_context voice injection (T10)`

---

## T11 — session-end re-shape: endSession + finalizeEndedSession

**Files:** Modify `backend/src/session/session-end.ts`; Test rewrite `backend/src/session/__tests__/session-end.test.ts`.

`endSession` becomes "begin ending" (enqueue the farewell); `finalizeEndedSession` is the new "complete ending" (flip + enqueue reconcile/analysis + broadcast), idempotent and callable from the turn-worker finally AND the QueueEvents backstop.

- [ ] **Write the failing tests:**
  - `endSession`: claims the `ending` flag → on first claim, `cancelSuspend`, reads `respondedSeq`, and enqueues ONE farewell turn (assert the payload: `trigger.kind:'farewell'`, `triggerMessages:[]`, `maxConsumedSeq` = the watermark, `farewellText`, `worldId`); a second `endSession` (flag already set) no-ops (no second farewell). It does NOT flip status, enqueue reconcile, or broadcast.
  - `finalizeEndedSession`: `markEnded` returns 1 → broadcasts `session_end` + enqueues reconcile + analysis; `markEnded` returns 0 (already ended) → does NOT broadcast but STILL enqueues reconcile + analysis (idempotent re-enqueue). Assert reconcile + analysis enqueues carry the right ids.
- [ ] **Implement** — rewrite the deps + the two functions:
```ts
import { randomUUID } from 'node:crypto'
import { cancelSuspend, type SuspendQueueLike } from './session-suspend.js'
import { enqueueReconcile, type ReconcileQueueLike } from './session-reconcile.js'
import { enqueuePostSessionAnalysis, type AnalysisQueueLike } from './post-session-analysis.js'
import { enqueueFarewellTurn, FAREWELL_DIRECTION, type TurnQueueLike } from './turn-queue.js'
import type { SessionState } from '../redis/session-state.js'

export interface MinimalLogger {
  info: (o: Record<string, unknown> | string, m?: string) => void
  warn: (o: Record<string, unknown> | string, m?: string) => void
  error: (o: Record<string, unknown> | string, m?: string) => void
}

/** MYT-74b §1 — "begin ending." Claims the once-only `ending` flag, cancels the
 *  pending suspend, and enqueues a player-less FAREWELL turn. Does NOT finalize —
 *  the turn worker runs the unconditional finalize after the farewell render. */
export interface EndSessionDeps {
  readonly sessionState: Pick<SessionState, 'tryMarkEnding'>
  readonly suspendQueue: SuspendQueueLike
  /** The farewell-turn producer (the session-turn queue). */
  readonly turnQueue: TurnQueueLike
  /** The current responded watermark — rides the player-less farewell payload so
   *  it never advances past unresponded player seqs. */
  readonly respondedSeq: (campaignId: string) => Promise<number>
  readonly logger: MinimalLogger
}

export interface EndSessionArgs {
  readonly campaignId: string
  readonly sessionId: string
  readonly worldId: string
}

export async function endSession(deps: EndSessionDeps, args: EndSessionArgs): Promise<void> {
  const { campaignId, sessionId, worldId } = args
  const claimed = await deps.sessionState.tryMarkEnding(campaignId)
  if (!claimed) {
    deps.logger.info({ campaignId, sessionId }, 'session_end_already_in_progress')
    return
  }
  // Cancel a pending all-disconnected suspend (it would re-checkpoint as active).
  await cancelSuspend(deps.suspendQueue, sessionId)
  const watermark = await deps.respondedSeq(campaignId)
  await enqueueFarewellTurn(deps.turnQueue, {
    campaignId,
    sessionId,
    turnId: randomUUID(),
    triggerMessages: [],
    maxConsumedSeq: watermark,
    trigger: { kind: 'farewell' },
    farewellText: FAREWELL_DIRECTION,
    worldId,
  })
  deps.logger.info({ campaignId, sessionId, worldId }, 'session_end_initiated')
}

/** MYT-74b §1.3 — "complete ending." The UNCONDITIONAL finalize: flip the row to
 *  ended (conditional → broadcast exactly once), then enqueue reconcile + analysis
 *  (both jobId-deduped → safe to re-enqueue). Idempotent: callable from the
 *  farewell turn's finally AND the QueueEvents backstop (the maxStalledCount
 *  terminal). A session ALWAYS ends; the farewell is best-effort closure. */
export interface FinalizeEndedSessionDeps {
  readonly sessions: { markEnded(id: string): Promise<number> }
  readonly reconcileQueue: ReconcileQueueLike
  readonly analysisQueue: AnalysisQueueLike
  readonly publish: (campaignId: string, frame: unknown) => Promise<void>
  readonly logger: MinimalLogger
}

export async function finalizeEndedSession(
  deps: FinalizeEndedSessionDeps,
  args: EndSessionArgs,
): Promise<void> {
  const { campaignId, sessionId, worldId } = args
  const flipped = await deps.sessions.markEnded(sessionId)
  // Always enqueue (jobId-deduped). A backstop re-run still guarantees both jobs.
  await enqueueReconcile(deps.reconcileQueue, { campaignId, sessionId, worldId })
  await enqueuePostSessionAnalysis(deps.analysisQueue, { campaignId, sessionId })
  if (flipped > 0) {
    await deps.publish(campaignId, { type: 'session_end', reason: 'normal' })
    deps.logger.info({ campaignId, sessionId, worldId }, 'session_finalized')
  } else {
    deps.logger.info({ campaignId, sessionId }, 'session_finalize_noop')
  }
}
```
- [ ] **Update the WS-route caller.** The 74a `end_session` WS handler builds `EndSessionDeps`. Update it to the new shape (drop `lock`/`reconcileQueue`/`sessions`/`publish`, add `turnQueue` = the session-turn producer + `respondedSeq` = `triggerState.respondedSeq`). Verify the exact wiring site in `routes/ws-session.ts` during implementation; the route already has the session-turn queue + triggerState in scope (it enqueues turns + reads the watermark). This is a same-file follow-on edit captured under T11's spec-compliance review.
- [ ] **Run:** `pnpm vitest run src/session/__tests__/session-end.test.ts src/routes/__tests__/ws-session.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74b): session-end re-shape — endSession enqueues farewell + finalizeEndedSession (T11)`

---

## T12 — turn-worker: farewell render + isPlayerless gates + unconditional finalize

**Files:** Modify `backend/src/session/turn-worker.ts`; Test extend `backend/src/session/__tests__/turn-worker.test.ts`.

- [ ] **Write the failing tests** (injected fakes):
  - A `farewell` turn renders via the silent-consume seam: the controller config receives `pendingDirection` = the farewell text (NOT a `[[DM CORRECTION:]]` marker) and `triggerKind:'farewell'`.
  - `isPlayerless` gates: a farewell turn does NOT advance the watermark (neither the fresh-run nor the converge `setRespondedSeq` fires), does NOT enqueue scribe, does NOT run the budget auto-end.
  - **Unconditional finalize (Eddystone-C1 guard):** a farewell turn whose FT render THROWS still calls `deps.finalizeEndedSession({campaignId, sessionId, worldId})` exactly once (spy); a farewell turn that renders cleanly also finalizes once.
  - The finally's explicit-drain + post-turn re-mature are SUPPRESSED when `isEnding(campaignId)` is true (a real turn that ran while ending was set does not enqueue a follow-up).
- [ ] **Implement:**
  - **Imports:** add `finalizeEndedSession, type FinalizeEndedSessionDeps` from `./session-end.js`; `enqueuePostSessionAnalysis, QUEUE_SESSION_ANALYSIS, type AnalysisQueueLike` from `./post-session-analysis.js`; `enqueueFarewellTurn, FAREWELL_DIRECTION` already exported from `./turn-queue.js` (import `FAREWELL_DIRECTION`).
  - **Hoist the kind predicates** to the top of `processTurnJob` (after `const { campaignId, sessionId, turnId } = job.data`):
```ts
  const isCorrection = job.data.trigger.kind === 'correction'
  const isFarewell = job.data.trigger.kind === 'farewell'
  const isPlayerless = isCorrection || isFarewell
```
  Remove the later `const isCorrection = …` at the fresh-run arm (now hoisted).
  - **Converge branch** (line ~340): gate the watermark advance:
```ts
      if (!isPlayerless) await deps.triggerState.setRespondedSeq(campaignId, job.data.maxConsumedSeq)
```
  - **`pendingDirection`** (fresh-run arm): extend for the farewell silent-consume seam:
```ts
    const pendingDirection = isCorrection
      ? `[[DM CORRECTION: ${job.data.correctionText ?? ''}]]`
      : isFarewell
        ? (job.data.farewellText ?? FAREWELL_DIRECTION)
        : await deps.triggerState.takeOneShotDirection(campaignId)
    const standingDirective = isPlayerless
      ? null
      : await deps.triggerState.readStandingDirection(campaignId)
```
  - **Thread `triggerKind` into the controller config** (the `new SessionController({...})` deps object): add `triggerKind: job.data.trigger.kind,`.
  - **Watermark / budget / scribe gates** (lines ~486/510/527): change each `if (!isCorrection)` → `if (!isPlayerless)`.
  - **`finally` suppression + the finalize.** At the top of the finally (after `clearInterval`/release/`clearResponding`), read the ending gate once and gate the drain + re-mature; then run the farewell finalize:
```ts
    // MYT-74b §1.1 — once an end is in progress, suppress the explicit-drain +
    // post-turn re-mature so no fresh real turn is enqueued behind the farewell.
    const ending = await deps.sessionState.isEnding(campaignId)
    // … wrap the existing explicit-drain block in `if (!ending) { … }`
    // … wrap the existing post-turn re-mature block in `if (!ending) { … }`

    // MYT-74b §1.3 — the UNCONDITIONAL finalize. Runs on EVERY farewell path
    // (clean render, thrown render, converge) because `finally` always runs.
    // worldId rides the farewell payload, so no re-resolution is needed.
    if (isFarewell) {
      try {
        const worldId =
          job.data.worldId ??
          (await resolveWorldId({ sessionState: deps.sessionState, repo: deps.repo }, campaignId, sessionId))
        await deps.finalizeEndedSession({ campaignId, sessionId, worldId })
      } catch (finErr) {
        deps.logger.error({ err: finErr, campaignId, turnId }, 'failed to finalize ended session')
      }
    }
```
  - **`TurnProcessorDeps`:** add `readonly finalizeEndedSession: (args: EndSessionArgs) => Promise<void>` and ensure `sessionState` includes `isEnding` (it is the full `SessionState`, which already has it).
  - **`buildSessionTurnWorker`:** update `endDeps` to the new `EndSessionDeps` shape (drop `lock`/`reconcileQueue`/`sessions`/`publish`; add `turnQueue: sessionTurnQueue` + `respondedSeq: (cid) => triggerState.respondedSeq(cid)`), construct the analysis queue producer + the finalize deps, and bind `finalizeEndedSession`:
```ts
  const analysisBullQueue = new Queue<AnalysisJobPayload>(QUEUE_SESSION_ANALYSIS, { connection: redisBatch })
  /* c8 ignore next */
  const analysisQueue: AnalysisQueueLike = { add: (n, d, o) => analysisBullQueue.add(n, d, o) }
  const finalizeDeps: FinalizeEndedSessionDeps = {
    sessions: repo.sessions,
    reconcileQueue,
    analysisQueue,
    /* c8 ignore start — the session_end broadcast fires only on a real farewell finalize (the §smoke), not the converge-path builder tests */
    publish: async (campaignId, frame): Promise<void> => {
      await redisRealtime.publish(sessionChannel(redisKeyPrefix, campaignId), JSON.stringify(frame))
    },
    /* c8 ignore stop */
    logger: { info: logger.info ?? logger.warn, warn: logger.warn, error: logger.error },
  }
```
  And in `deps`: `/* c8 ignore next */ finalizeEndedSession: (args) => finalizeEndedSession(finalizeDeps, args),` (the bound passthrough fires only on a real farewell finalize — the budget/smoke path — exercised via the injected fake in `processTurnJob`'s tests, like the existing `endSession` passthrough).
  - Import `AnalysisJobPayload` alongside the other analysis imports.
- [ ] **Run:** `pnpm vitest run src/session/__tests__/turn-worker.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74b): turn-worker farewell render + isPlayerless gates + unconditional finalize (T12)`

---

## T13 — QueueEvents backstop finalize

**Files:** Modify `backend/src/session/session-turn-queue-events.ts`; Test extend `backend/src/session/__tests__/session-turn-queue-events.test.ts`.

The `maxStalledCount` terminal of a farewell turn fires no `'failed'` JS event (the turn-worker finally never completed — the holder crashed), so the broker-side `QueueEvents('session-turn')` subscriber is the ONLY surface that can run the finalize backstop.

- [ ] **Write the failing test:** a broker `failed` event for a job with `trigger.kind:'farewell'` + `worldId` calls the injected `finalize({campaignId, sessionId, worldId})` (spy) AFTER the existing `turn_error` publish; a `failed` event for a NON-farewell job (e.g. `auto`) does NOT call `finalize`; a farewell job WITHOUT `worldId` logs a warn + skips finalize (defensive).
- [ ] **Implement:** add a `finalize` dep to `buildSessionTurnQueueEvents` and call it in `handleFailed` after `publishTerminalTurnError`:
```ts
export function buildSessionTurnQueueEvents(
  redisBatch: Redis,
  redisRealtime: Redis,
  redisKeyPrefix: string,
  logger: MinimalLogger,
  finalize: (args: { campaignId: string; sessionId: string; worldId: string }) => Promise<void>,
): SessionTurnQueueEvents {
  // … existing construction …
  async function handleFailed(jobId: string): Promise<void> {
    const job = await Job.fromId<TurnJobPayload>(queueHandle, jobId)
    if (job == null) {
      logger.warn({ jobId }, 'session-turn failed event for a job already reaped; cannot publish turn_error')
      return
    }
    await publishTerminalTurnError(publisher, job as TerminalFailureJob, logger, (turnId) => triggerState.claimTurnErrorPublish(turnId), job.failedReason)

    // MYT-74b §1.3 — the unconditional-finalize backstop for the maxStalledCount
    // terminal: a farewell turn whose holder crashed terminally fires NO 'failed'
    // JS event (the turn-worker finally never completed), so the session would
    // never finalize. finalizeEndedSession is idempotent, so a double-fire with
    // the JS path (attempts-exhaustion) is safe.
    if (job.data.trigger.kind === 'farewell') {
      if (typeof job.data.worldId === 'string') {
        await finalize({ campaignId: job.data.campaignId, sessionId: job.data.sessionId, worldId: job.data.worldId })
      } else {
        logger.warn({ jobId }, 'farewell turn failed without worldId; cannot finalize via backstop')
      }
    }
  }
  // … existing on('failed') registration + return …
}
```
- [ ] **Run:** `pnpm vitest run src/session/__tests__/session-turn-queue-events.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74b): QueueEvents backstop finalize for the farewell maxStalledCount terminal (T13)`

---

## T14 — worker + queue wiring

**Files:** Modify `backend/src/worker.ts`, `backend/src/server-queues.ts`; Test extend `backend/src/__tests__/worker.test.ts` + `backend/src/__tests__/server-queues.test.ts`.

- [ ] **Write the failing tests:** `buildSessionAnalysisQueue(redisBatch)` returns a `{bullmqQueue, sessionAnalysisQueue}` with the reconcile-mirrored options (assert `attempts:5`, `removeOnComplete:true`, `removeOnFail:true` on the Queue opts via the BullMQ fake); `worker.main()` registers a `session-analysis` worker (the workers list grows; assert a `'session-analysis'`-named worker) and passes a `finalize` closure into `buildSessionTurnQueueEvents` (assert the subscriber receives a callable).
- [ ] **Implement** `server-queues.ts` — add `buildSessionAnalysisQueue` mirroring `buildSessionReconcileQueue` (import `QUEUE_SESSION_ANALYSIS`, `AnalysisJobPayload`, `AnalysisQueueLike` from `./session/post-session-analysis.js`):
```ts
/** MYT-74b: build the session-analysis BullMQ Queue (end-of-session → Opus
 *  analysis). Mirrors buildSessionReconcileQueue: a terminally-failed analysis can
 *  be re-enqueued (the per-session jobId is freed by removeOnFail); attempts +
 *  exponential backoff because the processor THROWS on transient failure. */
export function buildSessionAnalysisQueue(redisBatch: Redis): {
  bullmqQueue: Queue
  sessionAnalysisQueue: AnalysisQueueLike
} {
  const bullmqQueue = new Queue<AnalysisJobPayload>(QUEUE_SESSION_ANALYSIS, {
    connection: redisBatch,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  })
  const sessionAnalysisQueue: AnalysisQueueLike = {
    add: (name, data, opts) => bullmqQueue.add(name, data, opts),
  }
  return { bullmqQueue, sessionAnalysisQueue }
}
```
- [ ] **Implement** `worker.ts`:
  - Import `buildPostSessionAnalysisWorker, QUEUE_SESSION_ANALYSIS` from `./session/post-session-analysis.js`; `finalizeEndedSession, type FinalizeEndedSessionDeps` from `./session/session-end.js`; `enqueueReconcile`/`ReconcileQueueLike` already imported; `sessionChannel` from `./contract/session-channel.js`.
  - Construct the analysis worker: `const sessionAnalysisWorker = buildPostSessionAnalysisWorker(redisBatch, redisRealtime, env.redisKeyPrefix, pg, logger)`.
  - Build the finalize closure for the QueueEvents backstop (its OWN reconcile + analysis producers + repo.sessions + a publish closure):
```ts
  const repoForFinalize = createRepo(pg)
  const finalizeReconcileQueue: ReconcileQueueLike = { add: (n, d, o) => new Queue(QUEUE_SESSION_RECONCILE, { connection: redisBatch }).add(n, d, o) }
  // (Prefer reusing the existing reconcile/analysis Queue handles if worker.ts
  //  already constructs them for shutdown; verify during implementation and reuse
  //  rather than constructing a fresh Queue per enqueue.)
  const finalizeDeps: FinalizeEndedSessionDeps = {
    sessions: repoForFinalize.sessions,
    reconcileQueue: finalizeReconcileQueue,
    analysisQueue: { add: (n, d, o) => sessionAnalysisQueueHandle.add(n, d, o) },
    publish: async (campaignId, frame) => {
      await redisRealtime.publish(sessionChannel(env.redisKeyPrefix, campaignId), JSON.stringify(frame))
    },
    logger,
  }
  const sessionTurnEvents = buildSessionTurnQueueEvents(
    redisBatch,
    redisRealtime,
    env.redisKeyPrefix,
    logger,
    (args) => finalizeEndedSession(finalizeDeps, args),
  )
```
  **Implementation note:** worker.ts must construct the reconcile + analysis Queue handles ONCE (for both the producer and shutdown `.close()`), not a fresh `new Queue` per enqueue (a per-enqueue Queue leaks a client). Verify whether worker.ts already holds these handles; if not, construct them once near the worker construction and reuse. Register `sessionAnalysisWorker` in the health `workers[]`, the `worker.started` queues log (add `QUEUE_SESSION_ANALYSIS`), and a `closeWithDeadline(sessionAnalysisWorker, …)` in shutdown.
- [ ] **Run:** `pnpm vitest run src/__tests__/worker.test.ts src/__tests__/server-queues.test.ts`; typecheck. PASS.
- [ ] **Commit:** `feat(MYT-74b): wire session-analysis queue + worker + the QueueEvents finalize backstop (T14)`

---

## T15 — Controller: leak-matrix + real-LLM smoke + close

**Controller-run** (like 74a's T14). Files: Create `backend/src/session/__tests__/analysis-leak.test.ts`; Create `backend/scripts/smoke/myt-74b-analysis-smoke.ts` + the `smoke:analysis` package script.

- [ ] **Leak matrix** (`analysis-leak.test.ts`, real PG + forced/mocked LLM, break-it-to-prove-it) — the §5/§8 cases:
  - (a) the analysis over a **secret-bearing `sd_playbook` AND a secret-adjacent running summary** → the persisted `summary` + `emergingThreads` carry no secret token (a semantic curated-paraphrase check WITH a negative control that fires when fed a leaking output — MYT-73 case-(b) shape, not a single clean run).
  - (b) the worker's failure/drop log path carries NO secret content (assert every `logger` arg on a forced drop is structural-only — counts/ids).
  - (c) **the transcript→`ft_context` path (the novel leak surface):** seed a transcript that INCLUDES a MYT-73 `[[DM CORRECTION:]]` retcon row (`trigger_kind='correction'`, carrying a secret-pointer line) → run the analysis (forcing the model to emit that retcon line as a `voice` excerpt) → assert the containment verifier DROPS it → run the deterministic injection (T10) → assert NO retcon-derived (or fabricated) line appears in the generated `ft_context`.
  - (d) a fabricated voice excerpt (in no transcript row) is dropped before persistence.
- [ ] **Run:** `pnpm vitest run src/session/__tests__/analysis-leak.test.ts`.
- [ ] **Gated real-LLM smoke** (`myt-74b-analysis-smoke.ts`, gated on the ANTHROPIC key, seeds + tears down a scratch session in `mythrun_dev`, modeled on `myt-74a-reconcile-smoke.ts`): seed a session with a transcript that builds an NPC relationship across several turns (early neutral → late warm/relational lines) + a key location with sensory prose → drive the END: enqueue/run a farewell turn against real Opus(FT) (assert the farewell streamed), then run the analysis worker against **real Opus** → assert the session row has a `summary` (secret-free) + a `handoff` whose NPC `voice[]` excerpts the **containment verifier confirms** appear in the seeded transcript (NON-correction rows), then run a session-N prep and assert the generated `ft_context` ENDS WITH the "Returning characters and places" section carrying the voice + atmosphere **byte-identical**. Inspect at the WIRE level (PG rows, the `ft_context` substring). The affect-QUALITY of the excerpts (relational / late-session / non-stereotype) is **logged for eval, NOT asserted** (`feedback_smoke_vs_eval`).
- [ ] **Controller sweep:** full `pnpm --filter @mythrun/backend lint` (eslint src — 0 errors) + scoped coverage on every new/modified file (`pnpm vitest run <test> --coverage --coverage.include='<src>'`), sweeping lint + coverage debt. Then full `pnpm --filter @mythrun/backend test:coverage` (100% gate).
- [ ] **Wiki:** dispatch the `docs/wiki/AUTHORING.md` subagent for MYT-74b (the Runtime "session end" page gains the farewell + post-session analysis + handoff-consumption flow; source-hash refresh for the touched runtime files) — content sync, BEFORE the push.
- [ ] **Push (single):** commit T15, then `git push origin main` (the pre-push gate runs typecheck + lint + test:coverage + wiki:check; this diff touches `routes/sessions.ts` + `session/*` but no `dev-tool/**` or contract-route source, so confirm whether `dev-tool:verify` triggers — if `contract/session-events.ts` is untouched, it should not; verify against the trigger list and start `pnpm dev` on :3030 if it does). Then flip Linear **MYT-74** per the user's call (74b is the 2nd of 4 pieces — leave MYT-74 open for 74c/74d unless told otherwise) + `bd close` the T15 bead.
- [ ] **Commit:** `test(MYT-74b): enforced-ignorance leak matrix (transcript→ft_context) + real-LLM analysis/handoff smoke (T15)`

---

## Self-review

**Spec coverage:** §1 end flow → T3 (farewell payload/enqueue) + T11 (endSession re-shape + finalizeEndedSession) + T12 (farewell render + unconditional finalize) + T13 (maxStalledCount backstop) + T4 (session_ending start-guard); §2 analysis worker → T5 (Opus call) + T9 (worker, input-size bound, idempotent gate, structural-only log) + T8 (listForAnalysis); §3 outputs/handoff shape + storage → T2 (schema/types) + T7 (writeAnalysis JSON wrappers); §4 prep wiring → T7 (getPriorContextForPrep) + T10 (serialize widen + processor fetch + deterministic injection); §5 enforced ignorance → T1 (trigger_kind column) + T6 (containment verifier) + T8 (trigger_kind thread) + T9 (redactRawText + structural-only log) + T15 (leak matrix incl. transcript→ft_context); §6 prompt + selection + repair-voids-verbatim → T5 (prompt) + T9 (verify runs unconditionally); §7 interface changes → all (each named file mapped to a task); §8 testing → per-task unit tests + T15 leak matrix + smoke; §9 out-of-scope → respected (no faction_updates, no recap surface, no regenerate-handoff, no canon promotion, no prompt-cache reuse). ✓

**Placeholder scan:** schemas/SQL/signatures/prompt-rules given in full. The few "verify against the real interface during implementation" notes (the `ws-session.ts` endSession caller rewiring in T11; the `sessionState` variable name in T4; the reuse-existing-Queue-handle note + the `dev-tool:verify` trigger in T14) are grounded named seams (the MYT-72/73/74a idiom), not substitutes for code. ✓

**Type consistency:** `SessionHandoff`/`PostSessionAnalysis` (T2) consumed by T5/T6/T7/T9/T10; `AnalysisQueueLike`/`enqueuePostSessionAnalysis`/`QUEUE_SESSION_ANALYSIS` (T9) consumed by T11/T12/T14; `FinalizeEndedSessionDeps`/`finalizeEndedSession`/`EndSessionDeps` (T11) consumed by T12/T13/T14; `enqueueFarewellTurn`/`FAREWELL_DIRECTION`/`farewell` kind/`worldId` payload (T3) consumed by T11/T12/T13; `markEnded`/`writeAnalysis`/`getPriorContextForPrep` (T7) consumed by T9/T10/T11; `trigger_kind` column (T1) + `appendDmTurn(triggerKind)`/`listForAnalysis` (T8) consumed by T9/T12; `verifyHandoffContainment`/`AnalysisTranscriptRow` (T6) consumed by T9; `PriorSessionContext` widening (T10) consumed by `generateSessionPrep` (T10) + `buildPriorSessionContext` (T10). The `isPlayerless` predicate (T12) supersedes every 74a `!isCorrection` gate consistently. ✓

**Idempotency / safety axes verified:** the finalize is exactly-once-broadcast via `markEnded`'s conditional + always-safe re-enqueue via per-session jobIds; the analysis write is gated on `summary IS NULL`; the farewell enqueue is gated by the `ending` SET-NX flag + the farewell jobId; the watermark never advances on a player-less turn (both the fresh-run and converge arms); the verbatim guarantee survives a repair (the verifier always runs). ✓
