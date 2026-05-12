// backend/src/sse/connection-counter.ts
//
// Process-scoped SSE connection counter. Emits a structured pino log
// every 60s with current count, max-since-last-emission, and wasted-
// message count. The setInterval handle is unref()'d so it doesn't pin
// the event loop during shutdown.

import type pino from 'pino'

const PERIODIC_LOG_MS = 60_000

export interface ConnectionCounter {
  readonly increment: () => void
  readonly decrement: () => void
  readonly current: () => number
  readonly incrementWasted: () => void
  /** Starts the periodic log; returns an unsubscribe fn that clears the interval. */
  readonly startPeriodicLog: () => () => void
}

export function createConnectionCounter(logger: pino.Logger): ConnectionCounter {
  let count = 0
  let maxSinceLast = 0
  let wastedMsgs = 0

  function increment(): void {
    count++
    if (count > maxSinceLast) maxSinceLast = count
  }

  function decrement(): void {
    count = Math.max(0, count - 1)
  }

  function incrementWasted(): void {
    wastedMsgs++
  }

  function current(): number {
    return count
  }

  function startPeriodicLog(): () => void {
    const handle = setInterval(() => {
      logger.info(
        {
          event: 'sse.connections.active',
          count,
          max_since_last: maxSinceLast,
          wasted_msgs: wastedMsgs,
          taskRevision: process.env.ECS_TASK_REVISION ?? null,
        },
        'sse connections snapshot',
      )
      // Reset counters; max_since_last starts from current so the next
      // window's peak still captures any spike.
      maxSinceLast = count
      wastedMsgs = 0
    }, PERIODIC_LOG_MS)
    handle.unref()
    return () => {
      clearInterval(handle)
    }
  }

  return { increment, decrement, current, incrementWasted, startPeriodicLog }
}
