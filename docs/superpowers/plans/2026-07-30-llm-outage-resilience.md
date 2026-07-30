# LLM Outage Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec v5 (`docs/superpowers/specs/2026-07-30-llm-outage-resilience-design.md`): fast LLM-failure discovery (two-dispatcher transport + streaming migration + wrapper-owned attempts), Redis-shared outage state with a recovery probe, self-delaying prep parking, and the sitewide notice strip.

**Architecture:** A pure taxonomy module and a transport module land first; the ai.ts core absorbs the attempt loop + sink seam + streaming transport switch; a Redis tracker and a stamps table carry shared state; processors park via `moveToDelayed`; a probe queue clears; one public route + a DS strip surface it. Waves: W1 = Tasks 1–6 (disjoint), W2 = Tasks 7–10, W3 = controller verification.

**Tech Stack:** undici (npm, new dep), ai@6 SDK, ioredis + Lua, BullMQ 5.76, Postgres migration 038, Fastify route, React/react-query + @mythrun/ui.

## Global Constraints

- Spec v5 is NORMATIVE — every number (10s/60s/120s/300s timeouts, 10-min window, ≥3 events ≥2 callsites-or-jobs, 3 probe successes, 30s→2m→5m→15m hold ladder, 6h `parkConsumedMs` cap, 5-min overdue grace) comes from it verbatim.
- Failure-class enum: `'connectivity' | 'rate-limit' | 'abort' | 'other'`. Park-eligible = connectivity OR rate-limit. Outage signal = connectivity ONLY (and only streaming-dispatcher pre-headers aborts).
- ai.ts stays dependency-free (sink injection seam); classification at the ai.ts boundary; `logAndNormalizeMiddleware` mapping unchanged EXCEPT the one in-band stream-error mapping addition.
- Never hardcode model ids — `models.ts` constants. ZFC: all logic here is mechanical (codes, counters, timers) — no LLM judgment calls.
- No `any`; single pre-authorized cast: npm-undici fetch → the SDK's `FetchFunction`.
- Redis keys namespaced `llm-health:` under the existing `redisKeyPrefix` discipline.
- Frontend: components in @mythrun/ui + story; no className on DS components in app code; copy via i18n keys, new strings flagged for the copy veto pass; `[ph:]` placeholders where the spec says so.
- TDD everywhere; implementers run scoped tests only (controller sweeps); implementers never commit (controller commits serially).
- Backend has a 100%-coverage gate — every new module ships with complete branch coverage.
- Wave discipline: W1 = Tasks 1–6 parallel (disjoint files); W2 = Tasks 7–10 (7∥8∥9 disjoint, 10 after 6); W3 = Task 11 (controller).

---

## File map

| File | Task | Action |
|---|---|---|
| `backend/src/llm/classify-llm-error.ts` (+test) | 1 | create — pure taxonomy |
| `backend/src/llm/llm-fetch.ts` (+test) | 2 | create — dispatchers + observable fetch |
| `backend/src/llm/models.ts` | 2 | wire `createAnthropic({ fetch })` |
| `backend/package.json` | 2 | `pnpm add undici` |
| `backend/src/llm/__tests__/llm-fetch.stall-server.test.ts` | 2 | create — local stall-server integration |
| `backend/src/llm/llm-health.ts` (+test) | 3 | create — Redis tracker (report/arm/clear Lua, reads) |
| `backend/src/llm/ai.ts` | 4 | attempt loop, sink seam, streaming transport switch, stream error-part observer, repair timeouts |
| `backend/src/llm/middleware.ts` | 4 | in-band `overloaded_error`/`api_error` mapping |
| `backend/src/llm/errors.ts` | 4 | export `LlmUpstreamError` (500-class) if absent |
| `backend/migrations/038_llm_resume_stamps.sql` | 5 | create |
| `backend/src/repo/resume-stamps.ts` (+test) | 5 | create |
| `backend/src/repo/__tests__/migrate-schema.test.ts` | 5 | pin migration 038 |
| `frontend/client-core/src/api/llm-health.ts` + web `use-llm-health.ts` (+tests) | 6 | create hook chain |
| `frontend/client-core/src/contract/notice-strip.ts`, `frontend/ui/.../NoticeStrip/*` | 6 | create DS component |
| `backend/src/llm/llm-health-probe.ts` (+test), `server-queues.ts`, `worker.ts` | 7 | probe queue + repeatable + fast-path scan |
| `backend/src/repo/pipeline-runs.ts` (+tests) | 8 | `in-flight` claim result; claim clears `next_resume_at` |
| `backend/src/llm/prep/world-gen-processor.ts` (+tests), `backend/src/sse/derive-phase.ts` (+tests) | 8 | parking + resuming/overdue arms |
| `backend/src/llm/prep/session-prep-processor.ts`, `character-creation-processor.ts` (+tests), `backend/src/worker.ts` QueueEvents | 9 | parking + jobId-recovery + their status derivations |
| `backend/src/routes/llm-health.ts` (+test), `backend/src/routes/index` registration | 10 | create route |
| `frontend/src/app/app-frame.tsx` (+test), worldgen `generating.tsx`/`reveal.tsx`/`campaign-detail.tsx` (+tests), i18n common.json + descriptions.ts | 10 | strip mount + hold copy + ETA suppression |

---

### Task 1: Error taxonomy module

**Files:** Create `backend/src/llm/classify-llm-error.ts`, Test `backend/src/llm/__tests__/classify-llm-error.test.ts`.

**Interfaces — Produces:**

```ts
export type LlmFailureClass = 'connectivity' | 'rate-limit' | 'abort' | 'other'
export interface LlmFailureContext {
  /** 'streaming' | 'non-streaming' from the transport observable; null when unknown. */
  readonly mode: 'streaming' | 'non-streaming' | null
  /** Whether response headers had arrived when the failure surfaced; null when unknown. */
  readonly headersArrived: boolean | null
}
export interface LlmFailureVerdict {
  readonly retryWorthy: boolean
  readonly outageSignal: boolean
  readonly failureClass: LlmFailureClass
}
export function classifyLlmError(err: unknown, ctx: LlmFailureContext): LlmFailureVerdict
```

Implements spec §1.2 verbatim: the unwrap walk (RetryError any-member for the outage axis / last-member for retry; AggregateError; APICallError statusCode ≥400 else cause; mapped classes; generic cause recursion depth 5), base cases by `code` STRING (all `UND_ERR_*`, errnos incl. `EHOSTUNREACH`/`ENETUNREACH`, `EPROTO`/`ERR_TLS_*` prefix, bare OpenSSL verify codes), HTTP statuses (500/502/503/504/529 → connectivity axis pair; 429 → `{retryWorthy: true, outageSignal: false, failureClass: 'rate-limit'}`), the dispatcher-aware abort rule (abort predicate: `DOMException` named `AbortError`/`TimeoutError` OR `LlmTimeoutError`; pre-headers + streaming → connectivity; pre-headers + non-streaming → `{retryWorthy: true, outageSignal: false, failureClass: 'abort'}`; post-headers → other/abort non-retry), and the in-band raw payload shape (object with `.type` in {`overloaded_error`,`api_error`} — classified directly so Task 4's observer can pass raw parts).

- [ ] **Step 1: Failing tests** — one `it.each` fixture table covering every §5 fixture verbatim. Representative rows (write ALL of these):

```ts
import { describe, it, expect } from 'vitest'
import { APICallError, RetryError } from 'ai'
import { classifyLlmError } from '../classify-llm-error.ts'
import { LlmTimeoutError, LlmOverloadedError } from '../errors.ts'

const und = (code: string): Error => Object.assign(new Error(code), { code })
const CTX_S = { mode: 'streaming', headersArrived: false } as const
const CTX_NS = { mode: 'non-streaming', headersArrived: false } as const

describe('classifyLlmError', () => {
  it('headers timeout (bare undici code) → connectivity both axes', () => {
    expect(classifyLlmError(und('UND_ERR_HEADERS_TIMEOUT'), CTX_S)).toEqual({
      retryWorthy: true, outageSignal: true, failureClass: 'connectivity',
    })
  })
  it('incident shape: APICallError wrapping the undici error, no statusCode', () => {
    const e = new APICallError({ message: 'Cannot connect to API: Headers Timeout Error', url: '', requestBodyValues: {}, cause: und('UND_ERR_HEADERS_TIMEOUT') })
    expect(classifyLlmError(e, CTX_NS).failureClass).toBe('connectivity')
  })
  it('RetryError [headers-timeout, abort]: outage axis sees ANY member', () => {
    const e = new RetryError({ message: 'Failed after 2 attempts.', reason: 'maxRetriesExceeded', errors: [und('UND_ERR_HEADERS_TIMEOUT'), new LlmTimeoutError('llm call aborted')] })
    const v = classifyLlmError(e, CTX_NS)
    expect(v.outageSignal).toBe(true) // any-member rule
  })
  it('mid-body death: statusCode 200 wrapper recurses into cause', () => {
    const e = new APICallError({ message: 'Failed to process successful response', url: '', requestBodyValues: {}, statusCode: 200, cause: new TypeError('terminated', { cause: und('UND_ERR_BODY_TIMEOUT') }) })
    expect(classifyLlmError(e, CTX_S).failureClass).toBe('connectivity')
  })
  it('in-band raw payload: overloaded_error object', () => {
    expect(classifyLlmError({ type: 'overloaded_error', message: 'Overloaded' }, CTX_S).failureClass).toBe('connectivity')
  })
  it('429 → retry-worthy, never signal, rate-limit class', () => {
    const e = new APICallError({ message: 'rate', url: '', requestBodyValues: {}, statusCode: 429 })
    expect(classifyLlmError(e, CTX_NS)).toEqual({ retryWorthy: true, outageSignal: false, failureClass: 'rate-limit' })
  })
  it('pre-headers abort: streaming → connectivity; non-streaming → abort, no signal', () => {
    const abort = new LlmTimeoutError('llm call aborted')
    expect(classifyLlmError(abort, CTX_S).outageSignal).toBe(true)
    expect(classifyLlmError(abort, CTX_NS)).toEqual({ retryWorthy: true, outageSignal: false, failureClass: 'abort' })
  })
  it('post-headers abort → other axis pair, non-retry', () => {
    const abort = new LlmTimeoutError('llm call aborted')
    expect(classifyLlmError(abort, { mode: 'streaming', headersArrived: true })).toEqual({ retryWorthy: false, outageSignal: false, failureClass: 'abort' })
  })
  it('LlmOverloadedError (mapped 529) → connectivity', () => {
    expect(classifyLlmError(new LlmOverloadedError('overloaded'), CTX_S).outageSignal).toBe(true)
  })
  it('schema/validation error → other, no retry', () => {
    expect(classifyLlmError(new Error('schema mismatch'), CTX_S)).toEqual({ retryWorthy: false, outageSignal: false, failureClass: 'other' })
  })
  it('cause-chain depth bound: 6-deep connectivity is NOT found (bounded at 5)', () => {
    let e: Error = und('ECONNRESET')
    for (let i = 0; i < 6; i++) e = new Error(`w${String(i)}`, { cause: e })
    expect(classifyLlmError(e, CTX_S).failureClass).toBe('other')
  })
  // ...plus one row per remaining code: UND_ERR_CONNECT_TIMEOUT, UND_ERR_BODY_TIMEOUT,
  // UND_ERR_SOCKET, ECONNREFUSED, ETIMEDOUT, EPIPE, ENOTFOUND, EAI_AGAIN, EHOSTUNREACH,
  // ENETUNREACH, EPROTO, ERR_TLS_CERT_ALTNAME_INVALID, CERT_HAS_EXPIRED,
  // DEPTH_ZERO_SELF_SIGNED_CERT, UNABLE_TO_VERIFY_LEAF_SIGNATURE, statuses 500/502/503/504/529,
  // AggregateError any-member, external-abort DOMException, api_error raw payload → connectivity? NO:
  // api_error maps 500-class → connectivity axes per the table.
})
```

- [ ] **Step 2:** `pnpm --filter @mythrun/backend exec vitest run src/llm/__tests__/classify-llm-error.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Implement per the Produces contract. Match codes via `(err as {code?: unknown}).code === 'string'` checks (never instanceof — two undici realms); statuses via the APICallError `statusCode` field ≥400; the walk in the §1.2 order; comment each rule with its spec item number.
- [ ] **Step 4:** Run — PASS. `pnpm --filter @mythrun/backend typecheck`.

### Task 2: Transport — dispatchers, observable fetch, models wiring

**Files:** Create `backend/src/llm/llm-fetch.ts` + `backend/src/llm/__tests__/llm-fetch.test.ts` + `backend/src/llm/__tests__/llm-fetch.stall-server.test.ts`; Modify `backend/src/llm/models.ts` (provider creation only); `pnpm add undici` in backend.

**Interfaces — Produces:**

```ts
export interface FetchObservation {
  readonly mode: 'streaming' | 'non-streaming'
  readonly headersArrived: boolean
  readonly invocationCount: number
}
/** Build a per-attempt fetch: routes by body ("stream":true → streaming dispatcher,
 *  non-string body → non-streaming), records last-invocation-wins observation. */
export function createObservedFetch(): { fetch: typeof globalThis.fetch; observation: () => FetchObservation | null }
/** The default provider fetch used by models.ts (fresh observation per invocation, discarded). */
export function providerFetch(): typeof globalThis.fetch
```

Dispatchers (module-scoped undici Agents): streaming `{connect: {timeout: 10_000}, headersTimeout: 60_000, bodyTimeout: 120_000}`; non-streaming `{connect: {timeout: 10_000}, headersTimeout: 300_000, bodyTimeout: 300_000}`. Implementation uses npm-undici `fetch` with the `dispatcher` option; the returned function carries the ONE pre-authorized cast to the SDK's fetch type at the models.ts call site.

- [ ] **Step 1: Failing unit tests** (mock undici fetch via vi.mock):

```ts
it('routes "stream":true bodies to the streaming dispatcher, others to non-streaming', async () => { /* assert dispatcher option identity per call */ })
it('non-string body routes non-streaming (fail-safe)', async () => { /* Request/FormData body */ })
it('records headersArrived=true once the response resolves; false while pending/rejected', async () => { /* resolve vs reject paths */ })
it('last-invocation-wins: two sequential invocations leave the second observation', async () => { /* invocationCount 2 */ })
```

- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement (body sniff: `typeof init?.body === 'string' && init.body.includes('"stream":true')`). **Step 4:** PASS.
- [ ] **Step 5: Stall-server integration test** (`llm-fetch.stall-server.test.ts`): start a local `node:http` server that (a) never sends headers → assert the STREAMING fetch rejects in ~60s with `UND_ERR_HEADERS_TIMEOUT` surfaced through `classifyLlmError` as connectivity (use vitest testTimeout 90_000 and a REDUCED-timeout test Agent injected via an exported factory `createDispatchers(overrides?)` so the test runs in ~2s, not 60 — assert the CODE path, override the numbers); (b) sends headers then idles the body → `UND_ERR_BODY_TIMEOUT` → connectivity, `headersArrived: true` recorded. This pins npm-undici v7 behavior.
- [ ] **Step 6: models.ts wiring** — replace the three `anthropic(ID)` calls' provider with a module-level `const anthropicProvider = createAnthropic({ fetch: providerFetch() as FetchFunction })` (import `createAnthropic` from `@ai-sdk/anthropic`; the cast is the pre-authorized exception, commented). Keep middleware wrapping identical. Run `pnpm --filter @mythrun/backend exec vitest run src/billing/__tests__/model-pricing.test.ts src/llm/__tests__/ai.test.ts` + typecheck to prove no provider regression.

### Task 3: Redis health tracker

**Files:** Create `backend/src/llm/llm-health.ts`, Test `backend/src/llm/__tests__/llm-health.test.ts` (constructed-state, real Redis via the existing test-redis helper — grep `createTestRedis`/how bullmq tests get redis and mirror).

**Interfaces — Produces:**

```ts
export interface LlmHealthReport {
  readonly callsite: string
  readonly jobId: string
  readonly modelId: string
  readonly mode: 'streaming' | 'non-streaming' | null
}
export interface LlmHealthState { readonly state: 'ok' | 'degraded'; readonly since: number | null }
export interface LlmHealthTracker {
  /** Fire-and-forget from ai.ts (sink). ZADDs the window (JSON member, Redis TIME score, prune), and runs the Lua arm script (threshold ≥3 in 10min spanning ≥2 callsites OR ≥2 jobs → SET NX state + SADD models + reset counter). Also resets probe-successes when already degraded. */
  report(r: LlmHealthReport): Promise<void>
  read(): Promise<LlmHealthState>
  readModels(): Promise<readonly string[]>
  /** Probe support: increment successes; at 3 runs the Lua clear (verify counter, DEL state+counter+window+models) and returns 'cleared'. */
  probeSuccess(): Promise<'counting' | 'cleared'>
  probeFailure(): Promise<void> // reset counter + refresh state TTL
}
export function createLlmHealthTracker(redis: Redis, keyPrefix: string): LlmHealthTracker
```

Keys per spec §2.1 (window ZSET 30-min TTL + prune; state JSON `{since}` TTL 30 min; models SET; counter TTL 30 min). Both transitions are Lua (arm: evaluate+SETNX+seed atomically; clear: verify+DEL atomically). Log events `llm_health.degraded` (window summary + models) / `llm_health.recovered` (duration) via the injected pino logger (add `logger` param).

- [ ] **Step 1: Failing constructed-state tests:** threshold flip exactly at the 3rd qualifying event (2 events same callsite+job → still ok; 3rd from a second callsite → degraded); distinctness (3 events one callsite one job → ok; two jobs same callsite → degraded); 10-min horizon (stale events don't count); probeSuccess ×3 → cleared + all four keys gone; a report while degraded resets the counter; counter/models seeded at arm; models union on later reports (SADD); prune bounds the ZSET.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (Lua via `redis.defineCommand` or `redis.eval`, matching repo Redis idioms). **Step 4:** PASS + typecheck.

### Task 4: ai.ts core — attempt loop, sink seam, streaming transport, stream observer, repair surfacing

**Files:** Modify `backend/src/llm/ai.ts`, `backend/src/llm/middleware.ts`, `backend/src/llm/errors.ts` (add `LlmUpstreamError` 500-class if no equivalent exists); Test `backend/src/llm/__tests__/ai.test.ts` (extend) + `backend/src/llm/__tests__/cost-middleware.test.ts` (keep green).

**Interfaces — Consumes:** Task 1 `classifyLlmError`, Task 2 `createObservedFetch`. **Produces:**

```ts
// New GenerateObjectOpts fields (contract for Task 8/9 call sites):
readonly stageBudgetMs?: number            // arms the loop; absent = legacy single-shot behavior
readonly expectedHealthyDurationMs?: number // retry gate; default 60_000
readonly skipHealthReport?: boolean
// Sink seam:
export type LlmHealthSink = (report: { callsite: string; jobId: string; modelId: string; mode: 'streaming' | 'non-streaming' | null; failureClass: 'connectivity' }) => void
export function setLlmHealthSink(sink: LlmHealthSink | null): void
```

Behavior (spec §1.3, all normative): loop only when `stageBudgetMs` present; SDK `maxRetries: 0` on loop-scoped calls; **streaming transport under the hood** for loop-scoped generateObject (drive `streamText` + `Output.object` — the non-deprecated path — with the same schema/validation/repair semantics; native-strict parity verified by the existing ai.test schemas); each attempt: fresh `createObservedFetch()` threaded via per-call provider… the SDK model is shared, so the per-attempt fetch rides `providerOptions`? NO — the model is constructed once in models.ts. **Mechanism (normative):** ai.ts wraps loop-scoped calls with a per-attempt AbortController and reads the observation through a module-scoped `currentObservation` slot set by `createObservedFetch` inside `providerFetch()` — implemented as: `providerFetch` consults an ALS-free exchange: ai.ts calls `beginAttemptObservation()` (returns a handle) before the SDK call and `endAttemptObservation(handle)` after; `llm-fetch` records into the ACTIVE handle (single-threaded per await chain is NOT guaranteed under concurrency — so the handle exchange must be per-request: match by the attempt's AbortSignal identity passed into the SDK call and surfaced to fetch via `init.signal` — a Map<AbortSignal, ObservationHandle> registered by ai.ts and consulted by llm-fetch, entries deleted on attempt end; signal identity holds because ai.ts passes ONE signal per attempt and the SDK's merge short-circuit forwards it when no SDK timeout is set — pin THAT with a unit test so an SDK upgrade that breaks identity fails loudly rather than silently). Full remaining budget per attempt (single timing authority — `createTimeoutSignal` is NOT armed for loop-scoped calls; the loop's controller is); retry gate `remainingMs ≥ expectedHealthyDurationMs` (+429 wait accounting `max(jitter, retryAfter)`); external-abort bail; per-attempt classify + sink report (fire-and-forget) unless `skipHealthReport`. `streamTextWithTools`: error/abort part observer classifies + reports before yielding. Repair chain (`tryRepairWithModel` path): pass a timeout; a connectivity-classed repair failure rethrows to the loop instead of tier-failure conversion. middleware.ts in-stream arm: map raw `{type:'overloaded_error'}` → `LlmOverloadedError`, `{type:'api_error'}` → `LlmUpstreamError`.

- [ ] **Step 1: Failing tests** (extend ai.test.ts with its existing mock-model harness):

```ts
it('loop: connectivity failure retries with FULL remaining budget and reports each attempt', …)
it('loop: retry gate blocks when remaining < expectedHealthyDurationMs', …)
it('loop: external abort bails without retry or report', …)
it('loop: 429 waits max(jitter, retry-after) and accounts it against the gate', …)
it('loop-scoped generateObject drives the streaming path and returns the identical validated object', …)
it('signal-identity pin: the fetch sees the exact AbortSignal the attempt registered', …)
it('streamTextWithTools reports classified error parts before yielding them', …)
it('middleware maps in-band overloaded_error to LlmOverloadedError', …)
it('repair-chain connectivity failure surfaces to the loop instead of tier failure', …)
it('legacy path (no stageBudgetMs) behaves byte-identically to today', …)
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Scoped runs: `vitest run src/llm/__tests__/ai.test.ts src/llm/__tests__/cost-middleware.test.ts src/llm/__tests__/classify-llm-error.test.ts` + typecheck. All prep-stage suites must stay green (`vitest run src/llm/prep`).

### Task 5: Migration 038 + resume-stamps repo

**Files:** Create `backend/migrations/038_llm_resume_stamps.sql`, `backend/src/repo/resume-stamps.ts`, Test `backend/src/repo/__tests__/resume-stamps.test.ts`; Modify `backend/src/repo/__tests__/migrate-schema.test.ts` (pin 038 + EXPECTED arrays — the standing per-migration rule).

```sql
-- 038_llm_resume_stamps.sql — spec §3.1: the parked-state stamp, one row per parked run.
CREATE TABLE llm_resume_stamps (
  pipeline        text        NOT NULL CHECK (pipeline IN ('world_gen','session_prep','character_creation')),
  entity_id       uuid        NOT NULL,
  resume_attempt  integer     NOT NULL DEFAULT 0,
  next_resume_at  timestamptz,           -- NULL = claimed/in-flight (cleared on stage claim)
  park_consumed_ms bigint     NOT NULL DEFAULT 0,
  last_error_class text       NOT NULL CHECK (last_error_class IN ('connectivity','rate-limit')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pipeline, entity_id)
);
```

**Interfaces — Produces:**

```ts
export interface ResumeStamp { pipeline: 'world_gen'|'session_prep'|'character_creation'; entityId: string; resumeAttempt: number; nextResumeAt: Date | null; parkConsumedMs: number; lastErrorClass: 'connectivity'|'rate-limit' }
export interface ResumeStampsRepo {
  upsertPark(p: { pipeline: ResumeStamp['pipeline']; entityId: string; delayMs: number; consume: boolean; errorClass: ResumeStamp['lastErrorClass'] }): Promise<ResumeStamp> // attempt+1 (capped at ladder top), nextResumeAt=now+delay, parkConsumedMs += consume ? delayMs : 0
  clearNextResumeAt(pipeline: string, entityId: string): Promise<void>   // on stage claim
  clearStamp(pipeline: string, entityId: string): Promise<void>          // on stage completion / fresh manual episode
  get(pipeline: string, entityId: string): Promise<ResumeStamp | null>
  listArmed(pipeline?: string): Promise<readonly ResumeStamp[]>          // nextResumeAt not null (recovery fast-path scan)
}
export const PARK_LADDER_MS = [30_000, 120_000, 300_000, 900_000] as const // rung 5+ holds at 900_000
export const PARK_BUDGET_MS = 6 * 60 * 60 * 1000
export function isParkExhausted(s: ResumeStamp): boolean // parkConsumedMs >= PARK_BUDGET_MS
export function nextParkDelayMs(resumeAttempt: number): number // ladder indexed, held at top
```

- [ ] Steps: failing repo tests (upsert climbs the ladder and holds at 15m; `consume:false` leaves parkConsumedMs; exhaustion predicate; clearNextResumeAt leaves attempt/consumed intact; clearStamp removes the row) → FAIL → SQL + repo (follow the repository-layer conventions: pool-bound like pipeline-runs' recovery methods) → PASS → update migrate-schema pins → run `vitest run src/repo/__tests__/resume-stamps.test.ts src/repo/__tests__/migrate-schema.test.ts` + typecheck.

### Task 6: Frontend hook + NoticeStrip DS component

**Files:** Create `frontend/client-core/src/api/llm-health.ts` (defineEndpoint GET `/api/llm-health`, mirror `session.ts` idioms), `frontend/src/app/use-llm-health.ts` (+test), `frontend/client-core/src/contract/notice-strip.ts` (+index export), `frontend/ui/src/components/NoticeStrip/NoticeStrip.tsx` (+test +story +ui index export).

**Interfaces — Produces:**

```ts
// contract/notice-strip.ts
export interface NoticeStripProps extends Omit<BaseProps, 'children'> {
  /** The notice line (consumer-resolved i18n). null/empty = the strip is collapsed but its
   *  live region STAYS MOUNTED — a role="status" node inserted already-populated is
   *  unreliably announced; the host renders this permanently and toggles content. */
  message: string | null
}
// use-llm-health.ts
export function useLlmHealth(): { degraded: boolean }  // react-query: refetchInterval 60_000, refetchOnWindowFocus: true, failures → ok
```

NoticeStrip visuals: full-width, `chrome` type role, quiet paper register, `border-t border-border`, `role="status"` always on the host element, collapsed = zero-height + empty content (no display:none on the live region host — keep it in the accessibility tree).

- [ ] Steps: failing tests (permanently-mounted host with role=status; message renders; null collapses but the element remains; class pins for register) + hook tests (degraded flip; fetch failure → ok) → FAIL → implement → PASS → story (Rest = collapsed, Degraded = message, both themes) → scoped runs + typechecks (client-core, ui, web).

### Task 7: Probe queue + repeatable job + recovery fast-path

**Files:** Create `backend/src/llm/llm-health-probe.ts` + test; Modify `backend/src/server-queues.ts` (probe queue, standard lifecycle), `backend/src/worker.ts` (register worker + `upsertJobScheduler` every 60s).

**Interfaces — Consumes:** Task 3 tracker, Task 5 `listArmed`. **Produces:** `runProbeCycle(deps): Promise<'healthy-noop' | 'still-degraded' | 'cleared'>` where deps = `{tracker, models: {probe(modelId): Promise<void>}, promoteArmed(): Promise<void>, logger}`.

Behavior per §2.2: healthy → one tracker.read, return. Degraded → targets = readModels() (empty → all three tier constants); parallel probes (each: minimal call through ai.ts with `skipHealthReport`, SDK maxRetries 0, wall-clock 30s, thinking suppressed via providerOptions, success = resolved); all succeed → probeSuccess() (on 'cleared' → promoteArmed scan via `job.promote()` catch-per-job); any fail → probeFailure(). ALSO: any healthy-observing cycle that finds armed stamps runs promoteArmed (spec: fire-once safety). Probe spend attribution: pass the reserved system callsite/jobId (`llm-health-probe`/`system`) so cost middleware buckets it.

- [ ] Steps: failing unit tests (mocked deps: noop path, empty-set fallback, all-succeed ×3 → cleared + promote, one-fail resets, healthy-cycle-with-armed-stamps promotes) → FAIL → implement + queue/worker wiring (mirror an existing repeatable/queue registration; boot-gate stub per the standing pattern) → PASS → scoped vitest + typecheck. NOTE for implementer: worker boot changes need the mocked boot probe pattern (fail-loud memory) — mirror existing worker tests.

### Task 8: World-gen parking + claim semantics + derive-phase

**Files:** Modify `backend/src/repo/pipeline-runs.ts` (+its tests), `backend/src/llm/prep/world-gen-processor.ts` (+its tests), `backend/src/sse/derive-phase.ts` (+its tests).

**Interfaces — Consumes:** Task 5 repo + ladder helpers, Task 1 classes (via the error's attached verdict — Task 4 attaches `failureClass` to surfaced errors as a `llmFailureClass` property; pin that in Task 4's Produces… IT IS: Task 4 sets `(err as {llmFailureClass?})` on every classified error it rethrows). **Produces:** claim result union gains `'in-flight'`; derive-phase emits `resuming` arm behavior (phase stays generating-shaped).

Normative behaviors (spec §3): containment on park-eligible non-terminal failure with budget remaining → `markStageFailed` AS TODAY, then health GET (degraded? consume:false), `upsertPark`, publish parked phase event, `job.moveToDelayed(Date.now()+delay, token)` + `throw DelayedError` (import from bullmq; the processor receives `token` — BullMQ passes it as the 2nd worker arg; thread it through). Claim: rows `running` and NOT stuck → return `'in-flight'` (loop STOPS: rethrow a retryable error, never `continue`); claim success clears `next_resume_at`. Stage completion clears the stamp. Exhausted (isParkExhausted) or non-park-eligible → today's failed path exactly. derive-phase: armed stamp (`next_resume_at` in future OR null-with-job… NO: null = in-flight = also resuming) and not overdue → the generating-shaped phase (never `world_gen_failed`); overdue (`next_resume_at` + 5 min < now) → failed/retryable. Manual retry route: recognizes stamps; a retry after exhaustion calls `clearStamp` (fresh episode); while armed-and-not-overdue the failed surface stays suppressed (derives generating).

- [ ] Steps: failing tests first — pipeline-runs: `in-flight` claim result for fresh running rows (stuck rows still claim; failed rows claim AND clear next_resume_at); world-gen-processor (constructed-state harness it already has): park-eligible containment parks (stamp row asserted, DelayedError thrown, no markFailed on worlds), degraded park consumes nothing, exhausted falls through to failed, other-class unchanged; derive-phase: armed → generating shape, overdue → failed, stamp+lastErrorClass surfaced in the snapshot payload. → FAIL → implement → PASS → scoped runs (`vitest run src/repo/__tests__/pipeline-runs* src/llm/prep/__tests__/world-gen-processor* src/sse`) + typecheck.

### Task 9: Session-prep + character-creation parking + QueueEvents recovery

**Files:** Modify `backend/src/llm/prep/session-prep-processor.ts`, `backend/src/llm/prep/character-creation-processor.ts` (+their tests), `backend/src/worker.ts` (QueueEvents subscribers for the three prep queues; +worker tests).

**Interfaces — Consumes:** Tasks 5/8 patterns (identical park shape, pipeline `'session_prep'`/`'character_creation'`; their status derivations gain the same armed/overdue arms — locate each pipeline's status read path by grepping its `status` route/SSE source and apply the stamp join). **Produces:** QueueEvents recovery — on terminal `failed` events for prep queues, parse the jobId at FIXED UUID WIDTHS (`campaignId` = chars 0–35; `sp-` prefix + 36-char uuid + `-` + sessionNumber; `cc-` + 36 + `-` + 36), look up an armed stamp; if armed and the job is gone → mark the entity failed via each pipeline's existing terminal path (retryable surface) + clearStamp.

- [ ] Steps: failing tests (park parity per pipeline on their constructed-state harnesses; jobId parser unit table incl. UUIDs-contain-hyphens cases; QueueEvents handler marks-failed only when stamp armed AND no job) → FAIL → implement → PASS → scoped runs + typecheck.

### Task 10: Route + strip mount + hold copy + ETA suppression

**Files:** Create `backend/src/routes/llm-health.ts` (+test; register beside health-ready — grep the route-registration index); Modify `frontend/src/app/app-frame.tsx` (+test), `frontend/src/routes/worldgen/generating.tsx`, `frontend/src/routes/worldgen/reveal.tsx`, `frontend/src/routes/campaign-detail.tsx` (+their tests), `frontend/client-core/src/i18n/locales/en/common.json` + `descriptions.ts`.

**Interfaces — Consumes:** Task 3 tracker (route deps), Task 6 hook + NoticeStrip, Task 8's snapshot-surfaced `lastErrorClass`/stamp fields (grep the worldgen stream/snapshot types in client-core and extend them). Route: `GET /api/llm-health` public, `{state, since}`, one tracker.read.

Frontend normative behaviors (spec §3.4/§4): AppFrame renders `<NoticeStrip message={degraded ? t('frame.outageNotice') : null} />` permanently, directly beneath StickyBar; parked worldgen (stamp-derived from the snapshot) → generating view shows `worldgen.degradedHold`, suppresses the ETA countdown AND `shared.wait.stalled`; when the stamp clears → ETA damper/clamp refs RESET; reveal settling swaps to `worldReveal.degradedSettling` while parked. i18n additions (flag for veto): `frame.outageNotice` = "The storyteller's connection is unsteady. Some things may pause and pick themselves back up."; `worldgen.degradedHold` = "The making was interrupted. Your world is safe. It keeps trying on its own."; `sessionPrep.degradedHold` = "[ph: session-prep parked hold line]"; `characterCreate.degradedHold` = "[ph: character-creation parked hold line]"; `worldReveal.degradedSettling` = "[ph: reveal-surface parked settling line]" (+descriptions.ts entries; run the resources drift suite).

- [ ] Steps: failing tests (route 200 shape both states; app-frame: strip host always present with role=status, content toggles with the mocked hook; generating: parked snapshot → hold copy + no countdown + no stalled line, resume → refs reset (drive the damper); reveal: parked → degradedSettling) → FAIL → implement → PASS → scoped runs (backend route test; web app-frame + worldgen suites; client-core drift suite) + typechecks.

### Task 11 (controller): verification, beads close, wiki, smokes

- [ ] Full backend gates: typecheck, lint, `test:coverage` (100% thresholds — new modules must be fully covered).
- [ ] Full frontend chain (client-core/ui/web typecheck+lint+test+coverage, story-coverage, screen-story-coverage, build-storybook, build).
- [ ] Real-wire smokes (constructed-state + real services per the standing rule): hand-flip Redis on the dev stack → strip raises/clears in the browser; dev-tool-induced mid-stage connection kill → park → resume (incl. one tail-stage park showing the reveal hold); one migrated stage against the real Anthropic API (streamed transport, valid final object, cost attributed).
- [ ] Wiki sync subagent (AUTHORING.md prompt; pages: backend LLM layer, worker/queues, worldgen pipeline, app-shell/frontend, + schema reference via migration 038 — wiki needs DATABASE_URL sourced).
- [ ] STOP for Miklos: visual check of the strip + parked-hold surfaces; then push per the Session Close Protocol (single push; full pre-push gate re-asserts).
