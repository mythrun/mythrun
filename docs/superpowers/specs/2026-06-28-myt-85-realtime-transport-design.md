# MYT-85 — Frontend Realtime Transport (WebSocket Session + SSE Status) — Design

> **Status:** Design approved (brainstormed 2026-06-28); revised after blind review round 1 (Fox/Falco/Marth/Sheik) and round 2 (Ryu/ChunLi/Guile/Akuma). Ready for implementation planning.
> **Linear:** MYT-85 — Frontend milestone, Phase 1 (plumbing).
> **Depends on:** MYT-83 (app shell, routing, typed data layer), MYT-84 (auth — the in-memory access token in `client-core/auth/token-manager`, the same-origin `/api/*` CloudFront proxy, the `ApiContext` + `defineEndpoint` seam).

## Goal

The shared realtime plumbing every frontend flow builds on: a **WebSocket session client** (the bidirectional play transport) and an **SSE status client** (the unidirectional world-gen / session-prep status stream). The transport is a **dumb, typed pipe with production-grade reconnection** — it carries frames and exposes connection state; it does not interpret frames, decide flow-level lifecycle, or own flow state.

The entire backend transport is already built and shipping (ticket → upgrade → protocol → persistence → resume-from-seq replay). MYT-85 is the client half plus one small infra addition + one tiny contract addition (a ws-ticket schema). **No backend behavior change.**

## Scope

**In:** WS session client (ticket → upgrade → typed I/O → reconnection-with-replay → heartbeat/close → a `__simulateDrop()` dev-only seam); SSE status client (injected streaming-fetch → typed stream → reconnection); a shared **connection primitive** (per-instance backoff state machine + connection-state store + ceiling); the `/ws/*` CloudFront behavior + origin-timeout config; verification (a DEV-lazy `/dev/transport` harness, mock-WS logic tests, a wire-level staging smoke); a `WsTicketResponse` Zod schema in `@mythrun/contract`.

**Out (deferred):** **L2 live gap-detection** (infeasible on the shared seq counter — [§Deferred](#deferred)); **L3 in-flight DM-turn resume** (backend change); the flow UIs (they consume this transport and own their lifecycle — when to `close()` an SSE, history-loading on first connect, the brand-styled overlay).

## Key Decisions

1. **Reconnection robustness = Layer 1 (reconnect-replay) only.** On disconnect → bounded backoff reconnect → re-mint ticket → replay from `lastSeq` → dedup. Covers the "survive a forced disconnect with no gaps **or duplicates**" done-when. **L2 (live gap-detection) was dropped on review:** the session seq counter is *shared* — DM-turn rows consume `session:{campaignId}:seq` but carry no live seq — so a client cannot compute "expected next seq" live, and any live gap-check false-fires on the normal play loop. A missed live broadcast (rare Redis hiccup) self-heals on the next reconnect-replay. **L3** deferred (a mid-turn reconnect gets the consolidated `dm_message` on a *subsequent* reconnect — see [§Deferred](#deferred) for the residual single-turn gap).

2. **WS reaches the API same-origin via a CloudFront `/ws/*` proxy.** AWS-documented first-class WebSocket support; keeps WAF/Shield + edge + one origin. Config: `Managed-CachingDisabled` + `Managed-AllViewerExceptHostHeader` (forwards `Sec-WebSocket-*`, drops Host so the ALB host-rule matches), `compress = false`, `allowed_methods = ["GET","HEAD"]`, **no Basic-Auth gate function** (gate-exempt). HTTP/1.1 is automatic (no terraform knob). **Origin idle survival:** set `origin_read_timeout = 60` (the streaming-relevant knob) and `origin_keepalive_timeout = 60` on the `api` custom origin. The exact mechanism by which CloudFront reaps an idle WS tunnel is not documented; **60s is empirically validated by the idle-survival smoke** ([§Verification](#verification)), not by a cited guarantee, and **60s is the no-service-quota ceiling for `origin_read_timeout`** (180 needs a quota raise). Fallback if the smoke ever fails: a quota raise or shortening the 30s heartbeat (backend, out of scope). Refs: [AWS — Use WebSockets with CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html).

3. **Deliverable + verification = a DEV-lazy `/dev/transport` harness + mock-WS logic tests + a wire-level staging smoke.** The harness exercises the real backend through the real transport; the smoke covers reconnect-replay, **idle-survival** (≥2 heartbeats silent, no drop — the only thing that catches the §2 timeout), and the **SSE path in a real browser through CloudFront** (SSE rides the `compress=true` `/api/*` behavior; a Node smoke can't see CloudFront buffering). The forced disconnect uses a DEV-only `__simulateDrop()` seam.

4. **Two clients over one shared connection primitive, all in `@mythrun/client-core`.**
   - WS client uses the `WebSocket` global directly.
   - SSE client: **all framing + reconnect + decode logic in client-core**; the platform seam is `StreamingFetch`, pinned as `(url: string, init: { headers: Record<string,string>; signal: AbortSignal }) => Promise<{ status: number; chunks: AsyncIterable<string> }>` — it surfaces the **open status** (so the non-200 routing is observable) and yields **raw decoded text chunks** (the only platform-divergent work). **Auth is computed in core** (core calls `ctx.getAuthHeaders()` and passes `headers` in — including the per-reconnect refresh); the web impl is `ctx`-free fetch+ReadableStream+TextDecoder. `configureStreamingFetch(fn)` is wired **unconditionally at boot** (both auth modes — the harness runs DEV/bypass; do NOT mirror `configureTokenRefresh`, which is jwt-conditional).
   - Both consume `@mythrun/contract/events` (`ServerFrame`, `ClientFrame`, `PipelineEvent`) verbatim, re-exported through the `@mythrun/client-core` barrel for R5 consistency (the route-bound harness is *not* contract-deep-import-banned, but barrel re-export matches the existing precedent).

## Architecture

### Module layout (under `frontend/client-core/src/`, except the web impl + the harness)

- `realtime/connection.ts` — the **shared connection primitive** (shared *code*, per-instance *state*): a `zustand/vanilla` `createStore()` minted **inside each client factory** (never the `create()` singleton — two clients must hold independent state) + the backoff/ceiling state machine. Invariants it MUST enforce: **single-flight connect** (ignore a late `close` from a superseded socket); **`close()` cancels any pending reconnect timer**; **the attempt counter resets on a successful open** (`onopen`/`session_ready`) so cumulative drops over a long session don't trip the ceiling; subscribe/`getState` usable without React. Exposes a `useConnectionState(client)` hook so flows/harness never import `zustand` directly.
- `realtime/ws-session-client.ts` — the WS client factory `(ctx) => WsSessionClient`: ticket fetch, `WebSocket` lifecycle, frame encode/decode, seq/turnId reconnection bookkeeping, close-code+reason routing, `__simulateDrop()` (DEV-fenced).
- `realtime/sse-status-client.ts` — the SSE client factory `(ctx) => SseStatusClient`: framing/parse over injected chunks, `event: snapshot` special-case, `PipelineEvent` decode, non-200/abnormal-drop routing.
- `realtime/ws-ticket.ts` — the ticket `defineEndpoint` (against the new `WsTicketResponse` schema).
- `client-core/src/platform/streaming-fetch.ts` — the `StreamingFetch` interface + `configureStreamingFetch`. DOM-free.
- `frontend/src/platform/web/streaming-fetch.ts` — the web impl.
- `frontend/src/routes/dev-transport.tsx` — the harness, loaded via `React.lazy(() => import(...))` gated on `import.meta.env.DEV` so it is a separate chunk **excluded from the prod bundle** (route-array gating alone doesn't tree-shake the import). Uses `@mythrun/ui` + i18n.

### The transport boundary (dumb typed pipe)

`onFrame(frame)` (consumer switches on `type`); `send(frame)` (WS — see [§send](#send-semantics)); `connectionState` (the per-instance store); `close()` (explicit teardown → the `closed` state). The transport never interprets frames or decides lifecycle; flow reducers + the decision to `close()` an SSE on its terminal event live in the flows.

## The WS protocol contract the client implements

(Source of truth: `frontend/contract/src/events/session-events.ts`. Note: that file's comment claiming combat frames replay-from-rows is **stale** — `rowToReplayFrame` drops them; see dedup below.)

- **Ticket flow:** `POST /api/sessions/:id/ws-ticket` (`defineEndpoint`) → `{ ticket }` (256-bit nonce, 30s TTL, single-use). Connect `GET {wsBase}/ws/session/:sessionId?ticket=<nonce>&lastSeq=<N>`. `wsBase` = the absolute HTTP base with `http→ws`/`https→wss` (DOM-free — **prod MUST set an absolute `VITE_API_BASE_URL`**, asserted by a test; a relative base would force `window.location`, an R1 violation).
- **Seq + dedup (the turn is the dedup unit):**
  - Track `lastSeenSeq` = the highest persisted-row seq **emitted via `onFrame`, advanced per-frame in seq order** (never batch-set to `max(seq)` — a mid-replay drop must leave it at the last *emitted* frame).
  - On reconnect, replay in seq order; **discard `seq ≤ lastSeenSeq`** — this is **load-bearing** (the backend registers the socket *before* building the replay, so a frame published during the DB-read window is delivered live *and* in the replay; the client-side discard removes that overlap — do not drop it "because the server filters `>lastSeq`").
  - **DM-turn dedup is keyed on `turnId`, replace-the-whole-turn:** live frames (`text_delta`, `skill_check`, `dice_roll`, `ledger_update`) carry a `turnId` and no live seq; on reconnect their rows replay *with* a seq, and `turnId` is not a per-frame identity (a turn can hold multiple mechanical frames). So on **any** replayed frame for turn T, discard **all** live-rendered frames for T (prose AND mechanical) and rebuild from the replay set. This is the fix for the common double-render (every reconnect after a DM turn).
  - Combat frames (`combat_started`/`combat_resolved`) are NOT replayed from rows (the backend appends a synthetic `turnId:''` frame only when `mode===combat`) → combat dedup keys on the **latest combat state**, not `turnId`.
  - **First-connect seeding:** a fresh connect omits `lastSeq` → `session_ready` (no replay); the flow loads history via REST and **seeds the WS client's `lastSeenSeq`** with its high-water seq (the client exposes a seed setter). A reconnect always sends `lastSeq=<lastSeenSeq>` (even `0`). Without the seed, a reconnect before the first live frame would re-replay the whole history as duplicates.
- **Heartbeat:** server pings every 30s, `terminate()`s after a 10s grace → the client observes **`1006`** (no close frame — *not* `1011`).
- **Reconnection (L1):** on close → `reconnecting`, backoff 1s→2s→4s→8s→max30s+jitter, **bounded by a retry ceiling** (≈10), re-mint a ticket each attempt, reconnect with `lastSeq`. On ceiling exhaustion → `failed{reason:'exhausted'}` (**re-armable** — the flow may call `connect()` again; not a permanent cliff).
- **Terminal-vs-transient — on READABLE signals only** (the browser sees every non-101 upgrade as `1006`):
  - **Immediate terminal:** a `session_end` data frame → the client self-closes (the server does NOT close the socket) → `closed` (clean). Ticket-POST `403`/`404` → `failed{reason:'denied'}`.
  - **Transient (reconnect, ceiling-bounded):** `1006`; `1011` any reason (`redis-resync-required` AND `connect-failed` — the backend emits `connect-failed` for transient DB/Redis faults too, so it CANNOT be treated as terminal); ticket-POST `401`/`503`/`429`/network. Treating the ended-session (`200`-ticket→`409`-upgrade→`1006`) and genuine-no-session (`401`) as transient is intentional — both hit the ceiling → `failed{exhausted}`, and this avoids stranding a recoverable hiccup as terminal.

## The SSE contract the client implements

(Source of truth: `frontend/contract/src/events/pipeline-events.ts`.)

- **Endpoints:** world-gen `GET /api/campaigns/:campaignId/status/stream`; session-prep `/prep-status`. Bearer-authed.
- **Framing (core):** read injected chunks → buffer on `\n\n` → parse `event:`/`data:`, skip `:keepalive`. The **first frame is `event: snapshot`** (a `worldSnapshotView` / `{status}`, NOT a `PipelineEvent`) — special-cased by event name; subsequent `data:` frames decode as `PipelineEvent`. Every reconnect re-emits `snapshot` then live frames with no seq → **flow reducers must be idempotent** (upsert by `synthKey`); the transport provides no SSE dedup.
- **Open status + close:** the `StreamingFetch` open status routes: `403`/`404` → terminal; **any other non-200** (`401`, `429`, `503`, and CloudFront-generated `502`/`504`) → transient → backoff (the `401` retries behind the next pre-flight refresh). A **stream-end or error with no `event: close` frame** (the dominant wifi-drop case) → transient → reconnect. `CloseReason` frames (`idle-timeout`/`server-shutdown`/`redis-resync-required`/`back-pressure`/`unknown`) → reconnect. The **flow** calls `close()` on its terminal data event (`phase:'world_ready'|'complete'|'world_gen_failed'`; `prep-ready`/`prep-failed`) — `finalized` is per-entity, NOT terminal; the transport never auto-closes on a data event.

## Connection-state surface

A per-instance store: `connecting | connected | reconnecting{attempt} | closed | failed{reason}`. `closed` = clean teardown (a `session_end` frame or an explicit `close()`). `failed{reason}` discriminates `'denied'` (terminal) from `'exhausted'` (re-armable — a flow may re-`connect()`). A normal end must surface as `closed`, never `failed`. Flows subscribe via `useConnectionState` and render the brand overlay.

## send() semantics

`send(frame)` guards on the live **`ws.readyState === OPEN`** (NOT the store, which can lag a server-initiated `CLOSING`). `WebSocket.send()` only *throws* in `CONNECTING`; in `CLOSING`/`CLOSED` it silently discards — so the client checks `readyState` and **returns `false`** (no silent loss) when not OPEN; the flow guards on `connectionState`/the return. No outbound queue/replay — an unsent `player_message` is the flow's to retry.

## Auth model (post-MYT-84)

Ticket POST goes through `defineEndpoint` (inherits the Bearer + single-flight 401-retry). The long-lived connections run a **pre-flight `runRefresh()`** before opening and before each reconnect. `runRefresh()`'s boolean is lossy (it collapses "logged out" and "transient refresh outage"), so the client does **not** branch terminal on it — a ticket-POST `401` is routed **transient** (ceiling-bounded), so a transient `/api/auth/refresh` outage recovers on a later attempt rather than killing a live session; a genuine logout hits the ceiling → `failed{exhausted}` → the flow bounces to sign-in. The web `StreamingFetch` impl applies the **core-supplied** `headers` (mode-correct via `ctx.getAuthHeaders()` — `Bearer` jwt / `x-mythrun-dev-sub` bypass), never a hardcoded Bearer. The WS upgrade carries no header (the ticket is the auth).

## Infra change

Add a `/ws/*` ordered_cache_behavior to `infra/modules/frontend-hosting/main.tf` (mirrors `/api/*`): `target_origin_id="api"`, `Managed-CachingDisabled`, `Managed-AllViewerExceptHostHeader`, `allowed_methods=["GET","HEAD"]`, `compress=false`, **no `function_association`**. On the `api` custom origin set `origin_read_timeout=60` + `origin_keepalive_timeout=60` (only `origin_read_timeout` is load-bearing for an actively-streaming connection; the keepalive bump is harmless). **This origin change is shared with `/api/*`** — every REST call's CloudFront origin-response timeout goes 30s→60s (a hung backend now surfaces a `504` after 60s, not 30s; benign for the fast API, but it's a distribution-wide change on a frontend ticket, ~5-15 min propagation). **Amend the MODULE INVARIANT comment** (main.tf:118-121) to list `/ws/*` as a second deliberate gate exemption — justification: the single-use ws-ticket self-authenticates pre-upgrade via `wsSessionAuth`; **precondition to encode: the exemption is safe only while `/ws/*` on the API serves exclusively the ticket-gated upgrade** (a future unauthenticated `/ws/*` route would inherit the bypass). Capacity note (not a spec defect): ~1k-2.5k persistent sockets at the 200-500-session target ride CloudFront→the shared ALB (idle 3600s, already provisioned) — watch ALB active-connection LCUs.

## Verification

- **Logic tests** (client-core, vitest, mock WS): handshake; encode/decode; reconnect-replay (discard ≤ lastSeenSeq, **whole-turn `turnId` replace** incl. mechanical frames, combat-by-latest, per-frame `lastSeenSeq` advance, **first-connect seed**); backoff + jitter + **ceiling → `failed{exhausted}` + re-arm**; close routing (1006/1011-any-reason transient, session_end→closed, ticket-403/404→denied, 401→transient); `send()` returns false when not OPEN; SSE (`{status}` non-200 routing incl. CloudFront 5xx, snapshot special-case, stream-end-no-frame → reconnect, flow-idempotency).
- **`/dev/transport` harness** (DEV-lazy): connect, send, `__simulateDrop()` → `Reconnecting…` → replay-no-gaps-no-dupes; open SSE → events drive a bare `@mythrun/ui` readout; flow-closes on its terminal.
- **Wire-level staging smoke** (real-E2E, mandatory): mint a ticket, connect `wss://staging.mythrun.com/ws/...`, round-trip, `__simulateDrop()` + assert reconnect-replay; **hold silent ≥2 heartbeats (~70s) asserting no drop** (the §2 idle survival); and exercise the **SSE path `https://staging.mythrun.com/api/...status/stream` in a real browser** (not Node) to confirm CloudFront doesn't buffer/coalesce `text/event-stream`.

## Portability notes (R1–R5)

WS client + connection primitive + all reconnection/seq + all SSE framing/decode logic → client-core (DOM-free; `WebSocket`/`fetch` allowed). `EventSource` banned (R1) → the injected `StreamingFetch` (the web fetch+ReadableStream work is the only thing in `frontend/src/platform/web/streaming-fetch.ts`; the interface lives in `client-core/src/platform/`). Built into `@mythrun/client-core` from day one (R5).

## Contract additions

Add `WsTicketResponseSchema` (`{ ticket: string }`) to `@mythrun/contract` — `defineEndpoint` requires a `response: ZodType` and no ws-ticket schema exists today.

## Deferred

- **L2 live gap-detection** — needs the backend to expose DM-row seqs on live frames; a missed live broadcast self-heals on reconnect-replay.
- **L3 in-flight DM-turn resume** — backend `inFlightResponse`. (Note: a mid-turn reconnect loses the deltas streamed during the disconnect; the healing consolidated `dm_message` only arrives on a *subsequent* reconnect — a transient single-turn prose gap, not strictly "no content loss.")
- **Optional ticket-POST `status` gate** — a ~3-line backend addition to make the ended-session case terminal immediately instead of after the ceiling.
- **Client-side liveness watchdog** — silent server death is currently bounded by (not faster than) the 60s CloudFront origin timeout; a "no traffic for N×heartbeat → force-reconnect" watchdog would tighten it.
- **`scribe_result` / world-knowledge live frames** — not in the contract yet; lands with MYT-94.
- The brand-styled connection-state overlay — the consuming flows.
