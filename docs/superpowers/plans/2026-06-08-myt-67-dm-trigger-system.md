# MYT-67 — DM Trigger System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. All subagents Opus; implementer subagents do NOT `git add`/`commit`/`push` — the controller stages + commits each task's files serially after the two-stage review; close each bead as it lands; hold all pushes until MYT-67 is fully done (then wiki subagent + single push).

**Goal:** Decide *when* the AI DM responds in a multiplayer session (explicit `@dm` / solo / typing-gated auto + proactive "keep alive" + 60s dead-air), and enqueue exactly one `session-turn` per decision — coordinated correctly across containers.

**Architecture:** A typing-gated quiet-window trigger. Typing state + coordination keys live in Redis; the quiet-window timer is a BullMQ **debounce-mode** delayed job per campaign (`deduplication: {id, replace, ttl}` + `delay`). The API server (ws-session) observes frames → writes typing state + reschedules the debounce (auto/solo) or fires explicit immediately. A new `dm-trigger` BullMQ worker matures the debounce → re-validates → builds the `(lastRespondedSeq,max]` batch → runs the real Haiku classifier (respond / sit-back / step-in) → enqueues a `session-turn` (MYT-66, **no dedup — H10 stands**). Collision/drain via a `dm_responding` flag + the lock. Conductor tiers stay stubbed (MYT-66); the Haiku DM-trigger classifier is the only real tier here. Spotlight balancing is OUT (filed MYT-76).

**Tech Stack:** Node 24, Fastify, TypeScript strict, Postgres (`pg`), Redis (`ioredis`), BullMQ, Vitest, the `src/llm` Anthropic abstraction (`generateObject` + `HAIKU`).

**Spec:** `docs/superpowers/specs/2026-06-08-myt-67-dm-trigger-system-design.md` — read it; every task cites a section. The spec is authoritative for behavior; this plan is the build order + concrete signatures.

---

## Build-against reference (verified signatures — use these exactly)

- **Contract** `src/contract/session-events.ts`: `CLIENT_FRAME_TYPES = ['player_message','typing_start','typing_stop'] as const`; `ClientFrame` union; `SERVER_FRAME_TYPES` (incl. `dm_thinking|text_delta|turn_end|turn_error`); `classifyClientFrame(t)` auto-covers the allowlist. Adding a client frame = (a) array, (b) union, (c) `parseClientFrame` validation in `ws-session.ts`.
- **WS route** `src/routes/ws-session.ts`: `WsSessionDeps { repo, sessionState, hub, suspendQueue, containerId, redisRealtime, redisKeyPrefix }` (NO turn queue today). `handleInbound(ctx,userId,campaignId,sessionId,raw,displayName,characterName)` — typing frames `hub.publish` then return; `player_message` → `persistMessage` → `hub.publish`. `parseClientFrame(raw,log): ClientFrame|null`. `handleDisconnect(ctx,userId,campaignId,sessionId)`. Registered in `app.ts:314`. No per-message rate-limit exists.
- **Turn queue** `src/session/turn-queue.ts`: `QUEUE_SESSION_TURN='session-turn'`, `TURN_JOB_NAME='turn'`, `TurnJobPayload {campaignId,sessionId,turnId,triggerMessages: readonly TriggerMessage[]}`, `enqueueTurn(queue,payload)`, `TurnQueueLike {add}`. **H10: no custom jobId — keep it.** `TriggerMessage` from `./tiers/types.js` = `{userId,characterName,text}`.
- **Turn worker** `src/session/turn-worker.ts`: `processTurnJob(deps,job)`; `buildSessionTurnWorker(redisBatch,redisRealtime,redisKeyPrefix,logger)`; constants `SESSION_LOCK_TTL_MS=45000`, `TURN_HEARTBEAT_MS=15000`, etc. `publishTerminalTurnError(publisher,job,logger,err?)` + `TerminalFailureJob`. `worker.on('failed')` — the myth-tvnb stalled-terminal gap is MYT-67's (needs `QueueEvents`).
- **Session state** `src/redis/session-state.ts`: `makeSessionState(redis,keyPrefix)`; keys built as `${keyPrefix}session:${campaignId}:<suffix>` (keyPrefix already ends `:`). `nextSeq`, `loadTurnState(campaignId): {ftHistory,summary,usage}`. `PRESENCE_TTL=60`.
- **Lock** `src/session/session-lock.ts`: `createSessionLock(redis,keyPrefix,ttlMs)`; key `${keyPrefix}session:lock:${campaignId}`; `tryAcquire→handle|null`, `handle.extend()/release()`.
- **LLM** `src/llm/ai.ts`: `generateObject<T>({model,schema,prompt,callSite,system?,temperature?,repairStrategy?,timeoutMs?,schemaName?}) → {output,usage,...}`. `repairStrategy: 'sonnet'|'haiku-then-sonnet'` (default `'sonnet'`). Models `src/llm/models.ts`: `HAIKU,SONNET,OPUS` (never hardcode IDs). Prompt loader `src/llm/prompts.ts`: `loadPrompt(area,name,vars?)` reads `src/llm/prompts/<area>/<name>.txt`. Schema example `src/llm/schemas/profanity.ts`. Call example `src/llm/profanity.ts`. **LLM prose fields: `.min()` only, no `.max()`.**
- **Worker bootstrap** `src/worker.ts`: `main()` builds `redisBatch`(BullMQ)/`redisRealtime`(publish)/`pg`; 4 workers now `[worldGen,campaignSetup,sessionPrep,sessionTurn]` + `queues=[...4...]`; shutdown closes each via `closeWithDeadline`. **The worker.test asserts 4 → must become 5.**
- **Queue wiring** `src/server-queues.ts` (`buildSessionTurnQueue(redisBatch) → {bullmqQueue,sessionTurnQueue}` + `stubSessionTurnQueue()`), `src/app-deps.ts` (`AppDeps.sessionTurnQueue`), `src/server.ts` (builds + threads into `createApp` + shutdown), `src/app.ts` (registers `devFireTurnRoutes`). `dev-fire-turn.ts` is the closest enqueue model + shows Fastify `config.rateLimit`.
- **Repo** `src/repo/`: `sessions.getActiveByCampaign(campaignId): Promise<Session|null>`. `sessionMessages.listAfterSeq(sessionId,afterSeq): Promise<SessionMessage[]>` (seq>afterSeq ASC) + `maxSeq(sessionId)`. `campaigns.listMembersBasic(campaignId): {user_id,display_name}[]` (no accept filter); the accepted predicate `AND cm.invite_accepted = true` lives in `campaigns.listByUser`. **No accepted-member count exists.**
- **dev-tool**: `dev-tool/verify-registry.ts` (`PANEL_EXERCISES`, `PAGE_REGISTRY`, `EXEMPT_ROUTES`, route-exhaustion invariant); `dev-tool/src/components/fire-turn-panel.ts` (action-panel pattern). MYT-67 adds **no new REST route** (the trigger is WS-driven), so route-exhaustion is satisfied without a new panel; the panel is an *event-driven* observer (optional, verifier-built).
- **Tests** (`src/__tests__/CONVENTIONS.md`): target `mythrun_test`; scoped fixtures (`createTestPool`, `makeTestScope`); **Redis tests use `ioredis-mock`** (`new IoRedisMock() as unknown as Redis`); **LLM tests mock the `'ai'` SDK** (`vi.mock('ai', ...)`), NOT `ai.ts`. Schema tests = pure `safeParse`.

**Naming note:** the spec §14 lists `typing-state.ts`; this plan widens it to **`trigger-state.ts`** (owns *all* new trigger Redis keys: typing + coordination). Same role, clearer name.

---

## File structure

**New (`src/session/`):** `dm-trigger-config.ts` (shared constants), `trigger-state.ts` (Redis: typing + last-activity + first-unresponded + last-responded-seq + dm_responding + explicit-pending + the `turn-error-published` latch), `turn-batch.ts` (`(lastRespondedSeq,max]` → `TriggerMessage[]`), `dm-trigger-queue.ts` (queue + debounce producer), `dm-trigger-worker.ts` (maturity→decide→enqueue), `session-turn-queue-events.ts` (QueueEvents terminal turn_error). **New (`src/llm/`):** `dm-trigger-classifier.ts`, `schemas/dm-trigger-classification.ts`, `prompts/session/dm-trigger-classifier.txt`. **New (dev-tool):** `src/components/dm-trigger-panel.ts`.

**Modified:** `contract/session-events.ts` (+`dm_invoke`), `routes/ws-session.ts` (+ trigger integration), `session/turn-queue.ts` (+`trigger` field), `session/turn-worker.ts` (dm_responding + watermark + explicit drain + latch), `repo/campaigns.ts` (+`countAcceptedMembers`), `worker.ts` (+ worker + QueueEvents), `server-queues.ts`/`app-deps.ts`/`server.ts`/`app.ts` (wire dm-trigger + session-turn into ws-session deps), `routes/dev-fire-turn.ts` (+`trigger.kind`), `dev-tool/verify-registry.ts`.

## Dependency waves (for beads)

- **A (parallel):** T1 config · T2 schema · T3 prompt · T6 campaigns count · T13 contract(`dm_invoke`)
- **B (after A):** T4 trigger-state(←T1) · T5 turn-batch · T7 dm-trigger-queue(←T1) · T8 classifier(←T1,T2,T3) · T10 turn-queue field
- **C (after B):** T9 dm-trigger-worker(←T1,T4,T5,T6,T7,T8,T10) · T11 turn-worker(←T4,T10) · T12 queue-events(←T11)
- **D (after C):** T14 ws-session(←T4,T7,T13,T10) [after T13] · T15 wiring(←T7) · T16 worker.ts(←T9,T12) · T17 dev-fire-turn(←T10)
- **E (last):** T18 dev-tool panel + verifier · T19 full verification + E2E wire smoke

Only `ws-session.ts` is touched twice (T13 then T14) — sequence them. All other files are single-owner → parallel-safe within a wave.

---

### Task 1: Shared config constants

**Files:** Create `backend/src/session/dm-trigger-config.ts`; Test `backend/src/session/__tests__/dm-trigger-config.test.ts`

Spec §7. Single source of truth imported by ws-session (server) + dm-trigger-worker (worker) so the `delay` and the re-validation guard can't drift.

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect } from 'vitest'
import * as cfg from '../dm-trigger-config.js'

describe('dm-trigger-config', () => {
  it('exposes the trigger timing constants with the spec invariants', () => {
    expect(cfg.QUEUE_DM_TRIGGER).toBe('dm-trigger')
    expect(cfg.QUIET_WINDOW_MS).toBe(4000)
    expect(cfg.DEAD_AIR_MS).toBe(60_000)
    expect(cfg.MAX_QUIET_EXTENSION_MS).toBe(30_000)
    expect(cfg.TYPING_TTL_S).toBe(8)
    expect(cfg.TYPING_HEARTBEAT_S).toBe(3)
    expect(cfg.CONFIDENCE_FLOOR).toBe(0.8)
    expect(cfg.MAX_BATCH).toBeGreaterThan(0)
    expect(cfg.HAIKU_CLASSIFY_TIMEOUT_MS).toBeLessThan(cfg.DM_TRIGGER_LOCK_DURATION_MS) // §4.3: timeout < lock
    expect(cfg.DEDUP_TTL_MS).toBeGreaterThan(cfg.DEAD_AIR_MS) // §4.2: ttl > longest delay
    expect(cfg.TYPING_TTL_S).toBeGreaterThan(2 * cfg.TYPING_HEARTBEAT_S) // no-flicker
  })
})
```
- [ ] **Step 2: Run → FAIL** `pnpm --filter @mythrun/backend test src/session/__tests__/dm-trigger-config.test.ts` (module not found).
- [ ] **Step 3: Implement**
```ts
// backend/src/session/dm-trigger-config.ts — MYT-67 §7. Shared by server (ws-session) + worker.
export const QUEUE_DM_TRIGGER = 'dm-trigger' as const
export const DM_TRIGGER_JOB_NAME = 'evaluate' as const
export const TYPING_HEARTBEAT_S = 3
export const TYPING_TTL_S = 8
export const QUIET_WINDOW_MS = 4_000
export const MAX_QUIET_EXTENSION_MS = 30_000   // continuous-typing cap
export const DEAD_AIR_MS = 60_000              // total-silence backstop
export const DEDUP_TTL_MS = DEAD_AIR_MS + 4_000 // must exceed the longest delay (dead-air) + pickup
export const MAX_BATCH = 30                    // classifier/turn batch cap
export const CONFIDENCE_FLOOR = 0.8
// dm-trigger worker BullMQ timing (mirror session-turn's H1 shape; Haiku timeout < lockDuration)
export const DM_TRIGGER_CONCURRENCY = 5
export const DM_TRIGGER_LOCK_DURATION_MS = 90_000
export const DM_TRIGGER_STALLED_INTERVAL_MS = 90_000
export const DM_TRIGGER_MAX_STALLED_COUNT = 1  // a stalled classify must NOT re-run (avoid double-fire); §4.3 fail-closed
export const HAIKU_CLASSIFY_TIMEOUT_MS = 60_000
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `git add backend/src/session/dm-trigger-config.ts backend/src/session/__tests__/dm-trigger-config.test.ts && git commit -m "feat(myth-67): dm-trigger shared config constants"`

---

### Task 2: Classification Zod schema

**Files:** Create `backend/src/llm/schemas/dm-trigger-classification.ts`; Test `backend/src/llm/schemas/__tests__/dm-trigger-classification.test.ts`

Spec §4.4. `{ shouldRespond, intent, complexity, confidence, reason }`. Prose `reason` = `.min()` only.

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect } from 'vitest'
import { DmTriggerClassificationSchema } from '../dm-trigger-classification.js'

describe('DmTriggerClassificationSchema', () => {
  it('accepts a valid classification', () => {
    const r = DmTriggerClassificationSchema.safeParse({
      shouldRespond: true, intent: 'proactive', complexity: 'high', confidence: 0.9, reason: 'table drifted off-topic',
    })
    expect(r.success).toBe(true)
  })
  it('rejects an out-of-range confidence and a bad intent', () => {
    expect(DmTriggerClassificationSchema.safeParse({ shouldRespond: false, intent: 'reactive', complexity: 'low', confidence: 1.5, reason: 'x' }).success).toBe(false)
    expect(DmTriggerClassificationSchema.safeParse({ shouldRespond: false, intent: 'nope', complexity: 'low', confidence: 0.5, reason: 'x' }).success).toBe(false)
  })
  it('rejects an empty reason', () => {
    expect(DmTriggerClassificationSchema.safeParse({ shouldRespond: false, intent: 'reactive', complexity: 'low', confidence: 0.5, reason: '' }).success).toBe(false)
  })
})
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
```ts
import { z } from 'zod'
export const DmTriggerClassificationSchema = z.object({
  shouldRespond: z.boolean(),
  intent: z.enum(['reactive', 'proactive']),
  complexity: z.enum(['low', 'high']),
  confidence: z.number().min(0).max(1),       // probability — max(1) is a real bound, not a prose cap
  reason: z.string().min(1),                  // prose: .min only, no .max
})
export type DmTriggerClassification = z.infer<typeof DmTriggerClassificationSchema>
```
- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(myth-67): dm-trigger classification schema`.

---

### Task 3: Classifier prompt template

**Files:** Create `backend/src/llm/prompts/session/dm-trigger-classifier.txt`; Test `backend/src/llm/prompts/__tests__/dm-trigger-classifier-prompt.test.ts`

Spec §4.4 — the respond/sit-back/step-in rubric + complexity + confidence anchoring + empty-batch + enforced ignorance.

- [ ] **Step 1: Write the failing test** (asserts the loader finds it + it carries the rubric anchors)
```ts
import { describe, it, expect } from 'vitest'
import { loadPrompt, _resetPromptCacheForTests } from '../../prompts.js'

describe('dm-trigger-classifier prompt', () => {
  it('loads and states the three-way decision + the confidence anchor + the public-only boundary', () => {
    _resetPromptCacheForTests?.()
    const p = loadPrompt('session', 'dm-trigger-classifier')
    expect(p.toLowerCase()).toContain('respond')
    expect(p.toLowerCase()).toContain('sit back')
    expect(p.toLowerCase()).toContain('step in')
    expect(p).toContain('0.8')           // confidence threshold anchored
    expect(p.toLowerCase()).toContain('secret') // states it must never reason about secrets/plot
  })
})
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — author `dm-trigger-classifier.txt` as a system-prompt instruction sheet. Required content (spec §4.4): the role (decide WHETHER the DM takes a turn, never WHAT it says); the three-way rubric with exemplars — *respond* (a player addressed the DM, an NPC, or acted on the world: "I check the wares", "I pick the lock"); *sit back* (grounded in-world banter advancing a scene); *step in* (several out-of-character/circular exchanges with the world untouched); the complexity rubric (light reaction → low, a beat needing the director → high); confidence anchoring with the explicit note that ≥ 0.8 means high confidence and < 0.8 should be treated as uncertain; the empty/all-addressed-to-others rule → don't respond; and the hard boundary: it sees only public conversation + pacing — it must never possess or reason about secrets/plot. No `{{vars}}` needed (context is passed as the user `prompt`).
- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(myth-67): dm-trigger classifier prompt template`.

---

### Task 6: Accepted-member count on the campaigns repo

**Files:** Modify `backend/src/repo/campaigns.ts`; Test `backend/src/repo/__tests__/campaigns-accepted-count.test.ts`

Spec §4.5 — solo = **accepted** members === 1; `listMembers` does NOT filter `invite_accepted`. Add a count using the `AND cm.invite_accepted = true` predicate.

- [ ] **Step 1: Write the failing test** (real DB, scoped fixtures — see CONVENTIONS). Seed an owner (accepted) + one pending invite; assert count === 1; accept the invite; assert 2.
```ts
// follow CONVENTIONS: createTestPool + makeTestScope; create campaign with owner, add a pending member, then accept.
// const repo = createRepo(pool); expect(await repo.campaigns.countAcceptedMembers(campaignId)).toBe(1)
```
- [ ] **Step 2: Run → FAIL** (method missing).
- [ ] **Step 3: Implement** — add to the campaigns binder:
```ts
async countAcceptedMembers(campaignId: string): Promise<number> {
  const { rows } = await c.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM campaign_members WHERE campaign_id = $1 AND invite_accepted = true`,
    [campaignId],
  )
  return rows[0]?.n ? Number(rows[0].n) : 0
}
```
- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(myth-67): campaigns.countAcceptedMembers (accepted-only)`.

---

### Task 13: `dm_invoke` client frame

**Files:** Modify `backend/src/contract/session-events.ts`, `backend/src/routes/ws-session.ts` (parseClientFrame only); Test `backend/src/contract/__tests__/session-events.test.ts` (extend), `backend/src/routes/__tests__/ws-session-parse.test.ts` (extend or add)

Spec §5. **Do this before Task 14** (both touch ws-session.ts). `dm_trigger` is NOT added to the server union (dev-only channel, §4.9).

- [ ] **Step 1: Write the failing test** — assert `classifyClientFrame('dm_invoke') === true` and `parseClientFrame('{"type":"dm_invoke"}', log)` returns `{type:'dm_invoke'}`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — `CLIENT_FRAME_TYPES = ['player_message','typing_start','typing_stop','dm_invoke'] as const`; add `| { type: 'dm_invoke' }` to `ClientFrame`; in `parseClientFrame` add an arm: `dm_invoke` has no fields, so once the allowlist passes, return `{ type: 'dm_invoke' }`.
- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(myth-67): dm_invoke client frame`.

---

### Task 4: Trigger Redis state (`trigger-state.ts`)

**Files:** Create `backend/src/session/trigger-state.ts`; Test `backend/src/session/__tests__/trigger-state.test.ts` (ioredis-mock)

Spec §4.1, §4.2, §4.7, §4.8, §6. All new trigger Redis keys, on the `${keyPrefix}session:${campaignId}:<suffix>` convention. Functional API `makeTriggerState(redis, keyPrefix)`.

- [ ] **Step 1: Write the failing test** (ioredis-mock)
```ts
import { describe, it, expect } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { makeTriggerState } from '../trigger-state.js'
const mk = () => makeTriggerState(new IoRedisMock() as unknown as Redis, 't:')

describe('trigger-state', () => {
  it('tracks typing presence with refresh + clear', async () => {
    const s = mk()
    await s.markTyping('c1', 'u1'); expect(await s.listTyping('c1')).toEqual(['u1'])
    await s.clearTyping('c1', 'u1'); expect(await s.listTyping('c1')).toEqual([])
  })
  it('stamps + reads last-activity and the dead-air anchor', async () => {
    const s = mk()
    await s.stampActivity('c1', 1000); expect(await s.lastActivityMs('c1')).toBe(1000)
    await s.armFirstUnresponded('c1', 1000) // first-only; second call no-ops
    await s.armFirstUnresponded('c1', 5000)
    expect(await s.firstUnrespondedMs('c1')).toBe(1000)
  })
  it('watermark + dm_responding + explicit-pending lifecycle', async () => {
    const s = mk()
    await s.setRespondedSeq('c1', 7); expect(await s.respondedSeq('c1')).toBe(7)
    await s.setResponding('c1', 'tok'); expect(await s.isResponding('c1')).toBe(true)
    await s.clearResponding('c1'); expect(await s.isResponding('c1')).toBe(false)
    await s.setExplicitPending('c1'); expect(await s.takeExplicitPending('c1')).toBe(true)
    expect(await s.takeExplicitPending('c1')).toBe(false) // take = atomic GETDEL
  })
  it('turn-error latch is one-shot per turnId', async () => {
    const s = mk()
    expect(await s.claimTurnErrorPublish('turn-1')).toBe(true)
    expect(await s.claimTurnErrorPublish('turn-1')).toBe(false)
  })
})
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `makeTriggerState(redis, keyPrefix)` returning the methods above. Keys (all `${keyPrefix}session:${campaignId}:...`): `typing:{userId}` (`SET '1' EX TYPING_TTL_S`; `listTyping` = SCAN the `typing:*` pattern → userIds; `clearTyping` = DEL), `last-activity` (`SET <ms>`), `first-unresponded` (`SET <ms> NX`-style — `armFirstUnresponded` uses `SET key val NX` so only the first wins; `clear` = DEL), `responded-seq` (`SET <int>` / GET), `dm_responding` (`SET <token> PX≈lock-ttl` / `clearResponding`=DEL / `isResponding`=EXISTS), `dm-trigger-explicit` (`setExplicitPending`=`SET '1'`; `takeExplicitPending`=`GETDEL` → bool). `claimTurnErrorPublish(turnId)` = `SET ${keyPrefix}turn-error-published:{turnId} '1' NX EX 60` → bool (the §4.8 cross-container latch). Use ioredis pipeline/SCAN per the session-state precedent.
- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(myth-67): trigger Redis state (typing + coordination keys)`.

---

### Task 5: Turn batch builder (`turn-batch.ts`)

**Files:** Create `backend/src/session/turn-batch.ts`; Test `backend/src/session/__tests__/turn-batch.test.ts`

Spec §4.3, §4.6 — `(lastRespondedSeq, max]` → `TriggerMessage[]`, capped, character-attributed (best-available name; true character mapping deferred — note inline).

- [ ] **Step 1: Write the failing test** with a fake repo (`sessionMessages.listAfterSeq` returns rows; `campaigns.listMembersBasic` returns the name map). Assert: only seq > lastRespondedSeq; capped to last `MAX_BATCH`; each `TriggerMessage` = `{userId, characterName: <displayName>, text}`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
```ts
import type { Repo } from '../repo/index.js'
import type { TriggerMessage } from './tiers/types.js'
import { MAX_BATCH } from './dm-trigger-config.js'
export async function buildTurnBatch(repo: Repo, campaignId: string, sessionId: string, lastRespondedSeq: number): Promise<{ batch: TriggerMessage[]; maxSeq: number }> {
  const rows = await repo.sessionMessages.listAfterSeq(sessionId, lastRespondedSeq) // seq > lastRespondedSeq, ASC
  const players = rows.filter((r) => r.messageType === 'player_message')
  const names = new Map((await repo.campaigns.listMembersBasic(campaignId)).map((m) => [m.user_id, m.display_name]))
  const capped = players.slice(-MAX_BATCH)
  const batch = capped.map((r) => ({ userId: r.userId, characterName: names.get(r.userId) ?? r.userId, text: r.content }))
  const maxSeq = players.length > 0 ? players[players.length - 1].seq : lastRespondedSeq
  return { batch, maxSeq }
}
```
(Note in a code comment: `characterName` uses display name until per-PC character mapping is wired in a later issue.)
- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(myth-67): turn-batch builder (watermark slice)`.

---

### Task 7: dm-trigger queue + debounce producer (`dm-trigger-queue.ts`)

**Files:** Create `backend/src/session/dm-trigger-queue.ts`; Test `backend/src/session/__tests__/dm-trigger-queue.test.ts`

Spec §4.2. The BullMQ **debounce-mode** producer. `DmTriggerQueueLike = { add: Queue<DmTriggerPayload>['add'] }`. NEW BullMQ feature for this codebase — uses `deduplication: {id, replace, ttl}` + `delay` (research-validated). Reschedule helpers compute the `delay` (normal `QUIET_WINDOW_MS`, clamped by the `MAX_QUIET_EXTENSION_MS` ceiling; dead-air re-arm passes a long delay).

- [ ] **Step 1: Write the failing test** — with a recording fake `{ add }`, assert `rescheduleDebounce(q,'c1', {...})` calls `add('evaluate', {campaignId:'c1'}, { deduplication: { id: 'dm-trigger:c1', replace: true, ttl: DEDUP_TTL_MS }, delay: <clamped> })`, and that the dead-air re-arm passes the supplied remaining-delay.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `DmTriggerPayload {campaignId: string}`; `DmTriggerQueueLike`; `dedupId(campaignId)='dm-trigger:'+campaignId`; `rescheduleDebounce(queue, campaignId, opts: {delayMs})` → `queue.add(DM_TRIGGER_JOB_NAME, {campaignId}, { deduplication: { id: dedupId(campaignId), replace: true, ttl: DEDUP_TTL_MS }, delay: opts.delayMs })`. Export `clampQuietDelay(nowMs, firstUnrespondedMs|null)` = `min(QUIET_WINDOW_MS, max(0, firstUnresponded + MAX_QUIET_EXTENSION_MS - now))` when `firstUnresponded` set, else `QUIET_WINDOW_MS`. (The server uses `clampQuietDelay`; the worker's dead-air re-arm passes `DEAD_AIR_MS - sinceLastActivity`.)
- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(myth-67): dm-trigger debounce queue producer`.

---

### Task 8: Haiku DM-trigger classifier (`dm-trigger-classifier.ts`)

**Files:** Create `backend/src/llm/dm-trigger-classifier.ts`; Test `backend/src/llm/__tests__/dm-trigger-classifier.test.ts` (mock `'ai'`)

Spec §4.4, §9. Public-by-construction `DmTriggerContext`; `generateObject(HAIKU, …, repairStrategy:'haiku-then-sonnet', timeoutMs:HAIKU_CLASSIFY_TIMEOUT_MS)`. (The wrapper has no "skip repair"; cheap-first repair + the short timeout + the §9 fail-closed caller honor the intent.)

- [ ] **Step 1: Write the failing test** — `vi.mock('ai', ...)` returning a fake `generateObject` output; assert `classifyDmTrigger(ctx)` returns the typed result; assert the call used HAIKU + the schema; assert an empty `messages` batch short-circuits to `{shouldRespond:false,...}` WITHOUT calling the model (cheap guard).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
```ts
import { generateObject } from './ai.js'
import { HAIKU } from './models.js'
import { loadPrompt } from './prompts.js'
import { DmTriggerClassificationSchema, type DmTriggerClassification } from './schemas/dm-trigger-classification.js'
import { HAIKU_CLASSIFY_TIMEOUT_MS } from '../session/dm-trigger-config.js'

export interface DmTriggerContext {            // public-by-construction (§4.4): no field can hold a secret
  readonly messages: ReadonlyArray<{ characterName: string; text: string }>
  readonly lastDmOutput: string | null
  readonly turnsSinceLastDmBeat: number
  readonly secondsSinceLastDmBeat: number
  readonly sceneGrounding: string | null       // public; empty while ST/Scribe stubbed
}
export async function classifyDmTrigger(ctx: DmTriggerContext): Promise<DmTriggerClassification> {
  if (ctx.messages.length === 0) return { shouldRespond: false, intent: 'reactive', complexity: 'low', confidence: 1, reason: 'empty batch' }
  const result = await generateObject({
    model: HAIKU,
    schema: DmTriggerClassificationSchema,
    schemaName: 'DmTriggerClassificationSchema',
    system: loadPrompt('session', 'dm-trigger-classifier'),
    prompt: serializeContext(ctx),            // a small deterministic serializer (character-attributed lines + pacing)
    repairStrategy: 'haiku-then-sonnet',
    timeoutMs: HAIKU_CLASSIFY_TIMEOUT_MS,
    callSite: 'dm-trigger-classifier',
  })
  return result.output
}
```
Write `serializeContext` to render the batch (character: text), the last DM line, and the pacing signal as plain text. **Do not** include any non-public field — the type forbids it structurally.
- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(myth-67): real Haiku DM-trigger classifier`.

---

### Task 10: `TurnJobPayload.trigger` field

**Files:** Modify `backend/src/session/turn-queue.ts`; Test extend `backend/src/session/__tests__/turn-queue.test.ts`

Spec §4.6. Additive; **no dedup id (H10 stands)**.

- [ ] **Step 1: Write the failing test** — `enqueueTurn` forwards a payload carrying `trigger: { kind: 'auto', classification: { intent:'proactive', complexity:'high', confidence:1 } }` to `queue.add(TURN_JOB_NAME, payload)` (assert the arg shape via a recording fake).
- [ ] **Step 2: Run → FAIL** (TS: `trigger` not on payload).
- [ ] **Step 3: Implement** — add to `TurnJobPayload`: `readonly trigger: { readonly kind: 'explicit' | 'solo' | 'auto'; readonly classification?: { readonly intent: 'reactive' | 'proactive'; readonly complexity: 'low' | 'high'; readonly confidence: number } }`. Leave `enqueueTurn` body unchanged (still no jobId).
- [ ] **Step 4: Run → PASS** (also fix any now-failing callers minimally — `dev-fire-turn.ts` is Task 17; if the typecheck breaks here, add `trigger:{kind:'explicit'}` at this call site too as part of this commit). **Step 5: Commit** `feat(myth-67): TurnJobPayload.trigger metadata (no dedup, H10)`.

---

### Task 11: turn-worker — dm_responding + watermark + explicit drain + latch

**Files:** Modify `backend/src/session/turn-worker.ts`; Test extend `backend/src/session/__tests__/turn-worker.test.ts`

Spec §4.7, §4.8, §3. Add `triggerState: TriggerState` to `TurnProcessorDeps`. On run: set `dm_responding` after lock acquire; on flush, `setRespondedSeq` to the batch's max seq (derive from `job.data.triggerMessages` — the max seq isn't on the payload, so **also add `maxSeq` to `TurnJobPayload`** OR record from the batch; simplest: add `readonly maxConsumedSeq: number` to the payload, set by the producer in T9/T14). In `finally` after `release()`: `clearResponding`; if `takeExplicitPending(campaignId)` → enqueue an explicit `session-turn` immediately (the §4.7 immediate drain). Guard `publishTerminalTurnError` with `triggerState.claimTurnErrorPublish(turnId)` (the §4.8 latch).

- [ ] **Step 1: Write the failing test** (extend the existing ioredis-mock + fake-lock harness): assert `dm_responding` is set during the body and cleared after; assert `respondedSeq` advances to `maxConsumedSeq` after a successful flush; assert that with an explicit-pending flag set, release enqueues one explicit turn; assert `publishTerminalTurnError` publishes only once across two calls for the same `turnId` (latch).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the above. Add `maxConsumedSeq: number` to `TurnJobPayload` (Task 10 sibling field — fold into T10 if cleaner) and have `setRespondedSeq(campaignId, job.data.maxConsumedSeq)` run inside the success path (after `flushToRedis`). Thread `triggerState` + a `dmTriggerQueue` (for the explicit drain) into `buildSessionTurnWorker`’s deps (built from `redisRealtime`/`redisBatch` + key prefix). Update `publishTerminalTurnError` to take the latch (or wrap its call site). Keep the lock-lost abort path unchanged.
- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(myth-67): turn-worker dm_responding + watermark + explicit drain + turn_error latch`.

---

### Task 12: QueueEvents terminal turn_error (`session-turn-queue-events.ts`)

**Files:** Create `backend/src/session/session-turn-queue-events.ts`; Test `backend/src/session/__tests__/session-turn-queue-events.test.ts`

Spec §4.8 — closes myth-tvnb. Dedicated `duplicate()`d connection; the `failed` broker event → `publishTerminalTurnError` guarded by the same `claimTurnErrorPublish` latch.

- [ ] **Step 1: Write the failing test** — mock `bullmq`'s `QueueEvents` (capture the `on('failed')` handler), invoke it with a fake `{jobId}`, assert it fetches the job + calls the latched publish once; assert the subscriber exposes a `close()`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `buildSessionTurnQueueEvents(redisBatch, redisRealtime, redisKeyPrefix, logger)`: create `new QueueEvents(QUEUE_SESSION_TURN, { connection: redisBatch.duplicate() })`; on `'failed'` `({jobId})` → fetch the job (via a `Queue` handle or the payload from the event), and if its retries are exhausted, `if (await triggerState.claimTurnErrorPublish(turnId)) publisher.turnError(...)`. Return `{ queueEvents, close }`. (Note in a comment: the JS `worker.on('failed')` path in turn-worker shares the same latch, so exactly one frame ships cluster-wide.)
- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(myth-67): QueueEvents terminal turn_error (closes myth-tvnb)`.

---

### Task 9: dm-trigger worker (`dm-trigger-worker.ts`)

**Files:** Create `backend/src/session/dm-trigger-worker.ts`; Test `backend/src/session/__tests__/dm-trigger-worker.test.ts`

Spec §4.3 — the heart. `processDmTriggerJob(deps, job)` then `buildDmTriggerWorker(...)`. Inject all deps (repo, triggerState, dmTriggerQueue, sessionTurnQueue, classify fn, publisher, now()).

- [ ] **Step 1: Write the failing tests** (unit, injected fakes — no broker):
  - dead-air: `secondsSinceLastActivity ≥ DEAD_AIR_S` + non-empty batch + not responding → enqueues a `session-turn` with `trigger.kind:'auto'`, `classification.intent:'proactive'`, and does NOT call the classifier.
  - empty batch → exits, no enqueue (no-monologue).
  - solo (countAcceptedMembers===1) → enqueues, classifier not called.
  - auto: classifier `shouldRespond:true` → enqueue with the returned classification; `shouldRespond:false` → no enqueue + re-arm the debounce toward the dead-air mark.
  - in-flight (`isResponding` true) → no enqueue.
  - late-reset (`now - lastActivity < QUIET_WINDOW_MS`) → re-arm the debounce, no enqueue.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the ordered logic from §4.3: (1) re-validate quiet → re-arm + exit if a reset landed; (2) resolve active session (`getActiveByCampaign`; null → exit), watermark, build batch (T5); empty → exit; (3) decide: dead-air (skip classifier) / explicit-pending (`takeExplicitPending`) / solo (`countAcceptedMembers`) / auto (`classifyDmTrigger` over a `DmTriggerContext` built from the batch + pacing + `loadTurnState` summary as the public `sceneGrounding`/lastDmOutput); on auto sit-back → re-arm toward dead-air; (4) drain-guard (`isResponding`) → enqueue `session-turn` (with `maxConsumedSeq` from the batch) + structured-log the decision (the §4.9 dev signal). `buildDmTriggerWorker(redisBatch, redisRealtime, redisKeyPrefix, repo, sessionTurnQueue, dmTriggerQueue, logger)` wires a `new BullmqWorker(QUEUE_DM_TRIGGER, processor, { connection: redisBatch, concurrency: DM_TRIGGER_CONCURRENCY, lockDuration: DM_TRIGGER_LOCK_DURATION_MS, stalledInterval: DM_TRIGGER_STALLED_INTERVAL_MS, maxStalledCount: DM_TRIGGER_MAX_STALLED_COUNT })`.
- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(myth-67): dm-trigger worker (quiet-window decide → enqueue)`.

---

### Task 14: ws-session trigger integration

**Files:** Modify `backend/src/routes/ws-session.ts` (+ `WsSessionDeps`), `backend/src/app.ts` (deps wiring — coordinate with Task 15); Test extend `backend/src/routes/__tests__/ws-session*.test.ts`

Spec §4.1, §4.2, §4.5, §8. **After Task 13.** Add to `WsSessionDeps`: `dmTriggerQueue: DmTriggerQueueLike`, `sessionTurnQueue: TurnQueueLike`, `triggerState: TriggerState`, `turnPublisher: TurnPublisher`. In `handleInbound`:
- `typing_start` → `triggerState.markTyping` + `stampActivity(now)` + `armFirstUnresponded(now)` + `rescheduleDebounce(clampQuietDelay)`, then `hub.publish` (unchanged).
- `typing_stop` → `triggerState.clearTyping` + `hub.publish`.
- `player_message` → (persist+broadcast, unchanged) then: clear sender typing; `stampActivity`/`armFirstUnresponded`; if explicit (`@dm`/`@DM` prefix) → the explicit path; else `rescheduleDebounce`.
- `dm_invoke` → the explicit path.
- **Explicit path** (§4.5): rate-limit (per campaign+user, in-memory token bucket or a Redis counter — bounded; reuse the dev-fire-turn `config.rateLimit` idea but per-identity); if NOT `isResponding`: allocate `turnId`, `turnPublisher.dmThinking(campaignId, turnId)` immediately, build batch, `enqueueTurn(sessionTurnQueue, {…, turnId, trigger:{kind:'explicit'}, maxConsumedSeq})`; else `setExplicitPending`.
- `handleDisconnect` → `triggerState.clearTyping`.

- [ ] **Step 1: Write the failing tests** — a typing_start reschedules the debounce (assert the fake queue `add` shape) + marks typing; a `@dm` message with no in-flight turn publishes `dm_thinking` + enqueues a `session-turn{kind:'explicit'}`; a `@dm` with `isResponding` sets explicit-pending instead; a normal message reschedules the debounce (no immediate enqueue).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the handler changes + extend `WsSessionDeps`; build the new deps in `app.ts` (the `triggerState`/`turnPublisher`/queues from the AppDeps — coordinate with Task 15 which adds them to AppDeps). Keep the persist-then-broadcast invariant; reschedule AFTER persist; log (warn) on a reschedule failure (don't swallow silently). The `@dm` literal prefix check is `text.trimStart().toLowerCase().startsWith('@dm')`.
- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(myth-67): ws-session trigger integration (typing, debounce, explicit preempt)`.

---

### Task 15: Queue + deps wiring

**Files:** Modify `backend/src/server-queues.ts`, `backend/src/app-deps.ts`, `backend/src/server.ts`, `backend/src/app.ts`; Test extend the relevant wiring/contract tests

Spec §3, §14. Add the dm-trigger producer + thread `dmTriggerQueue` + `triggerState` + the existing `sessionTurnQueue` + a `turnPublisher` into the ws-session route deps.

- [ ] **Step 1: Write the failing test** — assert `buildDmTriggerQueue(redisBatch)` returns `{ bullmqQueue, dmTriggerQueue }` with a working `add`; assert `stubDmTriggerQueue()` rejects on `.add`. (Mirror the session-turn queue tests.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `buildDmTriggerQueue`/`stubDmTriggerQueue` in server-queues.ts (mirror `buildSessionTurnQueue`, `defaultJobOptions: { removeOnComplete: true, removeOnFail: true, attempts: 1 }` — a trigger eval must not blind-retry); add `dmTriggerQueue: DmTriggerQueueLike` to `AppDeps`; in server.ts build it on the batch ref + thread into `createApp` + close on shutdown; in app.ts pass `dmTriggerQueue`, `sessionTurnQueue`, a `makeTriggerState(redisRealtime, keyPrefix)`, and `createTurnPublisher(redisRealtime, keyPrefix)` into `wsSessionRoutes` deps.
- [ ] **Step 4: Run → PASS** (`pnpm --filter @mythrun/backend typecheck` must be clean — the AppDeps change ripples to stub-deps + fixtures; fix them). **Step 5: Commit** `feat(myth-67): wire dm-trigger queue + trigger deps into the app`.

---

### Task 16: worker.ts — register dm-trigger worker + QueueEvents

**Files:** Modify `backend/src/worker.ts`; Test extend `backend/src/__tests__/worker.test.ts`

Spec §3, §4.8. Worker count 4 → 5 + the QueueEvents subscriber + shutdown.

- [ ] **Step 1: Update the failing test** — change the asserted worker count 4 → 5; assert the `dm-trigger` worker + the `QueueEvents` subscriber are built and closed on SIGTERM.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — build `buildDmTriggerQueue(redisBatch)` producer in worker.ts (the worker needs to re-arm the debounce → it needs the producer), `buildDmTriggerWorker(...)`, and `buildSessionTurnQueueEvents(...)`; add the worker to the `workers` array + `QUEUE_DM_TRIGGER` to `queues`; add the worker + the QueueEvents `close()` to the shutdown set. The dm-trigger worker needs `repo` (pg) → it already has `pg`; build `createRepo(pg)`.
- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(myth-67): register dm-trigger worker + session-turn QueueEvents in worker.ts`.

---

### Task 17: dev-fire-turn — set `trigger.kind`

**Files:** Modify `backend/src/routes/dev-fire-turn.ts`; Test extend its test

Spec §4.6. (If Task 10 already added it to satisfy typecheck, this task just adds the explicit test + `maxConsumedSeq`.)

- [ ] **Step 1: Failing test** — the dev route enqueues a payload with `trigger.kind:'explicit'`.
- [ ] **Step 2–4:** set `trigger: { kind: 'explicit' }` (+ `maxConsumedSeq`: read `repo.sessionMessages.maxSeq(sessionId)`) in the `enqueueTurn` payload; run.
- [ ] **Step 5: Commit** `feat(myth-67): dev-fire-turn sets trigger.kind=explicit`.

---

### Task 18: dev-tool panel + verifier

**Files:** Create `backend/dev-tool/src/components/dm-trigger-panel.ts`; Modify `backend/dev-tool/verify-registry.ts`

Built by the **dev-tool-verifier subagent** (per `docs/wiki/AUTHORING.md` / the dev-tool workflow), NOT hand-written here. MYT-67 adds **no new REST route**, so route-exhaustion is already satisfied; the panel is an **event-driven** observer of the session wire (it drives typing/messages and watches `dm_thinking` + the structured trigger logs). The verifier writes `tmp/.dev-tool-verifier-ok`.

- [ ] Dispatch the dev-tool-verifier (general-purpose Opus) after Tasks 14–16 land. It builds the panel (event-driven, observing the trigger flow), updates `verify-registry.ts` if needed, runs `pnpm --filter @mythrun/dev-tool typecheck` + `dev-tool:verify`, and writes the marker. Controller commits its files.

---

### Task 19: Full verification + E2E wire smoke

Spec §10. **No new behavior — gates only.**

- [ ] `pnpm --filter @mythrun/backend typecheck && pnpm --filter @mythrun/backend lint`
- [ ] `pnpm --filter @mythrun/backend test` (all green; the new debounce/maturity/drain/dead-air/latch unit tests included)
- [ ] **E2E wire smoke (required — real Anthropic key, wire level):** start `pnpm dev`; open a real WS to an active session; (a) send `typing_start` heartbeats then a `player_message`, go quiet → assert `dm_thinking` fires after ~the quiet window and the structured classifier log shows a decision; (b) send `@dm` → assert `dm_thinking` is near-immediate; (c) 1-member campaign → assert it fires without a classifier call (log shows the solo skip); (d) leave the table silent ~60s after an unresponded message → assert the dead-air step-in fires once and not again with no new message. Drive via a WS client (wscat/node) + `psql`/logs — NOT browser automation. Assert observable end state (`dm_thinking` for the specific turnId), not "no errors".
- [ ] If all green: hand to the wiki subagent (AUTHORING.md, param MYT-67) → then the single `git push` → flip MYT-67 Done.

---

## Self-review

- **Spec coverage:** §4.1 typing-state→T4/T14; §4.2 debounce+ceiling+ttl→T1/T7/T9; §4.3 worker decide+dead-air+re-arm→T9; §4.4 classifier (3-way, public input, intent, repair)→T2/T3/T8; §4.5 explicit-immediate+solo+rate-limit→T14/T6; §4.6 payload→T10; §4.7 collision/drain (dm_responding, watermark, explicit drain)→T11; §4.8 QueueEvents+latch→T11/T12; §4.9 dev signal (log + panel)→T9/T18; §5 dm_invoke→T13; §6 keys→T4; §7 config→T1; §10 tests→every task + T19; §11 scope (MYT-76 out)→respected. **No gap.**
- **Type consistency:** `TriggerState` (T4), `DmTriggerContext` (T8), `TurnJobPayload.trigger`+`maxConsumedSeq` (T10/T11), `DmTriggerQueueLike` (T7) used consistently downstream. `maxConsumedSeq` is introduced in T10/T11 and produced by T9/T14/T17 — flagged so all producers set it.
- **Placeholders:** none — every step has concrete code or a concrete behavior cite. The prompt text (T3) is content-authored against the spec rubric (asserted by the loader test).
- **Open follow-up (not a blocker):** character-name attribution uses display name until per-PC characters are wired (noted in T5); the dev-only `dm_trigger` channel is realized as structured logs for MYT-67 (the panel observes logs + `dm_thinking`) — a richer dev SSE channel can come with the frontend.
