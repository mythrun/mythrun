// MYT-66 Task 8 — the session-turn producer.
//
// `enqueueTurn` is the request-time enqueue surface for a player-driven turn.
// It is a thin BullMQ producer: it adds a job under the constant TURN_JOB_NAME
// with the caller's payload and NO custom jobId (H10). The per-session mutex is
// the session lock (Task 3), not a jobId-dedup — so unlike the suspend queue,
// turns must NOT collapse onto a shared id. The `turnId` (H2) is allocated by
// the caller (`randomUUID()`) at enqueue and lives in the payload, so it is
// STABLE across a BullMQ redelivery (a redelivered job carries the same data).

import type { Queue } from 'bullmq'
import type { TriggerMessage } from './tiers/types.js'

export const QUEUE_SESSION_TURN = 'session-turn' as const
export const TURN_JOB_NAME = 'turn' as const

export interface TurnJobPayload {
  readonly campaignId: string
  readonly sessionId: string
  readonly turnId: string
  readonly triggerMessages: readonly TriggerMessage[]
}

/** The narrow producer surface the controller needs: just `add`. The raw
 *  BullMQ Queue is closed at shutdown in server.ts; route/controller code only
 *  enqueues. */
export interface TurnQueueLike {
  add: Queue<TurnJobPayload>['add']
}

/** Enqueue one player-driven turn. No custom jobId (H10): the session lock is
 *  the per-session mutex, so turns must each land as a distinct job rather than
 *  dedup onto a shared id. */
export function enqueueTurn(queue: TurnQueueLike, payload: TurnJobPayload): Promise<unknown> {
  return queue.add(TURN_JOB_NAME, payload)
}
