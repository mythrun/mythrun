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
  /** The seq watermark this turn consumes up to (MYT-67 §4.6). The worker
   *  advances `last-responded-seq` to this value after a successful flush, so
   *  the next trigger batch starts at `(maxConsumedSeq, …]`. Set by the
   *  producer (dm-trigger worker / explicit path / dev-fire-turn) from the
   *  batch's max seq; redelivery-stable since it rides the payload. */
  readonly maxConsumedSeq: number
  /** Why this turn fired (MYT-67 §4.6 / MYT-73 §7.2 D6). `kind` is the decision
   *  source; the optional `classification` is present only for the `auto` path
   *  (the Haiku DM-trigger classifier's verdict) — `explicit`/`solo`/dead-air
   *  turns carry no classification. The `correction` kind (MYT-73) is a
   *  player-less retcon turn enqueued by the Scribe job on a core-secret breach;
   *  it carries no classification either. Metadata only: it does NOT cross the
   *  tier boundary into any Fast Thinker call. */
  readonly trigger: {
    readonly kind: 'explicit' | 'solo' | 'auto' | 'correction' | 'farewell'
    readonly classification?: {
      readonly intent: 'reactive' | 'proactive'
      readonly complexity: 'low' | 'high'
      readonly confidence: number
    }
  }
  /** MYT-73 §7.2 (D6) — the secret-preserving correction `Z` the FT delivers
   *  OPENLY on a `correction`-kind turn. Present ONLY on a correction turn; the
   *  worker injects it as a distinct `[[DM CORRECTION: <correctionText>]]` marker
   *  (the explicit FT-prompt exception to silent-consume). A correction turn
   *  carries `triggerMessages: []` and a `maxConsumedSeq` equal to the CURRENT
   *  responded watermark — it must NOT advance past unresponded player seqs, so
   *  the next real turn still picks them up. ST-authored to be secret-free. */
  readonly correctionText?: string
  /** MYT-74b §1 — the silent-consume direction the FT delivers on a `farewell`
   *  turn (the end-of-session send-off). Present ONLY on a farewell turn; the
   *  worker fuses it via the SINGLE-bracket `[DM direction: …]` seam (NOT the open
   *  `[[DM CORRECTION:]]` marker) — consumed silently, rendered in the FT's own
   *  voice. A farewell carries `triggerMessages: []` and a `maxConsumedSeq` equal
   *  to the current responded watermark (player-less — must not advance the watermark). */
  readonly farewellText?: string
  /** MYT-74b §1 — the campaign's world id, carried on the FAREWELL payload so the
   *  turn worker's finally (and the QueueEvents backstop) can run the finalize
   *  (enqueue reconcile, which needs worldId) WITHOUT re-resolving it. Present only
   *  on a farewell turn; normal turns resolve worldId in their fresh-run arm. */
  readonly worldId?: string
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

/** MYT-74b §1.2 — the fixed farewell direction. ZFC: the send-off is a static cue;
 *  the FT authors the prose. Silent-consume (single bracket), so the FT renders it
 *  in its own voice rather than quoting a marker. */
export const FAREWELL_DIRECTION =
  'The session is winding down. Bring the scene to a natural close: narrate where ' +
  'each character ends up and give the table a quiet moment of closure. Do not start ' +
  'new threads or introduce new conflict.'

/** Enqueue ONE player-less farewell turn. `jobId` is per-session
 *  (`farewell-${sessionId}`) — a broker-level dedup backstop beyond the `ending`
 *  flag, so an explicit-end / budget-end race that slips the flag still collapses
 *  to one farewell. */
export function enqueueFarewellTurn(queue: TurnQueueLike, payload: TurnJobPayload): Promise<unknown> {
  return queue.add(TURN_JOB_NAME, payload, { jobId: `farewell-${payload.sessionId}` })
}
