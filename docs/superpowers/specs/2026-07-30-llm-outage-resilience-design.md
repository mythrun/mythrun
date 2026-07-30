# LLM Outage Resilience + Sitewide Outage Notice — Design (v3)

**Date:** 2026-07-30 (v3 after blind rounds 1–2; round-2 stall on the non-streaming-detection axis resolved by Miklos: **Option A — the slow prep calls migrate to streaming**, making fast hang-detection universal)
**Source incident:** `tmp/2026-07-30-worldgen-stall-transient-llm-timeout.md` — one hung HTTPS connection burned undici's default 300s headers timeout, doomed its retry via the shared call budget, and showed the player "The world stalled" on the first transient.
**Goals (user-stated):** (1) discover an API outage fast, (2) show a sitewide indicator while it lasts, (3) clear it automatically on recovery.

**Locked decisions:** hybrid detection (passive from real traffic + active recovery probe); scope = transport hardening + outage state + notice strip + auto-resume for prep pipelines (world-gen, session-prep, character-creation) **+ the prep streaming migration (§1.0)**; live-play retry UX out of scope; indicator = slim prose strip under the sticky bar (no dots/chips — state as prose).

---

## 1. Fast failure discovery (LLM abstraction layer)

### 1.0 Prep generate calls migrate to streaming transport (the round-2 stall resolution)

On a non-streaming Anthropic call with thinking enabled, a hung connection and a healthy still-generating call are the same wire state — headers arrive only with the finished completion (healthy TTFB 60–240s+), so no timeout can distinguish them quickly. Streaming responses return headers within seconds on a healthy call, so a tight headers timeout IS a valid hang detector — but only for streams.

Therefore: **the prep `generateObject`-style call sites move to streaming transport inside the abstraction layer.** The wrapper's external contract is unchanged — call sites still pass a schema and receive a validated final object + usage — but internally it drives the SDK's streaming path and assembles the final object. Affected sites (the non-streaming prep generates): coherence-pass, starting-situation, entity-consolidation, random-tables, character-sheet, character-concept, character-integration, world-introduction, synthesize-concept, revise-concept, vocabulary-intake, and peers — the plan enumerates from `grep generateObject` truth. Already-streaming stages (locations-and-npcs, world-and-factions, entity-relationships, session-prep) are untouched.

Verification point for the plan (not open design): whether provider-native strict structured output is available identically under the streaming path; where it isn't, the existing Zod validation + semantic-validator + repair chain already owns correctness — transport changes, validation semantics don't.

Non-prep, non-streaming callers (Haiku classifiers, gates — short calls with fast TTFB) stay non-streaming and are covered by §1.1's backstop.

### 1.1 Transport timeouts — two dispatchers (normative)

A custom `fetch` given to `createAnthropic({ fetch })` picks a dispatcher mechanically off the request body's `"stream":true` (structural check, ZFC-clean):

| Dispatcher | connect timeout | headersTimeout | bodyTimeout | Applies to |
|---|---|---|---|---|
| streaming | 10 000 ms | 60 000 ms | 120 000 ms | `"stream":true` — headers arrive in seconds on a healthy stream; 120s idle-between-chunks tolerates thinking pauses (Anthropic also emits pings) |
| non-streaming | 10 000 ms | 300 000 ms | 300 000 ms | everything else — an explicit backstop at undici's former default, so short-call sites (classifiers/gates) keep a hung-connection bound and are never WORSE than today |

After §1.0, all long prep calls ride the streaming row: the incident's 300s hang dies at 60s. Wiring facts: the provider is built in `backend/src/llm/models.ts` via the default `anthropic` export — switch to `createAnthropic({ fetch })` there, preserving the `wrapLanguageModel` middleware for all three tiers. `undici` is NOT currently a direct dependency: `pnpm add undici`; import BOTH `Agent` and `fetch` from the npm package (never mix an npm-undici Agent into Node's global fetch — cross-major dispatcher breakage; note a transitive undici@5 also exists in the lockfile, which is why §1.2 matches undici errors by `code`, never `instanceof`). The undici option name is `connect: { timeout }` (the table's "connect timeout" is a label).

**Headers-arrival observable (normative — it is the classification linchpin):** the custom fetch records, per request, whether response headers arrived (e.g. a WeakMap keyed on the request's AbortSignal, or an attempt-context object threaded from the wrapper), readable by the attempt loop. A wall-clock or budget abort on a request whose headers never arrived is a hung connection (§1.2 item 6).

The existing wall-clock `timeoutMs` guard (myth-4omh) stays as the outer bound for every call.

### 1.2 Error taxonomy — two independent axes, with the unwrap walk (mechanical, ZFC-exempt)

Classification happens **at the ai.ts boundary for every failed call — prep, streaming, and live-play (FT/ST/Scribe) alike**; single-attempt sites classify and report their one attempt. It does NOT live in `logAndNormalizeMiddleware` (mapping semantics unchanged there — the middleware sits inside SDK retry loops).

Unwrap walk (wrappers before matching; failures never surface bare):

1. `AI_RetryError` → recurse into `errors[errors.length - 1]`.
2. `AggregateError` → recurse members; connectivity if any member is.
3. `APICallError` → match `statusCode` if present, else recurse `cause`.
4. Mythrun-mapped classes: `LlmOverloadedError` (529) → connectivity; others carry status via `cause`.
5. **Generic rule:** any `Error` with a `cause` recurses (bounded depth 5) — mid-stream failures surface as bare `TypeError: terminated` with the undici error as cause and would otherwise never reach the base cases.
6. Base cases, matched by **`code` string** (`UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, `UND_ERR_SOCKET`) and errnos (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`), plus HTTP status.
7. A budget/wall-clock abort whose request never received headers (per §1.1's observable) → connectivity. Post-headers aborts → other.

Two independent axes (round 2 established conflating them regresses retries):

| Failure | Retry-worthy (wrapper loop) | Outage signal (window) |
|---|---|---|
| connect/DNS/socket/headers-timeout/body-timeout errors; pre-headers aborts | yes | yes |
| HTTP 500, 502, 503, 504, 529 | yes | yes |
| HTTP 429 | yes (respecting retry-after semantics) | **no** — load/quota, not outage |
| 4xx application, schema/validation/repair, post-headers aborts, external aborts | no | no |

### 1.3 Wrapper-owned attempts (prep calls)

No app-level attempt loop exists today ("Failed after 2 attempts" is the AI SDK's internal `maxRetries`). The contract lives in a **new loop owned by ai.ts**; budget-shaped calls set SDK **`maxRetries: 0`** (nested attempts reproduce the incident's doomed stub). Existing scattered `maxRetries` values on the migrated prep sites are superseded; non-budget-shaped callers keep today's behavior.

- **Stage budget:** explicit `stageBudgetMs` input passed by prep call sites (plan sets per-pipeline defaults from today's effective bounds; session-prep already passes 9 min).
- **Attempts:** first attempt always runs (bounded by the budget). A RETRY only starts if `remainingMs ≥ MIN_ATTEMPT_MS` (30 000). Retry-worthy failures retry up to 3 total attempts, each with per-attempt timeout = `remainingMs / attemptsLeft`, fresh `AbortController`, jittered backoff ≤2s. With §1.0, hang detection rides the transport timeouts (≤60s/120s), NOT attempt duration — per-attempt slots being shorter than healthy TTFB is no longer possible on the streaming path, and the arithmetic never aborts a healthy in-flight call before transport verdicts arrive.
- **External aborts win:** after each failed attempt the loop checks the caller's `abortSignal.aborted` — if set, bail immediately: no retry, no health report (an external cancellation is neither retry-worthy nor outage signal).
- Non-retry-worthy failures surface immediately to the stage's existing repair/containment handling.
- Every failed attempt classifies and reports (§1.4) — the window counts attempts.

### 1.4 Failure reporting hook

ai.ts stays dependency-free: boot-injected sink (`setLlmHealthSink(sink)`, default no-op); API server and workers inject a Redis-backed sink at boot; tests need nothing. Fire-and-forget (`.catch(log)`, never awaited on the hot path). `skipHealthReport` option opts a call out — **the recovery probe passes it.** Reports carry `{callsite, jobId (job id or session id), modelId, class}`.

---

## 2. Outage state (Redis-shared; API server + workers both report)

### 2.1 State machine

```
healthy  --(≥3 connectivity-class attempt-failures within the ARMING WINDOW (10 min)
            spanning ≥2 distinct call sites OR ≥2 distinct jobs)-->  degraded
degraded --(3 consecutive probe cycles all-succeed; counter reset by any probe
            failure OR any new connectivity-class report)-->         healthy
```

The arming window is **10 minutes** (not 120s): hang-mode failures manifest only when a timeout fires (60s streaming headers; up to 300s on the non-streaming backstop), so events arrive minutes apart per pipeline — a 120s window could never assemble at low concurrency. The clear side has independent hysteresis, so the wide arm window causes no flap.

**Distinctness rule (stated once):** the qualifying events must span ≥2 distinct call sites OR ≥2 distinct job ids. Worked examples: one world failing one stage repeatedly — never trips sitewide (its player is covered by §3.4's per-world softening); one world failing across two consecutive stages — trips (2 call sites); two worlds failing the same stage — trips (2 jobs).

Redis keys (namespace `llm-health:`):

| Key | Type | Semantics |
|---|---|---|
| `llm-health:window` | ZSET | score = epoch-ms (from Redis `TIME`, not host clocks); member = **JSON-encoded** `{ts, callsite, jobId, modelId, nonce}` (no delimiter corruption). Score-ranged evaluation (`ZRANGEBYSCORE now-10min..now`), never ZCARD-after-prune. Rolling TTL 30 min. |
| `llm-health:state` | string (JSON) | Present ⇔ degraded: `{"since": <ms>, "models": [<ids>]}` — the implicated model set is **snapshotted at arm time and union-updated by every subsequent report** (the probe's target list must survive window expiry; round 2's starvation flaw). `SET NX`; TTL 30 min refreshed by each still-down probe cycle (worker death self-heals). |
| `llm-health:probe-successes` | counter | Reset to 0 on: arming, any probe failure, any new connectivity-class report. At 3 → clear. |

**Arming is race-checked:** after a reporter's successful `SET NX`, it re-verifies the window still meets the threshold (or the evaluate+arm runs as one small Lua script — plan's choice); a straggler that armed off a pre-clear read un-arms itself. **On clear:** `DEL` state + counter + window — a straggler failure re-earns the threshold from zero. Transitions emit `llm_health.degraded` / `llm_health.recovered` structured logs.

### 2.2 Recovery probe

A BullMQ repeatable job on a **dedicated queue, concurrency 1** (never behind prep jobs; standard boot-gate/shutdown lifecycle), every 60s: healthy → return after one Redis GET. While degraded:

- Probe targets = `state.models` (snapshotted set). **An empty or absent set is never a vacuous success** — fall back to probing all three tier constants from `models.ts`.
- Models probed **in parallel** (cycle duration < interval — invariant; ≤3 calls, wall-clock 30s each, few-but-not-truncation-prone `maxOutputTokens` given adaptive thinking shares the cap; **success = the call resolved**, regardless of finishReason), `skipHealthReport`, cost attributed to a reserved **system bucket** (probe spend never pollutes user/world cost surfaces).
- All targets succeed → `INCR` counter; at 3 → clear (§2.1 cleanup) **and enqueue the recovery fast-path (§3.2)**. Any failure → reset counter, refresh state TTL.

**Operator runbook:** manual clear = `DEL llm-health:state llm-health:probe-successes llm-health:window`. Manual ARM (pre-empting a known incident) = `SET llm-health:state '{"since":<now>,"models":[…]}'` — the strip raises and parked resumes stop consuming ladder budget. **Known hysteresis:** ~3 probe cycles + ≤60s poll ≈ up to 4 min of present-tense copy after true recovery. Accepted. CloudWatch alarm on sustained degradation = follow-up bead (log events land now).

---

## 3. Auto-resume for prep pipelines

Applies to world-gen, session-prep, character-creation. Round 1 established the eager markFailed path would flicker "stalled" through every backoff; round 2 established that same-jobId `queue.add` re-enqueues silently no-op while the id is held (the D9 landmine documented in server-queues.ts). So parking uses BullMQ's sanctioned self-delay, not re-adds:

### 3.1 Parking = the job delays ITSELF

On a contained **connectivity-class, non-terminal** failure with ladder budget remaining, the processor:

1. Persists the resume stamp on the run record: `resumeAttempt`, `nextResumeAt`, `lastErrorClass: 'connectivity'` — readable by all status/phase derivations.
2. `job.updateData({resumeAttempt: n+1})`, then **`job.moveToDelayed(now + ladder[n], token)` and throws `DelayedError`** — the SAME job re-arms itself (no add, no dedup interaction, single-flight by construction; a self-delay is not a failure, so BullMQ `attempts` are untouched).
3. Publishes a phase event carrying the parked state.

Ladder: 30s → 2m → 5m → 15m → 15m (5 resume attempts). **While degraded, a waking attempt re-parks without consuming ladder budget** (one health GET at attempt start; same `resumeAttempt`, current rung's delay). Entity status stays in-progress (`generating`); no `markFailed`, no failed phase.

Other-class or `terminal: true` failures keep today's exact behavior (immediate failed state; the standing rule holds — auto-resume never converts an unrecoverable re-entry into a retry loop). Exhausted ladder → today's failed path, landing on the **RETRYABLE** surface (never the terminal "start fresh" view).

### 3.2 Safety nets (worker death, lost jobs, recovery)

- **Worker dies mid-attempt:** BullMQ stall handling retries or terminally fails the job; stalled-terminal failures don't fire per-worker `failed` listeners — the **QueueEvents subscriber** (the MYT-67 precedent in worker.ts) owns terminal-failure handling: if a resume stamp is armed but the job is gone, it marks the entity failed (retryable surface). 
- **Overdue arm in derivation:** phase derivation treats a stamp whose `nextResumeAt` + grace (5 min) has passed **without a stage-start** as failed/retryable — pure row-based predicate, no BullMQ I/O (round 2: derivation sites can't reach the queue). A lost job degrades to the manual-retry surface, never an unbounded `generating`.
- **Recovery fast-path:** on the degraded→healthy transition, the prober scans runs with armed stamps and **`job.promote()`s** their delayed jobs (never `add`s — that would no-op against the held id).

### 3.3 Manual retry × armed resume

While parked the entity is not `failed`, so the retryable FailedView is naturally suppressed — no double pipeline. The resume routes' recovery arms are updated to recognize the parked representation. Derivation predicate is **stamp-presence-based**: `resuming` while the stamp exists, unexhausted, and not overdue; cleared on stage-start, exhaustion, or the overdue arm.

### 3.4 Softened mid-flow copy — per-world trigger, snapshot-carried

The parked/generating view shows the softened hold when the world's own containment was connectivity-class — keyed off the **persisted `lastErrorClass` surfaced through the phase/status snapshot derivation** (never only the live SSE event: CloudFront buffers SSE and the generating view invites leave-and-return; the class must be re-derivable on every (re)connect). Touchpoints: worldgen `derive-phase.ts` AND the session-prep and character-creation status derivations (all three pipelines, not just worldgen). The copy asserts only local knowledge (§4.3) — a single world's containment is not evidence of an outage (round 2: the source incident itself was one hung connection while Anthropic was fine).

---

## 4. The notice strip

### 4.1 API

`GET /api/llm-health` — public (`config.auth: 'public'`, mirroring `/health/ready`), one Redis read: `{"state": "ok" | "degraded", "since": <ms> | null}`. Polling GET (SSE is CloudFront-buffered; not used here). No caching.

### 4.2 Frontend

- Shared react-query hook: per-navigation cadence + `refetchInterval: 60_000`. Query/network failures degrade to `ok` — the strip only asserts LLM degradation positively.
- New DS component `NoticeStrip` (@mythrun/ui + story, both themes, a11y): slim full-width quiet prose strip — paper register, `chrome` type role, hairline `--border` top edge, no icons/dots/chips, no dismiss. **`role="status"` (polite live region)** — a strip appearing mid-session must reach screen-reader players. Smoke at 375px including two-line wrap.
- `AppFrame` mounts it beneath `StickyBar` while degraded; unmounts on `ok`. In-flow (accepted shift for an exceptional state; StickyBar's zero-CLS contract untouched). All authed surfaces including fullBleed (the play stage's one-viewport contract absorbs it; part of the 375 smoke).

### 4.3 Copy (drafts — flagged for the end-of-frontend veto pass)

The sitewide strip asserts **only the corroborated fact**; the resume promise lives only on prep surfaces (auto-resume's actual coverage — live-play chrome must not promise what the session won't do). The per-world hold asserts only **local** knowledge — no outage claim off one containment.

| Key | Draft value |
|---|---|
| `frame.outageNotice` | "The storyteller's connection is down." |
| `worldgen.degradedHold` | "The making was interrupted. Your world is safe — it tries again on its own, every few minutes." |

Register: quiet, factual, no alarm, no apology theater. The hold line names the retry cadence in prose (no timers) so the parked wait isn't shapeless. Renders in the route-level generating/failed branch (`campaign-detail.tsx`), not inside `reveal.tsx`.

---

## 5. Testing

- **Unit:** taxonomy (unwrap walk incl. RetryError, cause-chains, bare `TypeError: terminated`, `UND_ERR_*` by code, both-axes table incl. 429 retried-not-reported and 500 both-axes; pre- vs post-headers aborts via the observable; external-abort bail); attempt arithmetic (first-attempt-always, retry gate, per-attempt derivation); window math (score-ranged, distinctness call sites OR jobs, 10-min horizon); state machine (arm race-check/un-arm, model-set snapshot + union updates, counter resets incl. on-report, clear cleanup DELs, TTL refresh, empty-probe-set fallback never vacuous); ladder incl. degraded re-park; overdue-arm predicate.
- **Constructed-state integration** (real Redis + BullMQ, mocked LLM): threshold flip; probe clear incl. cleanup + fast-path `promote()`; park via `moveToDelayed`/`DelayedError` with single-flight against manual retry; stalled-terminal → QueueEvents → retryable; exhausted → retryable; streaming-migrated stage produces identical validated output + repair behavior.
- **Frontend:** hook + strip mount/unmount; parked phase renders generating (never stalled) with the hold copy on connectivity-class, surviving remount (snapshot-carried class); strip story both themes + a11y (`role="status"`) + 375 wrap.
- **Real-wire smoke:** flip the Redis key by hand; watch the strip raise and clear in the browser; dev-tool-induced connection kill mid-stage on a staged world → park → resume; one migrated stage run against the real API confirming streamed transport + valid final object.

## 6. Out of scope

- Live-play (FT/ST/Scribe) turn-failure retry UX (the strip is the honest surface they get for now).
- status.anthropic.com integration.
- CloudWatch alarm on sustained degradation (follow-up bead; log events land now).
