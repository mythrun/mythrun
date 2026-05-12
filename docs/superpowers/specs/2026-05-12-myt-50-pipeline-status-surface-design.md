# MYT-50 — Pipeline status surface: snapshot routes + SSE + Redis pub/sub bridge (design)

> **Status:** Design approved 2026-05-12 (brainstorming pass). Implementation next via writing-plans.
> **Linear:** MYT-50
> **Spec parent:** `docs/specs/2026-04-13-world-campaign-pipeline.md` §8 + §9 (both amended 2026-05-12 to consolidate status to campaign-scoped routes)
> **Estimate per Linear:** 1 working day
> **Worktree:** `.worktrees/myt-50` on branch `myt-50-pipeline-status`
> **Parallel with:** MYT-49 (BullMQ worker + `wrapStream` middleware) — no file overlap; minor coverage.json merge risk only

## 1. Goal

Land the pipeline-status data plane for campaign-scoped pipelines:

- `GET /api/campaigns/:id/status` — one-shot snapshot of where the pipeline is (phase + per-stage detail), computed from `pipeline_runs` + `campaigns.status` + `worlds.status`.
- `GET /api/campaigns/:id/status/stream` — SSE stream that forwards worker-published events for this campaign to attached clients.
- One shared Redis subscriber per API process, fanning out to attached SSE connections via an in-memory map. (Not one Redis subscriber per SSE connection.)
- Six initial event types in `pipeline-events.ts` (`phase`, `stage-started`, `stage-completed`, `stage-failed`, `cost-update`, `job-failed`). Entity-level events come later in MYT-52.
- Dev-tool status panel that paste-takes a `campaignId` and shows live phase + stage progression.

Subsequent issues (MYT-51 onward) consume this surface. MYT-50 itself never produces events — the worker (MYT-49 shell, MYT-51+ real processors) does the publishing. MYT-50 is the consumption side: the API hosts, the SSE forwarding, the snapshot derivation.

## 2. Decisions made during brainstorming

| # | Decision | Why |
|---|---|---|
| D1 | **Campaign-scoped surface only.** Drop all `/api/worlds/*` status routes. One channel `pipeline:campaign:{id}`. | Campaign is the user-facing unit at launch. World is a child resource (not independently addressable via HTTP). The "share an existing world during campaign creation" flow that would justify world-scoped routes is deferred with the rest of the fork story. Parent spec §9 amended in the prior commit to reflect this. |
| D2 | **Shared Redis subscriber per API process**, on a DEDICATED ioredis client (`redis.duplicate(...)` with explicit `retryStrategy` + `maxRetriesPerRequest: null`). NOT shared with `deps.redisRealtime`. | At 200–500 concurrent SSE connections per task, per-connection subscribers blow through Redis budget. In-memory `Map<channel, Set<SseConnection>>` fans messages out from one shared subscriber. **Critical: do NOT reuse `deps.redisRealtime` — that client is in command mode and is used by rate-limit + ws-ticket; once it issues SUBSCRIBE it can't accept commands and silently breaks both surfaces on every task with an SSE connection.** The dedicated subscriber also needs reconnect-on-blip semantics (existing factory at `redis/client.ts` is non-reconnecting by design for the boot probe); the subscriber overrides that and re-issues `PSUBSCRIBE` on `'ready'` after a disconnect, pushing an `event: resync` SSE frame to attached clients so they re-fetch state. |
| D3 | **JSON-discriminated-union encoding**: `data: {"type":"phase","phase":"world_gen"}\n\n`, not named SSE events. | Matches §8 event-type union; one message handler in the dev tool and future frontend; easier to log/inspect; named events offer no real benefit when there's only one consumer pattern. |
| D4 | **Snapshot is delivered AS THE FIRST FRAME of the SSE stream**, not via a separate `GET /status` call. The SSE handler computes the initial snapshot inside the request after the subscriber is attached, writes it as `event: snapshot\ndata: {...}\n\n`, then forwards live events. `GET /status` (the one-shot endpoint) still exists for callers that want a point-in-time read without a long-lived connection. | Eliminates the race window between snapshot-fetch and SSE-attach (events published in the ~50–200 ms gap would otherwise be lost). The SSE-stream handler's ordering is: attach to subscriber map → compute snapshot → send snapshot frame → forward live. No client-side coordination required. |
| D5 | **Server-side keepalive comment frames every 25 s** (`:\n\n`). | Prevents intermediate-proxy idle drops (ALB has a 3600 s idle timeout, but corporate VPN / dev-loop proxies can be tighter). Cheap; ~6 bytes per ping. |
| D6 | **Server-side idle timeout: 30 min no message → server closes** with one of a small enum of close reasons (`idle-timeout`, `server-shutdown`, `redis-resync-required`, `rate-limited`, `back-pressure`, `unknown`). The reason is encoded as `event: close\ndata: { reason }\n\n`. Client closes the EventSource on receipt + reconnects via a fresh `/status/stream` request (which carries the snapshot in its first frame per D4). | Recovers stuck connections AND lets ops distinguish "campaign is quiet" from "task scaled-in" from "Redis blipped" from "slow client dropped." 30 min covers active pipeline windows; the "all players idle waiting for one to submit" gap is recovered by snapshot-on-reconnect. |
| D7 | **Connection-leak metric**: 60-second pino log `event: 'sse.connections.active', count: N, max_since_last: M, taskRevision: <ECS task arn|rev>` from a process-scoped counter. `setInterval` is `unref()`'d so it doesn't pin the event loop during shutdown. | Cheap, observable via CloudWatch Logs Insights, no new infra. 60 s cadence captures spikes that hourly would miss; max-since-last surfaces transient peaks; `taskRevision` lets ops aggregate across the 1–4 task fleet. Connection leaks are operational concerns; this gives us the signal without committing to a metrics surface. (Future: emit a CloudWatch metric alongside if a leak alarm is wanted — trivial follow-up.) |
| D8 | **Phase derivation is a pure function** `derivePhase({ campaign, world, runs }): { phase, stages }`. | Testable in isolation; the route handler and the SSE-on-connect snapshot share one source of truth. |
| D9 | **No `derivePhase` re-computation on every SSE event.** The worker publishes the events; the API forwards as-is. Phase events are emitted explicitly by the worker (or by the route on connect-snapshot only). | Avoids re-querying Postgres on every event arrival. Worker is the source of truth for state transitions. |
| D10 | **Dev tool: paste-input campaignId + "Watch" button.** No real campaign-creation flow at MYT-50 time. | Phase 0 lets the engineer manually `INSERT INTO campaigns` and watch the SSE plumbing work. MYT-51 ships the real "create campaign" UI that auto-opens the status panel. |
| D11 | **Route param name is `:campaignId`** (not `:id`). All campaign routes in this issue and forward use that name. Parent spec §9 already says `:id` in the route-table text; the design treats `:campaignId` as the implementation name to match existing `requireCampaignMember` semantics. | `requireCampaignMember` (`backend/src/auth/access-control.ts:56`) reads `request.params.campaignId` — that's the established convention from sessions.ts. Using `:id` would 500 every request because the auth pre-handler can't resolve the param. Renaming the auth helper to be lenient is wider-blast than just standardizing on `:campaignId`. Parent spec §9 wording is a textual nit to clean up alongside this issue's wiki page. |
| D12 | **Per-USER rate-limit on `/status/stream`** (`keyGenerator: (req) => requireDbUser(req).id`), not per-IP. Snapshot route stays per-IP. | EventSource auto-reconnects on every close (browser default 3 s). A user with a flaky network or watching 2 campaigns simultaneously will burn through a per-IP 10/min cap and lock themselves out. The threat model — "burst-open many connections to leak resources" — is per-user, not per-IP. Matches `sessions.ts`'s ws-ticket route precedent. |
| D13 | **Back-pressure handling**: `SseSink.write(frame)` returns `boolean`. If the underlying `reply.raw.write()` returns `false`, the connection-writer arms a 5 s `'drain'` timer; if `'drain'` doesn't fire within the window, the connection is closed with `event: close\ndata: { reason: 'back-pressure' }\n\n`. Per-sink try/catch wraps every write so one slow client can't wedge the subscriber's iteration. | Under a slow client + event burst (entity-event flood once MYT-52 ships), unbounded buffering OOMs the Fargate 768 MB heap. Drop-and-let-the-client-reconnect is the recoverable path. The per-sink try/catch is the safety net against the in-memory map accumulating dead sockets. |
| D14 | **Shutdown ordering**: explicit, in `backend/src/app.ts` `createShutdown`. (1) `stopHourlyLog()`. (2) For every attached SSE connection: push `event: close\ndata: { reason: 'server-shutdown' }\n\n` + `response.end()`. (3) `subscriber.close()` — UNSUBSCRIBE + clear map + QUIT the dedicated subscriber client. (4) Existing teardown: `app.close()`, `pg.end()`, `redisRealtime.quit()`, `redisBatch.quit()`. | ALB deregistration delay is 120 s (Infra §2.5). Without explicit close-frame emission, `app.close()` hangs on SSE responses Fastify thinks are still active until SIGKILL. Goodbye-frame approach lets clients reconnect via snapshot on whichever task survives. |

## 3. File structure

```
backend/src/
├── sse/                            # NEW — pipeline-status SSE machinery
│   ├── derive-phase.ts             # pure: { campaign, world, runs } → { phase, stages }
│   ├── derive-phase.test.ts        # unit tests with fake row fixtures
│   ├── pipeline-subscriber.ts      # one shared Redis subscriber per API process
│   ├── pipeline-subscriber.test.ts # integration: real Redis, fake SSE writes
│   ├── sse-connection.ts           # SSE response writer (headers, keepalive, idle timeout)
│   ├── sse-connection.test.ts      # unit + integration where appropriate
│   └── connection-counter.ts       # tiny module: increment/decrement + hourly log
└── routes/
    └── campaigns.ts                # NEW — POST/GET/etc for campaigns (this issue
                                    # lands status + status/stream only; other
                                    # campaign routes come in MYT-51+)

backend/src/repo/
└── pipeline-runs.ts                # NEW — list rows for a campaign (joins through worlds)

backend/dev-tool/
├── src/components/
│   └── status-panel.ts             # NEW — paste campaignId, watch SSE
└── coverage.json                   # MODIFIED — add 2 routes, add 6 events

backend/src/contract/
├── pipeline-routes.ts              # MODIFIED — register 2 new routes
└── pipeline-events.ts              # MODIFIED — register 6 event types

backend/src/app.ts                  # MODIFIED — register campaigns plugin, boot
                                    # the pipeline subscriber on app start, tear
                                    # down on shutdown

docs/wiki/content/runtime/
└── pipeline-status.html            # NEW — wiki page covering the status surface
```

Module sizes target <200 lines each; functions <50 (per `CLAUDE.md` conventions).

## 4. Components

### 4.1 `backend/src/sse/derive-phase.ts`

Pure function — the only place that knows how to compute a campaign's pipeline phase.

```ts
import type { PipelinePhase } from '../contract/pipeline-events.js'
// (Or wherever the phase union lives — co-locate with event types per D9.)

export interface CampaignRow {
  readonly id: string
  readonly status: 'setup' | 'active' | 'archived'
  readonly world_id: string
}

export interface WorldRow {
  readonly id: string
  readonly status: 'generating' | 'complete' | 'failed'
}

export interface PipelineRunRow {
  readonly stage: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly user_id: string | null
  readonly world_id: string | null
  readonly campaign_id: string | null
  readonly started_at: Date | null
  readonly completed_at: Date | null
  readonly cost_usd: number
}

export interface PhaseAndStages {
  readonly phase: PipelinePhase
  readonly stages: ReadonlyArray<{
    readonly stage: string
    readonly status: 'pending' | 'running' | 'completed' | 'failed'
    readonly userId: string | null
    readonly costUsd: number
  }>
  readonly cumulativeCostUsd: number
}

export function derivePhase(input: {
  readonly campaign: CampaignRow
  readonly world: WorldRow
  readonly runs: readonly PipelineRunRow[]
}): PhaseAndStages {
  // Returns one of:
  //   'not_started' — no runs yet
  //   'world_gen' — any worldgen stage running or pending
  //   'world_gen_failed' — any worldgen stage failed AND no later progress
  //   'world_ready' — worlds.status='complete' AND no charcreation runs yet
  //   'character_creation' — any charcreation stage running or pending
  //   'post_creation' — barrier waiting OR materialize_relationships / continuity_check running
  //   'complete' — campaigns.status='active'
  //   'failed' — unrecoverable (any non-worldgen failure AND no retry capacity)
  // ...
}
```

Worldgen stages: `concept_intake`, `world_and_factions`, `locations_and_npcs`, `starting_situation`, `random_tables`. Charcreation stages: `location_selection`, `character_concept`, `character_sheet`, `character_integration`. Post stages: `materialize_relationships`, `continuity_check`. Stage taxonomy lives in this module too as a small const.

### 4.2 `backend/src/sse/pipeline-subscriber.ts`

One Redis subscriber per API process, on a **dedicated** ioredis client (`redis.duplicate(...)` with reconnect-friendly options). Holds the channel-to-connections map.

```ts
import type { Redis } from 'ioredis'

export interface SseSink {
  /** Returns false if the underlying writer is back-pressured. Callers may
   *  use this to detect slow clients and trigger close. */
  readonly write: (frame: string) => boolean
  readonly close: (reason: CloseReason) => void
}

export type CloseReason =
  | 'idle-timeout'
  | 'server-shutdown'
  | 'redis-resync-required'
  | 'rate-limited'
  | 'back-pressure'
  | 'unknown'

export interface PipelineSubscriber {
  /** Attach an SSE connection to a campaign's channel. Returns a detach fn. */
  attach: (campaignId: string, sink: SseSink) => () => void
  /** Number of currently-attached connections across all campaigns. */
  activeConnectionCount: () => number
  /** Tear down the underlying PSUBSCRIBE + clear the map + QUIT the dedicated client. */
  close: () => Promise<void>
}

export function createPipelineSubscriber(
  redis: Redis,                 // the command-mode client (deps.redisRealtime)
  redisKeyPrefix: string,       // e.g., 'staging:use1:'
  logger: pino.Logger,
): PipelineSubscriber {
  // CREATE a dedicated subscriber client. Do NOT call SUBSCRIBE/PSUBSCRIBE
  // on the command-mode client — that puts it in subscriber mode and breaks
  // every other command-mode consumer (rate-limit, ws-ticket).
  const sub = redis.duplicate({
    retryStrategy: (n) => Math.min(n * 1000, 30000),  // 1s..30s, unlimited
    maxRetriesPerRequest: null,                       // required for pub/sub
    enableOfflineQueue: true,
  })

  // PSUBSCRIBE pattern INCLUDES the prefix (staging and prod share one
  // ElastiCache cluster per Infra §6.4; the prefix is what scopes channels
  // by env). Pattern: `{redisKeyPrefix}pipeline:campaign:*`
  // Example concrete pattern: 'staging:use1:pipeline:campaign:*'
  const pattern = `${redisKeyPrefix}pipeline:campaign:*`
  const channelPrefix = `${redisKeyPrefix}pipeline:campaign:`

  // Channel-key in the in-memory map is the campaignId (not the full
  // channel name). Extracted by suffix-slice, NOT by splitting on ':'
  // (the prefix contains colons; UUIDv7 doesn't).
  //   campaignId = channel.slice(channelPrefix.length)
  //
  // Map shape: Map<campaignId, Set<SseSink>>
  //
  // On `pmessage`: extract campaignId, look up the Set, for each sink
  // call write() inside try/catch — if write throws, close the sink with
  // 'unknown' and detach immediately (don't let one stale sink wedge the
  // iteration over a snapshot of the Set).
  //
  // On `'reconnecting'`: log at warn.
  // On `'ready'` AFTER a reconnect: re-issue PSUBSCRIBE on `pattern`,
  //   push `event: close\ndata: { reason: 'redis-resync-required' }\n\n`
  //   to every attached sink, then clear the map. Clients reconnect via
  //   /status/stream which carries a fresh snapshot per D4.
  // On `'error'`: log at warn (do NOT swallow — the existing factory's
  //   `client.on('error', () => undefined)` is wrong for this use case).
}
```

**Channel-name shape:** `{redisKeyPrefix}pipeline:campaign:{campaignId}`. `redisKeyPrefix` already includes the env/region prefix (`staging:use1:`). Concrete example: `staging:use1:pipeline:campaign:01HABC...`.

**Worker-side contract (MYT-49 / MYT-51 territory, NOT this issue):** the worker must use the same `redisKeyPrefix` when publishing. The `app-deps.ts` `redisKeyPrefix` is the contract.

**Wasted-message counter (load-bearing operational signal):** the subscriber increments a counter every time a `pmessage` arrives for a channel with zero attached connections. Surfaced in the 60 s log line (D7). When the wasted/total ratio crosses ~0.5 over a sustained window, that's the signal to swap PSUBSCRIBE for per-channel SUBSCRIBE/UNSUBSCRIBE on attach/detach.

### 4.3 `backend/src/sse/sse-connection.ts`

Wraps a Fastify `Reply` into the `SseSink` shape. Owns:
- `reply.hijack()` BEFORE writing — required so Fastify doesn't inject `Content-Length` or close the response when the handler returns.
- SSE response headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. Do NOT set `Connection: keep-alive` (HTTP/1.1 default; forbidden under HTTP/2).
- Keepalive frame: `:keepalive\n\n` byte sequence; written via `setTimeout` that re-arms after every event-write (not `setInterval` — avoids useless ticks on busy streams). 25 s default cadence.
- Idle-timeout: 30 min no-message → `sink.close('idle-timeout')`.
- Cleanup hooks: listen on BOTH `request.raw 'close'` AND `reply.raw 'close'`; cleanup callback is idempotent. Do NOT rely on the deprecated `'aborted'` event.
- `write(frame): boolean` — returns `reply.raw.write(frame)`. If `false`, arm a 5 s `'drain'` timer; on timeout, `sink.close('back-pressure')`.
- `close(reason)` — write `event: close\ndata: { reason }\n\n` if the writer is still open, then `reply.raw.end()`, then run `onClose`. Idempotent.

```ts
export interface OpenSseConnectionOpts {
  readonly request: FastifyRequest
  readonly reply: FastifyReply
  readonly logger: pino.Logger
  readonly onClose: () => void
}

export function openSseConnection(opts: OpenSseConnectionOpts): SseSink {
  // ...
}
```

### 4.4 `backend/src/sse/connection-counter.ts`

```ts
export function createConnectionCounter(logger: pino.Logger): {
  increment: () => void
  decrement: () => void
  current: () => number
  /** Increment-only counter for "pmessage arrived with no attached sinks." */
  incrementWasted: () => void
  /** Returns an unsubscribe fn for the periodic log interval. */
  startPeriodicLog: () => () => void
} {
  // ...
}
```

The periodic log fires every 60 seconds with:

```json
{
  "event": "sse.connections.active",
  "count": 12,
  "max_since_last": 18,
  "wasted_msgs": 0,
  "taskRevision": "<ECS task arn or revision id>",
  "msg": "..."
}
```

The `setInterval` handle is `unref()`'d so it doesn't pin the event loop during shutdown. `max_since_last` resets each emission so transient spikes show up. `taskRevision` lets ops aggregate across the 1–4 task fleet via Logs Insights.

CloudWatch Logs Insights canonical query (documented in §4.11 wiki page):

```
fields @timestamp, count, max_since_last, wasted_msgs, taskRevision
| filter event = 'sse.connections.active'
| stats sum(count) as fleet_total, max(max_since_last) as peak by bin(1m)
```

### 4.5 `backend/src/repo/pipeline-runs.ts`

Repo helper used by the snapshot path. Returns the typed rows for `derivePhase`.

```ts
export interface PipelineRunsRepo {
  /**
   * Fetches the LATEST pipeline_runs row per stage for a campaign.
   * Composition is identical to parent spec §9 Resume Endpoint:
   * rows with campaign_id = $1 PLUS rows with world_id = (the campaign's world).
   * Returns the most recent run per (stage, user_id) tuple — a stage that
   * was retried after a failure surfaces only as its most recent attempt,
   * so "failed → retried → completed" reports as completed.
   *
   * Returns empty if the campaign doesn't exist (caller's auth pre-handler
   * already returned 403 in that case).
   */
  listLatestForCampaign: (campaignId: string) => Promise<readonly PipelineRunRow[]>
}
```

Query shape:

```sql
WITH all_runs AS (
  SELECT stage, status, user_id, world_id, campaign_id,
         started_at, completed_at, COALESCE(cost_usd, 0)::float8 AS cost_usd
  FROM pipeline_runs
  WHERE campaign_id = $1
     OR world_id = (SELECT world_id FROM campaigns WHERE id = $1)
)
SELECT DISTINCT ON (stage, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid))
       stage, status, user_id, world_id, campaign_id,
       started_at, completed_at, cost_usd
FROM all_runs
ORDER BY stage,
         COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
         started_at DESC NULLS LAST
```

**`cost_usd` is `NUMERIC(10,6)`** per migration 001. `node-postgres` returns NUMERIC as `string` by default. The cast `::float8` in the query forces a numeric return that `pg` parses as `number`. (Alternative: `pg.types.setTypeParser(1700, parseFloat)` globally — but that touches the global parser; the column-level cast is local to this query and matches the codebase's existing pattern of doing math-safe coercion at the boundary.)

### 4.6 `backend/src/routes/campaigns.ts`

This issue lands two routes; the rest of the campaign-scoped routes come in MYT-51 and later. The plugin is the right place for ALL of them — file will grow as later issues add routes.

```ts
// backend/src/routes/campaigns.ts
//
// Campaign-scoped HTTP routes. This issue (MYT-50) lands status + SSE
// stream only. Subsequent issues add create / details / member-mgmt /
// character-creation routes.

export interface Opts {
  readonly pool: Pool
  readonly subscriber: PipelineSubscriber
  readonly counter: ConnectionCounter
}

export const campaignsRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)

  // Snapshot route. Param name is :campaignId per D11 to match
  // requireCampaignMember's hard-coded param name.
  app.get<{ Params: { campaignId: string } }>(
    '/api/campaigns/:campaignId/status',
    {
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
      preHandler: requireCampaignMember(repo),
    },
    handleSnapshot(repo),
  )

  // SSE stream route. Per-user rate-limit (D12) — keys on the dbUserId
  // attached by the auth chain, mirroring sessions.ts ws-ticket.
  // The SSE handler ordering inside handleSseStream:
  //   1. Call reply.hijack() (must come before any reply.raw writes).
  //   2. Write SSE response headers.
  //   3. Open the SseSink (sse-connection.ts).
  //   4. Attach the sink to the subscriber map (BEFORE the snapshot fetch
  //      so events published during the snapshot read aren't lost — D4).
  //   5. Compute the snapshot via repo + derivePhase.
  //   6. Write the snapshot frame: `event: snapshot\ndata: {...}\n\n`.
  //   7. Return; the sink lives on, forwarding live events until the
  //      client closes or idle-timeout fires.
  app.get<{ Params: { campaignId: string } }>(
    '/api/campaigns/:campaignId/status/stream',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (req): string => {
            // requireDbUser populates request.dbUser per the existing
            // require-db-user.ts pattern from sessions.ts.
            return req.dbUser?.id ?? req.ip
          },
        },
      },
      preHandler: requireCampaignMember(repo),
    },
    handleSseStream(opts.subscriber, opts.counter, repo),
  )
}
```

**Auth:** `requireCampaignMember` is already wired (`backend/src/auth/access-control.ts`); it reads `request.params.campaignId` (per D11, that's why the route uses `:campaignId` not `:id`). The access-control allowlist gate at boot is a NEGATIVE check (it errors on routes that mark themselves access-controlled AND set `auth: 'public'/'jwt-no-db'`) — these routes don't set `auth`, so the gate is automatic. No registration step in `access-control-allowlist.ts` is needed (correcting an earlier draft; see retired §5 below).

**JWT-expiry / membership-revocation eviction is out of scope for MYT-50** (acknowledged in §8). Until those are added, idle-timeout (D6) bounds exposure for users removed from a campaign mid-stream. Document the gap in the wiki page (§4.11).

### 4.7 `backend/src/app.ts` modifications

- Boot the pipeline subscriber once on app start, after Redis clients exist. Pass it to the campaigns plugin opts. The subscriber internally calls `deps.redisRealtime.duplicate(...)` — `deps.redisRealtime` stays in command mode.
- Start the connection-counter's 60 s periodic log.
- Tear down in strict order (per D14).

```ts
const subscriber = createPipelineSubscriber(
  deps.redisRealtime,            // duplicated internally; not used directly
  deps.redisKeyPrefix,
  app.log,
)
const counter = createConnectionCounter(app.log)
const stopPeriodicLog = counter.startPeriodicLog()

await app.register(campaignsRoutes, { pool: deps.pg, subscriber, counter })

// in createShutdown — order matters (D14):
// 1. Stop the counter's interval (don't pin the event loop)
stopPeriodicLog()
// 2. Drain SSE: subscriber.close() pushes `event: close\ndata: { reason: 'server-shutdown' }\n\n`
//    to each attached sink, calls sink.close(), then UNSUBSCRIBEs + QUITs the dedicated client
await subscriber.close()
// 3. Existing teardown: app.close(), pg.end(), redisRealtime.quit(), redisBatch.quit()
//    (app.close() now drains in-flight HTTP cleanly — SSE responses have already been ended)
```

### 4.8 `backend/src/contract/pipeline-routes.ts` + `pipeline-events.ts`

```ts
// pipeline-routes.ts
export const PIPELINE_ROUTES: readonly string[] = [
  'GET /api/campaigns/:campaignId/status',
  'GET /api/campaigns/:campaignId/status/stream',
] as const
```

```ts
// pipeline-events.ts
//
// Full 11-arm event union — the 6 MYT-50 arms PLUS the 5 entity-event
// arms the worker will publish starting MYT-51 streaming stages. The
// SSE bridge is a TYPE-BLIND FORWARDER: it forwards every JSON payload
// published on the Redis channel verbatim, regardless of `type` field.
// Adding the entity events to the contract now lets MYT-51+ ship their
// worker emissions without expanding the contract piecemeal; dev-tool
// coverage uses the `exempt` list for the entity arms with a reason
// pointing at MYT-52 (where the live-graph UI lands).
export const PIPELINE_SSE_EVENTS: readonly string[] = [
  // Lifecycle (MYT-50 — landed):
  'phase',
  'stage-started',
  'stage-completed',
  'stage-failed',
  'cost-update',
  'job-failed',
  // Entity events (MYT-51+ publishes; MYT-52 renders in dev tool):
  'stage-reset',
  'entity-added',
  'entity-updated',
  'edge-added',
  'finalized',
] as const

export type PipelinePhase =
  | 'not_started'
  | 'world_gen'
  | 'world_gen_failed'
  | 'world_ready'
  | 'character_creation'
  | 'post_creation'
  | 'complete'
  | 'failed'

// Discriminated-union type for the event payloads. Each event-type
// arm has a matching shape; check-coverage.ts only cares about the
// string literals in PIPELINE_SSE_EVENTS. Field naming: nullable
// fields use `T | null` (not `T?`) to match the SQL-derived snapshot
// shape and survive JSON round-trips consistently.
export type PipelineEvent =
  | { type: 'phase'; phase: PipelinePhase }
  | { type: 'stage-started'; stage: string; userId: string | null; startedAt: string }
  | {
      type: 'stage-completed'
      stage: string
      userId: string | null
      durationMs: number
      costUsd: number
    }
  | {
      type: 'stage-failed'
      stage: string
      userId: string | null
      errorCode: string
      willRetry: boolean
    }
  | { type: 'cost-update'; cumulativeUsd: number }    // ABSOLUTE value; emitted only post-COMMIT (D-cost)
  | {
      type: 'job-failed'
      jobType: 'world-gen' | 'character-creation' | 'post-creation'
      errorCode: string
    }
  // Entity-event arm shapes are defined here as forward declarations
  // so MYT-51's worker doesn't have to re-specify them; the bridge
  // doesn't introspect them at runtime.
  | { type: 'stage-reset'; stage: string }
  | { type: 'entity-added'; synthKey: string; entityKind: string; data: Record<string, unknown> }
  | { type: 'entity-updated'; synthKey: string; patch: Record<string, unknown> }
  | { type: 'edge-added'; synthKey: string; from: string; to: string; relationship: string }
  | { type: 'finalized'; synthKey: string; entityId: string }
```

**Cumulative cost is DB-canonical (resolves the source-of-truth question):** the worker publishes `cost-update` events ONLY after the `pipeline_runs.cost_usd` write COMMITs. Snapshot derives `cumulativeCostUsd` by summing the same column. Both surfaces report ABSOLUTE values (not deltas). Out-of-order arrival is impossible within a single SSE stream, and snapshot ≤ stream-event ordering is guaranteed by the post-COMMIT publish.

The discriminated-union type lives alongside the runtime constant so consumers get tight typing for the payloads while the ship gate checks against the bare string list. `coverage.json` lists all 11 entries; the 5 entity-event entries go in `exempt.events` with reason "Rendered by live-graph in MYT-52; bridge forwards verbatim in MYT-50 — coverage lands with MYT-52" (≥20 chars; satisfies `check-coverage.ts:60-67`).

### 4.9 `backend/dev-tool/coverage.json` modifications

Append to existing arrays (preserve `version: 1`):

```json
{
  "version": 1,
  "routes": [
    "GET /api/campaigns/:campaignId/status",
    "GET /api/campaigns/:campaignId/status/stream"
  ],
  "events": [
    "phase",
    "stage-started",
    "stage-completed",
    "stage-failed",
    "cost-update",
    "job-failed",
    "stage-reset",
    "entity-added",
    "entity-updated",
    "edge-added",
    "finalized"
  ],
  "jobs": [],
  "exempt": {
    "routes": {},
    "events": {
      "stage-reset": "Rendered by live-graph in MYT-52; bridge forwards verbatim in MYT-50 — dev-tool coverage lands with MYT-52",
      "entity-added": "Rendered by live-graph in MYT-52; bridge forwards verbatim in MYT-50 — dev-tool coverage lands with MYT-52",
      "entity-updated": "Rendered by live-graph in MYT-52; bridge forwards verbatim in MYT-50 — dev-tool coverage lands with MYT-52",
      "edge-added": "Rendered by live-graph in MYT-52; bridge forwards verbatim in MYT-50 — dev-tool coverage lands with MYT-52",
      "finalized": "Rendered by live-graph in MYT-52; bridge forwards verbatim in MYT-50 — dev-tool coverage lands with MYT-52"
    },
    "jobs": {}
  }
}
```

`jobs` stays empty here. MYT-49 (parallel) may add `world-gen` + `campaign-setup` entries; the second-to-merge resolves the textual diff. Trivial.

### 4.10 `backend/dev-tool/src/components/status-panel.ts`

Component shape consistent with `identity-switcher.ts` and `health-panel.ts`:

```ts
import { apiCall } from '../api-client.js'

export function mountStatusPanel(parent: HTMLElement): void {
  // - Text input for campaignId.
  // - "Watch" button.
  // - Phase display.
  // - Stage list (rendered from snapshot frame, updated as events arrive).
  // - Cumulative cost display.
  // - "Stop watching" button to close the EventSource.
  //
  // On Watch:
  //   1. Open EventSource('/api/campaigns/{id}/status/stream').
  //      - First server frame is `event: snapshot\ndata: {...}\n\n` (per D4).
  //      - Subsequent frames are live events.
  //   2. Wire `addEventListener('snapshot', ...)` to render initial state.
  //   3. Wire `onmessage` for the live event stream (default `message` event).
  //   4. Wire `addEventListener('close', ...)` to handle the close-reason
  //      enum (D6). On reason='idle-timeout' or 'server-shutdown' or
  //      'redis-resync-required', auto-reconnect by re-opening the
  //      EventSource (a fresh stream delivers a fresh snapshot).
  //   5. Wire `onerror` for unexpected disconnects (use ReadyState to
  //      decide whether to surface or auto-retry).
  //   6. Silently ignore unknown `type` fields in event payloads
  //      (entity-* events arrive starting MYT-51's streaming stages;
  //      live-graph rendering lands in MYT-52).
  //
  // EventSource auth: identity-switcher.ts sets x-mythrun-dev-sub via a
  // browser cookie OR the bypass plugin reads it from a request-cookie
  // fallback (whichever the existing dev-tool components use — verify
  // by reading api-client.ts before implementation). Native EventSource
  // cannot set custom headers, so cookie / query-param propagation is
  // the only way; document the chosen mechanism in the wiki page.
}
```

Wired into `main.ts` next to the existing identity switcher and health panel.

### 4.11 `docs/wiki/content/runtime/pipeline-status.html`

New wiki page documenting:
- The two endpoints + their semantics
- The Redis channel naming + worker contract
- The phase derivation table (state → phase)
- The keepalive + idle-timeout behavior
- The connection-leak metric and how to inspect it
- How to test locally (dev tool paste-flow + `redis-cli PUBLISH`)
- The "what's not here" list (entity events → MYT-52, real campaign create UI → MYT-51)

Sources tracked:
- `docs/specs/2026-04-13-world-campaign-pipeline.md` (§8, §9)
- `backend/src/sse/derive-phase.ts`
- `backend/src/sse/pipeline-subscriber.ts`
- `backend/src/sse/sse-connection.ts`
- `backend/src/sse/connection-counter.ts`
- `backend/src/repo/pipeline-runs.ts`
- `backend/src/routes/campaigns.ts`
- `backend/src/contract/pipeline-routes.ts`
- `backend/src/contract/pipeline-events.ts`
- `backend/dev-tool/coverage.json`
- `backend/dev-tool/src/components/status-panel.ts`

## 5. Access-control allowlist (no registration needed)

`backend/src/auth/access-control-allowlist.ts` is a NEGATIVE check, not a positive set: it iterates routes at boot, finds ones that BOTH carry the `ACCESS_CONTROL_MARKER` (added automatically by `requireCampaignMember(repo)`) AND set `config.auth = 'public'` or `'jwt-no-db'`, and throws if any exist. The two new routes use `requireCampaignMember` and do NOT set `config.auth`, so the gate is automatically satisfied. No code changes in `access-control-allowlist.ts` required.

(An earlier draft of this design mistakenly said the allowlist needed an "tracked set" update — corrected here. Carried forward as a §5 entry rather than deleted so future readers don't repeat the confusion.)

## 6. Test strategy

### 6.1 Pure unit tests
- `derive-phase.test.ts` — fixture rows for each phase. Cases: empty runs (`not_started`), running worldgen (`world_gen`), all worldgen complete + campaign `setup` (`world_ready`), running charcreation (`character_creation`), running post-creation barrier (`post_creation`), campaigns.status=`active` (`complete`), worldgen-failed + no retry available (`world_gen_failed`), etc.
- `connection-counter.test.ts` — increment/decrement, idempotent close, hourly log timer fires correctly (use `vi.useFakeTimers`).
- `sse-connection.test.ts` — headers correct, keepalive frame emitted on schedule, idle-timeout closes correctly, client-disconnect cleanup runs `onClose`.

### 6.2 Integration tests (real Redis)
- `pipeline-subscriber.test.ts` — boot the subscriber, `redis-cli PUBLISH` (via ioredis) to a channel, assert attached sink receives the message. Detach, publish, assert sink does NOT receive.
- `campaigns.test.ts` (route-level) — full `buildApp()` instance, hit `/status` with a fixture campaign + pipeline_runs, assert JSON shape. Hit `/status/stream`, publish a fake event to Redis, assert SSE frame arrives.

### 6.3 Cross-process integration test
Mirrors MYT-45's two-`buildApp` precedent. One API instance hosts the SSE connection; a second `buildApp` (or just an ioredis Publisher) publishes to the channel. Confirms the in-memory routing isn't accidentally process-scoped in a way that breaks under multi-task ECS.

## 7. Done-when checklist

- [ ] Parent-spec amendment landed in prior commit (`0ec11ec`). ✓ (already done)
- [ ] `derivePhase` + tests cover all 8 phase states.
- [ ] `derivePhase` correctly handles multi-row-per-stage (latest-attempt wins; "failed → retried → completed" reports as `completed`).
- [ ] `PipelineSubscriber` uses a DEDICATED Redis client (`.duplicate(...)`) with reconnect policy; verified by stopping/starting the test Redis between PUBLISHes and confirming events resume.
- [ ] On Redis reconnect, attached SSE clients receive `event: close\ndata: { reason: 'redis-resync-required' }\n\n`; map cleared.
- [ ] Per-sink try/catch wraps every `sink.write` call so a stale connection doesn't wedge subscriber iteration.
- [ ] Subscriber.close() drains attached connections with `reason: 'server-shutdown'` before UNSUBSCRIBE + QUIT.
- [ ] App.ts shutdown ordering matches D14.
- [ ] `connection-counter` 60 s periodic log fires (verified via tests with fake timers); `setInterval` handle is `unref()`'d.
- [ ] Two new routes serve correctly:
  - [ ] Snapshot returns JSON with full phase + stages + cumulativeCostUsd.
  - [ ] SSE stream's FIRST frame is the snapshot event (per D4 — no separate client-side snapshot fetch needed).
  - [ ] SSE stream emits `:keepalive\n\n` every 25 s when idle.
  - [ ] SSE stream emits `event: close\ndata: { reason }\n\n` on idle-timeout / back-pressure / server-shutdown / Redis-resync.
- [ ] `reply.hijack()` called before `reply.raw.writeHead()` (verified by integration test asserting Fastify doesn't add `Content-Length`).
- [ ] Both `request.raw 'close'` AND `reply.raw 'close'` trigger sink cleanup (idempotent — verified by simulating both).
- [ ] Back-pressure: when `reply.raw.write()` returns `false` and `'drain'` doesn't fire within 5 s, sink closes with `reason: 'back-pressure'`.
- [ ] SSE stream rate-limit is per-user (`keyGenerator: req.dbUser.id`) per D12.
- [ ] `pipeline-routes.ts` + `pipeline-events.ts` carry all entries (11 events; 2 routes); `PipelineEvent` discriminated union typed with `userId: string | null` consistently.
- [ ] `coverage.json` updated with 2 routes + 11 events; 5 entity-event entries in `exempt.events` with ≥20-char reasons.
- [ ] Dev tool `status-panel.ts` lands; smoke-verified by manually `redis-cli PUBLISH`ing a `phase` event and confirming the panel updates. Unknown event types silently ignored.
- [ ] Wiki page lands with the canonical Logs Insights query (§4.4) + close-reason enum (§D6) + EventSource auth mechanism note.
- [ ] All gates green: `pnpm typecheck && pnpm lint && pnpm test && pnpm wiki:check && pnpm dev-tool:check`.
- [ ] Cross-process integration test (per MYT-45 precedent at `rate-limit-cross-worker.test.ts`): two in-process `buildApp()` instances against one Redis; one hosts the SSE attachment, the other PUBLISHes via its own ioredis instance; assert the event arrives at the SSE consumer.
- [ ] Branch backup pushed (`git push -u origin myt-50-pipeline-status`) — optional safety net per CLAUDE.md.
- [ ] (Merge to main + Linear flip handled by user, post-MYT-49 merge coordination.)

## 8. Out of scope

- **Worker-side event emission.** The worker publishing logic is MYT-49 (shell + middleware) and MYT-51+ (actual processors that publish phase/stage events). MYT-50 only consumes.
- **Entity-level events** (`entity-added`, `entity-updated`, `edge-added`, `stage-reset`, `finalized`). Landing in MYT-52.
- **Real campaign-creation route** (`POST /api/campaigns`). MYT-51 lands it.
- **Auto-resume on stuck campaigns / dead-job recovery via CloudWatch alarm.** Operational hardening, post-launch.
- **Per-tier rate limits** (paid users get higher caps). Not a launch concern.
- **PSubscribe vs Subscribe optimization**. We default to `PSUBSCRIBE pipeline:campaign:*` for simplicity; if it turns out to be a hot-path issue, we can switch to per-channel `SUBSCRIBE`/`UNSUBSCRIBE` as connections attach/detach. Trivially swappable behind the `PipelineSubscriber` interface.

## 9. Estimate

1.5 working days (revised after blind-review hardening). Breakdown:

- `derivePhase` + tests covering all phase states + multi-row-per-stage: 2 hr
- `PipelineSubscriber` with dedicated client + reconnect + per-sink try/catch + integration tests: 3 hr (ioredis subscriber-mode + duplicate-client lifecycle is the load-bearing risk)
- `sse-connection` with `reply.hijack()` + back-pressure detection + close-reason enum + dual-`'close'`-event cleanup + tests: 2 hr
- `connection-counter` (60 s + max-since-last + unref + taskRevision) + tests: 45 min
- `pipeline-runs` repo with NUMERIC-safe query + DISTINCT ON: 1 hr
- `campaigns.ts` plugin (per-user rate-limit, snapshot-in-stream handler, hijack ordering): 1 hr
- `app.ts` shutdown ordering + boot wiring: 45 min
- Contract files (11 events including entity arms) + coverage.json with exempt entries: 30 min
- Dev tool `status-panel.ts` with EventSource + close-reason handling + auto-reconnect: 1.5 hr
- Cross-process integration test (mirrors `rate-limit-cross-worker.test.ts`): 1 hr
- Wiki page (Logs Insights query, close-reason enum, EventSource auth notes): 1 hr
- Final verification + buffer: 1 hr

Total: ~14 hours. Most risk in the subscriber lifecycle + Fastify SSE-hijack patterns; the buffer absorbs ioredis quirks. The hardening folded in from blind review (dedicated client, back-pressure, close-reason enum, shutdown ordering) added ~4 hours over the original estimate — these are infrastructure-grade requirements that CLAUDE.md says "never hack," so the time is worth it.
