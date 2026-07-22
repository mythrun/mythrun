// backend/src/session/session-suspend.ts
//
// MYT-65 Task 10 — session suspend (all-players-disconnected grace window).
//
// When every player disconnects from a live session, the connection handler
// schedules a SUSPEND after a 5-minute grace period. Suspend flushes session
// state to a Postgres checkpoint, KEEPS status='active' (suspend != end), and
// holds the Redis transport keys ~1h so a quick reconnect cold-starts from
// live Redis rather than the checkpoint. On reconnect, the handler CANCELS the
// pending suspend.
//
// The grace window is a BullMQ DELAYED job (`delay: 5min`, jobId =
// `suspend-{sessionId}`). The job is enqueued on disconnect and removed on
// reconnect. Task 11 builds the Worker that runs `processSuspendJob` and wires
// the real deps (`makeSessionState` over realtime Redis + a CheckpointStore
// backed by the repo); this module owns the producer surface + the processor.
//
// CRITICAL CORRECTNESS PROPERTY — the processor is IDEMPOTENT and
// SELF-VALIDATING. On fire it RE-READS live presence via `countPresence` and
// only suspends when presence is genuinely ZERO. This neutralizes two failure
// modes that a fire-and-suspend job would walk into:
//
//   1. Stale connection state — a player reconnected during the grace window
//      but the cancel raced the fire (or the cancel's remove lost to the job
//      transitioning delayed→active). Presence is live → bail, no suspend.
//   2. The BullMQ jobId-dedup footgun — a duplicate delayed job that "shouldn't"
//      exist but does (see server-queues.ts:29-32). Even if a phantom job
//      fires, the presence re-read gates the suspend, so a duplicate is inert.
//
// The presence re-read is the load-bearing line — NOT the cancel. cancel is an
// optimization (skip the wasted wakeup); the re-read is the guarantee.

import type { Queue } from 'bullmq'
import type { CheckpointStore, SessionState } from '../redis/session-state.js'

/** BullMQ queue identifier for suspend jobs. Colocated with the producer +
 *  processor it serves (rather than worker/bullmq-config.ts) since this queue
 *  is wholly owned by the MYT-65 transport layer. server-queues.ts imports it
 *  to build the Queue; Task 11's Worker imports it to register the processor. */
export const QUEUE_SESSION_SUSPEND = 'session-suspend' as const

/** 5-minute grace window before an all-disconnected session suspends, in ms. */
const SUSPEND_GRACE_MS = 5 * 60_000

/** The BullMQ job name for suspend jobs (one job kind per queue here). */
const SUSPEND_JOB_NAME = 'suspend' as const

/** Payload threaded through the delayed job. The processor needs both ids:
 *  `campaignId` keys the live Redis transport state (presence / :seq / :state);
 *  `sessionId` keys the Postgres checkpoint (one live session per campaign, but
 *  the durable rows are session-scoped). */
export interface SuspendJobPayload {
  readonly sessionId: string
  readonly campaignId: string
}

/** Stable per-session jobId. Doubling as the BullMQ dedup key means a re-`add`
 *  for the same session targets the SAME delayed job — which is exactly why
 *  `cancelSuspend` must REMOVE it before a re-schedule (see footgun note in the
 *  module header + server-queues.ts:29-32).
 *
 *  Separator is `-`, NOT `:` — BullMQ rejects a custom jobId containing a colon
 *  (`Error: Custom Id cannot contain :`; `:` is its reserved Redis-key
 *  separator). `sessionId` is a UUIDv7, so `suspend-{uuid}` is unambiguous. */
export function suspendJobId(sessionId: string): string {
  return `suspend-${sessionId}`
}

/** Minimal producer view of the suspend queue — just the enqueue/remove
 *  surface the connection handler (Task 11) needs. The full BullMQ `Queue`
 *  satisfies it; tests can pass a real `Queue` or a narrow fake. */
export interface SuspendQueueLike {
  add: Queue<SuspendJobPayload>['add']
  getJob: Queue<SuspendJobPayload>['getJob']
  remove: Queue<SuspendJobPayload>['remove']
}

/**
 * Schedule a suspend for `sessionId` after the 5-minute grace window. Called by
 * the connection handler when the LAST player disconnects.
 *
 * Idempotent at the broker via the stable `suspend-{sessionId}` jobId — a
 * second schedule for an already-pending session targets the same delayed job.
 * Because the queue prunes terminal jobs (removeOnComplete/removeOnFail set in
 * server-queues.ts for this queue), a re-schedule after a prior job COMPLETED
 * lands a fresh job rather than dedup-skipping against a leftover record.
 */
export async function scheduleSuspend(
  queue: SuspendQueueLike,
  sessionId: string,
  campaignId: string,
): Promise<void> {
  await queue.add(
    SUSPEND_JOB_NAME,
    { sessionId, campaignId },
    { delay: SUSPEND_GRACE_MS, jobId: suspendJobId(sessionId) },
  )
}

/**
 * Cancel a pending suspend for `sessionId`. Called by the connection handler
 * when a player (re)connects inside the grace window.
 *
 * Removing the job — rather than relying on the processor's presence re-read
 * alone — both saves the wasted wakeup AND clears the jobId from BullMQ's set
 * so a LATER disconnect can `scheduleSuspend` cleanly without the dedup no-op.
 * `Queue.remove` is a no-op when the job is absent (already fired/removed), so
 * a double-cancel is safe.
 */
export async function cancelSuspend(queue: SuspendQueueLike, sessionId: string): Promise<void> {
  await queue.remove(suspendJobId(sessionId))
}

/** Dependencies the processor needs, injected by Task 11's Worker so this
 *  module issues no raw Redis/SQL of its own:
 *   - `sessionState` — `makeSessionState(realtimeRedis, keyPrefix)`; supplies
 *     `countPresence`, `checkpoint`, and `refreshTtls`.
 *   - `store` — the `CheckpointStore` that PINS the checkpoint target (see
 *     `processSuspendJob`'s wiring note). Its `writeCheckpoint` is backed by
 *     `repo.sessions.update(sessionId, { stRunningSummary: <envelope> })`. */
export interface SuspendProcessorDeps {
  readonly sessionState: SessionState
  readonly store: CheckpointStore
}

/** What the processor observed/did — surfaced for logging + tests. */
export interface SuspendResult {
  /** Live connection count re-read on fire. */
  readonly presence: number
  /** True iff presence was 0 and the session was checkpointed + held. */
  readonly suspended: boolean
  /** Durable MAX(seq) persisted by the checkpoint; undefined when not suspended. */
  readonly maxSeq?: number
}

/** Narrow job view — the processor only reads `data`. A real BullMQ `Job` or a
 *  `{ data }` fake both satisfy it; keeps the processor unit-testable without a
 *  broker. */
interface SuspendJobLike {
  readonly data: SuspendJobPayload
}

/**
 * The delayed-job processor. SELF-VALIDATING: re-reads live presence and only
 * suspends when it is genuinely zero (see the module header for why this — not
 * the cancel — is the load-bearing idempotency guarantee).
 *
 * On a genuine all-disconnected fire:
 *   1. `checkpoint(campaignId, sessionId, store)` — Task 5's checkpoint reads
 *      the DURABLE MAX(seq) via the store and flushes the live `:state` blob
 *      into a self-describing `{kind:'myt69-checkpoint', maxSeq, state, turnState}`
 *      envelope, persisted through `store.writeCheckpoint`.
 *   2. `refreshTtls(campaignId)` — extend the Redis transport keys (~1-2h) so a
 *      quick reconnect cold-starts from live Redis rather than the checkpoint.
 *   3. status is left UNTOUCHED at 'active' — suspend is not end. The ONLY
 *      Postgres write is the checkpoint envelope (no status flip).
 *
 * CHECKPOINT TARGET (pinned here per Task 5's deferral): the caller wires
 * `store.writeCheckpoint` to `repo.sessions.update(sessionId, { stRunningSummary })`,
 * overloading the currently-unused `st_running_summary` TEXT column with the
 * self-describing envelope. That column is the documented MINIMAL target;
 * a dedicated `session_checkpoints` row (or a jsonb column on `sessions`) is
 * the long-term home — a schema migration this transport-state task must not
 * own. The envelope's `kind` discriminator lets the future reader distinguish
 * a MYT-65 checkpoint from any other use of the column.
 */
export async function processSuspendJob(
  deps: SuspendProcessorDeps,
  job: SuspendJobLike,
): Promise<SuspendResult> {
  const { sessionId, campaignId } = job.data
  const { sessionState, store } = deps

  // LOAD-BEARING: re-read live presence. If anyone is connected, the
  // disconnect that scheduled this suspend has been superseded — bail without
  // touching state. This is what makes the job idempotent + dedup-proof.
  const presence = await sessionState.countPresence(campaignId)
  if (presence > 0) {
    return { presence, suspended: false }
  }

  // Genuinely empty: flush state to the Postgres checkpoint, keep status
  // 'active', and hold the Redis keys for a cheap reconnect.
  const { maxSeq } = await sessionState.checkpoint(campaignId, sessionId, store)
  await sessionState.refreshTtls(campaignId)

  return { presence, suspended: true, maxSeq }
}
