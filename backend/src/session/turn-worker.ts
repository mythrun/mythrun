// backend/src/session/turn-worker.ts
//
// MYT-68 Task 15 — the session-turn worker (v2): the lock-fenced conductor that
// runs ONE DM turn per job, now wired to the REAL FastThinker and carrying the
// converge / latch-terminal / lock-gate turn lifecycle (spec §5 / §3.7).
//
// `processTurnJob` is the BullMQ processor body. It is the cluster-coordination
// shell around `SessionController`:
//
//   1. Acquire the per-session lock (MYT-66 Task 3). No lock → contention;
//      return `{ran:false}` and let the debounce re-drive (§4.7). Only ONE
//      container drives a campaign's turn at a time.
//   2. Heartbeat the lock on an interval. If a refresh ever fails (the lock
//      expired and a SUCCESSOR re-acquired it — H1 stalled-resume guard), set
//      `lockLost`. The turn then ABORTS without flushing: the winning container
//      owns the continuation, and a never-flush abort leaves Postgres + Redis at
//      the pre-turn snapshot (the SessionController recovery invariant).
//   3. §5 DECISION ORDER (below) on ANY run (fresh OR re-run), evaluated AFTER
//      the lock is held and `dm_responding` is set, BEFORE any rendering:
//
//        a. PG rows exist for this turnId → the turn IS durable. CONVERGE to
//           completion: advance the watermark + publish turn_end + return.
//           NEVER turn_error — clients would discard prose the transcript keeps,
//           and the stuck watermark would double-answer the batch.
//        b. Frames were broadcast but nothing committed → a retry would
//           re-stream DIVERGENT prose + re-roll dice under the same turnId.
//           TERMINAL: publish turn_error via the SET-NX claim, throw
//           UnrecoverableError (skips remaining BullMQ attempts). No render.
//        c. Fresh run → render the turn through SessionController, gating the
//           PG commit on the lock (§3.7 lock-gate: lost lock stops us BEFORE
//           the flush, never after).
//   4. On a real (non-lock-lost) error, RETHROW so BullMQ applies its retry /
//      `attempts` policy. The terminal `turn_error` frame on attempts-exhaustion
//      is published by the worker's `failed`-event handler (H8), NOT here.
//   5. ALWAYS clear the heartbeat + release the lock in `finally`. Release is a
//      compare-and-delete (Task 3), so it is safe even after lock loss — it can
//      only ever drop OUR token, never a successor's (H12.c).
//
// THE FT IS NOW REAL (MYT-68): the production builder constructs a
// `SonnetFastThinker` per turn with that turn's scoped skill-check `mech`
// projection (ONLY `findSessionParticipantCharacterByName`, §8 — never the whole
// repo), the resolved `worldTone`, and the latched emitter the worker owns. The
// ST + Scribe remain stubs until MYT-69. Per-turn context (ftContext, display
// names, world tone) is resolved here from the `:state` blob with a PG re-load
// fallback (§3.10).

import { Queue, UnrecoverableError, Worker as BullmqWorker, type Job } from 'bullmq'
import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { Pool } from 'pg'
import { createRepo } from '../repo/index.js'
import { makeSessionState, type SessionState } from '../redis/session-state.js'
import { SessionController, type TranscriptStore } from './session-controller.js'
import { createSessionLock, type SessionLock } from './session-lock.js'
import { SonnetFastThinker } from './tiers/fast-thinker.js'
import { buildFtTools } from './tiers/ft-tools.js'
import { StubScribe, StubSlowThinker } from './tiers/stubs.js'
import type { FastThinker, Scribe, SlowThinker, TurnEmitter } from './tiers/types.js'
import type { MechanicalReads } from './skill-check.js'
import { makeTriggerState, type TriggerState } from './trigger-state.js'
import { createTurnPublisher, type TurnPublisher } from './turn-publisher.js'
import { enqueueTurn, QUEUE_SESSION_TURN, type TurnJobPayload, type TurnQueueLike } from './turn-queue.js'

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

/** The narrow repo surface the worker reads — the §3.7 idempotency probe +
 *  transcript I/O (passed through to the controller's TranscriptStore), the
 *  display-name roster, the session-row → session-number read, the prep
 *  ft_context read, and the scoped skill-check mechanical projection. Defining
 *  the worker's needs as a narrow interface (rather than the full `Repo`) keeps
 *  the in-memory test fakes small and makes the §8 scoping explicit. The real
 *  `createRepo(pool)` structurally satisfies it. */
export interface TurnWorkerRepo {
  readonly sessionMessages: TranscriptStore & {
    turnRowsExist(turnId: string): Promise<boolean>
  }
  readonly campaigns: {
    listMembersBasic(
      campaignId: string,
    ): Promise<readonly { user_id: string; display_name: string }[]>
  }
  readonly sessions: {
    getById(id: string): Promise<{ sessionNumber: number } | null>
  }
  readonly sessionPreps: {
    getBy(campaignId: string, sessionNumber: number): Promise<{ ftContext: string } | null>
  }
  readonly characters: Pick<MechanicalReads, 'findSessionParticipantCharacterByName'>
}

/** Per-turn arguments the tiers factory needs. The emitter is passed IN (the
 *  worker owns the latch wiring); the FT streams every frame through it. */
export interface TierTurnArgs {
  readonly sessionId: string
  readonly worldTone: string
  readonly emitter: TurnEmitter
}

export interface TurnProcessorDeps {
  readonly lock: SessionLock
  readonly sessionState: SessionState
  readonly repo: TurnWorkerRepo
  /** MYT-67 §4.7 — the DM-trigger coordination state. The processor sets/clears
   *  the `dm_responding` drain guard around the turn body, advances the
   *  `last-responded-seq` watermark at flush, drains a pending explicit summon
   *  on release, runs the §5 emitted-anything latch, and gates the §4.8 terminal
   *  turn_error publish. */
  readonly triggerState: TriggerState
  /** MYT-67 §4.7 — the `session-turn` producer used ONLY for the explicit drain:
   *  if an `@dm` landed while this turn was in flight, the worker enqueues one
   *  explicit follow-up turn on release so the summon fires the instant the
   *  current turn ends. */
  readonly sessionTurnQueue: TurnQueueLike
  readonly publisher: TurnPublisher
  /** Per-turn tier factory. Takes the resolved per-turn args (the latched
   *  emitter is passed IN so tests can fake the tiers while the worker owns the
   *  latch wiring; the controller receives the SAME emitter via its deps). */
  readonly makeTiers: (turn: TierTurnArgs) => { st: SlowThinker; ft: FastThinker; scribe: Scribe }
  readonly heartbeatMs: number
  readonly logger: MinimalLogger
}

/**
 * §3.10 — resolve the enforced-ignorance-safe prep doc (session_preps.ft_context)
 * when the `:state` blob doesn't carry it (a session started before the prep
 * wiring parked it on the blob, or an evicted blob). Reads the session row for
 * its session_number → `sessionPreps.getBy` → `.ftContext`. Absent → '' with a
 * LOUD warn (a turn with no prep context is degraded but must not crash).
 * Exported so the fallback is directly unit-testable.
 */
export async function reloadFtContext(
  repo: TurnWorkerRepo,
  campaignId: string,
  sessionId: string,
  logger?: MinimalLogger,
): Promise<string> {
  const session = await repo.sessions.getById(sessionId)
  if (session === null) {
    logger?.warn({ campaignId, sessionId }, 'reloadFtContext: no session row; ft_context defaults to empty')
    return ''
  }
  const prep = await repo.sessionPreps.getBy(campaignId, session.sessionNumber)
  if (prep === null) {
    logger?.warn(
      { campaignId, sessionId, sessionNumber: session.sessionNumber },
      'reloadFtContext: no session_prep row; ft_context defaults to empty',
    )
    return ''
  }
  return prep.ftContext
}

/**
 * §5 emitted-anything latch wrapper: wrap an inner emitter so the FIRST emit of
 * ANY kind awaits `markEmitted` BEFORE the inner publish (set-before-publish — a
 * set-AFTER leaves a crash window where a re-run can re-stream divergent prose
 * without `wasTurnEmitted` ever tripping). The mark fires exactly once (a local
 * boolean), then every subsequent emit passes straight through. Exported so the
 * set-before-publish ordering is directly unit-testable.
 */
export function makeLatchedEmitter(inner: TurnEmitter, markEmitted: () => Promise<void>): TurnEmitter {
  let marked = false
  const ensureMarked = async (): Promise<void> => {
    if (marked) return
    marked = true
    await markEmitted()
  }
  return {
    emitText: async (text) => {
      await ensureMarked()
      await inner.emitText(text)
    },
    emitSkillCheck: async (payload) => {
      await ensureMarked()
      await inner.emitSkillCheck(payload)
    },
    emitDiceRoll: async (payload) => {
      await ensureMarked()
      await inner.emitDiceRoll(payload)
    },
  }
}

/**
 * Run one DM turn under the per-session lock. Returns `{ran}`: `false` on
 * contention (no lock), `true` once we acquired the lock and either completed,
 * converged a durable turn, or aborted on lock loss. A real failure rethrows
 * (BullMQ owns the retry policy); the §5 latch-terminal throws
 * `UnrecoverableError` (no further BullMQ attempts).
 */
export async function processTurnJob(
  deps: TurnProcessorDeps,
  job: { data: TurnJobPayload },
): Promise<{ ran: boolean }> {
  const { campaignId, sessionId, turnId } = job.data

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
    // ── §5 decision order on ANY run (fresh OR re-run) ──────────────────────

    // 1. PG rows exist for this turnId → the turn IS durable. CONVERGE to
    //    completion: advance the watermark, publish turn_end, return. Never
    //    turn_error (clients would discard prose the transcript keeps, and the
    //    stuck watermark would double-answer the batch). Runs under the lock —
    //    we hold it from `tryAcquire` above.
    if (await deps.repo.sessionMessages.turnRowsExist(turnId)) {
      deps.logger.warn({ campaignId, turnId }, 'turn already durable in PG; converging to turn_end')
      await deps.triggerState.setRespondedSeq(campaignId, job.data.maxConsumedSeq)
      await deps.publisher.turnEnd(campaignId, turnId)
      return { ran: true }
    }

    // 2. Frames were broadcast but nothing committed → a retry would re-stream
    //    DIVERGENT prose + re-roll dice under the same turnId. Terminal: publish
    //    turn_error via the §4.8 SET-NX claim (cross-container dedup), then throw
    //    UnrecoverableError so BullMQ skips the remaining attempts. No render.
    if (await deps.triggerState.wasTurnEmitted(turnId)) {
      deps.logger.warn(
        { campaignId, turnId },
        'turn streamed frames but never committed; terminal (no divergent re-stream under one turnId)',
      )
      if (await deps.triggerState.claimTurnErrorPublish(turnId)) {
        await deps.publisher.turnError(campaignId, turnId, 'The turn failed. Please try again.')
      }
      throw new UnrecoverableError(
        'turn already streamed; terminal (no divergent re-stream under one turnId)',
      )
    }

    // 3. Fresh run.
    await deps.publisher.dmThinking(campaignId, turnId)

    // Resolve per-turn context from the `:state` blob, with a PG re-load
    // fallback for ftContext (§3.10) and the campaign roster for display names.
    const state = await deps.sessionState.getState(campaignId)
    const ftContext =
      state?.ftContext ?? (await reloadFtContext(deps.repo, campaignId, sessionId, deps.logger))
    const worldTone = state?.worldTone ?? ''
    const displayNames = new Map(
      (await deps.repo.campaigns.listMembersBasic(campaignId)).map((m) => [
        m.user_id,
        m.display_name,
      ]),
    )

    // The latched emitter (§5): the FIRST frame of any kind marks the
    // emitted-anything latch BEFORE publishing, so a crash between mark and
    // publish still trips `wasTurnEmitted` on retry.
    const emitter = makeLatchedEmitter(deps.publisher.emitFor(campaignId, turnId), () =>
      deps.triggerState.markTurnEmitted(turnId),
    )

    const tiers = deps.makeTiers({ sessionId, worldTone, emitter })

    const controller = new SessionController(
      {
        sessionState: deps.sessionState,
        ...tiers,
        emitter,
        transcript: deps.repo.sessionMessages,
        displayNames,
        ftContext,
        allocSeq: () => deps.sessionState.nextSeq(campaignId),
        logger: deps.logger,
      },
      campaignId,
      sessionId,
      turnId,
    )

    await controller.loadFromRedis()
    if (isLockLost()) throw new LockLostError()
    await controller.processDmTurn(job.data.maxConsumedSeq)
    // §3.7 lock-gate: re-check the lock BEFORE the (durable) PG commit, so a lost
    // lock stops us BEFORE persisting, never after.
    if (isLockLost()) throw new LockLostError()
    await controller.persistTurn()
    await controller.flushToRedis()
    // §4.7 — the batch is responded: advance the watermark so the next trigger
    // batch starts at `(maxConsumedSeq, …]`. Only on a real (flushed) success —
    // a lock-lost abort never flushes, so it must never advance the watermark.
    await deps.triggerState.setRespondedSeq(campaignId, job.data.maxConsumedSeq)
    // turn_end is the WORKER's, published only AFTER persist + flush + watermark
    // (so a client never sees turn_end for a turn that did not durably land).
    await deps.publisher.turnEnd(campaignId, turnId)
    return { ran: true }
  } catch (err) {
    // The §5 latch-terminal is deliberate, not a failure to swallow — let it
    // propagate so BullMQ skips the remaining attempts.
    if (err instanceof UnrecoverableError) throw err
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
 * waitFor-probed `redisBatch` (the shared BullMQ connection), `redisRealtime`,
 * and the pg `pool` — so this builder REUSES `redisBatch` as the Worker
 * connection (no new BullMQ client, no second ping-probe), constructs the
 * processor deps on `redisRealtime`, and builds ONE `createRepo(pool)` for the
 * §3.7 transcript I/O + per-turn context resolution.
 *
 * The FastThinker is now REAL (MYT-68): `makeTiers` constructs a fresh
 * `SonnetFastThinker` per turn with that turn's scoped skill-check `mech`
 * projection + resolved world tone + latched emitter. ST + Scribe remain stubs
 * until MYT-69.
 */
export function buildSessionTurnWorker(
  redisBatch: Redis,
  redisRealtime: Redis,
  redisKeyPrefix: string,
  logger: MinimalLogger,
  pool: Pool,
): BullmqWorker<TurnJobPayload> {
  const publisher = createTurnPublisher(redisRealtime, redisKeyPrefix)
  const triggerState = makeTriggerState(redisRealtime, redisKeyPrefix)
  const repo = createRepo(pool)

  // §4.7 — the explicit-drain producer. Build the BullMQ `Queue` ONCE (on the
  // shared BullMQ connection `redisBatch`, like every other producer) and reuse
  // it; a fresh `new Queue(...)` per enqueue would leak a client per drain.
  const turnQueue = new Queue<TurnJobPayload>(QUEUE_SESSION_TURN, { connection: redisBatch })
  const sessionTurnQueue: TurnQueueLike = { add: (n, d, o) => turnQueue.add(n, d, o) }

  const deps: TurnProcessorDeps = {
    lock: createSessionLock(redisRealtime, redisKeyPrefix, SESSION_LOCK_TTL_MS),
    sessionState: makeSessionState(redisRealtime, redisKeyPrefix),
    repo,
    triggerState,
    sessionTurnQueue,
    publisher,
    // The real FastThinker, constructed per turn with the scoped skill-check
    // mechanical projection (§8 — ONLY findSessionParticipantCharacterByName,
    // never the whole repo), the turn's world tone, and the worker-owned latched
    // emitter. ST + Scribe stay stubs until MYT-69.
    /* c8 ignore start -- real-FT construction: invoking it spends Sonnet tokens;
       wiring is exercised by the §10 real-Anthropic E2E smoke (T19), and the
       converge-path builder tests prove the surrounding wiring */
    makeTiers: ({ sessionId, worldTone }) => {
      const mech: MechanicalReads = {
        findSessionParticipantCharacterByName: (sid, name) =>
          repo.characters.findSessionParticipantCharacterByName(sid, name),
      }
      return {
        st: new StubSlowThinker(),
        scribe: new StubScribe(),
        ft: new SonnetFastThinker({
          tools: buildFtTools({ mech, sessionId, worldTone, logger }, undefined),
          logger,
        }),
      }
    },
    /* c8 ignore stop */
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
