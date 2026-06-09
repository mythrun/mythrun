// BullMQ producer-queue construction + boot-gate stubs for the API server
// (server.ts). Each `build*Queue` returns the raw BullMQ `Queue` (for shutdown
// drain) plus a minimal `*QueueLike` producer adapter (the request-time enqueue
// surface threaded through AppDeps). The `stub*Queue` variants back the
// boot-gate-disabled binary — they reject on `.add()`.

import type { Redis } from 'ioredis'
import { Queue, type JobType } from 'bullmq'
import type { BullMqQueueShutdown } from './app.js'
import {
  QUEUE_CAMPAIGN_SETUP,
  QUEUE_SESSION_PREP,
  QUEUE_WORLD_GEN,
} from './worker/bullmq-config.js'
import type { WorldGenQueueLike } from './routes/campaigns.js'
import type { CharacterCreationQueueLike } from './routes/campaign-characters.js'
import type { SessionPrepQueueLike } from './routes/session-preps.js'
import {
  QUEUE_SESSION_SUSPEND,
  type SuspendJobPayload,
  type SuspendQueueLike,
} from './session/session-suspend.js'
import {
  QUEUE_SESSION_TURN,
  type TurnJobPayload,
  type TurnQueueLike,
} from './session/turn-queue.js'
import { QUEUE_DM_TRIGGER } from './session/dm-trigger-config.js'
import type { DmTriggerPayload, DmTriggerQueueLike } from './session/dm-trigger-queue.js'

/** MYT-51 T12: build the world-gen BullMQ queue + its plugin-facing
 *  adapter. Extracted from main() so the boot orchestrator stays under
 *  the 100-line lint budget. Returns the raw `bullmqQueue` (for
 *  shutdown.close) AND the `WorldGenQueueLike` adapter that bridges
 *  campaigns.ts's contract to BullMQ's variadic `getJobCounts` API. */
export function buildWorldGenQueue(redisBatch: Redis): {
  bullmqQueue: Queue
  worldGenQueue: WorldGenQueueLike
} {
  // SHOWSTOPPER fix from Hydra-C2 / spec D9:
  //   `removeOnComplete: { count: 0 } + removeOnFail: { count: 0 }` —
  //   BullMQ keeps terminal jobs permanently by default; with their
  //   jobIds still in the dedupe set, our resume flow's
  //   `queue.add(..., { jobId: campaignId })` silently no-ops on a
  //   completed/failed job. The { count: 0 } config prunes terminal
  //   jobs so resume's enqueue contract holds.
  //
  // MYT-52 T1: `attempts: 2 + exponential backoff (30s)` — BullMQ's
  // default is `attempts: 1` (no retries), which makes every "BullMQ
  // retries the stage" recovery path in the MYT-52 design's §7.2 error
  // matrix (transient API, persistence COMMIT, repair-chain exhausted,
  // max-tokens truncation, in-stream error) fictional. The retry budget
  // here is the surface those paths rely on.
  const bullmqQueue = new Queue(QUEUE_WORLD_GEN, {
    connection: redisBatch,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: { count: 0 },
      removeOnFail: { count: 0 },
    },
  })
  // Adapter from the campaigns plugin's WorldGenQueueLike contract
  // (which takes states as a readonly string[]) to BullMQ Queue's real
  // `getJobCounts(...types)` variadic signature.
  const worldGenQueue: WorldGenQueueLike = {
    add: (name, data, opts) => bullmqQueue.add(name, data, opts),
    // The contract types `states` as readonly string[]; BullMQ's
    // getJobCounts narrows to JobType[]. Cast at this single boundary
    // — caller-supplied values come from the route handler, which
    // hardcodes 'waiting'/'active'/'delayed' (all valid JobType).
    getJobCounts: (states) => bullmqQueue.getJobCounts(...(states as JobType[])),
    getJob: (jobId) => bullmqQueue.getJob(jobId),
  }
  return { bullmqQueue, worldGenQueue }
}

/** myth-epo4 T22 / MYT-53: build the character-creation BullMQ queue + its
 *  plugin-facing adapter. Parallels `buildWorldGenQueue` for the
 *  `campaign-setup` queue. Returns the raw `bullmqQueue` (for shutdown.close)
 *  AND the `CharacterCreationQueueLike` adapter that the campaign-characters
 *  plugin's POST /start-character-creation route uses to enqueue jobs.
 *
 *  Job-options policy mirrors world-gen's D9 fix: `removeOnComplete:
 *  { count: 0 } + removeOnFail: { count: 0 }` so terminal jobs are pruned
 *  and a future re-enqueue with the same jobId (`cc-${campaignId}-${userId}`,
 *  per MYT-53 T13) does not silently no-op against a leftover completed
 *  record. `attempts: 2 + exponential backoff` matches world-gen so the
 *  per-stage retry surface the character-creation processor relies on
 *  (terminal vs non-terminal classification — see isTerminalError) is
 *  actually fired by BullMQ. */
export function buildCharacterCreationQueue(redisBatch: Redis): {
  bullmqQueue: Queue
  characterCreationQueue: CharacterCreationQueueLike
} {
  const bullmqQueue = new Queue(QUEUE_CAMPAIGN_SETUP, {
    connection: redisBatch,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: { count: 0 },
      removeOnFail: { count: 0 },
    },
  })
  const characterCreationQueue: CharacterCreationQueueLike = {
    add: (name, data, opts) => bullmqQueue.add(name, data, opts),
  }
  return { bullmqQueue, characterCreationQueue }
}

/** MYT-61 T4: build the session-prep BullMQ Queue. Job-options policy mirrors
 *  buildWorldGenQueue's D9 fix: `removeOnComplete: { count: 0 } +
 *  removeOnFail: { count: 0 }` so terminal jobs are pruned and a future
 *  re-enqueue with the same jobId (`sp-${campaignId}-${sessionNumber}`, per
 *  MYT-63) does not silently no-op against a leftover completed record.
 *  `attempts: 2 + exponential backoff (30s)` matches world-gen so the
 *  processor's terminal/non-terminal classification (isTerminalError) is
 *  actually fired by BullMQ retries.
 *
 *  MYT-63 T3: returns the raw `bullmqQueue` (for shutdown.close, after its
 *  worker drains) AND the `SessionPrepQueueLike` adapter that threads through
 *  AppDeps so the MYT-63 trigger route can enqueue. Mirrors buildWorldGenQueue /
 *  buildCharacterCreationQueue. */
export function buildSessionPrepQueue(redisBatch: Redis): {
  bullmqQueue: Queue
  sessionPrepQueue: SessionPrepQueueLike
} {
  const bullmqQueue = new Queue(QUEUE_SESSION_PREP, {
    connection: redisBatch,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: { count: 0 },
      removeOnFail: { count: 0 },
    },
  })
  const sessionPrepQueue: SessionPrepQueueLike = {
    add: (name, data, opts) => bullmqQueue.add(name, data, opts),
  }
  return { bullmqQueue, sessionPrepQueue }
}

/** MYT-65 Task 10: build the session-suspend BullMQ Queue (all-players-
 *  disconnected → 5-min-grace → suspend). Returns the raw `bullmqQueue` (for
 *  shutdown.close, after its Worker drains — Task 11) AND the narrow
 *  `SuspendQueueLike` adapter the connection handler uses to schedule/cancel.
 *
 *  JOBID-DEDUP FOOTGUN (server-queues.ts:29-32): this queue's jobs use the
 *  stable jobId `suspend-{sessionId}` so a re-add targets the same delayed job
 *  and `cancelSuspend` (a `queue.remove`) clears it on reconnect. With BullMQ's
 *  DEFAULT terminal-job retention, a `suspend-{sessionId}` job that COMPLETED
 *  (a genuine suspend fired) would leave its jobId in the dedup set — so the
 *  NEXT session's disconnect-driven `scheduleSuspend` for the same sessionId
 *  (or a resumed session re-using the id) would silently no-op against the
 *  leftover completed record. Setting `removeOnComplete: true + removeOnFail:
 *  true` prunes the terminal job immediately so the jobId is free for a clean
 *  re-add. (world-gen uses `{ count: 0 }`; `true` is the equivalent "keep none"
 *  for a queue with no completed-job history needs — suspend jobs are
 *  fire-and-forget, nothing reads their result.)
 *
 *  No `attempts`/backoff override: a suspend whose checkpoint write fails is
 *  better re-driven by the NEXT all-disconnected event (which re-reads
 *  presence) than blindly retried after a transient — the self-validating
 *  processor makes a missed suspend self-healing. Default `attempts: 1` is
 *  correct here. */
export function buildSessionSuspendQueue(redisBatch: Redis): {
  bullmqQueue: Queue
  sessionSuspendQueue: SuspendQueueLike
} {
  const bullmqQueue = new Queue<SuspendJobPayload>(QUEUE_SESSION_SUSPEND, {
    connection: redisBatch,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: true,
    },
  })
  const sessionSuspendQueue: SuspendQueueLike = {
    add: (name, data, opts) => bullmqQueue.add(name, data, opts),
    getJob: (jobId) => bullmqQueue.getJob(jobId),
    remove: (jobId) => bullmqQueue.remove(jobId),
  }
  return { bullmqQueue, sessionSuspendQueue }
}

/** MYT-66 Task 8: build the session-turn BullMQ Queue (player-driven turn →
 *  worker → broadcast). Returns the raw `bullmqQueue` (for shutdown.close,
 *  after its Worker drains — Task 9, in worker.ts) AND the narrow
 *  `TurnQueueLike` adapter the controller/trigger route uses to enqueue.
 *
 *  Job-options policy mirrors buildSessionSuspendQueue's terminal-job pruning
 *  (`removeOnComplete: true + removeOnFail: true`) so completed/failed turn
 *  jobs don't accumulate in Redis — nothing reads a turn job's result, the
 *  broadcast is the side effect. Unlike suspend, turns carry NO custom jobId
 *  (H10): the per-session mutex is the session lock, not jobId-dedup, so each
 *  turn must land as a distinct job. `attempts: 3` (vs suspend's default 1) so
 *  a transient worker crash mid-turn retries — the session lock makes the
 *  retry safe (a redelivered job re-acquires the lock and carries the same
 *  stable turnId in its payload, H2).
 *
 *  MYT-67 §4.8: `removeOnFail` is `{ age: 120 }` (NOT `true`) — a terminally-
 *  failed turn job is RETAINED for ~2 minutes rather than pruned immediately,
 *  so the `QueueEvents('session-turn')` subscriber can read the failed job (and
 *  the `maxStalledCount`-exhaustion terminal it reports) to publish the terminal
 *  `turn_error`. `true` would race the subscriber: the broker event fires, but
 *  the job is already gone before the subscriber's handler reads it. The 120s
 *  window comfortably covers the subscriber's BRPOP → handler latency; the job
 *  is then GC'd by age, so failed turns still don't accumulate in Redis. */
export function buildSessionTurnQueue(redisBatch: Redis): {
  bullmqQueue: Queue
  sessionTurnQueue: TurnQueueLike
} {
  const bullmqQueue = new Queue<TurnJobPayload>(QUEUE_SESSION_TURN, {
    connection: redisBatch,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: { age: 120 },
      attempts: 3,
    },
  })
  const sessionTurnQueue: TurnQueueLike = {
    add: (name, data, opts) => bullmqQueue.add(name, data, opts),
  }
  return { bullmqQueue, sessionTurnQueue }
}

/** MYT-67 §4.2: build the dm-trigger BullMQ Queue (the quiet-window debounce
 *  decision queue, kept cleanly separate from the session-turn execution
 *  queue). Returns the raw `bullmqQueue` (for shutdown.close, after its Worker
 *  drains — worker.ts) AND the narrow `DmTriggerQueueLike` adapter the WS
 *  inbound handler uses to reschedule the per-campaign debounce.
 *
 *  Job-options policy diverges from session-turn on ONE axis: `attempts: 1`
 *  (NOT 3). A debounce evaluation is a re-derivable decision — on a transient
 *  failure it must NOT blind-retry (a re-run could double-classify +
 *  double-enqueue a turn); the next activity pulse re-arms the debounce and
 *  re-drives the decision cleanly (§4.3). `removeOnComplete/removeOnFail: true`
 *  prunes terminal jobs — nothing reads a decision job's result, and the
 *  per-campaign coalescing is the dedup id, not a retained job. */
export function buildDmTriggerQueue(redisBatch: Redis): {
  bullmqQueue: Queue
  dmTriggerQueue: DmTriggerQueueLike
} {
  const bullmqQueue = new Queue<DmTriggerPayload>(QUEUE_DM_TRIGGER, {
    connection: redisBatch,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 1,
    },
  })
  const dmTriggerQueue: DmTriggerQueueLike = {
    add: (name, data, opts) => bullmqQueue.add(name, data, opts),
  }
  return { bullmqQueue, dmTriggerQueue }
}

// Stub queue/worker for the boot-gate-disabled fallback path. The fallback
// never connects to Redis, so we can't construct real BullMQ handles; the
// app-deps + shutdown contracts both expect a non-undefined value, so
// supply shape-conforming no-ops. None of the routes that USE the queue
// are reachable on the fallback path (no DB, requireOnboarded 500s), so
// `add` returning a rejected promise is operator-safe.
export function stubWorldGenQueue(): WorldGenQueueLike & BullMqQueueShutdown {
  return {
    add: () => Promise.reject(new Error('queue unavailable: BOOT_GATE_ENABLED is off')),
    getJobCounts: () => Promise.resolve({}),
    getJob: () => Promise.resolve(null),
    close: () => Promise.resolve(),
  }
}

// myth-epo4 T22: the character-creation surface is a single `add()` plus
// the shutdown-time `close()`. Reject on enqueue so a route that somehow
// reaches the queue gate (the plugin returns 503 first; this is defense
// in depth) gets a clean failure mode rather than a silent hang.
export function stubCharacterCreationQueue(): CharacterCreationQueueLike & BullMqQueueShutdown {
  return {
    add: () =>
      Promise.reject(
        new Error('character-creation queue unavailable: BOOT_GATE_ENABLED is off'),
      ),
    close: () => Promise.resolve(),
  }
}

// MYT-63 T3: session-prep stub for the boot-gate-disabled fallback path. Same
// rationale as stubWorldGenQueue — no Redis on that path, so reject on enqueue.
export function stubSessionPrepQueue(): SessionPrepQueueLike & BullMqQueueShutdown {
  return {
    add: () => Promise.reject(new Error('queue unavailable: BOOT_GATE_ENABLED is off')),
    close: () => Promise.resolve(),
  }
}

// MYT-65 Task 10: session-suspend stub for the boot-gate-disabled fallback path.
// Same rationale as the others — no Redis on that path. The WS transport is
// unreachable on the fallback binary anyway (no live sessions without a DB), so
// rejecting on enqueue + no-op on getJob/remove is operator-safe.
export function stubSessionSuspendQueue(): SuspendQueueLike & BullMqQueueShutdown {
  return {
    add: () => Promise.reject(new Error('queue unavailable: BOOT_GATE_ENABLED is off')),
    getJob: () => Promise.resolve(undefined),
    remove: () => Promise.resolve(0),
    close: () => Promise.resolve(),
  }
}

// MYT-66 Task 8: session-turn stub for the boot-gate-disabled fallback path.
// Same rationale as the others — no Redis on that path, so reject on enqueue.
// The session transport is unreachable on the fallback binary anyway (no live
// sessions without a DB), so rejecting on `add` is operator-safe.
export function stubSessionTurnQueue(): TurnQueueLike & BullMqQueueShutdown {
  return {
    add: () => Promise.reject(new Error('queue unavailable: BOOT_GATE_ENABLED is off')),
    close: () => Promise.resolve(),
  }
}

// MYT-67 §4.2: dm-trigger stub for the boot-gate-disabled fallback path. Same
// rationale as stubSessionTurnQueue — no Redis on that path, so reject on
// enqueue. The session transport is unreachable on the fallback binary anyway
// (no live sessions without a DB), so rejecting on `add` is operator-safe.
export function stubDmTriggerQueue(): DmTriggerQueueLike & BullMqQueueShutdown {
  return {
    add: () => Promise.reject(new Error('queue unavailable: BOOT_GATE_ENABLED is off')),
    close: () => Promise.resolve(),
  }
}
