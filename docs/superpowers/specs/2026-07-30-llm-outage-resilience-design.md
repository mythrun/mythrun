# LLM Outage Resilience + Sitewide Outage Notice — Design

**Date:** 2026-07-30
**Source incident:** `tmp/2026-07-30-worldgen-stall-transient-llm-timeout.md` — one hung HTTPS connection to Anthropic burned undici's default 300s headers timeout, doomed its retry via the stage abort budget, and surfaced "The world stalled" to the player on the first transient.
**Goals (user-stated):** (1) discover an API outage fast, (2) show a sitewide indicator while it lasts, (3) clear it automatically on recovery. Retry faster; keep the user informed.

**Decisions locked during brainstorm:** hybrid detection (passive detect from real traffic + active recovery probe); scope = global LLM-layer timeout tightening + outage state + notice strip + auto-resume for the PREP pipelines (world-gen, session-prep, character-creation) — live-play (FT/ST/Scribe) failure-handling redesign is out of scope; indicator = slim prose strip under the sticky bar, app-wide on authed surfaces (register: no dots/chips/badges — state as prose).

---

## 1. Fast failure discovery (LLM abstraction layer — all tiers inherit)

### 1.1 Transport timeouts (normative numbers)

The Anthropic provider in `backend/src/llm/ai.ts` gets a custom `fetch` backed by a module-scoped undici `Agent`:

| Setting | Value | Rationale |
|---|---|---|
| `connectTimeout` | 10 000 ms | TCP/TLS establishment that takes >10s is dead |
| `headersTimeout` | 60 000 ms | A generate/stream call that hasn't returned response HEADERS in 60s is a hung connection (the incident's 300 567 ms attempt would have failed at 60s) |
| `bodyTimeout` | 120 000 ms | Idle gap BETWEEN body chunks. Generous so long thinking pauses in streams never false-trip; Anthropic streams also emit periodic pings |

The custom fetch is the ONLY change to the transport; the SDK's own `maxRetries` and the existing wall-clock `timeoutMs` guard (myth-4omh, default 8 min) stay. The wall-clock guard remains the outer bound; the transport timeouts make the common hang fail in ≤60s instead of 300s.

### 1.2 Error taxonomy (mechanical, ZFC-exempt)

The existing error mapper gains a two-class, code-based classification — no heuristics on message prose beyond stable error `code`/`name` fields:

**connectivity-class** (retry-cheap; feeds outage detection):
- undici `HeadersTimeoutError`, `ConnectTimeoutError`, `BodyTimeoutError`
- socket errors: `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `ENOTFOUND`, `EAI_AGAIN`
- HTTP 502 / 503 / 504 / 529 (Anthropic "overloaded")
- the AI SDK's `AI_APICallError` when its cause/status matches any of the above

**other-class** (everything else): 4xx application errors, schema/validation failures, repair failures, the wall-clock abort. These NEVER feed outage detection and keep their current retry semantics.

429 rate-limit is explicitly **other-class**: it means load/quota, not outage; counting it would let our own burst paint a false outage.

### 1.3 Budget-shaped attempts (prep stages)

Contract for the per-stage LLM attempt loop:

- **Per-attempt timeout = remaining stage budget ÷ remaining attempts** (floored at 30s). Every attempt is a full attempt; the incident's 177s doomed stub becomes structurally impossible.
- **Connectivity-class failures get ≥3 attempts** within the stage budget (they're free to retry); other-class keeps the current count.
- Backoff between attempts stays short (seconds) — the transport timeouts already provide spacing.

The implementation plan locates the existing attempt loop ("Failed after 2 attempts" originates there) and applies this contract to it.

### 1.4 Failure reporting hook

The abstraction layer reports each connectivity-class failure to the outage tracker (§2) — fire-and-forget: a failed or slow Redis write must NEVER delay or fail the LLM call path (`.catch(log)` — no await in the hot path).

---

## 2. Outage state (Redis-shared; API server + workers both report)

### 2.1 State machine

```
healthy --(≥3 connectivity-class events within 120s, ≥2 distinct call sites)--> degraded
degraded --(3 consecutive probe successes)--> healthy
```

Redis (all keys namespaced `llm-health:`):

| Key | Type | Semantics |
|---|---|---|
| `llm-health:window` | ZSET | score = epoch-ms, member = `<ts>:<callsite>:<nonce>`. Writers `ZADD` + `ZREMRANGEBYSCORE` older than 120s. TTL 10 min rolling. |
| `llm-health:state` | string (JSON) | Present ⇔ degraded: `{"since": <epoch-ms>}`. Written once on transition (SET NX); cleared on recovery. |
| `llm-health:probe-successes` | counter | Consecutive probe successes while degraded; reset to 0 on any probe failure; at 3 → clear state. |

"Distinct call sites" = distinct stage/tier identifiers in the members (e.g. `coherence_pass`, `ft_turn`) — one wedged stage retrying can't solo-trip the sitewide state.

### 2.2 Recovery probe

A BullMQ **repeatable job** (worker-owned, every 60s): when `llm-health:state` is absent it returns immediately (zero cost in the healthy steady state — no LLM call, one Redis GET). While degraded it makes a minimal Haiku call through the same abstraction layer (model from `models.ts` config — never hardcoded; a few output tokens; wall-clock `timeoutMs` 30s) and updates the success counter. Probe results do NOT feed the failure window (no self-amplification); the probe is the only authority for clearing.

Transitions emit structured log events: `llm_health.degraded` (with window contents) and `llm_health.recovered` (with `since`→now duration). CloudWatch alarm wiring on sustained degradation is a follow-up bead, not this project.

---

## 3. Auto-resume for prep pipelines

Applies to world-gen, session-prep, and character-creation processors.

- A **non-terminal** stage failure no longer dead-ends after BullMQ's `attempts: 2`. On containment, the processor re-enqueues its own job with capped exponential backoff: **30s → 2m → 5m → 15m → 15m (5 auto-resume attempts, ~37 min total)**, tracked via a `resumeAttempt` counter in job data.
- **BullMQ dedup gotcha (known):** a job cannot re-arm its own dedup id — the re-enqueue explicitly removes the deduplication key first (or uses an attempt-suffixed job id, whichever the existing enqueue path makes cleaner; the plan decides against the real code).
- Each resume re-enters through the existing stage stamps (already idempotent re-entry); the standing rule holds: an UNRECOVERABLE re-entry throws `terminal: true` — auto-resume must never convert a terminal failure into a retry loop.
- **"Stalled" is reserved for exhausted auto-resume.** Until attempt 5 fails, the player-facing state remains in-progress, with softened copy while degraded (§4.3).

---

## 4. The notice strip

### 4.1 API

`GET /api/llm-health` — public (`config.auth: 'public'`, mirroring `/health/ready`), one Redis read, responds `{ "state": "ok" | "degraded", "since": <epoch-ms> | null }`. No caching (rides the existing `/api/*` no-cache behavior; polling GET, not SSE — CloudFront buffers SSE).

### 4.2 Frontend

- A shared react-query hook polls the endpoint: on the existing per-navigation cadence plus `refetchInterval: 60_000`. Query failures degrade to `ok` (an unreachable BACKEND is a different problem with different surfaces — the strip only ever asserts LLM degradation positively).
- **New DS component `NoticeStrip`** (`@mythrun/ui` + story, per the components-live-in-the-DS rule): a slim full-width quiet prose strip — paper register, `chrome` type role, top hairline `--border`, no icons/dots/chips, no dismiss affordance (it clears itself). Content is a single i18n-keyed line.
- `AppFrame` mounts `NoticeStrip` directly beneath `StickyBar` while `state === 'degraded'`, unmounts on `ok`. The strip is in-flow (content shifts down while mounted — acceptable for an exceptional state; the bar's own zero-CLS contract is untouched). It renders on ALL authed surfaces including fullBleed.

### 4.3 Softened mid-flow copy

While degraded, surfaces with an in-flight prep flow soften their failure states: the worldgen reveal's "The world stalled" renders only for a TERMINAL/exhausted world; a contained failure while degraded shows the softened line instead (world resumes on its own — §3 makes that true).

### 4.4 Copy (drafts — flagged for the end-of-frontend veto pass)

| Key | Draft value |
|---|---|
| `frame.outageNotice` | "The storyteller's connection is down. Nothing is lost — things will resume on their own." |
| `worldgen.degradedHold` | "The storyteller's connection is down. Your world is safe and will continue on its own." |

Register: quiet, factual, no alarm, no hype, no apology theater.

---

## 5. Testing

- **Unit:** taxonomy mapping (each listed code → class), window math (threshold, distinct-call-site rule, expiry), probe state machine (arm/clear/reset), budget-shaping arithmetic (per-attempt derivation incl. floor).
- **Constructed-state integration:** seed Redis to just-before-threshold → one more failure flips state; degraded + 3 probe successes clears; auto-resume re-enqueues with the right delays and respects the dedup workaround (real Redis + real BullMQ, mocked LLM).
- **Frontend:** hook + strip mount/unmount on state flips; reveal softening branch; strip story (both themes) + a11y.
- **Real-wire smoke:** hit `/api/llm-health` on the running stack; flip the Redis key by hand; watch the strip appear and clear in the browser.

## 6. Out of scope

- Live-play (FT/ST/Scribe) turn-failure retry UX.
- status.anthropic.com integration (status pages miss exactly the blips that caused this).
- CloudWatch alarm on sustained degradation (follow-up bead; log events land now).
