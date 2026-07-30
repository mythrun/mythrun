# LLM Outage Resilience + Sitewide Outage Notice — Design (v4)

**Date:** 2026-07-30 (v4 after blind rounds 1–3; round-2 stall resolved by Miklos: Option A — prep generates migrate to streaming)
**Source incident:** `tmp/2026-07-30-worldgen-stall-transient-llm-timeout.md` — one hung HTTPS connection burned undici's default 300s headers timeout, doomed its retry via the shared call budget, and showed the player "The world stalled" on the first transient.
**Goals (user-stated):** (1) discover an API outage fast, (2) show a sitewide indicator while it lasts, (3) clear it automatically on recovery.

**Locked decisions:** hybrid detection (passive from real traffic + active recovery probe); scope = transport hardening + outage state + notice strip + auto-resume for prep pipelines (world-gen, session-prep, character-creation) + the prep streaming migration (§1.0); live-play retry UX out of scope; indicator = slim prose strip under the sticky bar (no dots/chips — state as prose).

---

## 1. Fast failure discovery (LLM abstraction layer)

### 1.0 Prep generate calls migrate to streaming transport

On a non-streaming Anthropic call, headers arrive only with the finished completion — a hung connection and a healthy still-thinking call are the same wire state. Streaming responses return headers within seconds, so a tight headers timeout is a valid hang detector for streams only.

**The prep `generateObject`-style call sites move to streaming transport inside the abstraction layer.** External contract unchanged (schema in, validated final object + usage out); internally the wrapper drives the SDK streaming path and assembles the final object. The plan enumerates the sites from `grep generateObject` truth over `backend/src/llm/prep/` (coherence-pass, starting-situation, entity-consolidation, random-tables, character-sheet, character-concept, character-integration, world-introduction, synthesize-concept, revise-concept, vocabulary-intake, peers). Already-streaming stages (locations-and-npcs, world-and-factions, entity-relationships, session-prep) are untouched. Plan verification points (not open design): provider-native strict structured output parity under streaming (where absent, the existing Zod + semantic-validator + repair chain owns correctness), and a conscious choice between the deprecated `sdkStreamObject` and `streamText` + `Output.object` (do not inherit the deprecation by default).

**The non-streaming remainder is NOT only fast calls.** Besides Haiku classifiers/gates, it includes long Opus/Sonnet session-side thinking calls: st-director's eval, skill-check, world-lookup-gate, session-reconciler, post-session-analysis, retcon-author, st-lookup-vet, st-narrative-progress. Their detection story under this design: the 300s non-streaming backstop (§1.1) is their only unambiguous hang detector; their wall-clock aborts are retry-worthy but NEVER outage signal (§1.2). Migrating ST-class calls to streaming transport is a named follow-up (§6) — until then a hung ST call burns min(wall-clock, 300s), which is no worse than today.

### 1.1 Transport timeouts — two dispatchers (normative)

A custom `fetch` given to `createAnthropic({ fetch })` (built in `backend/src/llm/models.ts` — switch the default `anthropic` export to `createAnthropic`, preserving the `wrapLanguageModel` middleware for all three tiers) picks a dispatcher mechanically per request: the provider body is a JSON string — route to the streaming dispatcher iff it contains `"stream":true`; **a non-string body routes non-streaming** (fail-safe).

| Dispatcher | connect timeout | headersTimeout | bodyTimeout |
|---|---|---|---|
| streaming | 10 000 ms | 60 000 ms | 120 000 ms |
| non-streaming | 10 000 ms | 300 000 ms | 300 000 ms |

`pnpm add undici`; import BOTH `Agent` and `fetch` from the npm package (never mix an npm-undici Agent into global fetch; a transitive undici@5 exists in the lockfile — which is also why §1.2 matches undici errors by `code`, never `instanceof`). The undici connect option is `connect: { timeout }`. The SDK's `FetchFunction` type is global-fetch-shaped, so the wiring carries one pre-authorized type assertion (the unavoidable-cast exception). The existing wall-clock `timeoutMs` guard (myth-4omh) stays as the outer bound for every call.

**Request-scoped observable (normative — the classification linchpin):** each wrapper attempt runs its fetch inside a request-scoped context (AsyncLocalStorage per the worker/job-context precedent, or a per-attempt fetch closure) recording `{mode, headersArrived, invocationCount}` with **last-invocation-wins** (SDK-internal retries share one signal; per-invocation state must not let attempt 1's headers-arrival pollute attempt 2's classification). The WeakMap-keyed-on-AbortSignal alternative is explicitly non-normative (signal identity is an accident of the SDK's current merge short-circuit).

### 1.2 Error taxonomy — two independent axes, with the unwrap walk (mechanical, ZFC-exempt)

Classification happens at the ai.ts boundary for every failed call — prep, streaming, live-play. Two special surfaces are named so they can't slip: **streamTextWithTools never throws** (errors surface as in-band stream parts) — it gains an error/abort-part observer that classifies and reports before yielding the part through; **the structured-output repair chain** currently swallows errors into tier failures — repair calls get explicit timeouts and connectivity-classed repair failures surface to the attempt loop instead of converting to terminal schema errors. Single-attempt sites report their one attempt. `logAndNormalizeMiddleware`'s mapping semantics are unchanged.

Unwrap walk:

1. `AI_RetryError` → recurse into `errors[errors.length - 1]`.
2. `AggregateError` → recurse members; connectivity if any member is.
3. `APICallError` → match `statusCode` **only when ≥400** (mid-body deaths arrive as "Failed to process successful response" with `statusCode: 200` and the real undici error in `cause`); otherwise recurse `cause`.
4. Mythrun-mapped classes: `LlmOverloadedError` (529) → connectivity; others carry status via `cause`.
5. Generic rule: any `Error` with a `cause` recurses (bounded depth 5).
6. Base cases by `code`: `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, `UND_ERR_SOCKET`; errnos `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`; TLS-layer `EPROTO` / `ERR_TLS_*`; plus HTTP status.
7. **Dispatcher-aware abort rule:** a budget/wall-clock abort whose request never received headers is connectivity **only for streaming-dispatcher requests** (headers arrive in seconds on a healthy stream, so their absence means a hang). On the non-streaming dispatcher, no-headers-at-abort is the healthy state — such aborts are retry-worthy but NEVER outage signal. Post-headers aborts on either dispatcher → other. (The §1.1 observable carries `mode` for exactly this.)

| Failure | Retry-worthy (wrapper loop) | Outage signal (window) |
|---|---|---|
| connect/DNS/socket/headers/body-timeout errors; STREAMING pre-headers aborts | yes | yes |
| HTTP 500, 502, 503, 504, 529 | yes | yes |
| non-streaming wall-clock aborts (pre-headers) | yes | no |
| HTTP 429 | yes — wait = max(jitter, retry-after); the retry gate accounts the wait against the budget | no |
| 4xx application, schema/validation/repair(non-connectivity), post-headers aborts, external aborts | no | no |

### 1.3 Wrapper-owned attempts (prep calls)

No app-level attempt loop exists today ("Failed after 2 attempts" is the AI SDK's internal `maxRetries`). The contract lives in a new loop owned by ai.ts; budget-shaped calls set SDK **`maxRetries: 0`**.

**Scope:** the loop applies only to calls whose output ai.ts assembles internally (the §1.0-migrated generates and existing internally-assembled paths). Externally-consumed streaming stages (partials feed the streaming-extractor/SSE mid-stream) get classification + reporting only — a consumed stream cannot be transparently re-driven, and a naive retry would double-publish partials; their retry unit is the stage, via §3 parking.

- **Stage budget:** explicit `stageBudgetMs` passed by prep call sites (plan sets per-pipeline defaults from today's effective bounds).
- **Every attempt gets the FULL remaining budget.** There is NO division of remaining time across attempts — hang detection rides the transport timeouts (≤60s headers / 120s body-idle on the streaming path), so a hung attempt costs at most ~60–120s of budget, and a healthy long attempt is never killed by arithmetic. (Rounds 2–3 established any division re-creates the incident's doomed retry.)
- **Retry gate:** the first attempt always runs. A RETRY starts only if `remainingMs ≥ expectedHealthyDurationMs` — a per-call-site input (fast calls default 60s; slow stages set their observed healthy duration, e.g. ~5–6 min) — replacing any flat floor: starting a retry that cannot healthily finish wastes spend and ends in a misclassified abort.
- Retry-worthy failures (per §1.2's table) retry up to 3 total attempts, fresh `AbortController` per attempt, jittered backoff ≤2s (429: wait = max(jitter, retry-after), and the gate checks `remaining − wait ≥ expectedHealthyDurationMs`).
- **External aborts win:** after each failed attempt, if the caller's `abortSignal.aborted` is set — bail: no retry, no report.
- Non-retry-worthy failures surface immediately to the stage's existing repair/containment handling.
- Every failed attempt classifies and reports (§1.4); the window counts attempts.

### 1.4 Failure reporting hook

ai.ts stays dependency-free: boot-injected sink (`setLlmHealthSink(sink)`, default no-op); API server + workers inject a Redis-backed sink at boot. Fire-and-forget (`.catch(log)`). `skipHealthReport` opts a call out (the probe passes it). Reports carry `{callsite, jobId (job id or session id), modelId, mode, class}`.

---

## 2. Outage state (Redis-shared; API server + workers both report)

### 2.1 State machine

```
healthy  --(≥3 connectivity-class attempt-failures within 10 min spanning
            ≥2 distinct call sites OR ≥2 distinct jobs)-->  degraded
degraded --(3 consecutive probe cycles all-succeed; counter reset by any probe
            failure OR any new connectivity-class report)--> healthy
```

The 10-minute arming window matches failure-manifestation latency (hang events arrive minutes apart per pipeline; a 120s window could never assemble at low concurrency). The clear side has independent hysteresis — no flap from the wide arm window.

**Distinctness rule:** qualifying events must span ≥2 distinct call sites OR ≥2 distinct job ids. Worked examples: one world failing one stage repeatedly — never trips sitewide (its player is covered by §3.4); one world failing two consecutive stages — trips; two worlds failing the same stage — trips.

Redis keys (namespace `llm-health:`, riding the existing `redisKeyPrefix` discipline so test/worktree/staging isolation holds):

| Key | Type | Semantics |
|---|---|---|
| `llm-health:window` | ZSET | score = epoch-ms from Redis `TIME`; member = JSON-encoded `{ts, callsite, jobId, modelId, nonce}`. Score-ranged evaluation only. TTL 30 min rolling. |
| `llm-health:state` | string (JSON) | Present ⇔ degraded: `{"since": <ms>}`. TTL 30 min, refreshed by each still-down probe cycle (worker death self-heals). |
| `llm-health:models` | SET | The implicated model ids — **a separate Redis SET (`SADD` is atomic and commutative; a JSON array inside `state` is a lost-update race across concurrent reporters)**. Seeded at arm, `SADD`-ed by every subsequent report, TTL managed alongside `state`, DEL'd on clear. |
| `llm-health:probe-successes` | counter | Reset on arming, any probe failure, any new connectivity-class report. TTL 30 min. At 3 → clear. |

**Transitions are Lua-scripted (normative, both directions):** arm = evaluate-window + `SET NX` + seed models atomically; clear = verify-counter + DEL state/counter/window/models atomically. (Round 3 showed the check-then-act variants leak un-arm/spurious-clear races; the scripts eliminate the class.) Transitions emit `llm_health.degraded` / `llm_health.recovered` structured logs **carrying the model set and a window summary** — triage works from CloudWatch without Redis access.

### 2.2 Recovery probe

BullMQ repeatable job, dedicated queue, concurrency 1, every 60s: healthy → return after one Redis GET. While degraded:

- Targets = `SMEMBERS llm-health:models`; **an empty/absent set is never a vacuous success** — fall back to all three tier constants from `models.ts`.
- Models probed in parallel (cycle < interval — invariant); each probe: minimal call, **single-attempt (SDK `maxRetries: 0`, outside the §1.3 loop)**, thinking suppressed (or run streaming under the tight dispatcher), sane `maxOutputTokens` (adaptive thinking shares the cap — success = the call RESOLVED, regardless of finishReason), wall-clock 30s, `skipHealthReport`, cost attributed to a reserved system bucket.
- All targets succeed → `INCR`; at 3 → Lua clear + the recovery fast-path (§3.2). Any failure → reset counter, refresh state TTL.

**Operator runbook** (executed via the ECS run-task/exec path — production Redis is in-VPC; the planned admin surface (MYT-98) may wrap these later): manual clear = the Lua clear (or `DEL` all four keys); manual pre-emptive ARM = `SET llm-health:state` + `SADD llm-health:models …` — raises the strip and stops parked ladder consumption during a known incident. **Known hysteresis:** ~3 probe cycles + ≤60s poll ≈ up to 4 min of stale "down" copy after true recovery. Accepted.

---

## 3. Auto-resume for prep pipelines

Applies to world-gen, session-prep, character-creation. Parking uses BullMQ's sanctioned self-delay (same-jobId `queue.add` silently no-ops while the id is held — the documented D9 landmine).

### 3.1 Parking = the job delays ITSELF

On a contained **connectivity-class, non-terminal** failure with park budget remaining (§3.2), the processor:

1. **Marks the stage row failed as today** (`markStageFailed` — the row must be claimable on wake: a `running` row younger than the stuck-reset threshold makes the wake's claim return lost-race and SKIP the parked stage — silent world corruption; round 3). What distinguishes "parked" from "genuinely failed" is the STAMP, not the row.
2. Persists the resume stamp on the run record: `resumeAttempt`, `nextResumeAt`, `lastErrorClass: 'connectivity'` — readable by all status/phase derivations. **The stamp is the single source of `resumeAttempt`** (no `job.updateData` — it replaces job.data wholesale and would clobber the payload; job data stays `{campaignId,…}` untouched).
3. Publishes the parked phase event, THEN `job.moveToDelayed(now + delay, token)` and throws `DelayedError` (publish must precede the throw). The SAME job re-arms itself — no add, no dedup interaction, single-flight by construction; a self-delay is not a BullMQ failure.

**Stamp lifecycle:** all three stage-claim variants clear the stamp columns on claim; `lastErrorClass` is **sticky through waking attempts** (a wake in progress still shows the hold copy — no per-wake flicker) and clears on stage **completion**; derivations surface it only while the stamp exists.

**Park budget (decoupled from the sitewide state — round 3):** delay ladder 30s → 2m → 5m → 15m, then **hold at 15m**; the bound is total parked wall-clock, **6 hours**, not a rung count — a solo-world outage (which can never trip the sitewide threshold) must not burn out in ~40 minutes. While sitewide-degraded, waking attempts re-park without consuming park budget (one health GET at attempt start). Exhaustion (budget spent) → today's failed path, landing on the **RETRYABLE** surface (never the terminal "start fresh" view). Other-class or `terminal: true` failures keep today's exact behavior.

### 3.2 Safety nets

- **Worker death / stalled-terminal:** the **QueueEvents subscriber** (MYT-67 precedent) handles terminal failures — but prep queues keep `removeOnFail: {count: 0}` (age-retention would reintroduce D9), so the handler **operates from the broker event's jobId alone** (all three prep jobId formats are identity-recoverable: `campaignId`, `sp-…`, `cc-…`), cross-checked against runs with armed stamps in the DB — never via `getJob`/job.data.
- **Overdue arm:** derivations treat a stamp whose `nextResumeAt` + 5-min grace passed without a stage-start as failed/retryable — pure row predicate, no queue I/O. The manual-retry ROUTE (which can reach the queue) additionally checks job existence before surfacing retry, so a backlogged-but-alive wake isn't offered a duplicate retry.
- **Recovery fast-path:** on clear, scan runs with armed stamps and `job.promote()` their delayed jobs (never `add`) — catch-and-continue per job (promoting an already-waiting/active job throws; the natural wake may have raced).

### 3.3 Manual retry × armed resume

While parked the entity is not `failed` at the entity level (stage row is failed; entity status stays in-progress), so the retryable FailedView is naturally suppressed. The resume routes' recovery arms recognize the parked representation. Derivation predicate is stamp-presence-based: `resuming` while the stamp exists, unexhausted, not overdue.

### 3.4 The parked view — copy and mechanics

- The hold copy is keyed off the persisted `lastErrorClass` surfaced through the **snapshot/status derivation** (never only the live SSE event — CloudFront buffers SSE, and the generating view invites leave-and-return; the class must re-derive on every (re)connect; the live event is an optimization). Touchpoints: worldgen `derive-phase.ts` AND the session-prep and character-creation status derivations.
- **A park suppresses the ETA countdown and the `shared.wait.stalled` line** — "Still working" and "the making was interrupted" must never share a screen; during a park the hold copy owns the wait narrative (same rule for character-creation's `characterCreate.loading.stalled`). The plan wires this in the route-level generating branch and the view's countdown region.
- The copy asserts only local knowledge (a single world's containment is not evidence of an outage).

---

## 4. The notice strip

### 4.1 API

`GET /api/llm-health` — public (`config.auth: 'public'`, mirroring `/health/ready`), one Redis read: `{"state": "ok" | "degraded", "since": <ms> | null}`. Polling GET; no caching.

### 4.2 Frontend

- Shared react-query hook: per-navigation cadence + `refetchInterval: 60_000`. Query/network failures degrade to `ok` (positive assertion only).
- New DS component `NoticeStrip` (@mythrun/ui + story, both themes, a11y): slim full-width quiet prose strip — paper register, `chrome` type role, hairline `--border` top edge, no icons/dots/chips, no dismiss. **The live region is permanently mounted** (a `role="status"` node inserted already-populated is unreliably announced): AppFrame always renders the strip's live-region host; degraded toggles its CONTENT and visible height. The a11y test asserts announcement on the ok→degraded transition, not attribute presence. Smoke at 375px incl. two-line wrap.
- Renders on all authed surfaces including fullBleed. **Public surfaces (signin, join funnel, landing) intentionally do not show it** — they sit outside AppFrame; acceptable, deliberate.
- In-flow (accepted shift for an exceptional state; StickyBar's zero-CLS contract untouched).

### 4.3 Copy (drafts — flagged for the end-of-frontend veto pass)

Degradation is model-scoped but the strip is binary — the copy must stay TRUE during a partial-model outage (an Opus-only outage arms the strip while the Sonnet storyteller answers every live turn). No em dashes (house rule). The resume promise appears only on prep surfaces.

| Key | Draft value |
|---|---|
| `frame.outageNotice` | "The storyteller's connection is unsteady. Some things may pause and pick themselves back up." |
| `worldgen.degradedHold` | "The making was interrupted. Your world is safe. It keeps trying on its own." |
| `sessionPrep.degradedHold` | `[ph: session-prep parked hold line]` |
| `characterCreate.degradedHold` | `[ph: character-creation parked hold line]` |

No cadence numbers in copy (the tail rungs are 15-minute waits; "every few minutes" would be untrue).

---

## 5. Testing

- **Unit:** taxonomy (unwrap walk incl. RetryError, cause-chains, `statusCode: 200` mid-body shape, `UND_ERR_*`/errno/TLS codes by string, dispatcher-aware abort rule via the mode-carrying observable, external-abort bail, 429 wait accounting); attempt loop (full-remaining slots — no division; expectedHealthyDuration retry gate; scope excludes externally-consumed streams); window math (score-ranged, distinctness, 10-min horizon); Lua transitions (arm race, clear cleanup incl. models SET, counter resets incl. on-report, empty-probe-set fallback); park budget (ladder + hold-at-15m + 6h wall-clock cap + degraded non-consumption); stamp lifecycle (claim clears, sticky class, completion clears, overdue predicate).
- **Constructed-state integration** (real Redis + BullMQ, mocked LLM): threshold flip; probe clear + `promote()` fast-path (catch-on-race); park via `moveToDelayed`/`DelayedError` → wake claims the FAILED row (no stage skip) with single-flight vs manual retry; stalled-terminal → jobId-only QueueEvents recovery → retryable; exhausted → retryable; migrated stage produces identical validated output + repair behavior; repair-chain connectivity failure surfaces (not swallowed).
- **Frontend:** hook + strip content/visibility toggle on the permanent live region (announcement asserted on transition); parked phase renders generating with the hold copy, ETA/stalled line suppressed, surviving remount; strip story both themes + a11y + 375 wrap.
- **Real-wire smoke:** hand-flip Redis; strip raises and clears in the browser; dev-tool-induced connection kill mid-stage → park → resume; one migrated stage against the real API confirming streamed transport + valid final object.

## 6. Out of scope

- Live-play (FT/ST/Scribe) turn-failure retry UX (streamTextWithTools failures DO report to the detector; retrying them doesn't change).
- Migrating the ST-class non-streaming session calls (st-director eval, skill-check, world-lookup-gate, session-reconciler, post-session-analysis, retcon-author, st-lookup-vet, st-narrative-progress) to streaming transport — named follow-up; until then they ride the 300s backstop and never feed the outage window on wall-clock aborts.
- status.anthropic.com integration.
- CloudWatch alarm on sustained degradation (follow-up bead; log events land now).
