// MYT-69 §2 — the st-evaluation debounce/dedup producer. Single-flight per
// campaign by an explicit invariant (NOT a dedup accident): dedup
// `{ id: 'st-eval:<campaignId>' }` with NO ttl (a ttl'd key outlives the job
// and swallows re-adds — reference_bullmq_dedup_ttl_swallows_readds). NO delay,
// so `replace` is inert here (the job never sits in the delayed state). Adds
// while the job is WAITING collapse losslessly (the job reads current state at
// run time). Adds while the job is ACTIVE are SWALLOWED — closed by the JOB's
// own end-of-run self-re-arm (see the worker), which clears its own dedup key
// via `removeDeduplicationKey` then re-adds (the dm-trigger-worker pattern).
// The PRODUCER must NEVER remove the key (removing it under a waiting job would
// double-run).

import type { Queue } from 'bullmq'

export const QUEUE_ST_EVAL = 'st-evaluation'
export const ST_EVAL_JOB_NAME = 'st-evaluation'

export interface StEvalPayload {
  readonly campaignId: string
  readonly sessionId: string
}

/** Narrow producer surface (the turn worker's post-turn phase): just `add`. */
export interface StEvalQueueLike {
  add: Queue<StEvalPayload>['add']
}

/** Worker-side surface: the job's self-re-arm clears its OWN dedup key before
 *  re-adding (a running/active job cannot be replaced; a plain dedup'd add from
 *  inside the job is swallowed by its own key). Mirrors DmTriggerQueueWithDedup. */
export interface StEvalQueueWithDedup extends StEvalQueueLike {
  removeDeduplicationKey: Queue<StEvalPayload>['removeDeduplicationKey']
}

export function stEvalDedupId(campaignId: string): string {
  return `st-eval:${campaignId}`
}

export function enqueueStEval(queue: StEvalQueueLike, payload: StEvalPayload): Promise<unknown> {
  return queue.add(ST_EVAL_JOB_NAME, payload, {
    deduplication: { id: stEvalDedupId(payload.campaignId) },
  })
}
