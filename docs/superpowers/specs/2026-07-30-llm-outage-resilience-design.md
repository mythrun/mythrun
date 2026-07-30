# LLM Outage Resilience + Sitewide Outage Notice — Design (v2)

**Date:** 2026-07-30 (v2 after blind review round 1)
**Source incident:** `tmp/2026-07-30-worldgen-stall-transient-llm-timeout.md` — one hung HTTPS connection to Anthropic burned undici's default 300s headers timeout, doomed its retry via the shared call budget, and surfaced "The world stalled" to the player on the first transient.
**Goals (user-stated):** (1) discover an API outage fast, (2) show a sitewide indicator while it lasts, (3) clear it automatically on recovery. Retry faster; keep the user informed.

**Decisions locked during brainstorm:** hybrid detection (passive detect from real traffic + active recovery probe); scope = LLM-layer timeout tightening + outage state + notice strip + auto-resume for the PREP pipelines (world-gen, session-prep, character-creation) — live-play (FT/ST/Scribe) failure-handling redesign is out of scope; indicator = slim prose strip under the sticky bar, app-wide on authed surfaces (register: no dots/chips/badges — state as prose).

---

## 1. Fast failure discovery (LLM abstraction layer)

### 1.1 Transport timeouts — split by response mode (normative)

**The tight headers timeout applies to STREAMING calls only.** For a non-streaming Anthropic call, response headers arrive only when the full completion is ready — time-to-headers ≈ full generation time, routinely 60–240s with adaptive thinking on. A global 60s headers timeout would kill healthy calls and poison the detector (blind-review round 1, confirmed against `models.ts:49-51`'s own "streaming required at this size" note).

Two undici dispatchers, chosen mechanically per request off the JSON body's `"stream":true` (structural check, ZFC-clean), in a custom `fetch` given to `createAnthropic({ fetch })`:

| Dispatcher | connectTimeout | headersTimeout | bodyTimeout | Applies to |
|---|---|---|---|---|
| streaming | 10 000 ms | 60 000 ms | 120 000 ms | `"stream":true` requests — headers genuinely arrive within seconds on a healthy stream; 120s idle-between-chunks tolerates thinking pauses (Anthropic streams also emit pings) |
| non-streaming | 10 000 ms | disabled (0) | disabled (0) | everything else — bounded by the per-call wall-clock guard only |

Wiring facts (for the plan): the provider is built in `backend/src/llm/models.ts` via the default `anthropic` export — switch to `createAnthropic({ fetch })` there, preserving the `wrapLanguageModel` middleware for all three tiers. `undici` is NOT currently a dependency: `pnpm add undici` and import both `Agent` and `fetch` from the npm package (do not mix an npm-undici Agent into Node's global fetch — known cross-major dispatcher breakage surface).

The existing wall-clock `timeoutMs` guard (myth-4omh) stays and remains the outer bound for every call. Connect hangs now fail in 10s and streaming header hangs in 60s; a non-streaming hang is bounded by the per-attempt budget (§1.3), which is far tighter than today's shared 8-minute bound.

**Out-of-scope note:** migrating the long non-streaming prep calls to streaming under the hood (which would make the tight headers timeout universal) is a worthwhile follow-up, not this project.

### 1.2 Error taxonomy — with the unwrap walk (mechanical, ZFC-exempt)

Classification happens at the **ai.ts boundary** (the wrapper that owns attempts, §1.3) — NOT inside `logAndNormalizeMiddleware`, whose mapping semantics are unchanged (the middleware sits inside SDK retry loops; changing what it maps silently changes retry behavior).

Classification walks wrappers before matching (real failures never surface bare):

1. `AI_RetryError` → recurse into `errors[errors.length - 1]`.
2. `AggregateError` → recurse into each member; connectivity if any member is.
3. `APICallError` (and the SDK's wrapped fetch failures) → match `statusCode` if present, else recurse into `cause`.
4. Mythrun-mapped classes: `LlmOverloadedError` (529) is connectivity-class; status also reachable via `cause` for anything else pre-mapped.
5. Base cases — **connectivity-class**: undici `HeadersTimeoutError`, `ConnectTimeoutError`, `BodyTimeoutError`, `SocketError` (`UND_ERR_SOCKET`); socket errnos `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `ENOTFOUND`, `EAI_AGAIN`; HTTP 502 / 503 / 504 / 529.
6. A per-attempt wall-clock abort (§1.3) on a request that had NOT yet received response headers classifies as **connectivity** (a hung connection killed by our own budget is still a hung connection — the incident's attempt-1 shape).

**other-class** (everything else): 4xx application errors (incl. 429 — load/quota, not outage; counting it would let our own burst paint a false outage), schema/validation/repair failures, post-headers wall-clock aborts.

### 1.3 Wrapper-owned attempts (prep generate calls)

There is no app-level attempt loop today — "Failed after 2 attempts" comes from the AI SDK's internal `maxRetries` (blind-review round 1). The contract therefore lives in a **new attempt loop owned by ai.ts**, and budget-shaped calls set **SDK `maxRetries: 0`** (no nesting — nested attempts reproduce the incident's doomed-stub pathology). Existing per-call-site `maxRetries` values (0/1/3 scattered across stages) are superseded on the prep generate paths this loop covers; streaming call sites (`streamObject`, D2 cost-attribution paths) keep their current `maxRetries: 0` behavior and are NOT budget-shaped in this project.

Contract:

- **Stage budget** is a new explicit per-call input: `stageBudgetMs`, passed by prep call sites (defaults per pipeline set in the plan from today's effective bounds — e.g. session-prep already passes a 9-minute `timeoutMs`; world-gen stages get explicit budgets instead of inheriting the 8-minute default). The existing `timeoutMs`/`abortSignal` options remain for non-budget-shaped callers.
- **Attempt count from remaining budget, not a floor-raiser:** `attempts = clamp(1, 3, floor(remainingMs / MIN_ATTEMPT_MS))` with `MIN_ATTEMPT_MS = 30_000`. An attempt only STARTS if `remainingMs ≥ MIN_ATTEMPT_MS`; per-attempt timeout = `remainingMs / attemptsLeft`. No attempt can be authorized beyond the remaining budget — the doomed stub is structurally impossible.
- **Connectivity-class failures are retried** (up to the derived attempt count, fresh `AbortController` per attempt, short jittered backoff ≤2s); **other-class failures keep current semantics** (surface immediately to the stage's existing repair/containment handling — no new retries).
- Each attempt's failure classification is reported to the health tracker **per attempt** (§2.1's window counts attempts, not calls).

### 1.4 Failure reporting hook

ai.ts stays dependency-free: a boot-injected sink (`setLlmHealthSink(sink)`, default no-op) — API server and workers inject a Redis-backed sink at boot; unit tests and the boot-gate fallback path need nothing. Reporting is fire-and-forget (`.catch(log)`, never awaited in the hot path). Calls can opt out via a `skipHealthReport` option — **the recovery probe (§2.2) passes it**, resolving the probe/reporting contradiction from round 1.

---

## 2. Outage state (Redis-shared; API server + workers both report)

### 2.1 State machine

```
healthy  --(≥3 connectivity-class attempt-failures within 120s spanning
            ≥2 distinct call sites OR ≥2 distinct jobs)-->  degraded
degraded --(3 consecutive probe successes; counter reset by any probe failure
            OR any new connectivity-class report)-->        healthy
```

Redis keys (namespace `llm-health:`):

| Key | Type | Semantics |
|---|---|---|
| `llm-health:window` | ZSET | score = epoch-ms; member = `<ts>:<callsite>:<jobId>:<modelId>:<nonce>`. Writers ZADD; threshold evaluation is score-ranged (`ZRANGEBYSCORE now-120s..now`) — never ZCARD-after-prune (prune+count isn't atomic across multi-writer). Rolling TTL 10 min; pruned opportunistically. |
| `llm-health:state` | string (JSON) | Present ⇔ degraded: `{"since": <epoch-ms>}`. `SET NX` on transition (idempotent across concurrent writers). **TTL 30 min, refreshed by each probe cycle that finds the API still down** — if workers die while degraded, the state self-heals rather than sticking forever. |
| `llm-health:probe-successes` | counter | Consecutive probe successes. Reset to 0 on: arming degraded, any probe failure, and any new connectivity-class report (real traffic failing between lucky probes must block clearing). At 3 → clear. |

**Distinctness rule:** degraded requires the window's events to span ≥2 distinct call sites **or** ≥2 distinct job ids — so a solo world retrying one stage during a real outage CAN trip it (the source incident's shape: one call site, one job, would still need a second attempt-failure event from a distinct attempt… members carry the attempt-distinct nonce, and the ≥2-jobs arm handles multi-world; the single-world single-stage case is covered by §3.4's per-world softening, which does NOT depend on the global flag). One wedged stage on one world cannot solo-trip the SITEWIDE state; its player still gets softened copy via §3.4.

**On degraded→healthy transition:** `DEL llm-health:state`, `DEL llm-health:probe-successes`, `DEL llm-health:window` — a straggler failure from a pre-recovery call must re-earn the threshold from zero, not instantly re-arm. Transitions emit `llm_health.degraded` (window contents) and `llm_health.recovered` (duration) structured logs.

### 2.2 Recovery probe

A BullMQ repeatable job on a **dedicated queue** (never behind retrying prep jobs; the standard boot-gate/shutdown lifecycle from server-queues.ts applies), every 60s: healthy → return after one Redis GET (zero LLM cost at steady state). While degraded:

- Probe **each distinct model id present in the window** (≤3 tiers; per-model outages are the documented reality — a Haiku-only probe would clear mid-Sonnet-outage and flap). All probed models must succeed for the cycle to count as a success.
- Minimal call through the abstraction layer (models from `models.ts` constants, few output tokens, wall-clock 30s, `skipHealthReport`). Note: a hung probe surfaces as a wall-clock abort, not a connectivity error — irrelevant to the counter (any failure resets) but worth knowing in logs.
- On success: `INCR probe-successes`; at 3 → clear (§2.1). On failure: reset counter, refresh the state TTL.

**Operator runbook line:** manual clear = `DEL llm-health:state llm-health:probe-successes llm-health:window` (and the strip clears within one poll). CloudWatch alarm on sustained degradation is a follow-up bead; the log events land now.

**Known hysteresis:** clearing needs 3 probe cycles (~2–3 min) + ≤60s frontend poll — up to ~4 min of present-tense "down" copy after actual recovery. Accepted.

---

## 3. Auto-resume for prep pipelines

Applies to world-gen, session-prep, character-creation. Blind-review round 1 established that the existing containment path eagerly writes `failed` status and publishes the failed phase on every contained error — reusing it as-is would flicker "The world stalled" through every backoff window. So:

### 3.1 Parked state — an explicit representation

A contained **connectivity-class, non-terminal** failure with resume budget remaining does NOT mark the entity failed. Instead the processor:

1. Persists a **resume stamp** on the run record (`resumeAttempt` n, `nextResumeAt` timestamp, `lastErrorClass: 'connectivity'`) — readable by the status/phase derivation.
2. **Awaits** the re-enqueue (not fire-and-forget). If the re-enqueue itself fails, fall back to today's behavior: mark failed, publish the failed phase — a world must never sit in-progress with no job armed and no user affordance.
3. Publishes a phase event carrying the parked state.

Phase derivation (`derive-phase.ts`) gains a `resuming` arm: failed stage row + armed resume stamp (nextResumeAt in the future or job pending) → the phase stays the in-progress/generating shape, NOT `world_gen_failed`. The frontend renders the normal generating view (with §3.4 softened copy). "The world stalled" renders only when no resume is armed.

Other-class or terminal failures keep today's exact behavior (immediate failed state; the standing rule holds — an unrecoverable re-entry throws `terminal: true` and auto-resume never converts it into a retry loop).

### 3.2 Re-enqueue mechanics (against the real single-flight contract)

Dedup here is **jobId-based** (`jobId: campaignId` and `cc-…`/`sp-…` variants), not BullMQ's `deduplication` feature — the v1 "removeDeduplicationKey" idea is inapplicable, and attempt-suffixed ids would break single-flight against the manual retry routes. The mechanism:

- Auto-resume re-enqueues fire **only on the final BullMQ attempt** of the current job (attemptsMade ≥ attempts), from the processor's containment path, **after** the current job record no longer blocks the id (`removeOnFail: {count: 0}` prunes it; the plan verifies ordering against the real BullMQ lifecycle and, if the id is still held at containment time, re-enqueues from the worker's `failed` event instead).
- Re-add uses the **same base jobId** + `delay` per the ladder — single-flight is preserved against both BullMQ's own retries and the manual routes.
- Ladder: 30s → 2m → 5m → 15m → 15m (5 resume attempts), tracked via the resume stamp (job data carries `resumeAttempt`).
- **While degraded, a firing resume attempt re-parks without consuming ladder budget** (one health-state GET at attempt start; re-enqueue with the same `resumeAttempt` at the ladder's current delay) — an outage longer than the ladder must not exhaust every parked world. The probe's recovery transition additionally enqueues an immediate resume for parked runs (best-effort scan of runs with armed stamps; the plan sizes it).

### 3.3 Manual retry × armed resume

While a resume is armed the entity is not `failed`, so the retryable FailedView (whose guard keys off failed status) is naturally suppressed — no double pipeline. The resume routes' recovery arms are updated to recognize the parked representation. **Exhausted auto-resume lands on the RETRYABLE surface** (never the terminal "start fresh" view) — one post-recovery click saves the world.

### 3.4 Softened mid-flow copy — per-world trigger

The parked/generating view shows the softened line when the world's OWN containment was connectivity-class (the stage-failed SSE/phase event carries the class — no dependency on the global flag, so the solo-staging world gets honest copy even when the sitewide threshold hasn't tripped). The global degraded state additionally softens via the sitewide strip (§4).

---

## 4. The notice strip

### 4.1 API

`GET /api/llm-health` — public (`config.auth: 'public'`, mirroring `/health/ready`), one Redis read: `{ "state": "ok" | "degraded", "since": <epoch-ms> | null }`. Polling GET (SSE is CloudFront-buffered; not used here). No caching.

### 4.2 Frontend

- Shared react-query hook: per-navigation cadence + `refetchInterval: 60_000`. Query/network failures degrade to `ok` — the strip only ever asserts LLM degradation positively (an unreachable backend has its own surfaces).
- New DS component `NoticeStrip` (@mythrun/ui + story, both themes, a11y): slim full-width quiet prose strip — paper register, `chrome` type role, hairline `--border` top edge, no icons/dots/chips, no dismiss (self-clearing). Smoke at 375px including the two-line wrap case.
- `AppFrame` mounts it directly beneath `StickyBar` while degraded; unmounts on `ok`. In-flow (content shifts while mounted — accepted for an exceptional state; StickyBar's zero-CLS contract untouched). Renders on all authed surfaces including fullBleed (the play stage's one-viewport contract absorbs the shift; part of the 375 smoke).

### 4.3 Copy (drafts — flagged for the end-of-frontend veto pass)

The sitewide strip asserts **only the fact** — no resumption promise (live-play failures are out of §3's scope; chrome must not promise what the session won't do). The resume promise lives only on prep surfaces, which auto-resume actually covers.

| Key | Draft value |
|---|---|
| `frame.outageNotice` | "The storyteller's connection is down." |
| `worldgen.degradedHold` | "The storyteller's connection is down. Your world is safe and will continue on its own." |

Register: quiet, factual, no alarm, no apology theater. (The softened hold renders per §3.4 — worldgen's route-level failed/generating branch in `campaign-detail.tsx`, not inside `reveal.tsx`.)

---

## 5. Testing

- **Unit:** taxonomy incl. the unwrap walk (RetryError-wrapped, cause-nested, `UND_ERR_SOCKET`, pre-headers wall-clock abort → connectivity; 429/4xx/post-headers abort → other); attempt arithmetic (count derivation, no-start gate below MIN_ATTEMPT_MS, per-attempt budget); window math (score-ranged threshold, distinctness via callsites OR jobs, expiry); probe/counter state machine (arm/reset-on-report/clear/cleanup DELs, TTL refresh); resume ladder incl. degraded re-park.
- **Constructed-state integration** (real Redis + BullMQ, mocked LLM): threshold flip; 3-probe clear incl. window/counter cleanup; parked world → resumed job with base jobId single-flight (manual retry blocked while armed); re-enqueue failure → fallback to failed; exhausted → retryable surface.
- **Frontend:** hook + strip mount/unmount; parked phase renders generating (never stalled) with softened copy on connectivity-class; strip story both themes + a11y + 375 wrap.
- **Real-wire smoke:** flip the Redis key by hand on the running stack; watch the strip appear and clear in the browser; kill a staged world's connection mid-stage (dev-tool induced) and watch it park + resume.

## 6. Out of scope

- Live-play (FT/ST/Scribe) turn-failure retry UX.
- Migrating long non-streaming prep calls to streaming (would make the tight headers timeout universal — follow-up).
- status.anthropic.com integration.
- CloudWatch alarm on sustained degradation (follow-up bead; log events land now).
