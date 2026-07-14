# MYT-92 Play Session: Chat Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 1 is a VERIFY-FIRST bead — do it before writing any code (spec §7). TDD is mandatory: a failing test that defines "done" precedes every implementation step.

**Goal:** Build the live-play keystone (spec §2). Replace the `play.tsx` stub with the real screen: the session-prep atmospheric wait (SSE-driven) → the start flow (200 / 409-active-join / 409-prep / 402-purchase-moment) → the streamed multiplayer transcript over the shipped WS transport, with reconnect-safe whole-turn replay, optimistic own-messages, an `@DM` summon, a thinking indicator, and a session-end → recap landing. All new components land in `@mythrun/ui`; all reducers/view-models/endpoint-slices land in `@mythrun/client-core`; the web route composes. There is **NO backend work** — every contract is shipped and verified against source.

**Architecture:** client-core-brain + `@mythrun/ui` presentation over the enforced `client-core/contract` prop seam (rules R1–R5). The already-shipped realtime transport (`realtime/ws-session-client.ts`, MYT-85) is a dumb typed pipe: it does the mechanical seq-filter on a `session_reconnect` replay; the NEW `session/` flow reducer does the turnId-keyed **whole-turn replace** the transport deliberately delegates. Enforced ignorance is structural here: the client only ever renders frames the transport hands it; nothing in this issue adds a frame type or a read surface. The transcript reducer models **all** mechanical frames (`skill_check`/`dice_roll`/`ledger_update`/`mode_change`/`combat_*`) as first-class items even though 92 renders each as a terse mono system line — this is the wave-2 shared contract MYT-93/94 extend (RENDERING only, not the reducer shape; spec §7).

**Tech Stack:** React + Vite + TS strict; `@mythrun/{contract,client-core,ui}` + web; Vitest + RTL; Zod (endpoint schemas); the shipped `ws-session-client` + `sse-status-client` realtime clients; `defineEndpoint` data layer; i18n `[ph:]` keys.

## Global Constraints

- **Enforced ignorance / ZFC:** render only transport-delivered frames; add NO frame type, NO read surface, NO ST-stage-direction frame. No heuristics or pattern-matching on LLM prose — the transcript is displayed verbatim.
- **Named exports only; strict TS (no `any`, no assertions unless unavoidable — the wire-boundary `as ServerFrame` narrowing already lives in the transport, not here); functions < 50 lines; modules < 400 lines.** Split `session/` into cohesive files (types / reducer / optimistic / hooks) to hold the line.
- **Design-system-first (R5):** no ad-hoc UI. Every new component lives in `@mythrun/ui` with a Storybook story + tests, imports props from `@mythrun/client-core/contract`, is square-register (no circles, no status dots/chips), and works desktop AND ~375px by construction. Two typefaces only: `--font-body` (Source Serif 4) for DM prose, `--font-ui` (IBM Plex Mono) for player messages + all mechanical/chrome/data readouts.
- **i18n:** every user-facing string is a key with a `[ph:]` placeholder value; `common.json` + `descriptions.ts` in lockstep (the `resources.test.ts` drift test asserts identical key sets). MYT-100 is the one copy pass — do NOT write real copy. `text` props carrying LLM prose / player input are DATA, never keys.
- **Reduced motion:** auto-scroll uses INSTANT positioning under `prefers-reduced-motion`; streaming caret holds steady (never vanishes); the start beat lands instantly. Motion is never the only signal.
- **Accessibility:** the 100×4 bar (100% statements/branches/functions/lines on new source) + the CI storybook browser sweep (a11y contrast + overflow gates) both gate. Live regions announce streaming/thinking state.
- **§7 declared collision surfaces (do NOT restructure wholesale):** `frontend/src/app/app-frame.tsx` — 92 owns ONLY the play-route full-bleed content variant (Task 15); MYT-95 owns the header credit chrome. `frontend/ui/src/index.ts` barrel + i18n `common.json`/`descriptions.ts` — append-only. `router.tsx` — 92 adds only the play-route `handle`; it does not add new route entries (the play + recap routes already exist).
- **No `pipelineRoute` ripple, no migration, no dev-tool manifest:** this issue touches none of the five-contract / migration-pin / dev-tool surfaces. If a task tempts you toward one, stop — it is out of scope.
- Test conventions: co-located `__tests__/x.test.ts(x)`, Vitest + RTL; stories per component; mirror the ideas in `backend/src/__tests__/CONVENTIONS.md` (single isolation, no shared mutable state). Frequent commits (Conventional Commits, one per task).

---

## Phase 0 — Verify-first (spec §7, bead 1)

### Task 1: Drive the prep-status SSE + start arms live (no code)

**Files:** Create `tmp/sdd/myt92-verify-notes.md` (plan-adjacent notes; NOT committed — it is scratch for the build).

**Interfaces:**
- Consumes (observe, do not build): `GET /api/campaigns/:campaignId/prep-status` (SSE), `POST /api/sessions/:campaignId/start`, `GET /api/sessions/:campaignId/active`.
- Produces: a recorded, observed contract the beat + start-flow tasks build against.

Before building anything, confirm the as-shipped shapes on the live dev stack (`:3030`, `x-mythrun-dev-sub` auth). Do NOT trust the plan's transcription of the contract over the live wire.

- [ ] **Step 1 — bring up the dev stack** (`pnpm dev`; backend on `:3030`) and seed/pick a campaign that is `active` with a session prep present (an owner-completed campaign that has run the session-prep pipeline). Record the campaignId.
- [ ] **Step 2 — prep-status SSE:** `curl -N` the prep-status stream with the dev auth header. Record the FIRST frame (`event: snapshot\ndata: {"status":"ready"|"generating"}`) and any live `prep-started`/`prep-ready`/`prep-failed` events (fields: `sessionNumber`, `costUsd`, `terminal`). Note that the tripwire guarantees NO prose ever appears on this channel.
- [ ] **Step 3 — start arms:** `curl -X POST` `/api/sessions/:campaignId/start` and capture EACH observed arm across states: 200 `{sessionId}`; 409 bodies `{code}` for `session_already_active`, `prep_not_ready`, `campaign_not_active`, `reconcile_pending`, `session_ending`; and (on a drained owner) 402 `{code, available, required}`. Record the exact `code` string the 402 carries (spec calls it `insufficient_credits` — CONFIRM against `repo.credits.tryDebitForSession`'s `debit.code`). If it differs, record the real value and flag it — the start-flow classifier keys on it.
- [ ] **Step 4 — active lookup:** with a running session, `curl` `/api/sessions/:campaignId/active` and record the exact response envelope (`{session: null | {id, status, sessionNumber, startedAt, endedAt}}`).
- [ ] **Step 5 — write `tmp/sdd/myt92-verify-notes.md`** with the verbatim observed frames/bodies for steps 2–4. Every later task cites these notes, not the plan's transcription, where they differ. **If the 402 code or any arm differs from this plan, surface it to the controller before proceeding** (do not silently re-map).

---

## Phase A — client-core brain (`session/` — new)

### Task 2: Play-session API slice (`start` + `active`)

**Files:**
- Create: `frontend/client-core/src/api/play-session.ts`
- Modify: `frontend/client-core/src/index.ts` (barrel — append-only)
- Test: `frontend/client-core/src/api/__tests__/play-session.test.ts`

**Interfaces:**
- Consumes: `defineEndpoint` (`api/endpoint.ts`); `HttpError` (`.status`, `.code`, `.body`) on non-2xx.
- Produces:
  - `startSession(input: { campaignId: string }, ctx): Promise<{ sessionId: string }>` — POST `/api/sessions/:campaignId/start`; throws `HttpError` on 402/409.
  - `getActiveSession(input: { campaignId: string }, ctx): Promise<ActiveSessionResponse>` — GET `/api/sessions/:campaignId/active`.
  - Types `ActiveSession` (`{ id, status, sessionNumber, startedAt, endedAt }`) + `ActiveSessionResponse` (`{ session: ActiveSession | null }`), and `InsufficientCreditsBody` (`{ code: string; available: number; required: number }`) for the 402 `.body`.

Note: the existing `api/session.ts` is the AUTH-BFF session (`/api/auth/session`) — do NOT overload it. This is a distinct play-session slice.

- [ ] **Step 1 — failing tests:** (a) `startSession` POSTs to `/api/sessions/<id>/start` and returns `{ sessionId }` on 200; (b) a 409 body `{ code: 'session_already_active' }` rejects with an `HttpError` whose `.status === 409` and `.code === 'session_already_active'`; (c) a 402 `{ code: 'insufficient_credits', available, required }` rejects with an `HttpError` whose `.body` parses as `InsufficientCreditsBody`; (d) `getActiveSession` parses `{ session: null }` AND the populated shape. Run → FAIL (module missing).
- [ ] **Step 2 — implement:**
```ts
// frontend/client-core/src/api/play-session.ts
import { z } from 'zod'
import { defineEndpoint } from './endpoint.ts'

// The live play-session lifecycle endpoints (MYT-92). Distinct from api/session.ts
// (the auth-BFF session). `start` DEBITS the campaign OWNER'S session credit and
// creates the row the WS transport then connects to; `active` resolves the running
// session for the 409-already-active join path. Both throw HttpError on non-2xx —
// the start-flow classifier (start-flow.ts) branches on `.status`/`.code`/`.body`.

const StartSessionResponseSchema = z.object({ sessionId: z.string() })
export type StartSessionResponse = z.infer<typeof StartSessionResponseSchema>

const ActiveSessionSchema = z.object({
  id: z.string(),
  status: z.string(),
  sessionNumber: z.number(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
})
export type ActiveSession = z.infer<typeof ActiveSessionSchema>

const ActiveSessionResponseSchema = z.object({ session: ActiveSessionSchema.nullable() })
export type ActiveSessionResponse = z.infer<typeof ActiveSessionResponseSchema>

/** The 402 body shape (read off `HttpError.body`) — the purchase-moment seam. */
export interface InsufficientCreditsBody {
  code: string
  available: number
  required: number
}

export const startSession = defineEndpoint<StartSessionResponse, { campaignId: string }>({
  method: 'POST',
  path: ({ campaignId }) => `/api/sessions/${encodeURIComponent(campaignId)}/start`,
  response: StartSessionResponseSchema,
})

export const getActiveSession = defineEndpoint<ActiveSessionResponse, { campaignId: string }>({
  method: 'GET',
  path: ({ campaignId }) => `/api/sessions/${encodeURIComponent(campaignId)}/active`,
  response: ActiveSessionResponseSchema,
})
```
- [ ] **Step 3 — barrel:** append `startSession`, `getActiveSession`, and the `ActiveSession`/`ActiveSessionResponse`/`InsufficientCreditsBody` types to `client-core/src/index.ts`. Run the slice test + `pnpm --filter @mythrun/client-core typecheck` → PASS.
- [ ] **Step 4 — commit** `feat(MYT-92): client-core play-session api slice (start + active)`.

### Task 3: Prep-status SSE hook (`useSessionPrep`)

**Files:**
- Create: `frontend/client-core/src/session/use-session-prep.ts`
- Modify: `frontend/client-core/src/index.ts` (barrel)
- Test: `frontend/client-core/src/session/__tests__/use-session-prep.test.tsx`

**Interfaces:**
- Consumes: `createSseStatusClient` (`realtime/sse-status-client.ts` — `.open(path)`, `.onSnapshot`, `.onEvent`, `.connectionState`, `.close()`); the shipped prep-status contract (snapshot `{ status: 'ready' | 'generating' }`; `PipelineEvent`s `prep-started` / `prep-ready{costUsd}` / `prep-failed{terminal}`).
- Produces: `useSessionPrep(ctx, campaignId, deps?) → { status: 'generating' | 'ready' | 'failed'; terminal: boolean }`. Mirrors `useWorldGenStream`'s injected-client + mounted-ref shape (deps.createClient for tests).

The play route subscribes this on `prep_not_ready` (or on entering play before any session exists) and offers Start when `status === 'ready'`.

- [ ] **Step 1 — failing tests** (hand-driven fake SSE client, mirroring `use-worldgen-stream.test.ts`): (a) the `{status:'generating'}` snapshot yields `status:'generating'`; (b) a `prep-ready` event flips to `ready`; (c) a `prep-failed{terminal:true}` event yields `{status:'failed', terminal:true}`; (d) the hook opens `/api/campaigns/<id>/prep-status` and calls `client.close()` on unmount; (e) a `{status:'ready'}` first-frame snapshot (prep already done) yields `ready` with no events. Run → FAIL.
- [ ] **Step 2 — implement** (open the SSE in a `useEffect`; `onSnapshot` sets status from `raw.status`; `onEvent` maps `prep-ready → ready`, `prep-failed → failed` + `terminal`, `prep-started → generating`; a mounted ref guards late setState; unmount closes). Keep the module < 120 lines.
- [ ] **Step 3 — run** the hook test → PASS. Barrel-export `useSessionPrep`.
- [ ] **Step 4 — commit** `feat(MYT-92): prep-status SSE hook (useSessionPrep)`.

### Task 4: Transcript item types + per-frame reducer (the keystone)

**Files:**
- Create: `frontend/client-core/src/session/transcript-types.ts`, `frontend/client-core/src/session/transcript-reducer.ts`
- Test: `frontend/client-core/src/session/__tests__/transcript-reducer.test.ts`

**Interfaces:**
- Consumes: `ServerFrame` (`@mythrun/contract/events`).
- Produces:
  - `TranscriptItem` — the discriminated union of rendered rows (below). MYT-93/94 extend the RENDERING of the mechanical kinds, never this shape (spec §7).
  - `TranscriptState` + `emptyTranscript`.
  - `reduceFrame(state: TranscriptState, frame: ServerFrame): TranscriptState` — folds ONE frame; models every content-bearing frame first-class; handles `session_reconnect` as a **turnId-keyed whole-turn replace** over the transport-filtered batch.

**Design (pin in the module header):**
- The reducer owns TRANSCRIPT CONTENT only. Out-of-band frames are ignored here (the `useSession` hook, Task 6, owns them): `session_ready`, `dm_thinking`, `typing_start`/`typing_stop`, `player_joined`, `player_left`, `error`, `session_end`. `error` surfaces as a connection/system line via the hook, not the transcript.
- DM prose: `text_delta{turnId,text}` accumulates into a single `dm` item keyed on `turnId` (append-only text); `turn_end`/`turn_error` settle it (`streaming:false`). The replay-only `dm_message{seq,turnId,text}` produces a settled `dm` item.
- Mechanical frames (`skill_check`/`dice_roll`/`ledger_update`/`mode_change`/`combat_started`/`combat_resolved`) each append a first-class item carrying the whole frame + its `turnId` (`mode_change`'s turnId is optional — a turn-less resume flip carries none; key it off a minted id, not turnId, in that case).
- `player_message{seq,...}` dedups on `seq` (a `seqSeen` set) and appends a confirmed `player` item. (Optimistic own-echo reconciliation is layered in Task 5 — the raw reducer just dedups + appends.)
- **`session_reconnect` whole-turn replace:** the transport already discarded `seq <= lastSeen`. For every `turnId` present in the batch, REMOVE existing DM/mechanical items carrying that turnId (they may be the partial in-flight turn OR a fully-live-rendered turn in the replay window — either way they must not double-render), then fold each batch message through `reduceFrame` so the seq-bearing replay rebuilds them settled. Player messages in the batch dedup on `seq`. On a FIRST join (`seedLastSeq=0`, empty transcript) there is nothing to remove — the batch simply builds the backlog in order. Annotate the accepted residual: across a multi-turn reconnect window the re-folded turns append at the tail rather than perfectly interleaving by seq — acceptable for 92 (the dominant paths — first-join backlog and single in-flight-turn reconnect — are exact).

- [ ] **Step 1 — failing tests** (pure reducer, no React): (a) two `text_delta`s with the same `turnId` produce ONE `dm` item with concatenated text, `streaming:true`; (b) a following `turn_end` sets that item `streaming:false`; (c) a `skill_check` frame appends a first-class `skill_check` item carrying the frame; likewise `dice_roll`/`ledger_update`/`mode_change`/`combat_started`/`combat_resolved`; (d) a `player_message{seq:5}` appends a `player` item; a second `player_message{seq:5}` (duplicate) is ignored; (e) an out-of-band `dm_thinking`/`typing_start`/`player_joined`/`error` frame leaves `items` unchanged; (f) **whole-turn replace:** given a live partial turn (`text_delta{turnId:'T'}` → one streaming `dm` item), a `session_reconnect` batch containing `dm_message{seq:9,turnId:'T',text}` + `skill_check{seq:10,turnId:'T'}` replaces the streaming item with a settled `dm` item + the skill_check item — the turn renders ONCE (assert exactly one `dm` item with `turnId:'T'`, `streaming:false`); (g) first-join: an empty transcript + a `session_reconnect` with a mixed backlog builds items in batch order. Run → FAIL.
- [ ] **Step 2 — implement** `transcript-types.ts`:
```ts
// frontend/client-core/src/session/transcript-types.ts
import type { ServerFrame } from '@mythrun/contract/events'

/** A frame narrowed to its `type` — the mechanical items carry the whole frame so
 *  MYT-93/94 extend RENDERING (MessageStream's dispatch) without touching this. */
type FrameOf<T extends ServerFrame['type']> = Extract<ServerFrame, { type: T }>

/** A rendered transcript row. `key` is a stable, reducer-minted React key; `turnId`
 *  (where present) is the whole-turn-replace unit. Every mechanical frame is a
 *  first-class item even though MYT-92 renders each as a terse mono system line. */
export type TranscriptItem =
  | { kind: 'dm'; key: string; turnId: string; text: string; streaming: boolean }
  | {
      kind: 'player'
      key: string
      turnId: null
      seq: number | null
      userId: string
      displayName: string
      characterName: string
      text: string
      pending: boolean
    }
  | { kind: 'skill_check'; key: string; turnId: string; frame: FrameOf<'skill_check'> }
  | { kind: 'dice_roll'; key: string; turnId: string; frame: FrameOf<'dice_roll'> }
  | { kind: 'ledger_update'; key: string; turnId: string; frame: FrameOf<'ledger_update'> }
  | { kind: 'mode_change'; key: string; turnId: string | null; frame: FrameOf<'mode_change'> }
  | { kind: 'combat_started'; key: string; turnId: string; frame: FrameOf<'combat_started'> }
  | { kind: 'combat_resolved'; key: string; turnId: string; frame: FrameOf<'combat_resolved'> }

export interface TranscriptState {
  readonly items: readonly TranscriptItem[]
  readonly seqSeen: ReadonlySet<number>
  readonly nextId: number
}

export const emptyTranscript: TranscriptState = {
  items: [],
  seqSeen: new Set<number>(),
  nextId: 0,
}
```
- [ ] **Step 3 — implement** `transcript-reducer.ts` with `reduceFrame`. Load-bearing branches in full; the uniform mechanical branches via a small table. Keep every function < 50 lines (extract `appendMechanical`, `applyDelta`, `settleTurn`, `applyReconnect`).
  - `text_delta`: find the `dm` item with `turnId`; append text, or create a streaming `dm` item.
  - `turn_end`/`turn_error`: map the matching `turnId` `dm` item to `streaming:false`.
  - `dm_message`: append a settled `dm` item (`streaming:false`).
  - mechanical frames: `appendMechanical` mints a key, wraps the frame in the matching item kind.
  - `player_message`: if `seq ∈ seqSeen` return state; else append a `player` item + add `seq` to `seqSeen`.
  - `session_reconnect`: `applyReconnect` — collect `batchTurnIds` from the batch's turnId-bearing frames; drop items whose `turnId ∈ batchTurnIds`; then `reduceFrame`-fold each batch message over the pruned state.
  - default (out-of-band): return state unchanged.
- [ ] **Step 4 — run** the reducer tests (100×4 scoped) → PASS.
- [ ] **Step 5 — commit** `feat(MYT-92): transcript item types + per-frame reducer (whole-turn replace)`.

### Task 5: Optimistic own-messages (pending model + FIFO reconcile)

**Files:**
- Create: `frontend/client-core/src/session/optimistic.ts`
- Test: `frontend/client-core/src/session/__tests__/optimistic.test.ts`

**Interfaces:**
- Consumes: `TranscriptState`/`TranscriptItem`/`reduceFrame` (Task 4); the caller's own `viewerUserId`.
- Produces:
  - `addPending(state, { localId, text, viewerUserId, displayName, characterName }): TranscriptState` — appends a `player` item with `pending:true`, `seq:null`, `key:'pending:'+localId`.
  - `reduceFrameReconciling(state, frame, viewerUserId): TranscriptState` — wraps `reduceFrame`: when `frame` is a `player_message` with `userId === viewerUserId`, reconcile the FIRST pending own item whose `text` matches (FIFO) by REPLACING it in place (set `pending:false`, `seq`, and the frame's `displayName`/`characterName`) instead of appending a duplicate; otherwise delegate to `reduceFrame`.
  - `unconfirmedPending(state, viewerUserId): { localId: string; text: string }[]` — the still-pending own messages (drives reconnect confirm-or-resend in Task 6).

**Residual-risk annotation (required in the module header):** the protocol carries NO client message id, so reconciliation matches on `(viewerUserId, text)` in FIFO order. On reconnect, a pending message absent from the replay is RESENT; if the original actually landed but fell outside the filtered replay window, the resend duplicates. Adding a client message id is out of batch scope — this residual is accepted and documented here.

- [ ] **Step 1 — failing tests:** (a) `addPending` appends a `pending` player item; (b) `reduceFrameReconciling` on the matching own `player_message` flips that item to confirmed (pending:false, seq set) and does NOT add a second item; (c) two pending "hi" messages reconcile FIFO (first echo confirms the first pending); (d) a `player_message` from ANOTHER user with the same text appends a new item and leaves the pending one pending; (e) `unconfirmedPending` lists only still-pending own items. Run → FAIL.
- [ ] **Step 2 — implement.** Keep functions < 50 lines; reuse `reduceFrame` for the non-own path.
- [ ] **Step 3 — run** → PASS.
- [ ] **Step 4 — commit** `feat(MYT-92): optimistic own-message reconcile (FIFO, confirm-or-resend)`.

### Task 6: `useSession` — the play view-model over the WS transport

**Files:**
- Create: `frontend/client-core/src/session/use-session.ts`
- Modify: `frontend/client-core/src/index.ts` (barrel)
- Test: `frontend/client-core/src/session/__tests__/use-session.test.tsx`

**Interfaces:**
- Consumes: `createWsSessionClient` (`.connect(sessionId, { seedLastSeq })`, `.onFrame`, `.send`, `.close`, `.connectionState`, `.__simulateDrop`); `useConnectionState`; `reduceFrameReconciling` / `addPending` / `unconfirmedPending` (Task 5); `emptyTranscript` (Task 4).
- Produces: `useSession(ctx, { sessionId, viewerUserId, displayName, characterName }, deps?) → SessionView`:
```ts
export interface SessionView {
  readonly items: readonly TranscriptItem[]
  readonly connection: ConnectionState        // from the transport store
  readonly thinking: boolean                  // a dm_thinking turn is open
  readonly typingUserIds: readonly string[]   // typing_start minus typing_stop
  readonly ended: boolean                     // a session_end frame arrived
  sendMessage(text: string): void             // optimistic add + transport send (retry-on-fail)
  summonDm(text: string): void                // @DM explicit-text path: send as a player_message carrying the token
  endSession(): void                          // send { type: 'end_session' }
}
```

**Design (pin in the header):**
- Connect on mount with `seedLastSeq: 0` (spec §2 Backlog — full history replay covers the owner's first connect AND the 409-join / mid-session-joiner). `close()` on unmount.
- Fold every inbound frame through `reduceFrameReconciling(state, frame, viewerUserId)`. Track out-of-band state the reducer ignores: `dm_thinking` opens `thinking` (keyed by turnId); the FIRST `text_delta`, `turn_end`, or `turn_error` for that turn CLEARS it (spec §2 — a stuck indicator must not survive a reconnect); `typing_start`/`typing_stop` maintain `typingUserIds`; `session_end` sets `ended`; `error` appends nothing to the transcript but is available to the view as a connection concern.
- `sendMessage`: `addPending` (mint a `localId`), then `send({ type:'player_message', text })`; if `send` returns `false` (socket not OPEN) leave it pending — the reconnect path resends.
- **Reconnect confirm-or-resend:** when the transport store transitions back to `connected` after a `reconnecting`, re-`send` every `unconfirmedPending` message (the annotated residual). The `session_reconnect` replay confirms those that landed; the rest are re-sent.
- `summonDm(text)`: send a normal `player_message` whose text carries the `@dm` token (explicit-text path per spec §2 — the table SEES the summon; the invisible `dm_invoke` frame is NOT used). The SessionInput composes the token; the hook just sends the player_message (and optimistically adds it like any own message).
- Connection state is exposed raw; MessageStream / the route render it as a quiet system line (Task 9/16).

- [ ] **Step 1 — failing tests** (hand-driven fake transport exposing `onFrame`/`send`/a mutable connection store): (a) mounts → `connect` called with `{ seedLastSeq: 0 }`; (b) a `session_reconnect` backlog renders items; (c) `dm_thinking` sets `thinking:true`, the first `text_delta` clears it; (d) `turn_error` also clears thinking; (e) `sendMessage` optimistically adds a pending item AND calls `send`; the echoing `player_message` confirms it; (f) when `send` returns false, the item stays pending and a later reconnect (`connected` after `reconnecting`) re-sends it; (g) `session_end` sets `ended:true`; (h) unmount calls `close`. Run → FAIL.
- [ ] **Step 2 — implement.** Use a `useRef` for the client (one per mount, mirroring `dev-transport.tsx`); a mounted ref for async safety; `useSyncExternalStore`/`useConnectionState` for the connection; subscribe `onFrame` in a `useEffect`. Extract the frame-fold into a pure helper so it is unit-tested directly. Keep the module < 200 lines.
- [ ] **Step 3 — run** → PASS. Barrel-export `useSession` + `SessionView`.
- [ ] **Step 4 — commit** `feat(MYT-92): useSession play view-model (transport wiring, optimistic, reconnect resend)`.

### Task 7: Start flow (classifier + `useSessionStart`)

**Files:**
- Create: `frontend/client-core/src/session/start-flow.ts`
- Modify: `frontend/client-core/src/index.ts` (barrel)
- Test: `frontend/client-core/src/session/__tests__/start-flow.test.tsx`

**Interfaces:**
- Consumes: `startSession` / `getActiveSession` / `InsufficientCreditsBody` (Task 2); `isHttpError`.
- Produces:
  - `classifyStartError(err: unknown): StartOutcome` — pure. Maps a caught error to a discriminated outcome:
    - `HttpError` 409 `session_already_active` → `{ kind:'join' }` (caller then looks up `/active`)
    - `HttpError` 409 `prep_not_ready` → `{ kind:'prep' }`
    - `HttpError` 402 → `{ kind:'purchase', body: InsufficientCreditsBody }` (the purchase-moment seam)
    - `HttpError` 409 other (`campaign_not_active` / `reconcile_pending` / `session_ending`) → `{ kind:'blocked', code }`
    - anything else → `{ kind:'error' }`
  - `useSessionStart(ctx, { campaignId, viewerIsOwner }, deps?) → StartFlow`:
```ts
export interface StartFlow {
  readonly state:
    | { phase: 'idle' }
    | { phase: 'starting' }
    | { phase: 'prep' }                                   // → the route mounts SessionStartBeat's prep phase
    | { phase: 'ready'; sessionId: string }               // → the route mounts useSession
    | { phase: 'purchase'; moment: PurchaseMoment }        // → the MYT-95 seam (calm [ph:] fallback in 92)
    | { phase: 'blocked'; code: string }                   // → a calm retry notice
    | { phase: 'error' }
  start(): void
  retry(): void
}
```
  - `PurchaseMoment` — the typed signal MYT-95's `PurchasePrompt` consumes (define it HERE, exported): `{ available: number; required: number; viewerIsOwner: boolean }`. **This exact shape is the cross-issue seam (spec §4/§7) — MYT-95 imports it; do not rename at the 95-merge.**

**Design:** `start()` calls `startSession`; on 200 → `{ ready, sessionId }`. On a caught error, `classifyStartError`: `join` → call `getActiveSession`, take `session.id` → `{ ready, sessionId }` (or `blocked` if the active lookup comes back null — a race); `prep` → `{ phase:'prep' }`; `purchase` → `{ phase:'purchase', moment: { available, required, viewerIsOwner } }`; `blocked`/`error` → the matching phase. The prep phase resolves upward: the route watches `useSessionPrep`; when prep is `ready` it calls `retry()` (= `start()` again).

- [ ] **Step 1 — failing tests** (spy `startSession`/`getActiveSession`): (a) 200 → `ready` with sessionId; (b) 409 `session_already_active` → looks up `/active` → `ready` with the active id; (c) 409 `prep_not_ready` → `prep`; (d) 402 → `purchase` with `moment.available/required` from the body AND `viewerIsOwner` threaded through; (e) 409 `session_ending` → `blocked` with the code; (f) a network error → `error`; (g) `classifyStartError` unit-tested for each arm in isolation. Run → FAIL.
- [ ] **Step 2 — implement.** Keep `classifyStartError` pure + exhaustively tested; the hook is a thin async state machine over it.
- [ ] **Step 3 — run** → PASS. Barrel-export `useSessionStart`, `classifyStartError`, `StartFlow`, `StartOutcome`, `PurchaseMoment`.
- [ ] **Step 4 — commit** `feat(MYT-92): session start flow (classifier + useSessionStart + purchase-moment seam)`.

---

## Phase B — `@mythrun/ui` components

> Each U-task: author the prop contract (Task 8) first, then a presentational component importing props from `@mythrun/client-core/contract`, shipping a Storybook story + tests, square register, two-faces-only, responsive to ~375px, reduced-motion honored. Append to the `ui/src/index.ts` barrel. The mechanical-frame rendering (terse mono system lines) lives INSIDE MessageStream's item dispatch — it is NOT a separate listed component (the six components are exactly those in spec §2).

### Task 8: Session prop-contracts

**Files:**
- Create: `frontend/client-core/src/contract/session/index.ts` (+ `message-stream.ts`, `dm-message.ts`, `player-message.ts`, `session-input.ts`, `thinking-indicator.ts`, `session-start-beat.ts`, or one file — match the `contract/character/` grouping)
- Modify: `frontend/client-core/src/contract/index.ts` (re-export — append-only)
- Test: type-only (tsc) + the existing `contract.test.ts` barrel assertion.

**Interfaces (DOM-free prop types, R1; neutral callbacks only):**
- `MessageStreamProps` — `{ items: readonly TranscriptItem[]; connectionLine: string | null; reducedMotion: boolean }`. (Re-export `TranscriptItem` through the contract surface so the component reads it here, not via a second import — mirror how `character/index.ts` re-exports `LoadingBeat`.)
- `DmMessageProps` — `{ text: string; streaming: boolean; writingLabel?: string }`.
- `PlayerMessageProps` — `{ displayName: string; characterName: string; text: string; pending: boolean }`.
- `SessionInputProps` — `{ value: string; onChange: (v: string) => void; onSend: () => void; onSummonDm: () => void; disabled: boolean; placeholder: string; summonLabel: string; sendLabel: string }`.
- `ThinkingIndicatorProps` — `{ thinking: boolean; typingNames: readonly string[]; thinkingLabel: string; typingLabel: string }`.
- `SessionStartBeatProps` — `{ phase: 'prep' | 'connecting'; reducedMotion: boolean; prepLabel: string; connectingLabel: string }`.

- [ ] **Step 1** — author the prop types + the `TranscriptItem` re-export + the `contract/index.ts` re-export block. `pnpm --filter @mythrun/client-core typecheck` + the barrel test → PASS.
- [ ] **Step 2 — commit** `feat(MYT-92): client-core prop contracts for session components`.

### Task 9: `MessageStream` (+ mechanical system-line dispatch)

**Files:** `frontend/ui/src/components/MessageStream/{MessageStream.tsx,.stories.tsx,.test.tsx}` + `ui/src/index.ts`.

**Behavior:** a scroll container that maps each `TranscriptItem` to its renderer — `dm` → `<DmMessage>`, `player` → `<PlayerMessage>`, each mechanical kind → a **terse `--font-ui` (IBM Plex Mono) system line** (e.g. `skill_check` → `perception · 14 vs DC 12 · success`; `ledger_update` → its `summary`; `mode_change` → `— combat —`; etc. — all `[ph:]`-labeled where a label is needed, the numbers are data). Auto-follow the tail with a "jump to now" affordance when the user has scrolled up; **auto-scroll uses INSTANT positioning under `reducedMotion`** (no smooth-scroll vestibular trigger). A quiet `connectionLine` (reconnect banner as a system line) renders pinned when non-null. Day/scene dividers are a light structural affordance (a `Divider` between turns — keep minimal; the rich divider is later polish).

- [ ] Steps: TDD (renders each item kind to the right sub-renderer; mechanical kinds render a mono line; auto-scrolls to the tail on new items; under `reducedMotion` uses `scrollTop = scrollHeight` not `scrollIntoView({behavior:'smooth'})`; a `connectionLine` renders when set) → implement (extract a pure `renderItem(item)` dispatch so 93/94 extend it; the scroll effect keyed on `items.length` + a `wasAtBottom` ref) → stories (a mixed transcript: DM streaming + settled, player messages, a skill_check line, a combat line, a reconnect line; a reduced-motion story) → PASS → commit `feat(MYT-92): MessageStream (item dispatch + auto-follow + reduced-motion scroll)`.

### Task 10: `DmMessage` (serif streaming)

**Files:** `frontend/ui/src/components/DmMessage/{DmMessage.tsx,.stories.tsx,.test.tsx}` + barrel.

**Behavior:** composes the shipped `StreamingProse` (Source Serif 4 `prose-body`, append-only text node, brand caret while `streaming`, hands off to static Text with zero reflow on settle). Paper tint. `writing={streaming}`; `writingLabel` a `[ph:]` SR annotation. This is a thin wrapper that fixes the DM register (serif, paper) over `StreamingProse` — do NOT re-implement the caret.

- [ ] Steps: TDD (renders `text`; shows the writing caret while `streaming`; drops it on settle; `writingLabel` present while streaming) → implement (wrap `StreamingProse`) → stories (streaming, settled) → commit `feat(MYT-92): DmMessage (serif streaming prose)`.

### Task 11: `PlayerMessage` (IBM Plex Mono)

**Files:** `frontend/ui/src/components/PlayerMessage/{PlayerMessage.tsx,.stories.tsx,.test.tsx}` + barrel.

**Behavior:** the humans at the table in **`--font-ui` (IBM Plex Mono)** — the mechanical register (the DM is narrative-register; the split IS the distinction). A distinct paper tint from the DM. Shows `displayName` (or `characterName`) + `text`. `pending` renders a quiet in-flight treatment (a dimmed tint — NOT a spinner/dot; square register, no circles). **No bubbles-and-avatars chat idiom.**

- [ ] Steps: TDD (renders name + text in the mono role; `pending` applies the dimmed treatment; no avatar/circle) → implement → stories (confirmed, pending, long name at 375px) → commit `feat(MYT-92): PlayerMessage (mono, no-bubble)`.

### Task 12: `SessionInput` (@DM explicit-text summon)

**Files:** `frontend/ui/src/components/SessionInput/{SessionInput.tsx,.stories.tsx,.test.tsx}` + barrel.

**Behavior:** a text input + a Send affordance + a prominent `@DM` summon. Controlled (`value`/`onChange`). Send fires `onSend`. The `@DM` button fires `onSummonDm` — the **explicit-text path**: the composition inserts the `@dm` token into the visible message so it persists + broadcasts as a normal `player_message` (the backend's explicit-trigger path recognizes the token; the invisible `dm_invoke` frame is NOT used — the table sees the summon). The token-insertion detail lives at the route wire (Task 16) which owns the send handlers; the component just exposes the two intents. `disabled` gates both while the session is `ended`/not-ready. Enter-to-send; Shift+Enter newline.

- [ ] Steps: TDD (typing fires `onChange`; Enter/Send fires `onSend`; the `@DM` control fires `onSummonDm`; `disabled` blocks both) → implement (compose `TextArea`/`SeamlessInput` + `Button`/`IconButton` DS primitives) → stories (empty, typed, disabled, 375px) → commit `feat(MYT-92): SessionInput (@DM explicit-text summon)`.

### Task 13: `ThinkingIndicator`

**Files:** `frontend/ui/src/components/ThinkingIndicator/{ThinkingIndicator.tsx,.stories.tsx,.test.tsx}` + barrel.

**Behavior:** shows "DM is thinking…" while `thinking`, and player typing from `typingNames` (`typing_start`/`typing_stop`). Pure/presentational — the hook (Task 6) owns the CLEAR conditions (first `text_delta`/`turn_end`/`turn_error`); the component just renders the current booleans/names. Quiet `--font-ui` line; the brand's sanctioned opacity-fade only under motion; steady under reduced motion. A polite live region announces the state for AT.

- [ ] Steps: TDD (renders the thinking line when `thinking`; renders typing names when present; renders nothing when both empty; live region present) → implement → stories (thinking, one typer, thinking+typing, idle) → commit `feat(MYT-92): ThinkingIndicator`.

### Task 14: `SessionStartBeat`

**Files:** `frontend/ui/src/components/SessionStartBeat/{SessionStartBeat.tsx,.stories.tsx,.test.tsx}` + barrel.

**Behavior:** the 1-bit loading-beat family (same register as `CharacterLoadingBeat` / `WorldGenLoading` — paper, Dither hatch, NOT voxel). TWO labeled phases of ONE beat: `phase:'prep'` (the SSE-driven atmospheric "DM is preparing tonight's session…" 1–2 minute wait) and `phase:'connecting'` (the short socket-connect boundary). Accelerates toward completion; `reducedMotion` lands instantly (no churn). `aria-busy` + a polite live region naming the active phase. Reuse the shipped `Dither`; do NOT invent a new gradient.

- [ ] Steps: TDD (renders the prep label in `prep`, the connecting label in `connecting`; `aria-busy`; reduced-motion snaps) → implement (mirror `CharacterLoadingBeat`'s figure/Dither idiom; the phase is the only state) → stories (prep, connecting, reduced-motion) → commit `feat(MYT-92): SessionStartBeat (prep + connect phases)`.

---

## Phase C — web wiring

### Task 15: AppFrame full-bleed content variant (§7 declared shared file)

**Files:**
- Modify: `frontend/src/app/app-frame.tsx` (the CONTENT area only — NOT the header row, which is MYT-95's)
- Modify: `frontend/src/app/router.tsx` (add `handle: { fullBleed: true }` to the existing play route entry — no new routes)
- Test: `frontend/src/app/__tests__/app-frame.test.tsx` (extend), `frontend/src/app/router.test.tsx` (assert the handle)

**Interfaces:**
- Produces: when a matched route declares `handle.fullBleed === true`, AppFrame renders the content `<Outlet/>` WITHOUT the `padding={6}` Box and lets it fill the viewport below the header (header + content = exactly one viewport, no page scroll). Default routes are unchanged.

**Design decision (flagged — see Spec Ambiguity #1):** the spec says the play route "escapes AppFrame's padded content Box via an explicit frame variant/prop, NOT ad-hoc negative margins." I implement this as a **route `handle` flag read via `useMatches()`** — the React Router idiomatic "child route influences layout" seam — rather than a prop threaded through the router element or the shipped `FullBleedStage` (which cancels padding with negative margins, exactly what the spec rules out). This keeps ONE AppFrame instance and isolates 92's edit to the content branch, leaving 95's header edit non-overlapping.

- [ ] **Step 1 — failing tests:** (a) a route with `handle:{fullBleed:true}` renders the content without the `app-frame-content` padded Box (a new `data-testid="app-frame-content-bleed"` full-height container instead); (b) a normal route still renders the padded `app-frame-content`; (c) the header row is identical in both; (d) router test: the `campaigns/:id/play` entry carries `handle:{fullBleed:true}`. Run → FAIL.
- [ ] **Step 2 — implement:** read `const matches = useMatches()` in AppFrame; `const fullBleed = matches.some((m) => (m.handle as { fullBleed?: boolean } | undefined)?.fullBleed === true)`. Branch the content region: full-bleed → a flex container filling `min-h-[calc(100dvh-<header>)]` (a `min-h-0 flex-1` column under a `min-h-dvh` Stack) with no padding; else the existing `<Box padding={6}>`. Add `handle: { fullBleed: true }` to the play route in `router.tsx`. Keep the header row byte-identical (95 owns it).
- [ ] **Step 3 — run** app-frame + router tests + the app-frame story → PASS.
- [ ] **Step 4 — commit** `feat(MYT-92): AppFrame full-bleed content variant for the play route`.

### Task 16: Play route composition

**Files:**
- Modify: `frontend/src/routes/play.tsx` (replace the stub)
- Create (route-local compositions if needed): `frontend/src/routes/play/` (e.g. `session-shell.tsx`, `sidebar-placeholder.tsx`) — thin route-local compositions of DS primitives; promote to `@mythrun/ui` only if reused.
- Modify: web i18n (`common.json` + `descriptions.ts` — append-only `[ph:]` keys)
- Test: `frontend/src/routes/__tests__/play.test.tsx` (+ a screen story)

**Interfaces:**
- Consumes: `useMe` (viewer `user.id` + `displayName`); a campaign read for `viewerIsOwner` (mirror MYT-90's `CampaignSummary.creator === null ⟹ owner`); `useSessionStart`, `useSessionPrep`, `useSession`, `PurchaseMoment` (client-core); `MessageStream`, `SessionInput`, `ThinkingIndicator`, `SessionStartBeat` (`@mythrun/ui`); `useNavigate`.
- Produces: the live-play screen composition (spec §2 Screen).

**Design:**
- **Ownership + identity:** fetch the campaign summary (owner = `creator === null`) and `useMe` (viewer `user.id` / `displayName`; `characterName` from the member's finalized character where available — pass `''` fallback if the in-session sheet read is MYT-94's). `viewerUserId = user.id` (the DB id the `player_message` frame carries — see Spec Ambiguity #2).
- **Start + prep:** drive `useSessionStart({ campaignId, viewerIsOwner })`. On mount call `start()`. Render by `state.phase`:
  - `starting`/`ready`-pending-connect → `<SessionStartBeat phase="connecting" />`.
  - `prep` → subscribe `useSessionPrep`; render `<SessionStartBeat phase="prep" />`; when prep `status === 'ready'` call `retry()`. On prep `failed` → a calm `[ph:]` notice.
  - `ready{sessionId}` → mount the session shell (below).
  - `purchase{moment}` → the **MYT-95 seam**: render a calm `[ph:]` fallback (owner-branch placeholder wired to `moment`; non-owner → the "owner is out of session credits" calm notice per spec §4). Leave a clearly-marked seam comment where 95 slots `<PurchasePrompt moment={moment} />`.
  - `blocked{code}` / `error` → a calm retry notice (Retry → `retry()`).
- **Session shell (`ready`):** mount `useSession(ctx, { sessionId, viewerUserId, displayName, characterName })`.
  - Desktop: chat column ~70% + a **collapsible sidebar ~30%** whose panel is a `sidebar-placeholder` (a seam MYT-94 fills), **collapsed by default** (MYT-94 flips the default to open per UX §9). Mobile: chat full-bleed; the sidebar summons via the shipped `Drawer` pattern.
  - Compose: `<MessageStream items connectionLine reducedMotion>` (scrolls internally — the full-bleed frame gives it the height) + `<ThinkingIndicator thinking typingNames>` + `<SessionInput value onChange onSend onSummonDm disabled={ended}>`. `connectionLine` derives from `connection.status` (`reconnecting`/`failed` → a `[ph:]` quiet line; else null). `reducedMotion` from `prefers-reduced-motion`.
  - Send handlers: `onSend` → `sendMessage(value)` + clear; `onSummonDm` → compose the `@dm`-token message and `summonDm(...)` (the explicit-text path).
  - **Session end:** when `ended` flips true → a brief "Session complete" transition, then `navigate('/campaigns/:id/recap')`. The recap READ is out of scope (Spec Ambiguity #3 / filed bead) — this only LANDS on the route.
- **Full-bleed:** the route relies on Task 15's `handle:{fullBleed:true}`; it does NOT add negative margins.

- [ ] **Step 1 — failing tests** (inject fake hooks via props/deps, mirroring `CharacterNewRoute`'s injectable endpoints): (a) prep phase renders `SessionStartBeat[phase=prep]` and calls `retry` when prep goes ready; (b) `ready` mounts `MessageStream` with the session items; (c) `onSend` calls `sendMessage` and clears the input; (d) `@DM` sends via `summonDm` with the token in the text; (e) `ended` navigates to the recap route; (f) `purchase` renders the calm `[ph:]` seam (owner branch); (g) a non-owner purchase renders the "owner out of credits" notice; (h) `blocked`/`error` render a retry notice; (i) at 375px the layout is single-column full-bleed with a drawer-summoned sidebar (min-w-0, no horizontal scroll). Run → FAIL.
- [ ] **Step 2 — implement** the route + any route-local compositions. Keep each file < 400 lines / functions < 50 (extract the shell + the start-phase switch). Add the `[ph:]` i18n keys to `common.json` + `descriptions.ts` in lockstep.
- [ ] **Step 3 — run** the route test + screen story + `resources.test.ts` (i18n drift) → PASS.
- [ ] **Step 4 — commit** `feat(MYT-92): play route — prep beat, start flow, live session shell, recap landing`.

---

## Phase D — verification

### Task 17: Merged battery + E2E done-when smoke

**Files:** none new (verification). A Playwright E2E under the repo's smoke convention if a script home exists; otherwise a documented manual wire-walk (curl/SSE/psql + two browser identities) per the CLAUDE.md dev-tool-E2E rule.

- [ ] **Step 1 — full batteries:** `pnpm --filter @mythrun/client-core test`, `pnpm --filter @mythrun/ui test`, the web route tests; `pnpm typecheck`; `pnpm lint` (whole `src`, for the type-aware rules); scoped coverage at 100×4 on the new source; the Storybook browser sweep on the new stories (a11y contrast + overflow gates). All green.
- [ ] **Step 2 — E2E done-when (spec §2, verbatim):** on the live dev stack, a real multi-message session runs end to end:
  - the prep beat shows, then Start (the OWNER's session credit is debited — verify the `credit_ledger` row);
  - streamed DM prose renders live (token-wise);
  - a SECOND browser identity joining MID-SESSION sees the FULL backlog + the live stream + typing;
  - `@DM` visibly summons a DM response (the `@dm` token appears in the transcript as a player message, and a DM turn follows);
  - a reconnect mid-turn (use `__simulateDrop` in the dev harness, or kill the socket) resyncs WITHOUT double-rendering that turn;
  - session end lands on the recap ROUTE (stub content acceptable).
  - **Wire smoke:** inspect the WS frames + the `sessions` / `session_messages` / `credit_ledger` rows (psql). Assert observable END STATE (e.g. a rendered transcript with N>0 DM + player rows, the debited ledger row), not "page loaded / no errors" (the Playwright-asserts-end-state rule).
- [ ] **Step 3 — wiki sync:** dispatch the `docs/wiki/AUTHORING.md` subagent (parameterized with MYT-92) before the merge's final push (the controller owns the push per the worktree flow).
- [ ] **Step 4 — commit** any verification scaffolding as `test(MYT-92): play chat-core E2E smoke + merged battery`.

---

## Filed beads (not built here — spec §2 / §5 scope cuts)

- **Recap read + real recap screen** (`sessions.summary` → a player-facing recap endpoint + the real screen; resolve the `campaignId`-vs-`sessionId` recap-param question). Explicitly deferred; 92 only lands on the recap route.
- **`member_joined` realtime event** (a possible backend follow-up so party/roster liveness has a real signal rather than the pipeline `character_creation_complete` proxy — noted by MYT-91, relevant to the play roster later).
- **In-stream mechanical rendering upgrades** (MYT-93 dice/skill cards, MYT-94 entity highlighting + sidebar tabs) — extend MessageStream's `renderItem` dispatch + the play-route sidebar seam; the reducer shape is already wave-2-final.

---

## Self-review

**Spec §2 coverage:** prep phase (SSE + `prep_not_ready` arm + two-phase beat) → Tasks 3, 7, 14, 16; start flow (200 / 409-active-join / 409-prep / 402-purchase-seam) → Tasks 2, 7, 16; WS view-model modeling ALL mechanical frames first-class + turnId whole-turn replace + `seedLastSeq(0)` first join + optimistic FIFO + reconnect confirm-or-resend + connection-as-system-line → Tasks 4, 5, 6, 9; the six components → Tasks 9–14; play-route composition (70/30 + collapsed sidebar shell seam + mobile full-bleed via the AppFrame variant + drawer) → Tasks 15, 16; session end → recap landing (read out of scope) → Task 16 + filed bead; the E2E done-when verbatim → Task 17. Verify-first bead → Task 1. ✅ all mapped.

**Enforced ignorance / ZFC:** no new frame type, no new read surface, no ST-stage-direction frame; the transcript renders transport-delivered frames verbatim; no heuristic/pattern-matching on prose. ✅

**§7 collision discipline:** AppFrame edit scoped to the content variant (Task 15), header untouched (95's); barrel + i18n append-only; router adds only the play `handle`; `PurchaseMoment` seam defined once (Task 7) for 95 to import; the transcript reducer models all mechanical frames so 93/94 extend rendering only. ✅

**Placeholder scan:** load-bearing code inline (the API slice, the reducer types + whole-turn-replace design, the optimistic reconcile contract, the start-flow classifier arms, the AppFrame variant mechanism, the `SessionView`/`StartFlow`/`PurchaseMoment` interfaces). UI tasks carry exact props + test intent + composition notes (matching the MYT-90 C-task altitude). No "TBD".

**Type consistency:** `startSession`/`getActiveSession`/`InsufficientCreditsBody`, `TranscriptItem`/`TranscriptState`/`reduceFrame`, `reduceFrameReconciling`/`addPending`/`unconfirmedPending`, `useSession`/`SessionView`, `useSessionStart`/`classifyStartError`/`StartFlow`/`PurchaseMoment`, `useSessionPrep`, the six `*Props` types, and the `handle.fullBleed` flag are used consistently across tasks.
