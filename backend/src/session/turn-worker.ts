// backend/src/session/turn-worker.ts
//
// MYT-66 Task 9 — the session-turn worker: the lock-fenced conductor that runs
// ONE DM turn per job in the dedicated worker.ts process.
//
// `processTurnJob` is the BullMQ processor body. It is the cluster-coordination
// shell around `SessionController`:
//
//   1. Acquire the per-session lock (Task 3). No lock → contention; return
//      `{ran:false}` and let BullMQ's `attempts` re-run the job (the real
//      trigger queue + retry policy is MYT-67's §8). Only ONE container drives a
//      campaign's turn at a time.
//   2. Heartbeat the lock on an interval. If a refresh ever fails (the lock
//      expired and a SUCCESSOR re-acquired it — H1 stalled-resume guard), set
//      `lockLost`. The turn then ABORTS without flushing: the winning container
//      owns the continuation, and a never-flush abort leaves Redis at the
//      pre-turn snapshot (the SessionController recovery invariant).
//   3. Run the turn through SessionController (load → process → flush). The
//      `lockLost` checkpoints around the long body mean a lost lock stops us
//      BEFORE the flush, never after.
//   4. On a real (non-lock-lost) error, RETHROW so BullMQ applies its retry /
//      `attempts` policy. The terminal `turn_error` frame is published by the
//      worker's `failed`-event handler on the FINAL attempt (H8), NOT here.
//   5. ALWAYS clear the heartbeat + release the lock in `finally`. Release is a
//      compare-and-delete (Task 3), so it is safe even after lock loss — it can
//      only ever drop OUR token, never a successor's (H12.c).
//
// DEFERRED (scope): the plan's periodic PG checkpoint ("checkpoint if ≥5 min")
// is NOT implemented here. `flushToRedis` (live Redis turn-state) is sufficient
// for crash recovery, which rides BullMQ redelivery + the never-flush invariant
// — not a checkpoint read-back. The widened envelope is already written via the
// suspend path (Task 5). A periodic cadence needs a last-checkpoint tracker that
// does not exist yet; it lands with the real tiers (MYT-68/69).

import { Queue, Worker as BullmqWorker, type Job } from 'bullmq'
import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { makeSessionState, type SessionState } from '../redis/session-state.js'
import { SessionController, type TranscriptStore } from './session-controller.js'
import { createSessionLock, type SessionLock } from './session-lock.js'
import { StubFastThinker, StubScribe, StubSlowThinker } from './tiers/stubs.js'
import type { FastThinker, Scribe, SlowThinker } from './tiers/types.js'
import { makeTriggerState, type TriggerState } from './trigger-state.js'
import { createTurnPublisher, type TurnPublisher } from './turn-publisher.js'
import { enqueueTurn, QUEUE_SESSION_TURN, type TurnJobPayload, type TurnQueueLike } from './turn-queue.js'

/** MYT-68 interim (T15): a no-op TranscriptStore so the rewritten controller's
 *  construction signature is satisfied without the real session_messages repo
 *  wiring (which T15 threads in properly). `listFtContextRows` returns no rows
 *  (the in-memory FT history starts empty, matching the old controller); the
 *  per-turn append is a no-op (no durable transcript yet). */
const INTERIM_EMPTY_TRANSCRIPT: TranscriptStore = {
  listFtContextRows: () => Promise.resolve([]),
  appendDmTurn: () => Promise.resolve(),
}

/** The lock for a turn was lost mid-flight (a heartbeat `extend()` failed,
 *  meaning a successor re-acquired it). Distinguished from a real failure so the
 *  catch arm can abort QUIETLY — the winning container owns the continuation, so
 *  we neither flush nor publish a terminal `turn_error`. */
export class LockLostError extends Error {
  constructor() {
    super('session lock lost mid-turn')
    this.name = 'LockLostError'
  }
}

/** Minimal pino-compatible logger surface the processor needs. */
interface MinimalLogger {
  warn: (objOrMsg: Record<string, unknown> | string, msg?: string) => void
  error: (objOrMsg: Record<string, unknown> | string, msg?: string) => void
}

export interface TurnProcessorDeps {
  readonly lock: SessionLock
  readonly sessionState: SessionState
  /** MYT-67 §4.7 — the DM-trigger coordination state. The processor sets/clears
   *  the `dm_responding` drain guard around the turn body, advances the
   *  `last-responded-seq` watermark at flush, and drains a pending explicit
   *  summon on release. */
  readonly triggerState: TriggerState
  /** MYT-67 §4.7 — the `session-turn` producer used ONLY for the explicit drain:
   *  if an `@dm` landed while this turn was in flight, the worker enqueues one
   *  explicit follow-up turn on release so the summon fires the instant the
   *  current turn ends. */
  readonly sessionTurnQueue: TurnQueueLike
  readonly publisher: TurnPublisher
  readonly makeTiers: () => { st: SlowThinker; ft: FastThinker; scribe: Scribe }
  readonly heartbeatMs: number
  readonly logger: MinimalLogger
}

/**
 * Run one DM turn under the per-session lock. Returns `{ran}`: `false` on
 * contention (no lock), `true` once we acquired the lock and either completed or
 * aborted on lock loss. A real failure rethrows (BullMQ owns the retry policy).
 */
export async function processTurnJob(
  deps: TurnProcessorDeps,
  job: { data: TurnJobPayload },
): Promise<{ ran: boolean }> {
  const { campaignId, sessionId, turnId, triggerMessages } = job.data

  const handle = await deps.lock.tryAcquire(campaignId)
  if (handle === null) {
    // Contention: another container holds the lock. The debounce re-drives this
    // (§4.7) rather than blind BullMQ `attempts`.
    return { ran: false }
  }

  // §4.7 — mark a turn in flight (token = the lock token) so the dm-trigger
  // worker won't enqueue a colliding turn while we run. Cleared in `finally`.
  await deps.triggerState.setResponding(campaignId, handle.token)

  // The flag is mutated only inside the heartbeat's async callbacks. Read it
  // through `isLockLost()` (a function, not a bare property access): ESLint's
  // control-flow narrowing would otherwise treat the synchronous reads below as
  // always-false, since it cannot see the closure flip the value at runtime.
  const lockState = { lost: false }
  const isLockLost = (): boolean => lockState.lost
  const heartbeat = setInterval(() => {
    // Guard the async so no floating promise escapes the interval callback.
    handle
      .extend()
      .then((ok) => {
        if (!ok) lockState.lost = true
      })
      .catch((err: unknown) => {
        // A failed refresh is treated as a lost lock — we can no longer prove we
        // hold it, so abort the turn rather than risk a two-holder flush.
        lockState.lost = true
        deps.logger.warn({ err, campaignId, turnId }, 'turn lock heartbeat failed')
      })
  }, deps.heartbeatMs)

  try {
    await deps.publisher.dmThinking(campaignId, turnId)
    // MYT-68 interim (T15): the controller's construction signature changed to
    // the PG-direct model (sessionId arg; emitter/transcript/displayNames/
    // ftContext/allocSeq deps; no publisher; processDmTurn takes maxConsumedSeq;
    // turn_end + persist moved out of the controller). T15 rewrites this worker
    // properly (real session_messages transcript, resolved ftContext, display
    // names). This interim wiring keeps behavior identical: an empty transcript
    // (so the in-memory history starts empty, as the old controller did), the
    // FT streams through the publisher's latched emitter, persistTurn is a
    // no-op against the stub store, flushToRedis carries summary/usage, and the
    // worker publishes turn_end after persist+flush (it moved off the controller).
    const controller = new SessionController(
      {
        sessionState: deps.sessionState,
        ...deps.makeTiers(),
        emitter: deps.publisher.emitFor(campaignId, turnId),
        transcript: INTERIM_EMPTY_TRANSCRIPT,
        displayNames: new Map(),
        ftContext: '',
        allocSeq: () => deps.sessionState.nextSeq(campaignId),
      },
      campaignId,
      sessionId,
      turnId,
    )
    void triggerMessages
    await controller.loadFromRedis()
    if (isLockLost()) throw new LockLostError()
    await controller.processDmTurn(job.data.maxConsumedSeq)
    if (isLockLost()) throw new LockLostError()
    await controller.persistTurn()
    await controller.flushToRedis()
    // MYT-68 interim (T15): turn_end moved off the controller — the worker now
    // publishes it, only AFTER persist+flush (and below, the watermark advance).
    await deps.publisher.turnEnd(campaignId, turnId)
    // §4.7 — the batch is responded: advance the watermark so the next trigger
    // batch starts at `(maxConsumedSeq, …]`. Only on a real (flushed) success —
    // a lock-lost abort never flushes, so it must never advance the watermark.
    await deps.triggerState.setRespondedSeq(campaignId, job.data.maxConsumedSeq)
    return { ran: true }
  } catch (err) {
    if (err instanceof LockLostError || isLockLost()) {
      // The lock was re-acquired by a successor: do NOT flush (the recovery
      // invariant leaves Redis at the pre-turn snapshot) and do NOT publish
      // turn_error (the winning container owns the continuation). It ran but
      // aborted.
      deps.logger.warn({ campaignId, turnId }, 'turn aborted: session lock lost mid-turn')
      return { ran: true }
    }
    // A real failure: rethrow so BullMQ applies its retry / `attempts` policy.
    // The terminal turn_error frame is published by the worker's `failed`-event
    // handler on the final attempt (H8), not here.
    throw err
    /* c8 ignore next — v8 finally-boundary quirk; both paths tested. */
  } finally {
    clearInterval(heartbeat)
    // Compare-and-delete: safe even after lock loss (only drops OUR token).
    await handle.release()
    // §4.7 — clear the drain guard so the dm-trigger worker can enqueue the next
    // turn. Done AFTER release so the lock is the binding mutex right up to here.
    await deps.triggerState.clearResponding(campaignId)
    // §4.7 — explicit drain: if an `@dm` landed while this turn was in flight,
    // the server set the explicit-pending flag. Take-and-clear it and enqueue
    // ONE explicit follow-up so the summon fires the instant this turn ends.
    // Guarded in its OWN try/catch: a drain hiccup must never mask the turn
    // outcome (it would re-run an already-flushed turn via BullMQ `attempts`).
    try {
      if (await deps.triggerState.takeExplicitPending(campaignId)) {
        await enqueueTurn(deps.sessionTurnQueue, {
          campaignId,
          sessionId,
          turnId: randomUUID(),
          // The explicit follow-up re-reads its batch on run; an empty seed is
          // type-correct and keeps the drain minimal.
          triggerMessages: [],
          maxConsumedSeq: job.data.maxConsumedSeq,
          trigger: { kind: 'explicit' },
        })
      }
    } catch (drainErr) {
      deps.logger.error(
        { err: drainErr, campaignId, turnId },
        'failed to drain pending explicit summon',
      )
    }
  }
}

/** BullMQ lock duration. Held below the session lock TTL so the session lock is
 *  the binding mutex (H1): `lockDuration(30s) < sessionLockTtl(45s) ≈
 *  stalledInterval(30s)`. A stalled job is reclaimed AFTER the session lock has
 *  expired, so the reclaiming worker can cleanly re-acquire. */
const TURN_LOCK_DURATION_MS = 30_000
const TURN_STALLED_INTERVAL_MS = 30_000
const TURN_MAX_STALLED_COUNT = 3
const TURN_CONCURRENCY = 5
const SESSION_LOCK_TTL_MS = 45_000
const TURN_HEARTBEAT_MS = 15_000

/**
 * Build the session-turn BullMQ Worker for the dedicated worker.ts process.
 *
 * IMPORTANT: this runs in worker.ts, NOT the API server. worker.ts has already
 * waitFor-probed `redisBatch` (the shared BullMQ connection) and `redisRealtime`
 * — so this builder REUSES `redisBatch` as the Worker connection (no new BullMQ
 * client, no second ping-probe) and constructs the processor deps on
 * `redisRealtime`.
 *
 * The tiers are the MYT-66 stubs; the real Anthropic-backed tiers land in
 * MYT-68/69.
 */
export function buildSessionTurnWorker(
  redisBatch: Redis,
  redisRealtime: Redis,
  redisKeyPrefix: string,
  logger: MinimalLogger,
): BullmqWorker<TurnJobPayload> {
  const publisher = createTurnPublisher(redisRealtime, redisKeyPrefix)
  const triggerState = makeTriggerState(redisRealtime, redisKeyPrefix)

  // §4.7 — the explicit-drain producer. Build the BullMQ `Queue` ONCE (on the
  // shared BullMQ connection `redisBatch`, like every other producer) and reuse
  // it; a fresh `new Queue(...)` per enqueue would leak a client per drain.
  const turnQueue = new Queue<TurnJobPayload>(QUEUE_SESSION_TURN, { connection: redisBatch })
  const sessionTurnQueue: TurnQueueLike = { add: (n, d, o) => turnQueue.add(n, d, o) }

  const deps: TurnProcessorDeps = {
    lock: createSessionLock(redisRealtime, redisKeyPrefix, SESSION_LOCK_TTL_MS),
    sessionState: makeSessionState(redisRealtime, redisKeyPrefix),
    triggerState,
    sessionTurnQueue,
    publisher,
    makeTiers: () => ({
      st: new StubSlowThinker(),
      ft: new StubFastThinker(),
      scribe: new StubScribe(),
    }),
    heartbeatMs: TURN_HEARTBEAT_MS,
    logger,
  }

  const worker = new BullmqWorker<TurnJobPayload>(
    QUEUE_SESSION_TURN,
    (job) => processTurnJob(deps, job),
    {
      connection: redisBatch,
      concurrency: TURN_CONCURRENCY,
      lockDuration: TURN_LOCK_DURATION_MS,
      stalledInterval: TURN_STALLED_INTERVAL_MS,
      maxStalledCount: TURN_MAX_STALLED_COUNT,
    },
  )

  // H8 — terminal turn_error. On the FINAL exhausted attempt of a turn that
  // THREW (a real failure rethrown out of `processTurnJob`), publish a
  // turn_error frame so the player's client stops waiting on a turn that will
  // never complete. Lock-lost aborts never reach here (they return `{ran:true}`).
  //
  // KNOWN GAP (deferred → MYT-67, bead myth-tvnb): this `'failed'` JS listener
  // covers ONLY the throw-then-`attempts`-exhausted terminal. It does NOT fire
  // for the `maxStalledCount`-exhaustion terminal — when a worker crashes
  // mid-flight and the job is reclaimed `maxStalledCount` times, BullMQ
  // transitions stalled→failed INSIDE the `moveStalledJobsToWait` Lua script and
  // emits only a `'stalled'` event, never the per-worker `'failed'` JS event
  // this listener subscribes to. So a turn whose holder crashes 3× terminally
  // fails with NO turn_error. Closing that gap needs a `QueueEvents('session-turn')`
  // subscriber (broker-side events), which MYT-67's trigger queue owns.
  worker.on('failed', (job: Job<TurnJobPayload> | undefined, err: Error) => {
    // §4.8 — gate the publish on the cross-container SET-NX latch so exactly one
    // `turn_error` ships per terminal turn regardless of how many containers (or
    // which path: this JS listener vs the broker-side QueueEvents) fire. Guarded
    // as a floating promise — nothing in the 'failed' callback may reject.
    void publishTerminalTurnError(
      publisher,
      job,
      logger,
      (turnId) => triggerState.claimTurnErrorPublish(turnId),
      err,
    )
  })

  return worker
}

/** Narrow view of the fields the terminal-failure gate reads — a real BullMQ
 *  `Job` or a `{ attemptsMade, opts, data }` fake both satisfy it, so the H8
 *  boundary is unit-testable without a broker. */
export interface TerminalFailureJob {
  readonly attemptsMade: number
  readonly opts: { readonly attempts?: number }
  readonly data: TurnJobPayload
}

/** The §4.8 cross-container idempotency latch: a `SET NX` keyed by `turnId` that
 *  returns true IFF THIS caller won (it should publish). Bound to
 *  `TriggerState.claimTurnErrorPublish` in `buildSessionTurnWorker`; injected as
 *  a param so `publishTerminalTurnError` stays broker-free + unit-testable. */
export type TurnErrorPublishClaim = (turnId: string) => Promise<boolean>

/**
 * H8 / §4.8 terminal-failure gate. Publishes a `turn_error` frame IFF `job` is
 * defined, its retries are exhausted (`attemptsMade >= opts.attempts ?? 1`), AND
 * `claim(turnId)` wins the cross-container SET-NX latch — so exactly one
 * `turn_error` ships per terminal turn even when both the JS `failed` listener
 * and the broker-side `QueueEvents` fire across containers. The attempts gate
 * runs BEFORE the latch claim, so a non-final attempt never consumes the latch.
 * The publish is `.catch`-guarded so no rejection escapes the `'failed'` handler.
 * Extracted + exported so the boundary is unit-testable (no broker, no Worker).
 */
export async function publishTerminalTurnError(
  publisher: TurnPublisher,
  job: TerminalFailureJob | undefined,
  logger: MinimalLogger,
  claim: TurnErrorPublishClaim,
  err?: unknown,
): Promise<void> {
  if (job === undefined) return
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return
  // §4.8 — only the latch winner publishes (cross-container dedup).
  if (!(await claim(job.data.turnId))) return
  try {
    await publisher.turnError(
      job.data.campaignId,
      job.data.turnId,
      'The turn failed. Please try again.',
    )
  } catch (publishErr: unknown) {
    logger.error(
      {
        err: publishErr,
        original: err,
        campaignId: job.data.campaignId,
        turnId: job.data.turnId,
      },
      'failed to publish terminal turn_error',
    )
  }
}
