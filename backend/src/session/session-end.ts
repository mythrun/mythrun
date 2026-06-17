// backend/src/session/session-end.ts
//
// MYT-74a T11 — the END-OF-SESSION lifecycle orchestration. The trigger that
// fires the T10 reconcile worker. Reusable by BOTH the explicit `end_session`
// WS frame AND T12's budget auto-end — so the load-bearing property is
// IDEMPOTENCE: the SET-NX `ending` flag makes the explicit frame and the
// auto-end (which can race) collapse to a SINGLE end (one status flip, one
// reconcile enqueue, one broadcast).
//
// The orchestration is pure: every effect is an injected dependency, so the
// whole decision tree is unit-testable with recording fakes (no broker / Redis /
// PG / LLM). The WS route (and later the auto-end) wires the real instances:
// the realtime-Redis-backed `sessionState` flag, the suspend + reconcile
// producers, the per-session lock, the sessions repo, and the turn publisher.
//
// QUIESCE: the per-session lock is the fence that quiesces an in-flight turn —
// acquiring it (or finding it already held by a live turn) is what guarantees
// the final turn's render isn't still mutating canon when reconcile reads the
// working set. The lock-fence is the load-bearing part; the trailing post-turn
// jobs (Scribe / ledger) drain on their OWN queues. If the lock is contended (a
// turn is genuinely mid-flight), we STILL proceed with the flip + enqueue — the
// reconcile worker (T10) re-acquires the same lock itself before reading, so the
// fence is also enforced THERE. That backstop is why a contended end is safe.

import { cancelSuspend, type SuspendQueueLike } from './session-suspend.js'
import { enqueueReconcile, type ReconcileQueueLike } from './session-reconcile.js'
import type { SessionLock } from './session-lock.js'
import type { SessionState } from '../redis/session-state.js'
import type { SessionUpdate, Session } from '../repo/types.js'

/** Minimal pino-compatible logger surface (structured info/warn with an optional
 *  message; matches the worker's MinimalLogger). */
export interface MinimalLogger {
  info: (o: Record<string, unknown> | string, m?: string) => void
  warn: (o: Record<string, unknown> | string, m?: string) => void
  error: (o: Record<string, unknown> | string, m?: string) => void
}

/** The narrow sessions-repo surface the end flow writes/reads. `update` flips
 *  the row to 'ended'; `getById` is reserved for callers that resolve state from
 *  the row (the WS route resolves worldId via `resolveWorldId` and passes it in).
 *  The concrete repo's `sessions` structurally satisfies this. */
export interface EndSessionRepo {
  update(id: string, patch: SessionUpdate): Promise<Session>
  getById(id: string): Promise<Session | null>
}

/** Dependencies the end orchestration composes — all injected so the flow is
 *  unit-testable with recording fakes. */
export interface EndSessionDeps {
  /** The once-only end flag (SET-NX) + the inbound drop-gate read. */
  readonly sessionState: Pick<SessionState, 'tryMarkEnding' | 'isEnding'>
  /** The suspend producer — `cancelSuspend` removes a pending all-disconnected
   *  suspend so it can't re-checkpoint an ended session. */
  readonly suspendQueue: SuspendQueueLike
  /** The end-of-session reconcile producer — `enqueueReconcile` fires the T10
   *  worker (jobId per-session, so a double-trigger collapses to one job). */
  readonly reconcileQueue: ReconcileQueueLike
  /** The per-session lock — acquired to FENCE the in-flight turn (quiesce). */
  readonly lock: SessionLock
  /** The sessions repo — `update` flips the row to 'ended'. */
  readonly sessions: EndSessionRepo
  /** Broadcast a server frame to every session client (the `session_end`
   *  fan-out). The WS route wires this to the turn publisher's redis + the
   *  session channel; the orchestration stays frame-shape-agnostic at the seam. */
  readonly publish: (campaignId: string, frame: unknown) => Promise<void>
  readonly logger: MinimalLogger
}

/** The ids the end flow needs. `worldId` is resolved by the caller (the WS route
 *  reuses `resolveWorldId` — blob-cached campaign→world) and threaded onto the
 *  reconcile job, so the orchestration issues no campaign→world read of its own. */
export interface EndSessionArgs {
  readonly campaignId: string
  readonly sessionId: string
  readonly worldId: string
}

/**
 * End a live session. IDEMPOTENT via the SET-NX `ending` flag — a second call
 * (the explicit frame + the budget auto-end collapsing) short-circuits at the
 * gate, so the flip / reconcile / broadcast each run exactly once.
 *
 * Steps:
 *   (a) Claim the `ending` flag (SET-NX). Already set → another end is in
 *       progress → return (idempotent).
 *   (b) Cancel the pending all-disconnected suspend (an uncancelled suspend
 *       would re-checkpoint an ended session).
 *   (c) Quiesce: acquire the per-session lock to fence the in-flight turn; hold
 *       it across the flip and release after. A contended lock (null) STILL
 *       proceeds — the reconcile worker re-acquires the lock as the backstop.
 *   (d) Flip the session row to status='ended' with endedAt=now.
 *   (e) Enqueue ONE reconcile job ({campaignId, sessionId, worldId}).
 *   (f) Broadcast {type:'session_end', reason:'normal'}.
 *   (g) Structural info log.
 */
export async function endSession(deps: EndSessionDeps, args: EndSessionArgs): Promise<void> {
  const { campaignId, sessionId, worldId } = args

  // (a) Once-only interlock. The loser of the explicit-frame-vs-auto-end race
  //     short-circuits here — the winner already drives the single end.
  const claimed = await deps.sessionState.tryMarkEnding(campaignId)
  if (!claimed) {
    deps.logger.info({ campaignId, sessionId }, 'session_end_already_in_progress')
    return
  }

  // (b) Cancel the pending suspend before the flip — a suspend firing on an
  //     ended session would re-checkpoint it (KEEPS status='active'), undoing
  //     the end. cancelSuspend is a no-op when there's no pending job.
  await cancelSuspend(deps.suspendQueue, sessionId)

  // (c) Quiesce: fence the in-flight turn with the per-session lock. Acquiring it
  //     means no turn is rendering; a held lock (handle === null) means a turn is
  //     genuinely mid-flight — we proceed anyway because the reconcile worker
  //     re-acquires this same lock before it reads the working set (T10), so the
  //     fence is also enforced there. The lock-fence is the load-bearing part;
  //     the final turn's trailing post-turn jobs drain on their own queues.
  const handle = await deps.lock.tryAcquire(campaignId)
  if (handle === null) {
    deps.logger.info(
      { campaignId, sessionId },
      'session_end_lock_contended — proceeding (reconcile worker re-fences)',
    )
  }

  try {
    // (d) Flip the row to ended. COALESCE-based update; status+endedAt only.
    await deps.sessions.update(sessionId, { status: 'ended', endedAt: new Date() })
  } finally {
    // Release the fence after the flip regardless of an update throw, so a
    // failed flip never strands the lock for the (now never-coming) turn loop.
    if (handle !== null) await handle.release()
  }

  // (e) Fire the reconcile worker. Per-session jobId → a double-trigger that
  //     somehow got past the flag still collapses to one job at the broker.
  await enqueueReconcile(deps.reconcileQueue, { campaignId, sessionId, worldId })

  // (f) Tell every client the session is over.
  await deps.publish(campaignId, { type: 'session_end', reason: 'normal' })

  // (g) Structural close log.
  deps.logger.info({ campaignId, sessionId, worldId }, 'session_ended')
}
