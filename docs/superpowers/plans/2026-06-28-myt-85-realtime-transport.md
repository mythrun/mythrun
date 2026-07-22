# MYT-85 Realtime Transport — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **The authoritative behavior spec is `docs/superpowers/specs/2026-06-28-myt-85-realtime-transport-design.md` — read it; this plan is the task decomposition + the tests that define "done", not a restatement of every behavior.**

**Goal:** A frontend WebSocket session client + SSE status client — the shared, production-grade realtime transport every play/world-gen/prep flow builds on.

**Architecture:** Two client factories (`(ctx) => Client`) over one per-instance connection primitive, all in `@mythrun/client-core` (DOM-free). The WS client uses the `WebSocket` global directly; the SSE client's framing/decode logic is in core over an injected `StreamingFetch` capability (web fills it with fetch+ReadableStream). A dumb typed pipe: `onFrame` + a connection-state store; flows own their reducers + lifecycle. Plus one CloudFront `/ws/*` behavior and one `WsTicketResponse` contract schema.

**Tech Stack:** TypeScript (strict), Zod (`@mythrun/contract`), `zustand/vanilla`, Vitest, React (`@mythrun/ui` + i18next for the harness), Terraform (CloudFront).

## Global Constraints

- **TDD required** — a failing test that defines "done" before any implementation. Core infra (production-grade reconnection): no shortcuts.
- **Reconnection = Layer 1 only** (reconnect-replay). No L2 live gap-detection. The **turn (`turnId`) is the dedup unit**.
- **Portability (R1–R5):** client-core is DOM-free — banned globals `document/window/localStorage/location/navigator/EventSource`; `fetch`/`WebSocket` allowed. All SSE framing logic in core; only fetch+ReadableStream+TextDecoder in `frontend/src/platform/web/`. Built into `@mythrun/client-core` from day one.
- **Frontend lint rails:** no hardcoded strings (i18n keys, `[placeholder for <purpose>]` for prose); no ad-hoc UI (compose `@mythrun/ui`); routes import only from package-root barrels (no deep `@mythrun/client-core/src/*`).
- **Named exports, no default exports; strict TS (no `any`, no assertions unless unavoidable); functions <50 lines; modules <400 lines.**
- **Per-instance state:** the connection store is a `zustand/vanilla` `createStore()` minted inside each factory — never the `create()` singleton.
- **Auth in core:** core computes `ctx.getAuthHeaders()` and passes headers to the streaming-fetch seam; the web impl is `ctx`-free and applies whatever headers it's handed (mode-correct Bearer/`x-mythrun-dev-sub`).
- **The done-when is the real-wire staging smoke** (Task 11): reconnect-replay + idle-survival + SSE-in-a-real-browser. Mocked tests don't satisfy it.
- **Implementers do NOT `git add`/`commit`/`push`** — the controller commits each task serially after review.

## File Structure

| File | Responsibility |
|---|---|
| `frontend/contract/src/rest/ws-ticket.ts` (+ barrel) | `WsTicketResponseSchema` `{ ticket: string }` |
| `frontend/client-core/src/platform/streaming-fetch.ts` | `StreamingFetch` interface + `configureStreamingFetch` (DOM-free seam) |
| `frontend/client-core/src/realtime/connection.ts` | per-instance connection-state store + backoff/ceiling state machine + invariants + `useConnectionState` |
| `frontend/client-core/src/realtime/ws-ticket.ts` | the ticket `defineEndpoint` |
| `frontend/client-core/src/realtime/ws-session-client.ts` | WS lifecycle, frame I/O, `send()`, seq+turn dedup, reconnect-replay, close-routing, `__simulateDrop` |
| `frontend/client-core/src/realtime/sse-status-client.ts` | SSE framing over injected chunks, snapshot special-case, non-200/close routing |
| `frontend/client-core/src/realtime/index.ts` + `client-core/src/index.ts` | barrel re-exports |
| `frontend/src/platform/web/streaming-fetch.ts` | web `StreamingFetch` impl (fetch + ReadableStream + TextDecoder → `{status, chunks}`) |
| `frontend/src/main.tsx` | unconditional `configureStreamingFetch` wiring |
| `frontend/src/routes/dev-transport.tsx` + `frontend/src/app/router.tsx` | DEV-lazy harness route |
| `infra/modules/frontend-hosting/main.tf` | `/ws/*` behavior + `api`-origin timeouts + MODULE INVARIANT amendment |
| `backend/scripts/smoke/ws-transport.ts` (+ browser SSE step) | wire-level staging smoke |

Each test file is colocated (`*.test.ts` / `*.test.tsx`) per `backend/src/__tests__/CONVENTIONS.md`-style conventions for the frontend packages.

---

## Task 1 — Contract: `WsTicketResponse` schema

**Files:** Create `frontend/contract/src/rest/ws-ticket.ts`; Modify the contract barrel (`frontend/contract/src/index.ts` / `rest/index.ts`); Test `frontend/contract/src/__tests__/rest.test.ts` (extend).
**Interfaces — Produces:** `WsTicketResponseSchema: z.ZodType`, `type WsTicketResponse = { ticket: string }`.

- [ ] **Step 1: Failing test** — in `rest.test.ts`, add: `expect(WsTicketResponseSchema.parse({ ticket: 'abc' }).ticket).toBe('abc')` and `expect(() => WsTicketResponseSchema.parse({ ticket: '' })).toThrow()`.
- [ ] **Step 2: Run** `pnpm --filter @mythrun/contract test -- rest.test` → FAIL (schema undefined).
- [ ] **Step 3: Implement** `export const WsTicketResponseSchema = z.object({ ticket: z.string().min(1) })` + `export type WsTicketResponse = z.infer<typeof WsTicketResponseSchema>`; export from the barrel.
- [ ] **Step 4: Run** → PASS; `pnpm --filter @mythrun/contract typecheck && lint`.
- [ ] **Step 5: Commit** (controller).

## Task 2 — `StreamingFetch` seam (interface + `configureStreamingFetch`)

**Files:** Create `frontend/client-core/src/platform/streaming-fetch.ts`; Test colocated.
**Interfaces — Produces:** `type StreamingFetch = (url: string, init: { headers: Record<string,string>; signal: AbortSignal }) => Promise<{ status: number; chunks: AsyncIterable<string> }>`; `configureStreamingFetch(fn: StreamingFetch): void`; `getStreamingFetch(): StreamingFetch` (throws if unconfigured); a test-only `resetStreamingFetch()`.

- [ ] **Step 1: Failing test** — `getStreamingFetch()` throws before configure; after `configureStreamingFetch(fakeFn)`, `getStreamingFetch()` returns `fakeFn`. Mirror `token-manager.ts`'s `configureTokenRefresh` module-seam shape (verify against `frontend/client-core/src/auth/token-manager.ts`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the module-level seam (no DOM, no import of the web impl).
- [ ] **Step 4: Run** → PASS; typecheck + lint (must pass `no-restricted-globals` for client-core).
- [ ] **Step 5: Commit.**

## Task 3 — Connection primitive (`connection.ts`)

**Files:** Create `frontend/client-core/src/realtime/connection.ts`; Test colocated. **Read spec §"Connection-state surface", §Architecture `connection.ts`, §Reconnection.**
**Interfaces — Produces:** `type ConnectionState = { status: 'connecting'|'connected'|'reconnecting'|'closed'|'failed'; attempt: number; failedReason?: 'denied'|'exhausted' }`; `createConnection(opts: { ceiling: number; backoff?: (attempt: number) => number }) => Connection` where `Connection = { store: StoreApi<ConnectionState>; nextDelayMs(): number; onOpenSuccess(): void; reset(): void; ... }`; `useConnectionState(client: { connectionState: StoreApi<ConnectionState> })`.

- [ ] **Step 1: Failing tests** (each = a spec requirement): (a) a fresh `createConnection()` has independent state from a second instance (no shared singleton); (b) backoff schedule `1000,2000,4000,8000,30000,30000…` with jitter bounded within ±X%; (c) the **attempt counter resets on `onOpenSuccess()`**; (d) reaching `ceiling` attempts sets `failed{reason:'exhausted'}`; (e) `useStore` subscription updates a React consumer.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with `import { createStore } from 'zustand/vanilla'` **inside** the factory; the backoff math; the ceiling; `useConnectionState` via `zustand`'s `useStore`. Enforce single-flight + timer-cancel as documented invariants (the client tasks consume them).
- [ ] **Step 4: Run** → PASS; typecheck + lint.
- [ ] **Step 5: Commit.**

## Task 4 — ws-ticket endpoint (`realtime/ws-ticket.ts`)

**Files:** Create `frontend/client-core/src/realtime/ws-ticket.ts`; Test colocated (MSW).
**Interfaces — Consumes:** `WsTicketResponseSchema` (T1), `defineEndpoint`/`ApiContext` (`api/endpoint.ts`). **Produces:** `mintWsTicket(sessionId: string, ctx: ApiContext): Promise<WsTicketResponse>` via `defineEndpoint({ method:'POST', path:(id)=>`/api/sessions/${id}/ws-ticket`, response: WsTicketResponseSchema })`.

- [ ] **Step 1: Failing test** — MSW mocks `POST /api/sessions/s1/ws-ticket` → `{ticket:'n'}`; `mintWsTicket('s1', ctx)` resolves `{ticket:'n'}`; a 401 triggers the `defineEndpoint` refresh-retry (assert one retry).
- [ ] **Step 2–5:** run-fail → implement → run-pass → typecheck/lint → commit.

## Task 5 — WS session client: lifecycle, frame I/O, `send()`, `__simulateDrop`

**Files:** Create `frontend/client-core/src/realtime/ws-session-client.ts`; Test colocated against a **mock WS server** (use `vitest`'s env + a `MockWebSocket`/`ws`-style harness). **Read spec §"WS protocol contract" (ticket flow, frames, heartbeat, `send()`), §send semantics.**
**Interfaces — Consumes:** T3 `createConnection`, T4 `mintWsTicket`, `ApiContext`, `@mythrun/contract/events` (`ServerFrame`/`ClientFrame`), `runRefresh` (`token-manager`). **Produces:** `createWsSessionClient(ctx: ApiContext) => WsSessionClient` where `WsSessionClient = { connect(sessionId, opts?: { seedLastSeq?: number }): void; onFrame(cb: (f: ServerFrame)=>void): () => void; send(f: ClientFrame): boolean; connectionState: StoreApi<ConnectionState>; close(): void; seedLastSeen(seq: number): void; /** DEV-only */ __simulateDrop(): void }`.

- [ ] **Step 1: Failing tests:** pre-flight `runRefresh()` runs before the ticket POST; `connect()` mints a ticket then opens `ws://…/ws/session/:id?ticket&lastSeq`; an inbound JSON frame dispatches to `onFrame` typed; `send(playerMessage)` writes to the socket when `readyState===OPEN`; **`send()` returns `false` (no throw, no write) when not OPEN** (simulate CONNECTING + CLOSING); `__simulateDrop()` closes the socket and transitions state to `reconnecting`. Derive `wsBase` from `ctx.baseUrl` (`http→ws`).
- [ ] **Step 2–5:** run-fail → implement (fence `__simulateDrop` behind `import.meta.env.DEV`) → run-pass → typecheck/lint → commit.

## Task 6 — WS reconnect-replay + dedup + close-routing

**Files:** Extend `frontend/client-core/src/realtime/ws-session-client.ts`; extend its test. **Read spec §"Seq + dedup", §Reconnection, §"Terminal-vs-transient".** Depends on T5.
**Interfaces — Produces:** (internal) the reconnection loop + the dedup; no new public surface.

- [ ] **Step 1: Failing tests (each a spec requirement):** (a) on reconnect, replay frames with `seq ≤ lastSeenSeq` are **discarded** (the register-before-replay overlap); (b) `lastSeenSeq` advances **per emitted frame** in seq order, not batch-set; (c) **whole-turn dedup** — a turn T with live `text_delta` + 2 `skill_check` + 1 `ledger_update`, then a reconnect replaying T's rows → the client discards all live T frames and rebuilds from the replay (NO duplicate cards); (d) combat `combat_resolved{turnId:''}` dedups by latest state, not turnId; (e) reconnect re-mints a fresh ticket + sends `lastSeq=lastSeenSeq`; (f) **close routing:** `1006` → transient/reconnect; `1011` reason `redis-resync-required` AND `connect-failed` → transient; a `session_end` data frame → `close()`+`closed`; ticket-POST `403/404` → `failed{denied}`; ticket-POST `401`/`503` → transient; ceiling → `failed{exhausted}`; (g) **re-arm:** after `failed{exhausted}`, a `connect()` call re-starts.
- [ ] **Step 2–5:** run-fail → implement → run-pass → typecheck/lint → commit.

## Task 7 — SSE status client (`sse-status-client.ts`)

**Files:** Create `frontend/client-core/src/realtime/sse-status-client.ts`; Test colocated (inject a fake `StreamingFetch` yielding scripted chunks + a status). **Read spec §"SSE contract".** Depends on T2 (seam), T3 (primitive).
**Interfaces — Consumes:** T2 `getStreamingFetch`, T3 `createConnection`, `ApiContext`, `@mythrun/contract/events` (`PipelineEvent`), `runRefresh`. **Produces:** `createSseStatusClient(ctx: ApiContext) => SseStatusClient` = `{ open(path: string): void; onEvent(cb: (e: PipelineEvent)=>void): ()=>void; onSnapshot(cb: (raw: unknown)=>void): ()=>void; connectionState; close(): void }`.

- [ ] **Step 1: Failing tests:** core computes `ctx.getAuthHeaders()` and passes `headers` to the injected fetch (the fake asserts it received `Authorization`/`x-mythrun-dev-sub`); `\n\n` framing across chunk boundaries; `:keepalive` skipped; the **first `event: snapshot`** routes to `onSnapshot` (raw, NOT decoded as `PipelineEvent`), subsequent `data:` frames decode to `PipelineEvent`; non-200 open routing — `403/404` → `failed{denied}`, `401`/`429`/`503`/`502`/`504` → transient/reconnect; a **stream-end with no `event: close`** → transient/reconnect; the transport does NOT auto-close on `finalized`/any data frame (the flow calls `close()`).
- [ ] **Step 2–5:** run-fail → implement → run-pass → typecheck/lint → commit.

## Task 8 — Web `StreamingFetch` impl + boot wiring + barrels

**Files:** Create `frontend/src/platform/web/streaming-fetch.ts`; Modify `frontend/src/main.tsx` (wire), `frontend/client-core/src/realtime/index.ts` + `client-core/src/index.ts` (barrels). Tests: colocated for the web impl (jsdom + a mock `fetch`). Depends on T2/T5/T6/T7.
**Interfaces — Produces:** `createWebStreamingFetch(): StreamingFetch`; barrel re-exports of `createWsSessionClient`, `createSseStatusClient`, `configureStreamingFetch`, `useConnectionState`, the connection types.

- [ ] **Step 1: Failing tests:** the web impl calls `fetch(url, { headers, signal })`, returns `{ status: res.status, chunks }` where `chunks` is an `AsyncIterable<string>` decoding `res.body.getReader()` via `TextDecoder`; a non-OK status still resolves `{status, chunks}` (no throw — the SSE client routes on status); `signal` aborts the read. Barrel test: `import { createWsSessionClient } from '@mythrun/client-core'` resolves.
- [ ] **Step 2–5:** run-fail → implement (`main.tsx`: `configureStreamingFetch(createWebStreamingFetch())` **unconditionally** at module scope — NOT in the jwt-only branch) → run-pass → web typecheck/lint/test/coverage/build → commit.

## Task 9 — `/dev/transport` harness (DEV-lazy)

**Files:** Create `frontend/src/routes/dev-transport.tsx`; Modify `frontend/src/app/router.tsx` (DEV-lazy registration). Tests: a render/wiring test (the route is absent in a prod build; present in DEV). **Read spec §Verification + the visual-audit standing rule.** Depends on T8.
**Interfaces — Consumes:** the barrel clients + `useConnectionState`.

- [ ] **Step 1: Failing tests:** the route is registered only under `import.meta.env.DEV` (assert the prod route tree omits it); the harness composes `@mythrun/ui` + i18n keys (no raw strings — passes `i18next/no-literal-string`, `no-ad-hoc-ui`); it drives `connect → send → __simulateDrop → reconnect` and renders the `useConnectionState` readout + an SSE event list.
- [ ] **Step 2–5:** run-fail → implement via `React.lazy(() => import('../routes/dev-transport.tsx'))` gated on DEV (separate chunk) → run-pass → web gate → commit. **Then STOP and flag to Miklos for a visual look before the push** (it's bare/dev-only, but the standing rule is hold-for-audit; one screenshot/Storybook-equivalent check).

## Task 10 — Infra: CloudFront `/ws/*` behavior + origin timeouts

**Files:** Modify `infra/modules/frontend-hosting/main.tf`. **Read spec §"Infra change".** Independent (parallel with T1–T9).
- [ ] **Step 1:** add the `/ws/*` `ordered_cache_behavior` (`target_origin_id="api"`, `Managed-CachingDisabled`, `Managed-AllViewerExceptHostHeader`, `allowed_methods=["GET","HEAD"]`, `compress=false`, no `function_association`); set `origin_read_timeout=60` + `origin_keepalive_timeout=60` on the `api` `custom_origin_config`; **amend the MODULE INVARIANT comment** to enumerate `/ws/*` as a second gate exemption + the "exclusively ticket-gated" precondition.
- [ ] **Step 2:** `terraform fmt` + `terraform -chdir=infra/environments/staging validate` + `plan` → expect the distribution updated in-place (the new behavior + the origin-timeout change shared with `/api/*`). Verify no replacement.
- [ ] **Step 3: Commit** (controller). Apply (`terraform apply`) is part of the deploy in Task 11.

## Task 11 — Wire-level staging smoke (the done-when)

**Files:** Create `backend/scripts/smoke/ws-transport.ts` (Node smoke) + a documented browser SSE step. **Read spec §Verification + `feedback_dev_tool_e2e_smoke_required`, `feedback_playwright_smoke_must_assert_end_state`.** Depends on T8/T9 (clients) + T10 applied.
- [ ] **Step 1:** apply T10's terraform to staging; deploy the frontend (the harness ships DEV-only, so this is just the client-core; no prod behavior change to the SPA bundle). 
- [ ] **Step 2:** the Node smoke: mint a ticket against staging (authed), open `wss://staging.mythrun.com/ws/session/:id?ticket&lastSeq`, round-trip a `player_message`, `__simulateDrop`-equivalent (close the socket) → reconnect → **assert the replay closes the gap with no dupes**; then **hold the socket silent ≥2 heartbeats (~70s) and assert no drop** (idle survival).
- [ ] **Step 3:** the browser SSE step (Playwright OR manual, asserting an observable end-state — events received > 0, not "page loaded"): open `https://staging.mythrun.com/api/campaigns/:id/status/stream` through CloudFront in a real browser and assert events arrive un-buffered (incremental, not coalesced).
- [ ] **Step 4:** only when both pass is the done-when met. **Commit + (controller) the close-the-loop: wiki subagent → push → flip MYT-85 → Done.**

---

## Self-Review

**Spec coverage:** WS client (T5/T6) ✓; SSE client (T7) ✓; connection primitive + ceiling + re-arm + state surface (T3) ✓; StreamingFetch seam + auth-in-core (T2/T7/T8) ✓; ws-ticket schema (T1) + endpoint (T4) ✓; dumb-pipe `send()` readyState (T5) ✓; whole-turn dedup + per-frame lastSeenSeq + load-bearing discard + seed (T6) ✓; close-routing on readable signals (T6) ✓; SSE snapshot/non-200/flow-close (T7) ✓; harness DEV-lazy (T9) ✓; infra `/ws/*` + timeouts + invariant (T10) ✓; smoke incl. idle-survival + SSE-in-browser (T11) ✓; barrels + boot wiring (T8) ✓; portability/lint constraints (Global) ✓. No spec section unmapped.

**Placeholder scan:** none — each task has concrete files, interfaces, and named test cases; complex behavior cites the spec section (the spec carries the full detail by design).

**Type consistency:** `ConnectionState`/`createConnection`/`useConnectionState` (T3) consumed verbatim in T5/T7/T8; `StreamingFetch` `{status, chunks}` (T2) consumed in T7/T8; `WsTicketResponse` (T1)→`mintWsTicket` (T4)→T5; `createWsSessionClient`/`createSseStatusClient` (T5–T7) barrelled in T8 consumed in T9/T11. Names align.

## Dependency wiring (for beads)

Parallel wave 1 (independent): **T1, T2, T3, T10**. Then **T4** (needs T1); **T7** (needs T2,T3). Then **T5** (needs T3,T4) → **T6** (needs T5). Then **T8** (needs T2,T6,T7) → **T9** (needs T8). Then **T11** (needs T8,T9,T10).
