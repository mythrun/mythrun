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
// SlowThinker is retired off this path (MYT-69 — it runs post-hoc in its own
// st-evaluation worker, enqueued on the flushed-success path); Scribe stays a
// stub. The fresh-run arm resolves the §6 direction slots (one-shot GETDEL +
// standing read) and threads them into the controller. Per-turn context (ftContext, the
// session-participant roster + character-name attribution, world tone) is
// resolved here from the `:state` blob with a PG re-load fallback (§3.10).

import { Queue, UnrecoverableError, Worker as BullmqWorker, type Job } from 'bullmq'
import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { Pool } from 'pg'
import { createRepo, expectCommitted } from '../repo/index.js'
import { makeSessionState, type SessionState } from '../redis/session-state.js'
import { SessionController, type TranscriptStore } from './session-controller.js'
import { createSessionLock, type SessionLock } from './session-lock.js'
import { SonnetFastThinker } from './tiers/fast-thinker.js'
import { buildFtTools } from './tiers/ft-tools.js'
import { StubScribe } from './tiers/stubs.js'
import type { FastThinker, PartyLedgerSnapshot, Scribe, TurnEmitter } from './tiers/types.js'
import type { MechanicalReads } from './skill-check.js'
import type { LedgerOps } from '../repo/characters-ledger.js'
import type { LedgerTxRunner } from './rules-lawyer.js'
import type { VoyageEmbedder } from '../llm/embed.js'
import { buildLookupDeps } from './tiers/lookup-wiring.js'
import { reloadFtContext, resolveWorldId } from './turn-context.js'
import { makeTriggerState, type TriggerState } from './trigger-state.js'
import {
  rescheduleDebounce,
  type DmTriggerPayload,
  type DmTriggerQueueLike,
} from './dm-trigger-queue.js'
import { QUEUE_DM_TRIGGER, QUIET_WINDOW_MS } from './dm-trigger-config.js'
import { createTurnPublisher, type TurnPublisher } from './turn-publisher.js'
import { enqueueTurn, QUEUE_SESSION_TURN, type TurnJobPayload, type TurnQueueLike } from './turn-queue.js'
import {
  enqueueStEval,
  QUEUE_ST_EVAL,
  type StEvalPayload,
  type StEvalQueueLike,
} from './st-eval-queue.js'

// The per-turn context resolvers moved to turn-context.ts (keeping this module
// under its length budget). Re-exported so existing consumers + tests keep their
// `from './turn-worker.js'` import surface.
export { reloadFtContext, resolveWorldId, type ResolveWorldIdDeps } from './turn-context.js'

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
 *  session-participant roster (names + the userId→character-name attribution
 *  map, off one read), the session-row → session-number read, the prep
 *  ft_context read, and the scoped skill-check mechanical projection. Defining
 *  the worker's needs as a narrow interface (rather than the full `Repo`) keeps
 *  the in-memory test fakes small and makes the §8 scoping explicit. The real
 *  `createRepo(pool)` structurally satisfies it. */
export interface TurnWorkerRepo {
  readonly sessionMessages: TranscriptStore & {
    turnRowsExist(turnId: string): Promise<boolean>
    /** §4.7 post-turn re-mature: the unanswered-rows probe. */
    listAfterSeq(sessionId: string, afterSeq: number): Promise<readonly { messageType: string }[]>
  }
  readonly sessions: {
    getById(id: string): Promise<{ sessionNumber: number } | null>
  }
  readonly sessionPreps: {
    getBy(campaignId: string, sessionNumber: number): Promise<{ ftContext: string } | null>
  }
  /** MYT-72: the read-only PUBLIC world-id lookup (campaigns.world_id), used by
   *  `resolveWorldId` to scope the FT's world-knowledge lookup tools. This is NOT
   *  the secret sd_playbook surface — that read stays OFF TurnWorkerRepo, on the
   *  dedicated `LookupVetRepo` in tiers/lookup-wiring.ts (captured inside the vet
   *  closure, never the FT-side surface). */
  readonly campaigns: {
    getWorldId(id: string): Promise<string | null>
  }
  readonly characters: Pick<MechanicalReads, 'findSessionParticipantCharacterByName'> & {
    /** MYT-68: the FT prompt roster + the per-turn player-attribution map, off
     *  one read — the session's joined PCs as `{userId, name}` in a deterministic
     *  order, derived per turn from session_participants (the source of truth the
     *  skill-check resolver also reads), never from the racy :state blob (two
     *  simultaneous joins lost a name to last-write-wins). The names feed the FT
     *  system-prompt roster; the userId→name map is the codec's player
     *  attribution (CHARACTER names — the prompt echoes the attributed name into
     *  roll_skill_check.character_name, which resolves against
     *  session_participants). */
    listSessionParticipantCharacters(
      sessionId: string,
    ): Promise<readonly { userId: string; name: string }[]>
    /** MYT-70 §7: the per-turn party-ledger snapshot — each joined character's
     *  live mechanical sheet (HP, hit dice, gold, slots, conditions, tracked
     *  features, spells, equipment) as of turn start. Threaded onto the FT
     *  context (public-by-construction; rendered as a non-persisted tail). */
    readPartyLedgerSnapshot(sessionId: string): Promise<PartyLedgerSnapshot>
  }
}

/** Per-turn arguments the tiers factory needs. The emitter is passed IN (the
 *  worker owns the latch wiring); the FT streams every frame through it. */
export interface TierTurnArgs {
  readonly sessionId: string
  /** MYT-70 §10: the per-turn id — the journal idempotency key the FT's ledger
   *  tools thread into `RulesLawyerDeps.turnId`. */
  readonly turnId: string
  readonly worldTone: string
  readonly emitter: TurnEmitter
  /** MYT-72: the campaign's world id, scoping the FT's world-knowledge lookup
   *  tools (resolved once per turn via `resolveWorldId`, blob-cached). */
  readonly worldId: string
  /** MYT-72: the campaign id — the vet closure reads the secret sd_playbook for
   *  THIS campaign + session (off `LookupVetRepo`, never the FT-side surface). */
  readonly campaignId: string
  /** MYT-72: the recent player-visible narration the ST-vet reasons over. The
   *  ST's running session summary (a cheap, available, thread-consistent source;
   *  a verbatim-prose tail is a documented v1 follow-up). */
  readonly recentNarrative: string
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
  /** §4.7 post-turn re-mature (auto path): the dm-trigger debounce producer.
   *  A message that lands while a turn is in flight is swallowed (the evaluate
   *  job exits on `isResponding`, and a dedup'd add during an in-flight
   *  evaluation is dropped) — at turn end, if player rows sit above the
   *  responded watermark, the worker re-arms the quiet window so the DM comes
   *  back for them. Found live in the MYT-68 E2E smoke. */
  readonly dmTriggerQueue: DmTriggerQueueLike
  /** MYT-67 §4.7 — the `session-turn` producer used ONLY for the explicit drain:
   *  if an `@dm` landed while this turn was in flight, the worker enqueues one
   *  explicit follow-up turn on release so the summon fires the instant the
   *  current turn ends. */
  readonly sessionTurnQueue: TurnQueueLike
  /** MYT-69 §2 — the st-evaluation producer. Enqueued ONLY on the flushed-success
   *  path (post-hoc, off the hot path) — the post-turn narrative director runs in
   *  its own worker. The producer NEVER touches the dedup key (the job
   *  self-re-arms). */
  readonly stEvalQueue: StEvalQueueLike
  readonly publisher: TurnPublisher
  /** Per-turn tier factory. Takes the resolved per-turn args (the latched
   *  emitter is passed IN so tests can fake the tiers while the worker owns the
   *  latch wiring; the controller receives the SAME emitter via its deps). The
   *  SlowThinker seam is retired (MYT-69 — the ST runs off the turn path in its
   *  own worker), so the factory returns only `{ ft, scribe }`. */
  readonly makeTiers: (turn: TierTurnArgs) => { ft: FastThinker; scribe: Scribe }
  readonly heartbeatMs: number
  readonly logger: MinimalLogger
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
    emitLedgerUpdate: async (payload) => {
      await ensureMarked()
      await inner.emitLedgerUpdate(payload)
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
    // fallback for ftContext (§3.10).
    const state = await deps.sessionState.getState(campaignId)
    const ftContext =
      state?.ftContext ?? (await reloadFtContext(deps.repo, campaignId, sessionId, deps.logger))
    const worldTone = state?.worldTone ?? ''
    // MYT-68: one read off session_participants (the same source the skill-check
    // resolver reads), in deterministic joined order, never the racy :state blob
    // (two simultaneous joins lost a name to last-write-wins; caught live in the
    // MYT-68 smoke). The names feed the FT system-prompt roster; the
    // userId→character-name map is the codec's player attribution — CHARACTER
    // names, because the ft-system prompt tells the model to echo the attributed
    // name into roll_skill_check.character_name, which resolves against
    // session_participants (a display-name attribution fail-softed the first
    // check live in the smoke).
    const sessionPcs = await deps.repo.characters.listSessionParticipantCharacters(sessionId)
    const participants = sessionPcs.map((p) => p.name)
    const attributionNames = new Map(sessionPcs.map((p) => [p.userId, p.name]))
    // MYT-70 §7: load the party-ledger snapshot per turn (same fresh-run-only
    // placement as the roster — a non-rendering converge/latch/contention path
    // never needs it). Public-by-construction; the FT renders it as a
    // non-persisted `[Party ledger: …]` tail.
    const partyLedger = await deps.repo.characters.readPartyLedgerSnapshot(sessionId)

    // The latched emitter (§5): the FIRST frame of any kind marks the
    // emitted-anything latch BEFORE publishing, so a crash between mark and
    // publish still trips `wasTurnEmitted` on retry.
    const emitter = makeLatchedEmitter(deps.publisher.emitFor(campaignId, turnId), () =>
      deps.triggerState.markTurnEmitted(turnId),
    )

    // MYT-73 §7.2 (D6) — a `correction` turn is a player-less retcon: the
    // Scribe job enqueued it directly (bypassing the dm-trigger no-monologue
    // guard), and its "direction" is the worker-injected secret-free `Z`, NOT a
    // slot read. So a correction does NOT consume the one-shot/standing slots
    // (burning an unrelated sanctioned reveal on the correction render). Instead
    // the worker sets the one-shot direction to the DISTINCT `[[DM CORRECTION:
    // <Z>]]` marker — the explicit FT-prompt EXCEPTION to silent-consume
    // (deliver it OPENLY). It rides the SAME fusion seam as a normal one-shot
    // (fused onto the last user row, verbatim — the marker survives the fusion).
    const isCorrection = job.data.trigger.kind === 'correction'

    // §6 — take the one-shot (GETDEL, latest-wins) and READ the standing
    // directive. ONLY on the fresh-run arm: a take before the converge/latch
    // exits (above) would burn a sanctioned reveal on a turn that never renders,
    // and a take by a contention loser would starve the lock holder. A correction
    // turn skips the slot reads entirely (its direction is the injected `Z`).
    const pendingDirection = isCorrection
      ? `[[DM CORRECTION: ${job.data.correctionText ?? ''}]]`
      : await deps.triggerState.takeOneShotDirection(campaignId)
    const standingDirective = isCorrection
      ? null
      : await deps.triggerState.readStandingDirection(campaignId)

    // MYT-72 — resolve the world id (blob-cached) scoping the FT's world-knowledge
    // lookup tools, and the recent-narrative the ST-vet reasons over. The vet IS
    // the ST, so its running session summary is the cheap, available, thread-
    // consistent context source (a verbatim-prose tail is a documented v1
    // follow-up). Fresh-run-only, like the roster/ledger reads above.
    const worldId = await resolveWorldId(
      { sessionState: deps.sessionState, repo: deps.repo },
      campaignId,
      sessionId,
    )
    const { summary: recentNarrative } = await deps.sessionState.loadTurnState(campaignId)

    const tiers = deps.makeTiers({
      sessionId,
      turnId,
      worldTone,
      emitter,
      worldId,
      campaignId,
      recentNarrative,
    })

    const controller = new SessionController(
      {
        sessionState: deps.sessionState,
        ...tiers,
        emitter,
        transcript: deps.repo.sessionMessages,
        attributionNames,
        participants,
        ftContext,
        partyLedger,
        ...(pendingDirection !== null ? { pendingDirection } : {}),
        ...(standingDirective !== null ? { standingDirective } : {}),
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
    // MYT-73 §7.2/§9 — a `correction` turn consumed NO player message (it is
    // player-less), so it must NOT advance the watermark: doing so would strand
    // genuine pending player seqs above it. The post-turn re-mature (shared
    // `finally`) then re-arms the quiet window so the next real turn picks them up.
    if (!isCorrection) {
      await deps.triggerState.setRespondedSeq(campaignId, job.data.maxConsumedSeq)
    }
    // §8 — a flushed turn happened; bump the ST floor counter.
    await deps.triggerState.incrTurnsSinceSt(campaignId)
    // §2 — enqueue the st-evaluation (post-hoc, off the hot path). Gated on the
    // flushed-success path ONLY (a failed/lock-lost/converge run has no fresh FT
    // response to evaluate). Own try/catch — an enqueue hiccup never masks the
    // turn outcome.
    try {
      await enqueueStEval(deps.stEvalQueue, { campaignId, sessionId })
    } catch (enqErr) {
      deps.logger.error({ err: enqErr, campaignId, turnId }, 'failed to enqueue st-evaluation')
    }
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
    // §4.7 post-turn re-mature (auto path). The in-flight guard makes the
    // evaluate job exit while a turn runs, so a message that arrived mid-turn
    // has no pending evaluation — without this re-arm it would sit unanswered
    // until the NEXT message (or forever, at a quiet table). Re-arm only when
    // unanswered player rows actually exist above the watermark; the
    // re-armed evaluation classifies them like any other batch. Own
    // try/catch: a re-arm hiccup must never mask the turn outcome.
    try {
      const watermark = await deps.triggerState.respondedSeq(campaignId)
      const trailing = await deps.repo.sessionMessages.listAfterSeq(sessionId, watermark)
      if (trailing.some((r) => r.messageType === 'player_message')) {
        await rescheduleDebounce(deps.dmTriggerQueue, campaignId, QUIET_WINDOW_MS)
      }
    } catch (rearmErr) {
      deps.logger.error(
        { err: rearmErr, campaignId, turnId },
        'failed to re-arm the quiet window after the turn',
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
 * projection + resolved world tone + latched emitter. The SlowThinker is retired
 * off this path (MYT-69 — it runs post-hoc in the st-evaluation worker); Scribe
 * stays a stub.
 */
export function buildSessionTurnWorker(
  redisBatch: Redis,
  redisRealtime: Redis,
  redisKeyPrefix: string,
  logger: MinimalLogger,
  pool: Pool,
  embedder: VoyageEmbedder,
): BullmqWorker<TurnJobPayload> {
  const publisher = createTurnPublisher(redisRealtime, redisKeyPrefix)
  const triggerState = makeTriggerState(redisRealtime, redisKeyPrefix)
  const repo = createRepo(pool)

  // §4.7 — the explicit-drain producer. Build the BullMQ `Queue` ONCE (on the
  // shared BullMQ connection `redisBatch`, like every other producer) and reuse
  // it; a fresh `new Queue(...)` per enqueue would leak a client per drain.
  const turnQueue = new Queue<TurnJobPayload>(QUEUE_SESSION_TURN, { connection: redisBatch })
  // §4.7 post-turn re-mature producer (one Queue per process, like turnQueue).
  const dmTriggerBullQueue = new Queue<DmTriggerPayload>(QUEUE_DM_TRIGGER, {
    connection: redisBatch,
  })
  const dmTriggerQueue: DmTriggerQueueLike = {
    add: (n, d, o) => dmTriggerBullQueue.add(n, d, o),
  }
  const sessionTurnQueue: TurnQueueLike = { add: (n, d, o) => turnQueue.add(n, d, o) }
  // §2 post-turn st-evaluation producer (one Queue per process, like the others).
  const stEvalBullQueue = new Queue<StEvalPayload>(QUEUE_ST_EVAL, { connection: redisBatch })
  // The enqueue closure only fires on the FULL FT-success path (enqueueStEval,
  // gated on a flushed turn) — the buildSessionTurnWorker unit tests drive the §5
  // CONVERGE path (no fresh FT response → no st-eval), so this passthrough is
  // exercised by the §10 real-Anthropic E2E smoke, not vitest. (The sibling
  // sessionTurnQueue/dmTriggerQueue closures DO fire on the converge drain path.)
  /* c8 ignore next */
  const stEvalQueue: StEvalQueueLike = { add: (n, d, o) => stEvalBullQueue.add(n, d, o) }

  const deps: TurnProcessorDeps = {
    lock: createSessionLock(redisRealtime, redisKeyPrefix, SESSION_LOCK_TTL_MS),
    sessionState: makeSessionState(redisRealtime, redisKeyPrefix),
    repo,
    triggerState,
    sessionTurnQueue,
    stEvalQueue,
    dmTriggerQueue,
    publisher,
    // The real FastThinker, constructed per turn with the scoped skill-check
    // mechanical projection (§8 — ONLY findSessionParticipantCharacterByName,
    // never the whole repo), the turn's world tone, and the worker-owned latched
    // emitter. The SlowThinker is retired off this path (MYT-69); Scribe stays a stub.
    /* c8 ignore start -- real-FT construction: invoking it spends Sonnet tokens;
       wiring is exercised by the §10 real-Anthropic E2E smoke (T19), the
       converge-path builder tests prove the surrounding wiring, and the lookup
       deps' construction is fully covered by lookup-wiring's own unit tests */
    makeTiers: ({ sessionId, turnId, worldTone, worldId, campaignId, recentNarrative }) => {
      const mech: MechanicalReads = {
        findSessionParticipantCharacterByName: (sid, name) =>
          repo.characters.findSessionParticipantCharacterByName(sid, name),
      }
      // MYT-70 §5/§10 — the scoped LedgerOps the FT's ledger tools resolve
      // against. `repo.characters` composes `charactersLedgerNs`, so the
      // pool-bound surface IS a LedgerOps superset (used for the pre-mutation
      // reads). `runInTx` opens ONE repo transaction so each mutation + its
      // journal row commit atomically: it binds the tx-scoped `tx.characters`
      // (also a LedgerOps superset) into the resolver callback. The resolver
      // never returns the ROLLBACK sentinel (it throws on failure), so
      // `expectCommitted` narrows the `T | RollbackSignal` result back to `T`.
      const ledger: LedgerOps = repo.characters
      const runInTx: LedgerTxRunner = (fn) =>
        repo.transaction((tx) => fn(tx.characters)).then(expectCommitted)

      // MYT-72 — the world-knowledge lookup surface, built by the dedicated,
      // fully-covered lookup-wiring module (which owns the search/graph/vet/
      // askerSummary construction + the enforced-ignorance sd_playbook-captured-
      // inside-the-vet-closure boundary). Spread into FtToolDeps; the secret
      // playbook never lands on the returned object.
      const lookup = buildLookupDeps(
        { repo, embedder, logger },
        { worldId, campaignId, sessionId, recentNarrative },
      )

      return {
        scribe: new StubScribe(),
        ft: new SonnetFastThinker({
          tools: buildFtTools(
            { mech, ledger, runInTx, sessionId, turnId, worldTone, logger, ...lookup },
            undefined,
          ),
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
