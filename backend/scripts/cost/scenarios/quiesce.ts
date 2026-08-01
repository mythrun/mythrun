// backend/scripts/cost/scenarios/quiesce.ts
//
// Drained-queue quiescence (cost-wave1 spec §1.1(3)): the capture window
// closes when waiting+active+delayed == 0 across the SCENARIO'S queue set,
// held for a settle interval — never at the last HTTP/WS frame (queue-chained
// work lands after the client-visible response). Delayed counts on purpose: a
// parked debounce, a backoff retry, or world-gen's self-delaying park is work
// the window hasn't absorbed yet.
//
// The queue set is a PARAMETER, re-derived per scenario (Task-4 review,
// Minor 1): S-1's four turn-driven queues are correct only for non-ending
// sessions; S-4 spans campaign-setup + session-prep; S-5 spans world-gen.
// Copying a set blind silently truncates a window.

import { Redis } from 'ioredis'
import { Queue } from 'bullmq'

const QUIESCENCE_POLL_MS = 1_000

export interface QuiesceOpts {
  readonly redisUrl: string
  readonly queues: readonly string[]
  /** Zero-pending must HOLD this long before the window closes. */
  readonly settleMs: number
  readonly timeoutMs: number
  readonly log: (msg: string, extra?: Record<string, unknown>) => void
}

async function pendingCount(queue: Queue): Promise<number> {
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed')
  return Object.values(counts).reduce((s, n) => s + n, 0)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Wait for drained-queue quiescence; returns toMs (settle completion). */
export async function awaitQuiescence(opts: QuiesceOpts): Promise<number> {
  const connection = new Redis(opts.redisUrl, { maxRetriesPerRequest: null })
  const queues = opts.queues.map((name) => new Queue(name, { connection }))
  try {
    const deadline = Date.now() + opts.timeoutMs
    let zeroSince: number | null = null
    while (Date.now() < deadline) {
      const perQueue = await Promise.all(queues.map(pendingCount))
      const total = perQueue.reduce((s, n) => s + n, 0)
      if (total === 0) {
        zeroSince ??= Date.now()
        if (Date.now() - zeroSince >= opts.settleMs) {
          opts.log('quiescence_settled', { settleMs: opts.settleMs })
          return Date.now()
        }
      } else {
        if (zeroSince !== null) opts.log('quiescence_reset', {})
        zeroSince = null
        opts.log('quiescence_wait', {
          counts: Object.fromEntries(opts.queues.map((n, i) => [n, perQueue[i]])),
        })
      }
      await sleep(QUIESCENCE_POLL_MS)
    }
    throw new Error(`queues never quiesced within ${String(opts.timeoutMs)}ms`)
  } finally {
    await Promise.all(queues.map((q) => q.close()))
    connection.disconnect()
  }
}
