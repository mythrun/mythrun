// backend/src/session/session-turn-queue-events.ts
//
// MYT-67 Task 12 (spec §4.8) — the broker-side terminal `turn_error` subscriber
// that closes the `myth-tvnb` gap.
//
// MYT-66's `worker.on('failed')` JS listener fires only for the throw-then-
// `attempts`-exhausted terminal. It does NOT fire for the `maxStalledCount`-
// exhaustion terminal: when a worker crashes mid-flight and the job is reclaimed
// `maxStalledCount` times, BullMQ transitions stalled→failed INSIDE the
// `moveStalledJobsToWait` Lua script and emits only a broker-side event — never
// the per-worker `'failed'` JS event the in-process listener subscribes to. So a
// turn whose holder crashes terminally would fail with NO `turn_error`, and the
// player's client would wait forever on a turn that will never complete.
//
// This module subscribes a `QueueEvents('session-turn')` to the broker `failed`
// stream and publishes the terminal `turn_error` — gated on the SAME cross-
// container SET-NX latch (`triggerState.claimTurnErrorPublish`) the JS-listener
// path uses, so EXACTLY ONE `turn_error` ships per terminal turn cluster-wide,
// regardless of how many containers (or which path: this broker subscriber vs the
// worker.ts JS listener) fire. The shared `publishTerminalTurnError` (turn-worker.ts)
// enforces the attempts gate + the latch claim; this module just fetches the job
// and delegates.
//
// IMPORTANT — dedicated blocking connection. `QueueEvents` `BRPOP`s a Redis
// stream, so it MUST get its own `duplicate()`d ioredis connection (like the hub),
// never the BullMQ Worker's shared connection: a blocking command on the Worker's
// connection would stall every non-blocking command multiplexed onto it. The
// `Queue` handle used to fetch the failed job's data is built on the shared
// `redisBatch` (non-blocking GETs only).
//
// The session-turn queue retains failed jobs briefly (`removeOnFail: { age }`,
// set by a sibling task) so `Job.fromId` can still fetch the job's payload here.
// If the job was already reaped, we log a warn and skip — we can't publish a
// `turn_error` without the campaignId/turnId, which is acceptable (a rare race at
// the edge of the retention window).

import { Job, Queue, QueueEvents } from 'bullmq'
import type { Redis } from 'ioredis'

import { makeTriggerState } from './trigger-state.js'
import { createTurnPublisher } from './turn-publisher.js'
import { publishTerminalTurnError, type TerminalFailureJob } from './turn-worker.js'
import { QUEUE_SESSION_TURN, type TurnJobPayload } from './turn-queue.js'

/** Minimal pino-compatible logger surface this subscriber needs. */
interface MinimalLogger {
  warn: (objOrMsg: Record<string, unknown> | string, msg?: string) => void
  error: (objOrMsg: Record<string, unknown> | string, msg?: string) => void
}

/** The built subscriber handle: the live `QueueEvents` plus a `close` that tears
 *  down the subscriber, its dedicated blocking connection, and the job-fetch
 *  `Queue` handle. Registered into worker.ts's shutdown set so SIGTERM releases
 *  the blocking connection (no leaked connection per deploy — §4.8). */
export interface SessionTurnQueueEvents {
  readonly queueEvents: QueueEvents
  readonly close: () => Promise<void>
}

/**
 * Build the `QueueEvents('session-turn')` subscriber that publishes the terminal
 * `turn_error` for the broker-side `failed` event (§4.8).
 *
 * @param redisBatch    The shared BullMQ connection. `duplicate()`d for the
 *                      QueueEvents BRPOP stream; reused directly for the job-fetch
 *                      `Queue` handle (non-blocking GETs).
 * @param redisRealtime The pub/sub + coordination connection — backs both the
 *                      `TurnPublisher` (publishes the `turn_error` frame) and the
 *                      `TriggerState` SET-NX latch.
 */
export function buildSessionTurnQueueEvents(
  redisBatch: Redis,
  redisRealtime: Redis,
  redisKeyPrefix: string,
  logger: MinimalLogger,
): SessionTurnQueueEvents {
  // Dedicated blocking connection: QueueEvents BRPOPs, so it never shares the
  // Worker's connection (blocking-command contention).
  const connection = redisBatch.duplicate()
  const queueEvents = new QueueEvents(QUEUE_SESSION_TURN, { connection })

  // Job-fetch handle on the shared BullMQ connection (non-blocking GETs only).
  const queueHandle = new Queue<TurnJobPayload>(QUEUE_SESSION_TURN, { connection: redisBatch })

  const publisher = createTurnPublisher(redisRealtime, redisKeyPrefix)
  const triggerState = makeTriggerState(redisRealtime, redisKeyPrefix)

  async function handleFailed(jobId: string): Promise<void> {
    const job = await Job.fromId<TurnJobPayload>(queueHandle, jobId)
    if (job == null) {
      // The job was already reaped past its `removeOnFail` retention window —
      // we have no campaignId/turnId to address a `turn_error` to. Rare; log + skip.
      logger.warn({ jobId }, 'session-turn failed event for a job already reaped; cannot publish turn_error')
      return
    }
    // The latch is shared with the worker.ts JS-listener path, so exactly one
    // `turn_error` ships cluster-wide. `publishTerminalTurnError` runs the
    // attempts gate BEFORE the claim, so a non-final attempt never consumes it.
    await publishTerminalTurnError(
      publisher,
      job as TerminalFailureJob,
      logger,
      (turnId) => triggerState.claimTurnErrorPublish(turnId),
      job.failedReason,
    )
  }

  queueEvents.on('failed', ({ jobId }) => {
    // Floating-promise guard: nothing in the broker event callback may reject.
    // `handleFailed` is fully `.catch`-guarded internally (publishTerminalTurnError
    // swallows publish errors), but the Job.fromId fetch could reject, so wrap it.
    void handleFailed(jobId).catch((err: unknown) => {
      logger.error({ err, jobId }, 'failed to handle session-turn broker failed event')
    })
  })

  return {
    queueEvents,
    close: async (): Promise<void> => {
      await queueEvents.close()
      await connection.quit()
      await queueHandle.close()
    },
  }
}
