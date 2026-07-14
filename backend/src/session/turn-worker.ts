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
import type { CombatEvent, CombatPartyMember, InitiateCombatEvent } from './combat/events.js'
import { applyToLedger, assembleSummary, reconcileDeltas, type ReconcilePc } from './combat/apply.js'
import type { FastThinker, PartyLedgerSnapshot, TurnEmitter } from './tiers/types.js'
import type { MechanicalReads } from './skill-check.js'
import type { LedgerOps } from '../repo/characters-ledger.js'
import type { LedgerTxRunner, RulesLawyerDeps } from './rules-lawyer.js'
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
import {
  enqueueTurn,
  FAREWELL_DIRECTION,
  QUEUE_SESSION_TURN,
  type TurnJobPayload,
  type TurnQueueLike,
} from './turn-queue.js'
import {
  enqueueStEval,
  QUEUE_ST_EVAL,
  type StEvalPayload,
  type StEvalQueueLike,
} from './st-eval-queue.js'
import { QUEUE_SCRIBE, type ScribeJobPayload, type ScribeQueueLike } from './scribe-queue.js'
import {
  bindFinalizeLogger,
  endSession,
  finalizeEndedSession,
  type EndSessionArgs,
  type EndSessionDeps,
  type FinalizeEndedSessionDeps,
} from './session-end.js'
import { QUEUE_SESSION_SUSPEND, type SuspendQueueLike } from './session-suspend.js'
import { SESSION_TOKEN_BUDGET } from './st-config.js'
import { buildSessionReconcileQueue, buildSessionAnalysisQueue } from '../server-queues.js'
import { sessionChannel } from '../contract/session-channel.js'
import { makeWorkingSetRepo } from '../redis/working-set.js'
import type { WorkingSetItem, WorkingSetProposal } from './working-set/types.js'

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

/** Minimal pino-compatible logger surface the processor needs. `info` is optional
 *  here (the processor itself only ever warns/errors); the real pino logger
 *  supplies it, and the T12 budget auto-end's `endSession` orchestration (which
 *  logs at info) gets a guaranteed `info` via the builder's adapter. */
interface MinimalLogger {
  info?: (objOrMsg: Record<string, unknown> | string, msg?: string) => void
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
    /** MYT-74a T12 — the durable cumulative session usage row, read on the
     *  post-flush success phase to decide the budget-100% auto-end. `null` when
     *  the session has recorded no LLM usage yet (a brand-new session). */
    budgetSummary(sessionId: string): Promise<{ inputTokens: number; outputTokens: number } | null>
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
  /** MYT-73: the per-turn injection sink. A lookup whose ST-vet relays/invents a
   *  fact records the (secret-free) vetted relay into the working set through
   *  this — the SAME array the SessionController carries onto the Scribe job
   *  payload. Threaded into the lookup tools' `recordInjection`. */
  readonly recordInjection: (p: WorkingSetProposal) => void
  /** MYT-75: the per-turn party-ledger snapshot (the same one read for the
   *  fresh-run arm). The combat tools' `combatParty` dep projects it to
   *  `CombatPartyMember[]` (id + name + level + current/max HP). */
  readonly partyLedger: PartyLedgerSnapshot
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
  /** MYT-73 §2.4 — the post-turn Scribe producer. Threaded into the
   *  SessionController so `enqueueScribeJob` (called on the flushed-success path)
   *  can enqueue the turn's prose + delta + injections off the hot path. */
  readonly scribeQueue: ScribeQueueLike
  readonly publisher: TurnPublisher
  /** Per-turn tier factory. Takes the resolved per-turn args (the latched
   *  emitter is passed IN so tests can fake the tiers while the worker owns the
   *  latch wiring; the controller receives the SAME emitter via its deps). The
   *  SlowThinker seam is retired (MYT-69 — the ST runs off the turn path in its
   *  own worker) and the on-path Scribe seam is retired (MYT-73 — it is a
   *  post-turn job). MYT-75 adds the per-turn `combatEvents` accumulator the
   *  combat tools push into; the worker reads `tiers.combatEvents` post-turn (T7)
   *  to apply the ledger, persist the blob, flip the mode, and emit the frames. */
  readonly makeTiers: (turn: TierTurnArgs) => { ft: FastThinker; combatEvents: CombatEvent[] }
  /** MYT-75 T7 — the scoped `LedgerOps` the POST-TURN combat application writes the
   *  reconciled PC damage through (the pre-mutation reads in `applyToLedger` →
   *  `resolveAdjustHp`). The SAME `repo.characters` surface `makeTiers`'s FT ledger
   *  tools resolve against (a `LedgerOps` superset). Threaded on the processor deps
   *  (not `TurnWorkerRepo.characters`, whose FT-side type stays the narrow
   *  skill-check projection) so the post-flush block applies combat without
   *  widening the FT-facing repo surface. */
  readonly combatLedger: LedgerOps
  /** MYT-75 T7 — the ledger tx runner the post-turn combat application binds onto
   *  `RulesLawyerDeps.runInTx`. The SAME runner `makeTiers`/`buildFtTools` build
   *  (`repo.transaction((tx) => fn(tx.characters)).then(expectCommitted)`), so each
   *  HP write + its `ledger_events` journal row commit atomically (§10). The
   *  journal makes `applyToLedger` idempotent under the synthetic, turn-stable
   *  `combat-resolve:${turnId}` toolCallId — a BullMQ re-run replays as a no-op. */
  readonly ledgerTx: LedgerTxRunner
  /** MYT-74a T12 — the budget-100% auto-end. A bound closure (the worker binds
   *  the real `endSession` orchestration's deps in `buildSessionTurnWorker`) so
   *  the processor stays testable. Invoked on the post-flush success phase when
   *  cumulative session usage reaches `SESSION_TOKEN_BUDGET`. IDEMPOTENT across
   *  turns via `endSession`'s SET-NX `ending` flag — a second over-budget turn
   *  no-ops at the flag, so the processor needs no dedup of its own. */
  readonly endSession: (args: EndSessionArgs) => Promise<void>
  /** MYT-74b §1.3 — the UNCONDITIONAL end-of-session finalize. A bound closure (the
   *  worker binds the real `finalizeEndedSession` orchestration's deps in
   *  `buildSessionTurnWorker`). Invoked from the FAREWELL turn's `finally` on EVERY
   *  path (clean render, thrown render, converge) — `finally` always runs — so the
   *  table sees the DM's send-off prose before the `session_end` frame, and a
   *  thrown farewell render still finalizes. IDEMPOTENT: the conditional row flip
   *  fires the broadcast exactly once across this caller + the QueueEvents
   *  backstop, and reconcile/analysis dedup on per-session jobIds. */
  readonly finalizeEndedSession: (args: EndSessionArgs) => Promise<void>
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
    emitModeChange: async (payload) => {
      await ensureMarked()
      await inner.emitModeChange(payload)
    },
    emitCombatStarted: async (payload) => {
      await ensureMarked()
      await inner.emitCombatStarted(payload)
    },
    emitCombatResolved: async (payload) => {
      await ensureMarked()
      await inner.emitCombatResolved(payload)
    },
  }
}

/**
 * MYT-75 T7 — project the per-turn party-ledger snapshot onto the `ReconcilePc[]`
 * the envelope reconciler resolves PC damage against (id + name + current/max HP).
 * Pure projection — the snapshot was already read for the fresh-run arm, so the
 * post-turn combat application needs no second ledger read. Exported so the
 * projection is directly unit-testable.
 */
export function projectPartyLedgerToReconcilePc(
  partyLedger: PartyLedgerSnapshot,
): readonly ReconcilePc[] {
  return partyLedger.map((c) => ({
    characterId: c.characterId,
    name: c.name,
    hp: c.hitPoints,
    maxHp: c.maxHitPoints,
  }))
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

  // MYT-74b §1.3 / MYT-73 §7.2 — the player-less turn predicates, hoisted so the
  // §5 decision order + the shared `finally` both gate on them. A `correction`
  // (MYT-73 retcon) and a `farewell` (MYT-74b end-of-session send-off) are both
  // player-less: they consumed no player message, so neither advances the
  // watermark / enqueues Scribe / runs the budget auto-end. The farewell ALSO
  // runs the unconditional finalize in the `finally`.
  const isCorrection = job.data.trigger.kind === 'correction'
  const isFarewell = job.data.trigger.kind === 'farewell'
  const isPlayerless = isCorrection || isFarewell

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
      // A player-less turn (correction / farewell) consumed no player message, so
      // even on the converge path it must NOT advance the watermark past
      // unresponded player seqs (same invariant as the fresh-run arm below).
      if (!isPlayerless) await deps.triggerState.setRespondedSeq(campaignId, job.data.maxConsumedSeq)
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
    //
    // MYT-74b §1.2 — a `farewell` turn is the player-less end-of-session send-off
    // (enqueued by `endSession`). Its direction is the RAW farewell text (NOT a
    // pre-wrapped marker): the controller/FT fuses it via the single-bracket
    // `[DM direction: …]` silent-consume seam, so the FT authors the closing prose
    // in its own voice. Like a correction it reads neither direction slot.

    // §6 — take the one-shot (GETDEL, latest-wins) and READ the standing
    // directive. ONLY on the fresh-run arm: a take before the converge/latch
    // exits (above) would burn a sanctioned reveal on a turn that never renders,
    // and a take by a contention loser would starve the lock holder. A player-less
    // turn (correction / farewell) skips the slot reads entirely (its direction is
    // the worker-injected text, not a slot).
    const pendingDirection = isCorrection
      ? `[[DM CORRECTION: ${job.data.correctionText ?? ''}]]`
      : isFarewell
        ? (job.data.farewellText ?? FAREWELL_DIRECTION)
        : await deps.triggerState.takeOneShotDirection(campaignId)
    const standingDirective = isPlayerless
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

    // MYT-73 §2.4 — the per-turn injection sink: ONE array shared between the FT
    // tools' `recordInjection` (a mid-turn ST-vet relay pushes its secret-free
    // proposal here) and the SessionController, which carries the accumulated
    // array onto the post-turn Scribe job payload (`enqueueScribeJob`).
    const injections: WorkingSetProposal[] = []

    const tiers = deps.makeTiers({
      sessionId,
      turnId,
      worldTone,
      emitter,
      worldId,
      campaignId,
      recentNarrative,
      recordInjection: (p) => injections.push(p),
      partyLedger,
    })

    const controller = new SessionController(
      {
        sessionState: deps.sessionState,
        ...tiers,
        scribeQueue: deps.scribeQueue,
        worldId,
        injections,
        emitter,
        transcript: deps.repo.sessionMessages,
        attributionNames,
        participants,
        ftContext,
        partyLedger,
        triggerKind: job.data.trigger.kind,
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
    // MYT-75 T7 — post-turn combat application (the post-flush side-effect seam).
    // The combat tools recorded into `tiers.combatEvents` (D12: pure execute — no
    // session-state write there); the durable ledger writes + the CombatState blob
    // + the mode flip + the `combat_resolved` emit all happen HERE. Gated on
    // `!isPlayerless` like the rest of the post-flush tail (a correction/farewell
    // never opens combat). OWN try/catch (like `enqueueStEval`): a combat-apply
    // failure logs but never crashes the turn — the turn already persisted, so a
    // throw here would re-run an already-flushed turn via BullMQ `attempts`.
    //
    // Idempotent via a synthetic, turn-stable toolCallId (`combat-resolve:${turnId}`):
    // `applyToLedger` → `applyWithJournal` checks `ledger_events` FIRST, so a BullMQ
    // re-run of THIS post-flush block (after the rows already landed) replays as a
    // no-op. KNOWN L1 LIMITATION: a crash AFTER flush but BEFORE this completes
    // leaves the combat tools persisted but the mechanical apply not yet applied —
    // rare; the next turn proceeds in exploration (we do NOT make this fully atomic
    // with the turn flush in L1; that's a documented follow-up).
    if (!isPlayerless) {
      try {
        await applyCombat(deps, tiers.combatEvents, partyLedger, emitter, {
          campaignId,
          sessionId,
          turnId,
        })
      } catch (combatErr) {
        deps.logger.error({ err: combatErr, campaignId, turnId }, 'failed to apply post-turn combat')
      }
    }
    // §4.7 — the batch is responded: advance the watermark so the next trigger
    // batch starts at `(maxConsumedSeq, …]`. Only on a real (flushed) success —
    // a lock-lost abort never flushes, so it must never advance the watermark.
    // MYT-73 §7.2/§9 + MYT-74b §1 — a player-less turn (correction / farewell)
    // consumed NO player message, so it must NOT advance the watermark: doing so
    // would strand genuine pending player seqs above it. The post-turn re-mature
    // (shared `finally`) then re-arms the quiet window so the next real turn picks
    // them up.
    if (!isPlayerless) {
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
    // MYT-74a T12 — budget-100% auto-end. The §3.11 FT-context bound is the real
    // session length cap; when cumulative token usage reaches it, the session has
    // to end (the FT can hold no more transcript). Read the durable cumulative
    // usage and, if it has reached SESSION_TOKEN_BUDGET, fire the end orchestration
    // (status flip → reconcile → session_end broadcast). `endSession`'s SET-NX
    // `ending` flag makes this idempotent across turns: a second over-budget turn
    // no-ops at the flag, so no per-turn dedup is needed here. Gated like the
    // watermark on `!isPlayerless` (a player-less correction/farewell never opens
    // new budget-bearing context of its own — and a farewell is itself the end, so
    // re-triggering the end orchestration off it is meaningless). OWN try/catch — a
    // failure to enqueue the end must NEVER mask the turn outcome (mirrors the
    // st-evaluation isolation).
    if (!isPlayerless) {
      try {
        const usage = await deps.repo.sessions.budgetSummary(sessionId)
        const cumulativeTokens = usage === null ? 0 : usage.inputTokens + usage.outputTokens
        if (cumulativeTokens >= SESSION_TOKEN_BUDGET) {
          await deps.endSession({ campaignId, sessionId, worldId })
        }
      } catch (endErr) {
        deps.logger.error({ err: endErr, campaignId, turnId }, 'failed to end session on budget')
      }
    }
    // §2.4 — enqueue the post-turn Scribe job (prose + delta + injections), off
    // the hot path. Gated like the watermark on `!isPlayerless`: a player-less
    // correction/farewell delivers already-vetted secret-free prose, so running
    // the tripwire over it is wasted spend (and a correction risks a retcon loop).
    // Own try/catch — an enqueue hiccup never masks the turn outcome (mirrors the
    // st-evaluation enqueue above).
    if (!isPlayerless) {
      try {
        await controller.enqueueScribeJob()
      } catch (scErr) {
        deps.logger.error({ err: scErr, campaignId, turnId }, 'failed to enqueue scribe')
      }
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

    // MYT-74b §1.3 — the ending gate. Once `endSession` has claimed the `ending`
    // flag, the session is winding down: the post-turn re-engagement work (explicit
    // drain + quiet-window re-mature) would only re-summon the DM into a session
    // that is over. Suppress BOTH on an ending session — the unconditional finalize
    // below is the only thing that should run after a farewell render.
    const ending = await deps.sessionState.isEnding(campaignId)

    // §4.7 — explicit drain: if an `@dm` landed while this turn was in flight,
    // the server set the explicit-pending flag. Take-and-clear it and enqueue
    // ONE explicit follow-up so the summon fires the instant this turn ends.
    // Guarded in its OWN try/catch: a drain hiccup must never mask the turn
    // outcome (it would re-run an already-flushed turn via BullMQ `attempts`).
    if (!ending) {
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
    // §4.7 post-turn re-mature (auto path). The in-flight guard makes the
    // evaluate job exit while a turn runs, so a message that arrived mid-turn
    // has no pending evaluation — without this re-arm it would sit unanswered
    // until the NEXT message (or forever, at a quiet table). Re-arm only when
    // unanswered player rows actually exist above the watermark; the
    // re-armed evaluation classifies them like any other batch. Own
    // try/catch: a re-arm hiccup must never mask the turn outcome. Suppressed on
    // an ending session (no point re-summoning the DM into a closing session).
    if (!ending) {
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

    // MYT-74b §1.3 — the UNCONDITIONAL finalize. Runs on EVERY farewell path
    // (clean render, thrown render, converge) because `finally` always runs: the
    // table sees the DM's send-off prose, then the finalize flips the row to
    // 'ended', enqueues reconcile + analysis, and broadcasts `session_end` (the
    // CONDITIONAL flip makes the broadcast fire exactly once across this caller +
    // the QueueEvents backstop). The worldId rides the farewell payload; a missing
    // one falls back to `resolveWorldId` (blob-cached). OWN try/catch — a finalize
    // hiccup must never mask the turn outcome.
    if (isFarewell) {
      try {
        const worldId =
          job.data.worldId ??
          (await resolveWorldId({ sessionState: deps.sessionState, repo: deps.repo }, campaignId, sessionId))
        await deps.finalizeEndedSession({ campaignId, sessionId, worldId })
      } catch (finErr) {
        deps.logger.error({ err: finErr, campaignId, turnId }, 'failed to finalize ended session')
      }
    }
  }
}

/** The per-turn identifiers `applyCombat` threads onto the journal + the frame. */
interface CombatApplyIds {
  readonly campaignId: string
  readonly sessionId: string
  readonly turnId: string
}

/**
 * MYT-75 T7 — the post-turn combat application. Reads the per-turn
 * `combatEvents`; if a fight was initiated this turn, applies the reconciled PC
 * ledger deltas, assembles the `CombatSummaryL1`, durably writes the resolved
 * `CombatState` + flips `mode` to `combat`, and emits `combat_resolved`. Extracted
 * + exported so the application is unit-testable apart from the turn lifecycle.
 *
 * The reconciliation source depends on whether the FT also resolved the fight in
 * the SAME turn:
 *   - `resolve` present → use the FT's already-reconciled deltas + close-out
 *     narration (the natural path: initiate then resolve in one turn).
 *   - `resolve` ABSENT (a cap-hit: `initiate` fired but the FT loop hit its tool
 *     cap before resolving) → FORCE-RESOLVE from the deterministic envelope by
 *     reconciling EMPTY FT deltas. The envelope's floors (minDownedPcs /
 *     minAggregateHpLossFraction) still fill, so the dice stay authoritative.
 *
 * The ledger write is journal-idempotent under the synthetic, turn-stable
 * `combat-resolve:${turnId}` toolCallId — a re-run that already applied is a no-op.
 */
export async function applyCombat(
  deps: TurnProcessorDeps,
  combatEvents: readonly CombatEvent[],
  partyLedger: PartyLedgerSnapshot,
  emitter: TurnEmitter,
  ids: CombatApplyIds,
): Promise<void> {
  // LAST initiate wins (a turn could re-enter combat); `find` over the reversed
  // list narrows the union to `InitiateCombatEvent`.
  const initiate = [...combatEvents].reverse().find((e) => e.kind === 'initiate')
  if (initiate === undefined) return

  const resolve = [...combatEvents].reverse().find((e) => e.kind === 'resolve')
  const party = projectPartyLedgerToReconcilePc(partyLedger)
  // resolve present → the FT's reconciled deltas; absent (cap hit) → force-resolve
  // from the envelope by reconciling EMPTY deltas (the envelope fills the floors).
  const reconciled =
    resolve !== undefined
      ? resolve.reconciled
      : reconcileDeltas(
          initiate.outcome,
          { hp_changes: [], conditions_applied: [], conditions_removed: [], casualties: [] },
          party,
          initiate.enemies.map((e) => e.name),
        )
  const narration = resolve !== undefined ? resolve.narration : initiate.outcome.tierProse

  // The synthetic, turn-stable toolCallId is the §10 journal idempotency key: a
  // BullMQ re-run of the post-flush block replays `applyToLedger` as a no-op.
  const rlDeps: RulesLawyerDeps = {
    ledger: deps.combatLedger,
    runInTx: deps.ledgerTx,
    sessionId: ids.sessionId,
    turnId: ids.turnId,
    toolCallId: `combat-resolve:${ids.turnId}`,
    logger: deps.logger,
  }
  const hpChanges = await applyToLedger(rlDeps, reconciled)
  const summary = assembleSummary(initiate.outcome, reconciled, hpChanges, narration)

  // Persist the resolved combat blob + flip the durable mode to 'combat'. Read
  // the live `:state` blob first; a missing one (never started / TTL-reaped)
  // means there is nothing to flip — skip the blob/mode writes but still emit.
  const state = await deps.sessionState.getState(ids.campaignId)
  if (state !== null) {
    await deps.sessionState.setCombatState(ids.campaignId, {
      status: 'resolved',
      enemies: initiate.enemies,
      environment: initiate.environment,
      surprise: initiate.surprise,
      initiative: initiate.initiative,
      outcome: initiate.outcome,
      result: { summary },
    })
    // The durable mode flip — the client already flipped on the consume-loop
    // mode_change frame; this makes a cold-start reconnect read 'combat'.
    await deps.sessionState.setState(ids.campaignId, { ...state, mode: 'combat' })
  }

  await emitter.emitCombatResolved({
    narration,
    outcome: summary.outcome,
    casualties: summary.casualties,
    hpChanges: summary.hpChanges,
  })
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
 * off this path (MYT-69 — it runs post-hoc in the st-evaluation worker); the
 * Scribe is retired off this path too (MYT-73 — it is a post-turn job enqueued
 * via the `scribeQueue` producer on the flushed-success path).
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
  // MYT-73 — the in-session working set (the FT lookup tools' read-after-write
  // source), on the realtime connection (the working set is hot-path state, not
  // a job queue). The per-turn read thunk in makeTiers loads it for the lookup
  // tools' canon-merge.
  const workingSetRepo = makeWorkingSetRepo(redisRealtime, redisKeyPrefix)

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
  // §2.4 post-turn Scribe producer (one Queue per process, like the others). The
  // enqueue closure fires only on the FULL FT-success path (`enqueueScribeJob`,
  // gated on a flushed non-correction turn) — the builder unit tests drive the §5
  // CONVERGE path (no fresh FT response → no scribe enqueue), so this passthrough
  // is exercised by the §10 real-Anthropic E2E smoke, not vitest.
  const scribeBullQueue = new Queue<ScribeJobPayload>(QUEUE_SCRIBE, { connection: redisBatch })
  /* c8 ignore next */
  const scribeQueue: ScribeQueueLike = { add: (n, d, o) => scribeBullQueue.add(n, d, o) }

  // MYT-74a T12 — the budget-100% auto-end orchestration deps. The session lock +
  // sessionState are shared with the processor deps (the SAME instances, so the
  // end-fence quiesces the very turn loop this worker drives). The suspend +
  // reconcile producers are dedicated Queues on the shared BullMQ connection (one
  // per process, like every other producer). `publish` is a raw session-channel
  // broadcast on the realtime connection (the `session_end` server frame is a
  // session-level control frame, not a per-turn frame off the TurnPublisher).
  const lock = createSessionLock(redisRealtime, redisKeyPrefix, SESSION_LOCK_TTL_MS)
  const sessionState = makeSessionState(redisRealtime, redisKeyPrefix)
  const suspendBullQueue = new Queue(QUEUE_SESSION_SUSPEND, { connection: redisBatch })
  // The suspend + reconcile producer passthroughs fire only through `endSession`
  // (the budget-end path / the §10 smoke), never the converge-path builder unit
  // tests — c8-ignored like the sibling stEvalQueue/scribeQueue passthroughs.
  /* c8 ignore start */
  const suspendQueue: SuspendQueueLike = {
    add: (n, d, o) => suspendBullQueue.add(n, d, o),
    getJob: (id) => suspendBullQueue.getJob(id),
    remove: (id) => suspendBullQueue.remove(id),
  }
  /* c8 ignore stop */
  // MYT-74b T14 — the finalize-path reconcile + analysis producers go through the
  // POLICY builders (not plain `new Queue`), so the jobs they enqueue carry the
  // `attempts: 5 + exponential backoff` retry policy the processors' throw-to-retry
  // design relies on. 74b moved ALL reconcile + analysis enqueues into the finalize
  // path, so a plain `attempts: 1` handle here would silently defeat both. No
  // import cycle: server-queues.ts pulls only queue-name consts + payload/adapter
  // types from session modules; none of them import back into turn-worker.ts.
  const { sessionReconcileQueue: reconcileQueue } = buildSessionReconcileQueue(redisBatch)
  const { sessionAnalysisQueue: analysisQueue } = buildSessionAnalysisQueue(redisBatch)

  // MYT-74b T11 — the BEGIN-phase end deps (the budget-100% auto-end path). The
  // session lock + sessionState are shared with the processor deps (the SAME
  // instances). `endSession` only claims the `ending` flag, cancels the pending
  // suspend, reads the watermark, and enqueues ONE farewell turn — it does NOT
  // finalize. The suspend + turn producers are dedicated Queues on the shared
  // BullMQ connection (one per process, like every other producer).
  const endDeps: EndSessionDeps = {
    sessionState,
    suspendQueue,
    turnQueue: sessionTurnQueue,
    // The watermark read fires only inside the real `endSession` orchestration (the
    // budget-end path / the §smoke), never the converge-path builder unit tests —
    // c8-ignored like the sibling queue passthroughs.
    /* c8 ignore next */
    respondedSeq: (cid) => triggerState.respondedSeq(cid),
    // `endSession` logs at info; the worker's MinimalLogger types `info` as
    // optional, so guarantee one (the real pino logger has it; a test fake
    // without it falls back to warn — the end-flow's info logs aren't load-bearing).
    logger: bindFinalizeLogger(logger),
  }

  // MYT-74b §1.3 — the COMPLETE-phase finalize deps (the farewell turn's `finally`).
  // `finalizeEndedSession` conditionally flips the row to 'ended' (broadcast exactly
  // once), then enqueues reconcile + analysis (both jobId-deduped). `publish` is a
  // raw session-channel broadcast on the realtime connection (the `session_end`
  // server frame is a session-level control frame, not a per-turn TurnPublisher frame).
  const finalizeDeps: FinalizeEndedSessionDeps = {
    sessions: repo.sessions,
    reconcileQueue,
    analysisQueue,
    // The session_end broadcast fires only on a real farewell finalize (the §smoke),
    // not the converge-path builder tests (those never enter the farewell `finally`).
    /* c8 ignore start */
    publish: async (campaignId, frame): Promise<void> => {
      await redisRealtime.publish(sessionChannel(redisKeyPrefix, campaignId), JSON.stringify(frame))
    },
    /* c8 ignore stop */
    logger: bindFinalizeLogger(logger),
  }

  const deps: TurnProcessorDeps = {
    lock,
    sessionState,
    repo,
    triggerState,
    sessionTurnQueue,
    stEvalQueue,
    scribeQueue,
    dmTriggerQueue,
    publisher,
    // MYT-75 T7 — the post-turn combat application's ledger surface. `repo.characters`
    // composes `charactersLedgerNs`, so the pool-bound surface IS a `LedgerOps`
    // superset (the pre-mutation reads); `ledgerTx` opens ONE repo transaction per
    // mutation so the HP write + its `ledger_events` journal row commit atomically.
    // Identical wiring to `makeTiers`'s FT ledger tools (the same surface + runner).
    combatLedger: repo.characters,
    // The tx-runner arrow fires only when a real combat applies through the builder
    // (the §10 real-Anthropic E2E smoke), never the converge-path builder unit tests
    // — c8-ignored like the sibling stEvalQueue/scribeQueue/endSession passthroughs.
    // The applyCombat orchestration itself is covered via the injected ledger/tx in
    // processTurnJob's combat-application tests.
    /* c8 ignore next */
    ledgerTx: (fn) => repo.transaction((tx) => fn(tx.characters)).then(expectCommitted),
    // The real FastThinker, constructed per turn with the scoped skill-check
    // mechanical projection (§8 — ONLY findSessionParticipantCharacterByName,
    // never the whole repo), the turn's world tone, and the worker-owned latched
    // emitter. The SlowThinker is retired off this path (MYT-69); the Scribe is
    // a post-turn job (MYT-73 — enqueued via scribeQueue, not a tier here).
    /* c8 ignore start -- real-FT construction: invoking it spends Sonnet tokens;
       wiring is exercised by the §10 real-Anthropic E2E smoke (T19), the
       converge-path builder tests prove the surrounding wiring, and the lookup
       deps' construction is fully covered by lookup-wiring's own unit tests */
    makeTiers: ({
      sessionId,
      turnId,
      worldTone,
      worldId,
      campaignId,
      recentNarrative,
      recordInjection,
      partyLedger,
    }) => {
      const mech: MechanicalReads = {
        findSessionParticipantCharacterByName: (sid, name) =>
          repo.characters.findSessionParticipantCharacterByName(sid, name),
      }
      // MYT-75 §combat — the per-turn combat-event accumulator the two combat
      // tools push into via `recordCombat`. The worker reads `tiers.combatEvents`
      // post-turn (T7) to apply the reconciled ledger, persist the combat blob,
      // flip the mode, and emit `combat_resolved`.
      const combatEvents: CombatEvent[] = []
      // `combatParty` projects the per-turn party-ledger snapshot (already read
      // for the fresh-run arm) → the public CombatPartyMember shape the resolvers
      // consume (id + name + level + current/max HP). Pure projection — no read.
      const combatParty = (): Promise<readonly CombatPartyMember[]> =>
        Promise.resolve(
          partyLedger.map((c) => ({
            characterId: c.characterId,
            name: c.name,
            level: c.level,
            hp: c.hitPoints,
            maxHp: c.maxHitPoints,
          })),
        )
      // `pendingInitiate` returns the LAST recorded initiate event this turn (or
      // null) so `resolve_combat` reconciles against the right outcome envelope.
      // `find`'s predicate discriminates the union, so `last` is already narrowed
      // to `InitiateCombatEvent | undefined`.
      const pendingInitiate = (): InitiateCombatEvent | null =>
        [...combatEvents].reverse().find((e) => e.kind === 'initiate') ?? null
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

      // MYT-73 read-after-write — the per-turn working-set thunk the lookup tools'
      // search_lore closure loads to cosine-merge near-query working-set items
      // into the canon LoreHit[] (so a fact invented earlier this session is
      // findable now). Bound to the campaign's working-set list.
      const workingSet = (): Promise<WorkingSetItem[]> => workingSetRepo.load(campaignId)

      // MYT-72 — the world-knowledge lookup surface, built by the dedicated,
      // fully-covered lookup-wiring module (which owns the search/graph/vet/
      // askerSummary construction + the enforced-ignorance sd_playbook-captured-
      // inside-the-vet-closure boundary). Spread into FtToolDeps; the secret
      // playbook never lands on the returned object. MYT-73 closes the type gap by
      // threading the injection sink (`recordInjection`) + the read-after-write
      // working-set thunk (`workingSet`) the LookupWiringArgs declares.
      const lookup = buildLookupDeps(
        { repo, embedder, logger },
        { worldId, campaignId, sessionId, recentNarrative, recordInjection, workingSet },
      )

      return {
        ft: new SonnetFastThinker({
          tools: buildFtTools(
            {
              mech,
              ledger,
              runInTx,
              sessionId,
              turnId,
              worldTone,
              logger,
              ...lookup,
              combatParty,
              recordCombat: (e) => combatEvents.push(e),
              pendingInitiate,
            },
            undefined,
          ),
          logger,
        }),
        combatEvents,
      }
    },
    /* c8 ignore stop */
    // MYT-74a T12 — bind the budget-100% auto-end. The closure threads the
    // worker-constructed endDeps into the shared `endSession` orchestration; the
    // processor invokes it with `{campaignId, sessionId, worldId}` when cumulative
    // usage reaches SESSION_TOKEN_BUDGET on the post-flush success phase. This
    // builder-only passthrough fires only on a real flushed-then-over-budget turn
    // (the §10 real-Anthropic E2E / the reconcile smoke), not the converge-path
    // builder unit tests — the budget branch itself is covered via the injected
    // `endSession` fake in processTurnJob's tests.
    /* c8 ignore next */
    endSession: (args) => endSession(endDeps, args),
    // MYT-74b §1.3 — bind the UNCONDITIONAL finalize. The closure threads the
    // worker-constructed finalizeDeps into the shared `finalizeEndedSession`
    // orchestration; the farewell turn's `finally` invokes it with `{campaignId,
    // sessionId, worldId}`. This builder-only passthrough fires only on a real
    // farewell finalize (the §smoke), not the converge-path builder unit tests —
    // the finalize branch itself is covered via the injected fake in
    // processTurnJob's tests.
    /* c8 ignore next */
    finalizeEndedSession: (args) => finalizeEndedSession(finalizeDeps, args),
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
