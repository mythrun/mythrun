# Session Prep — Streaming + prep-status SSE + dev-tool prose surfacing (MYT-62) — Design

**Date:** 2026-06-02
**Linear:** MYT-62 (milestone: Session Prep Pipeline)
**Status:** design approved (verbally); pending spec review → implementation plan
**Depends on:** MYT-59 (`generateSessionPrep`, shipped), MYT-61 (session-prep worker + processor, shipped). **Reuses:** MYT-50 SSE pub/sub bridge, MYT-52 world-gen-streaming-to-inspector pattern. **Related:** MYT-63 (trigger route — enqueues the job), MYT-64 (real-LLM E2E smoke).

---

## 1. Overview

Make session-prep generation observable: stream the prose to the dev-tool live, and expose a player-facing phase-level `prep-status` SSE for the "The DM is preparing tonight's session…" loading screen. `generateSessionPrep` already uses `streamObject` (MYT-59) but only `await`s the final object — the `partialObjectStream` is unused, so consuming deltas adds **no LLM cost**.

The design rests on a **two-channel topology** that makes enforced ignorance structural rather than a runtime filter:

- **Prose** (the actual `ft_context` + `sd_playbook` text, `sd_playbook` may contain secrets) rides a **new dev-only channel** exposed by a route that **does not exist in production**.
- **Phase** events (`generating → done`) ride the **existing** pipeline channel and are the only prep signal a player ever receives.

There is no runtime leak guard (MYT-60 was descoped). This channel separation is the enforced-ignorance control for streaming.

## 2. Scope boundary

**MYT-62 delivers:** prose-delta consumption in `generateSessionPrep`; the new `prep:campaign:{id}` Redis channel + its dev-only subscriber + the `GET /api/dev/campaigns/:campaignId/prep-prose` route; the player-facing `GET /api/campaigns/:campaignId/prep-status` SSE (phase-only); new `pipeline-events.ts` arms; the dev-tool drawer second-subscription + prose rendering; the contract/gate updates; reconciliation of MYT-61's shape-drifted session-prep `stage-completed`/`stage-failed` events into proper prep arms.

**Out of scope (siblings):** the trigger route that **enqueues** the job (`POST …/session-prep`) → MYT-63; the `/start` "prep exists" precondition → Session Runtime; the real-LLM E2E smoke → MYT-64; the production frontend loading screen that *consumes* `prep-status` → frontend milestone. For MYT-62 the job is still enqueued directly (by tests / MYT-64).

## 3. Decisions locked (from brainstorming)

1. **Dev-tool shows live prose text, kept simple** — no counters, no per-field diffing UI. Just `ft_context` then `sd_playbook` text flowing in.
2. **Separate dev-only prose channel + a route absent in production** — enforced ignorance is structural: in prod there is literally no route that serves prep prose.
3. Player `prep-status` carries **phase events only**, by construction (prose is never published to the phase channel).

---

## 4. Channels & event taxonomy

Channel formula today (worker.ts ≈ L67): `${redisKeyPrefix}pipeline:campaign:${campaignId}`. We add a second, parallel formula: `${redisKeyPrefix}prep:campaign:${campaignId}`.

### 4.1 Phase channel — `pipeline:campaign:{id}` (existing, player-safe)

New **phase** arms added to the `PipelineEvent` union AND the `PIPELINE_SSE_EVENTS` string list in `backend/src/contract/pipeline-events.ts`:

- `prep-started` — `{ type: 'prep-started'; sessionNumber: number }`
- `prep-ready` — `{ type: 'prep-ready'; sessionNumber: number; costUsd: number }`
- `prep-failed` — `{ type: 'prep-failed'; sessionNumber: number; terminal: boolean }`

These **replace** the session-prep processor's current `stage-completed`/`stage-failed` emissions (MYT-61), whose shapes drifted from the contract's generic arms (missing `userId`/`durationMs`; used `message`/`terminal`). Net: the processor emits `prep-started` before generation, `prep-ready` on success, `prep-failed` on failure. No prose on this channel — ever.

### 4.2 Prose channel — `prep:campaign:{id}` (new, dev-only)

The prose arm lives in a **separate type**, NOT in `PipelineEvent`/`PIPELINE_SSE_EVENTS` (this is the load-bearing type-level enforced-ignorance control — see §12):

- `ProseEvent` union + `PROSE_SSE_EVENTS` list (new, in `pipeline-events.ts` or a sibling), single arm: `prep-delta` — `{ type: 'prep-delta'; field: 'ft_context' | 'sd_playbook'; text: string }`. `text` is the newly-appended substring since the last delta for that field.

`publishEvent` is typed to accept `PipelineEvent` (which **does not include** `prep-delta`); `publishProse` is typed to accept `ProseEvent`. Therefore `publishEvent(campaignId, prepDelta)` — the one transposition that would leak `sd_playbook` onto the player channel — is a **compile error**, not a runtime hazard. `prep-delta` is published **only** to the `prep:` channel and can never type-check onto `pipeline:`.

---

## 5. Prose delta loop — `backend/src/llm/prep/stages/session-prep.ts`

`GenerateSessionPrepArgs` gains an **optional field** (keeping the 2-arg `generateSessionPrep(repo, args)` shape stable for the MYT-64 direct-call seam):

```
onProseDelta?: (field: 'ft_context' | 'sd_playbook', text: string) => void
```

Replace `await result.object` with a consume-then-finalize loop over `result.partialObjectStream` (this is the exact sequence MYT-52's `world-and-factions.ts` already runs in production — consume `partialObjectStream`, then `await result.object`, then `await result.usage`; consuming the stream does not "use up" the object/usage promises):

1. Track `seen = { ft_context: 0, sd_playbook: 0 }`.
2. For each `partial` chunk, for each field: if `partial[field]` is a string longer than `seen[field]` AND it `startsWith` the prior prefix, call `onProseDelta(field, partial[field].slice(seen[field]))` and advance `seen[field]`. **Wrap the `onProseDelta` call in try/catch (log + continue)** — a throwing callback must never abort the `for await` and skip the finalize step; prose emit is fire-and-forget cosmetic.
3. After the stream drains, read the final object (`await result.object`) and `await result.usage` exactly as today; return `{ ft_context, sd_playbook, usage }` unchanged.

`onProseDelta` is **optional** — when absent (unit tests of the stage, MYT-64 direct calls) the loop still drains correctly and returns the same result. Length-diff is the simplest mechanism that yields "prose flowing"; no batching/throttling (the SDK already dedupes partials via deep-equality + chunks them). Field attribution is correct **regardless of emission order** because each field is diffed independently against its own `seen[field]` — do not justify it by "fields fill in order" (a future simplifier who leans on order reintroduces a bug).

**Edge case:** the AI SDK's partial-JSON parser, on a chunk boundary mid-escape (a `\` arrives before its escaped char), emits a partial whose committed prefix is *truncated* — never rewritten. The `startsWith` + length guard handles this: when the new value isn't a strict extension, reset `seen[field]` to the new length without emitting (the few mid-escape characters are dropped from the dev feed — cosmetic). The §13 unit test must exercise this with a realistic `\`-split fixture (e.g. `"foo\` → `"foo\n bar"`), not a naive "shrunk string."

---

## 6. Worker wiring — `backend/src/worker.ts` + `backend/src/server.ts` + `session-prep-processor.ts`

- Add a second publisher alongside `publishEvent`: `publishProse(campaignId, event: ProseEvent) → redisRealtime.publish(`${prefix}prep:campaign:${campaignId}`, JSON.stringify(event))`. Inject it into the session-prep processor's deps (the other processors do not get it).
- **The session-prep worker is constructed at TWO entrypoints** and `publishProse` must be wired at BOTH (this is the known dual-wiring footgun — `worker.ts` carries a comment about `server.ts` being missed for world-gen): `backend/src/worker.ts` (dedicated worker, the prod path) AND `backend/src/server.ts`'s `buildSessionPrepWorker` (the API container's in-process worker, the dev path the dev-tool prose stream actually rides). Each has its own `publishEvent` closure; each needs the parallel `publishProse` closure. A TDD assertion should construct the processor the way *each* entrypoint does and assert prose publication — missing the `server.ts` site silently breaks the dev-tool prose feed (the feature's whole point).
- `session-prep-processor.ts`:
  - Before calling `generateSessionPrep`, publish `prep-started` to the phase channel.
  - Pass `onProseDelta: (field, text) => deps.publishProse(campaignId, { type: 'prep-delta', field, text })` into `generateSessionPrep`.
  - On success: publish `prep-ready { sessionNumber, costUsd }` to the phase channel (replacing the drifted `stage-completed`).
  - On failure: publish `prep-failed { sessionNumber, terminal }` to the phase channel (replacing the drifted `stage-failed`). Failure semantics otherwise unchanged: session-scoped, **no `campaigns.setFailed`**, `isTerminalError` rethrow for BullMQ retry.
  - A `publishProse` failure must never fail the job — wrap in the same best-effort posture as `publishEvent` (prose is cosmetic, dev-only).

`atomicClaimStage` / cost recording / `repo.sessionPreps.insert` are unchanged from MYT-61.

---

## 7. Routes

### 7.1 Player phase route — `GET /api/campaigns/:campaignId/prep-status`

Lives in the **campaigns plugin** (`backend/src/routes/campaigns.ts`) — reuses `requireCampaignMember`, the in-scope `subscriber`, and `counter`, mirroring `…/status/stream` (campaigns.ts ≈ L255). Campaign-scoped rather than the Linear title's `/api/sessions/…` because the sessions plugin has no `subscriber`/`counter` wired; prep is keyed on `(campaign_id, session_number)` and this route serves the campaign's current prep (session 1 for MVP per MYT-59).

- `config.rateLimit` per-user + `config.pipelineRoute: true` (mirror `status/stream`; this route **is** a pipelineRoute — always registered, player-facing — so it goes in `PIPELINE_ROUTES`, unlike the dev prose route, see §7.2/§10).
- Initial frame: `event: snapshot\ndata: <json>\n\n`, snapshot from `repo.sessionPreps.getBy(campaignId, sessionNumber)` — `ready` if the row exists, else `generating`/`pending`. **`sessionNumber` is hardcoded to `1` for the MVP** (per MYT-59's session-1 scope); a later session-runtime change resolves the campaign's current session. State the hardcode explicitly in the handler.
- Then attaches to the **phase** channel via `opts.subscriber.attach`. The existing subscriber forwards every channel message verbatim (`pipeline-subscriber.ts` `pmessage`) — there is **no** per-type filter today, so this route gets whatever is live on `pipeline:campaign:{id}`. In practice at prep time only `prep-*` events are live (pub/sub is not replayed; world-gen completed earlier), so "phase-only" holds. To make it robust against any future producer on this channel — and as defense-in-depth for the whole `pipeline:` channel, not just this route — add a **publish/forward-side tripwire**: drop+log any event whose `type` is not in `PIPELINE_SSE_EVENTS`. Combined with the §4.2 type quarantine (`prep-delta ∉ PIPELINE_SSE_EVENTS`), a stray `prep-delta` on `pipeline:` is both a compile error AND dropped at runtime before reaching a player sink. This is structural validation / policy enforcement (ZFC-allowed), O(1). Wire format identical to `status/stream`.

### 7.2 Dev prose route — `GET /api/dev/campaigns/:campaignId/prep-prose`

**Registered only under `AUTH_MODE=bypass`** — so the route is **literally absent in production**. This is not a new pattern: `app.ts` already gates `devCreditsRoutes` behind `if (config.env.authMode === 'bypass')`; the prep-prose route + its prose subscriber register inside the same conditional. In production (`authMode ≠ bypass`) neither the route nor the subscriber is constructed.

- **NOT a `pipelineRoute`, and NOT in `PIPELINE_ROUTES`** — follow the dev-credits precedent exactly. ⚠️ If `prep-prose` were both in `PIPELINE_ROUTES` and bypass-only-registered, the `pipeline-routes` `onReady` reverse-check (every `PIPELINE_ROUTES` entry must have a registered route) would throw at boot in production → **the prod API crashes on deploy**, uncaught by the bypass-mode route-drift test. Only the player `prep-status` route (§7.1, always-registered) is a `pipelineRoute`.
- Streams `prep-delta` events from the `prep:` channel via a **dedicated prose subscriber** (see §8), constructed in the same bypass-only block.
- Dev auth: the `x-mythrun-dev-sub` header path (bypass-plugin); the dev-tool reads it with `fetch`-based SSE (`sse-client.ts openSse`), not native `EventSource`. The route intentionally **omits** an ownership check (`requireCampaignMember('owner')`) because bypass mode collapses to a single dev identity — note that any future *multi-identity* bypass mode must add the owner check so one dev's prep prose isn't exposed to another.
- No initial snapshot needed (prose is ephemeral); attach and stream.

---

## 8. Prose subscriber — `backend/src/sse/`

The existing `createPipelineSubscriber` (`pipeline-subscriber.ts`) `PSUBSCRIBE`s `${prefix}pipeline:campaign:*`. Generalize its channel segment (parameter, default `'pipeline'`) so a second instance can `PSUBSCRIBE` `${prefix}prep:campaign:*`. The prose subscriber is constructed in `app.ts` **only when bypass mode is active**, and handed to the dev prose route. Production never constructs it. Reuses `attach`/`SseSink`/`openSseConnection` unchanged.

---

## 9. Dev-tool surfacing — `backend/dev-tool/`

- The drawer's `createSubscriptionManager` (`shell/drawer/subscriptions.ts`) keys its connection map by `campaignId` and early-returns if a campaign already has a connection — it **cannot** hold a second stream per campaign as-is. So instantiate a **second `createSubscriptionManager`** in `shell.ts` with `urlFor: (id) => /api/dev/campaigns/${id}/prep-prose` and its own `onEvent` routing `prep-delta` to the prose view, driven by the **same** subscribe/closeAll lifecycle as the existing status manager (the 4 `shell.ts` call sites must drive both). This reuses the manager unchanged rather than reworking its keying. Render `prep-delta` as prose appended under a `ft_context` / `sd_playbook` view. Keep it minimal — text flowing in.
- Coverage: move `session-prep` from `coverage.json` `exempt.jobs` → `jobs`. (Note: the `jobs` gate only checks listed-or-exempt — there is no automated job-driver check; the prose surface working is proven by the MYT-64 E2E smoke, not by a gate.) Update the `pipeline-jobs.ts:session-prep` comment (drop the "MYT-62" exempt note).

---

## 10. Contracts & gates (lockstep)

- `backend/src/contract/pipeline-events.ts` — add the 3 **phase** arms to `PipelineEvent` + `PIPELINE_SSE_EVENTS`; add the separate `ProseEvent`/`PROSE_SSE_EVENTS` for `prep-delta` (§4).
- `backend/src/contract/__tests__/pipeline-contracts.test.ts` — update the hardcoded `expected` parity array (`toEqual([...PIPELINE_SSE_EVENTS].sort())`); adding arms fails this test until the array matches. **(Easy to miss — it's a separate gate from the union.)**
- `backend/src/contract/backend-routes.ts` — add both new routes; group the bypass-only `prep-prose` under the existing "Dev (AUTH_MODE=bypass only)" comment block (alongside dev-credits) and fix the file header that says "every route the **production** app registers" → "…the app registers in bypass-mode boot (the superset; `/api/dev/*` are bypass-only, absent in prod)". The drift test boots under bypass so it sees `prep-prose` — consistent with how `/api/dev/credits/*` is already listed.
- `backend/src/contract/pipeline-routes.ts` — add **only** `prep-status` (it's `pipelineRoute: true`). **NOT** `prep-prose` (see §7.2 — would crash prod boot).
- `backend/dev-tool/coverage.json` — add **only** `prep-status` to `routes[]` (the `routes[]` gate is checked against `PIPELINE_ROUTES`, not `BACKEND_ROUTES`; `prep-prose ∉ PIPELINE_ROUTES`, so listing it there warns). Move `session-prep` into `jobs`. Add the 3 phase events to `events[]` (`prep-delta` is a `ProseEvent`, not a `PIPELINE_SSE_EVENT` — keep it out of `events[]`).
- `backend/dev-tool/verify-registry.ts` — both new routes land in `BACKEND_ROUTES` → trip the route-exhaustion gate (`verify.ts routeAudit` / `verify-registry.test.ts`), which credits routes only to `PAGE_REGISTRY` panels. The wire-log drawer is **chrome, not a `PAGE_REGISTRY` panel** (the JSDOM verifier never mounts it), so neither SSE route can be credited to a panel. Add **both** to `EXEMPT_ROUTES` with justification ≥20 chars ("live SSE consumed by the wire-log drawer — header chrome, not a JSDOM-mountable page panel; exercised E2E by MYT-64").
- The dev-tool **drawer** renders via a loose `{type: string}` summarizer (tolerates new types with no code change). Do **NOT** add the new arms to the placeholder `live-events-panel.ts` `LiveEvent` union — its `compactLine` switch is exhaustive (adding arms without cases is a typecheck failure) and the placeholder panel renders nothing. Leave `live-events-panel.ts` untouched.

---

## 11. Error handling

- **Generation/stream error** → `prep-failed` on the phase channel + the MYT-61 failure path (markStageFailed, terminal-aware rethrow, no `campaigns.setFailed`).
- **Dropped/duplicated prose delta** → cosmetic on the dev-only feed; never retried, never gates the job. A throwing `onProseDelta` is swallowed by the §5 try/catch (never aborts generation).
- **Back-pressure close on the prose stream** → the prose sink reuses `openSseConnection`'s 5s drain timeout; a backgrounded/throttled dev tab streaming hundreds of small deltas can hit a `back-pressure` close, which is **non-recoverable** (unlike `redis-resync-required`, there's no re-fetch) — the dev silently loses the rest of that run's prose. Acceptable for a dev-only feed; noted so it isn't mistaken for a bug.
- **Redis resync** → the existing subscriber closes sinks with `redis-resync-required`; the dev-tool re-fetches (existing behavior, applies to the prose subscriber too).

---

## 12. Enforced-ignorance guarantee (restated)

The boundary is structural, defended at three layers — no single mistake leaks prose:

1. **Compile-time** — `prep-delta` is a `ProseEvent`, not a `PipelineEvent`; `publishEvent` accepts only `PipelineEvent`. Publishing prose onto the player channel does not type-check (§4.2).
2. **Runtime** — the `pipeline:` subscriber/publisher tripwire drops any event whose `type ∉ PIPELINE_SSE_EVENTS` (`prep-delta` is not in that list) before it reaches a player sink (§7.1).
3. **Topology** — in production (`AUTH_MODE ≠ bypass`) the prose route and prose subscriber are not constructed at all → no code path serves `sd_playbook` (or any prep prose) over the wire. The only prep route a player can reach (`prep-status`) attaches to `pipeline:`, to which `prep-delta` is never published.

A leak would require defeating all three: changing the types, removing the tripwire, AND registering the prose route in production. None happens by accident.

## 13. Testing (TDD)

- **Delta loop** (stage unit test, mocked `streamObject`): scripted `partialObjectStream` → ordered `prep-delta` calls with correct per-field attribution and no overlap/loss; the mid-escape guard exercised with a realistic `\`-split fixture (`"foo\` → `"foo\n bar"`, not a naive shrunk string); a **throwing** `onProseDelta` is swallowed and the loop still returns the final object; absent-callback drains cleanly.
- **Type-level:** a `// @ts-expect-error` assertion that `publishEvent(campaignId, { type: 'prep-delta', … })` does **not** type-check (proves the §4.2 quarantine).
- **Processor** (real-Postgres + mocked `generateSessionPrep`): emits `prep-started`→`prep-ready` (phase channel) and `prep-delta` (prose channel) on the **correct channels**; the enforced-ignorance assertion — **no `prep-delta` ever published to `pipeline:`**; failure path emits `prep-failed` + leaves campaign status untouched. Assert prose publication for the processor constructed the way **both** `worker.ts` and `server.ts:buildSessionPrepWorker` build it (§6).
- **Subscriber tripwire:** an event whose `type ∉ PIPELINE_SSE_EVENTS` injected on `pipeline:` is dropped+logged, never written to an attached sink (§7.1).
- **Routes:** player `prep-status` forwards prep phase events + emits the initial snapshot; the dev prose route streams `prep-delta`. **Real-mode negative test (the structural enforced-ignorance assertion):** boot `buildApp` with `mode: 'real'`, assert `app.printRoutes()` contains **no** `/api/dev/` path AND an injected request to `/api/dev/campaigns/:id/prep-prose` returns 404. (Also tests the dev-credits family — make it a first-class deliverable, not just a present-under-bypass registration test.)
- **Dev-tool:** the prose-view reducer renders `prep-delta` under the right field; `dev-tool:check` green with `session-prep` moved to `jobs` + both routes in `EXEMPT_ROUTES`; `dev-tool:verify` green.
- **Smoke seam:** wire (not run) the constructed-state seam MYT-64 will drive; do not run a real-LLM smoke here.

## 14. References

- `backend/src/llm/prep/stages/session-prep.ts` (`generateSessionPrep`, `await result.object` ≈ L81), `session-prep-processor.ts` (publishEvent deps; current `stage-completed`/`stage-failed`).
- `backend/src/worker.ts` (`publishEvent` channel formula ≈ L67), `backend/src/app-deps.ts`.
- `backend/src/sse/pipeline-subscriber.ts` (`PSUBSCRIBE` pattern, `attach`), `sse-connection.ts` (`openSseConnection`, wire format), `derive-phase.ts`.
- `backend/src/routes/campaigns.ts` (`…/status/stream` ≈ L255), `backend/src/routes/dev-credits.ts` (`/api/dev/*` pattern).
- `backend/src/contract/pipeline-events.ts` (`PipelineEvent`, `PIPELINE_SSE_EVENTS`), `pipeline-jobs.ts`, `backend-routes.ts`, `pipeline-routes.ts`.
- `backend/dev-tool/src/shell/drawer/subscriptions.ts`, `src/sse-client.ts` (`openSse`), `src/components/live-events-panel.ts` (`LiveEvent`), `backend/dev-tool/coverage.json`, `verify-registry.ts`, `backend/src/dev-tool-check/check-coverage.ts`.
- NOT used: `runStreamingStage` (array-keyed; session prep is a two-string object — confirmed in MYT-59).
