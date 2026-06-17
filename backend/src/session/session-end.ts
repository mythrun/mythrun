// backend/src/session/session-end.ts
//
// MYT-74b T11 — the END-OF-SESSION lifecycle, SPLIT into a begin + a complete
// phase so the LIVE farewell send-off precedes the `session_end` frame.
//
//   - `endSession` (§1) only BEGINS the end. It claims the once-only `ending`
//     flag (SET-NX), cancels the pending all-disconnected suspend, reads the
//     responded watermark, and enqueues ONE player-less FAREWELL turn. It does
//     NOT finalize — the turn worker runs the finalize AFTER the farewell render,
//     so the table sees the DM's send-off prose BEFORE the session_end frame.
//   - `finalizeEndedSession` (§1.3) COMPLETES the end. It conditionally flips the
//     row to 'ended' (markEnded → rowCount; broadcast exactly once), then enqueues
//     reconcile + analysis (both jobId-deduped → safe to re-enqueue). It is
//     IDEMPOTENT: callable from the farewell turn's `finally` AND the QueueEvents
//     backstop — the conditional flip makes the broadcast fire exactly once.
//
// Reusable by BOTH the explicit `end_session` WS frame AND T12's budget auto-end,
// so the load-bearing property is IDEMPOTENCE: the SET-NX `ending` flag collapses
// the explicit frame and the auto-end (which can race) to a SINGLE farewell, and
// the per-session jobIds (farewell / reconcile / analysis) are broker-level dedup
// backstops beyond the flag.
//
// The orchestration is pure: every effect is an injected dependency, so the whole
// decision tree is unit-testable with recording fakes (no broker / Redis / PG /
// LLM). The WS route and the turn worker wire the real instances.

import { randomUUID } from 'node:crypto'
import { cancelSuspend, type SuspendQueueLike } from './session-suspend.js'
import { enqueueReconcile, type ReconcileQueueLike } from './session-reconcile.js'
import { enqueuePostSessionAnalysis, type AnalysisQueueLike } from './post-session-analysis.js'
import { enqueueFarewellTurn, FAREWELL_DIRECTION, type TurnQueueLike } from './turn-queue.js'
import type { SessionState } from '../redis/session-state.js'

/** Minimal pino-compatible logger surface (structured info/warn with an optional
 *  message; matches the worker's MinimalLogger). */
export interface MinimalLogger {
  info: (o: Record<string, unknown> | string, m?: string) => void
  warn: (o: Record<string, unknown> | string, m?: string) => void
  error: (o: Record<string, unknown> | string, m?: string) => void
}

/** The ids the end flow needs. `worldId` is resolved by the caller (the WS route
 *  reuses `resolveWorldId` — blob-cached campaign→world) and threaded onto both
 *  the farewell payload and the reconcile job, so the orchestration issues no
 *  campaign→world read of its own. */
export interface EndSessionArgs {
  readonly campaignId: string
  readonly sessionId: string
  readonly worldId: string
}

// ── begin: endSession ─────────────────────────────────────────────────────────

/** Dependencies the BEGIN phase composes — all injected so the flow is
 *  unit-testable with recording fakes. */
export interface EndSessionDeps {
  /** The once-only end flag (SET-NX). */
  readonly sessionState: Pick<SessionState, 'tryMarkEnding'>
  /** The suspend producer — `cancelSuspend` removes a pending all-disconnected
   *  suspend so it can't re-checkpoint an ending session. */
  readonly suspendQueue: SuspendQueueLike
  /** The session-turn producer — `enqueueFarewellTurn` lands the player-less
   *  send-off turn (jobId per-session). */
  readonly turnQueue: TurnQueueLike
  /** The responded-seq watermark read. The farewell carries it as `maxConsumedSeq`
   *  so a player-less turn does NOT advance past unresponded player seqs. */
  readonly respondedSeq: (campaignId: string) => Promise<number>
  readonly logger: MinimalLogger
}

/**
 * MYT-74b §1 — "begin ending." Claims the once-only `ending` flag, cancels the
 * pending suspend, and enqueues a player-less FAREWELL turn. Does NOT finalize —
 * the turn worker runs the unconditional finalize after the farewell render, so
 * the live send-off precedes the `session_end` frame.
 *
 * IDEMPOTENT via the SET-NX `ending` flag: a second call (the explicit frame +
 * the budget auto-end collapsing) short-circuits at the gate, so exactly one
 * farewell turn is enqueued.
 */
export async function endSession(deps: EndSessionDeps, args: EndSessionArgs): Promise<void> {
  const { campaignId, sessionId, worldId } = args

  // Once-only interlock. The loser of the explicit-frame-vs-auto-end race
  // short-circuits here — the winner already enqueued the single farewell.
  const claimed = await deps.sessionState.tryMarkEnding(campaignId)
  if (!claimed) {
    deps.logger.info({ campaignId, sessionId }, 'session_end_already_in_progress')
    return
  }

  // Cancel the pending suspend — a suspend firing on an ending session would
  // re-checkpoint it (KEEPS status='active'), undoing the end. cancelSuspend is a
  // no-op when there's no pending job.
  await cancelSuspend(deps.suspendQueue, sessionId)

  // The watermark the farewell consumes UP TO (not past): a player-less turn must
  // not advance past unresponded player seqs, so the next real turn (there is
  // none, but the invariant holds) still picks them up.
  const watermark = await deps.respondedSeq(campaignId)
  await enqueueFarewellTurn(deps.turnQueue, {
    campaignId,
    sessionId,
    turnId: randomUUID(),
    triggerMessages: [],
    maxConsumedSeq: watermark,
    trigger: { kind: 'farewell' },
    farewellText: FAREWELL_DIRECTION,
    worldId,
  })
  deps.logger.info({ campaignId, sessionId, worldId }, 'session_end_initiated')
}

// ── complete: finalizeEndedSession ────────────────────────────────────────────

/** Dependencies the COMPLETE phase composes — all injected so the flow is
 *  unit-testable with recording fakes. */
export interface FinalizeEndedSessionDeps {
  /** The narrow sessions-repo surface — `markEnded` is the CONDITIONAL flip
   *  (status='ended' only when not already ended), returning the rowCount so the
   *  broadcast fires exactly once across the farewell-finally + QueueEvents
   *  backstop callers. */
  readonly sessions: { markEnded(id: string): Promise<number> }
  /** The end-of-session reconcile producer — `enqueueReconcile` fires the T10
   *  worker (jobId per-session → re-enqueue collapses to one job). */
  readonly reconcileQueue: ReconcileQueueLike
  /** The post-session analysis producer — `enqueuePostSessionAnalysis` fires the
   *  T9 worker (jobId per-session → re-enqueue collapses to one job). */
  readonly analysisQueue: AnalysisQueueLike
  /** Broadcast a server frame to every session client (the `session_end`
   *  fan-out). The caller wires this to the turn publisher's redis + the session
   *  channel; the orchestration stays frame-shape-agnostic at the seam. */
  readonly publish: (campaignId: string, frame: unknown) => Promise<void>
  readonly logger: MinimalLogger
}

/**
 * MYT-74b §1.3 — "complete ending." The UNCONDITIONAL finalize: flip the row to
 * ended (conditional → broadcast exactly once), then enqueue reconcile + analysis
 * (both jobId-deduped → safe to re-enqueue). Idempotent: callable from the
 * farewell turn's `finally` AND the QueueEvents backstop.
 *
 * The flip is CONDITIONAL (markEnded returns rowCount): the first finalize to
 * reach it flips (rowCount 1) and broadcasts; any later finalize gets rowCount 0
 * and skips the broadcast. reconcile + analysis are still (re-)enqueued each call
 * — their per-session jobIds collapse a re-enqueue to the existing job, so a
 * second finalize is harmless.
 */
export async function finalizeEndedSession(
  deps: FinalizeEndedSessionDeps,
  args: EndSessionArgs,
): Promise<void> {
  const { campaignId, sessionId, worldId } = args

  // Conditional flip — rowCount 1 on the winning finalize, 0 thereafter.
  const flipped = await deps.sessions.markEnded(sessionId)

  // Fire the canon-fold + narrative-closeout workers. Per-session jobIds collapse
  // a re-enqueue (the farewell-finally + the QueueEvents backstop both call this)
  // to the existing job at the broker.
  await enqueueReconcile(deps.reconcileQueue, { campaignId, sessionId, worldId })
  await enqueuePostSessionAnalysis(deps.analysisQueue, { campaignId, sessionId })

  if (flipped > 0) {
    // The winning finalize tells every client the session is over.
    await deps.publish(campaignId, { type: 'session_end', reason: 'normal' })
    deps.logger.info({ campaignId, sessionId, worldId }, 'session_finalized')
  } else {
    deps.logger.info({ campaignId, sessionId }, 'session_finalize_noop')
  }
}
