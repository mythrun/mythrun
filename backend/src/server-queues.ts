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
