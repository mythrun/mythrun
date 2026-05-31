// backend/src/boot/process-error-handlers.ts
//
// myth-449j Layer 2: process-level safety net. Installs
// 'unhandledRejection' + 'uncaughtException' handlers that:
//   1. Read AsyncLocalStorage context (the per-job frame from
//      backend/src/worker/job-context.ts) to learn which job, world,
//      campaign, and stage was active.
//   2. Log structured at error level with full stack + ALS context.
//   3. Track recent rejections in a sliding-window ring buffer; if
//      >= 5 within 5 minutes, this is chronic - flush and exit so
//      ECS / tsx watch restarts the container.
//   4. Mark the in-flight world failed (best-effort) and publish a
//      world_gen_failed phase event via Redis Pub/Sub so SSE
//      subscribers see a clean terminal phase.
//
// Installing these handlers SUPPRESSES Node 24's default
// terminate-on-unhandled-rejection behavior - this is required for
// soft-survival across concurrent BullMQ jobs (CONCURRENCY=3). The
// process must keep running for the two siblings that didn't fail.

import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { getJobContext } from '../worker/job-context.js'
import { createRepo } from '../repo/index.js'

export interface ProcessErrorHandlerDeps {
  readonly pool: Pool
  readonly redisRealtime: Pick<Redis, 'publish'>
  readonly redisKeyPrefix: string
  readonly logger: Logger
  // Hook for tests; production passes the real process.exit. Returns
  // never in production, but tests pass a recording mock.
  readonly exit: (code: number) => void
  // Hook for tests; production passes Date.now.
  readonly now: () => number
}

const WINDOW_MS = 5 * 60 * 1000
const ESCALATION_THRESHOLD = 5

export function installProcessErrorHandlers(
  deps: ProcessErrorHandlerDeps,
): { uninstall: () => void } {
  const recent: number[] = []
  // Build the repo once over the handler's pool. The best-effort crash-time
  // "mark world failed" write goes through `repo.worlds.markFailed` (SQL
  // byte-identical to the prior inline `UPDATE worlds SET status = 'failed'
  // WHERE id = $1`) — keeping the all-access-through-repo rule total even for
  // process-level glue.
  const repo = createRepo(deps.pool)

  function pruneOld(): void {
    const cutoff = deps.now() - WINDOW_MS
    let first = recent[0]
    while (first !== undefined && first < cutoff) {
      recent.shift()
      first = recent[0]
    }
  }

  async function markFailedBestEffort(worldId: string, campaignId: string): Promise<void> {
    try {
      await repo.worlds.markFailed(worldId)
    } catch (markErr) {
      deps.logger.error(
        { event: 'process.mark_failed.pg_error', worldId, err: markErr },
        'process-error-handlers: failed to mark world failed in PG',
      )
    }
    try {
      await deps.redisRealtime.publish(
        `${deps.redisKeyPrefix}pipeline:campaign:${campaignId}`,
        JSON.stringify({ type: 'phase', phase: 'world_gen_failed' }),
      )
    } catch (publishErr) {
      deps.logger.error(
        { event: 'process.mark_failed.publish_error', campaignId, err: publishErr },
        'process-error-handlers: failed to publish world_gen_failed phase',
      )
    }
  }

  function reasonToWire(reason: unknown): Record<string, unknown> {
    if (reason instanceof Error) {
      return { name: reason.name, message: reason.message, stack: reason.stack }
    }
    return { value: String(reason) }
  }

  async function handle(
    eventName: 'unhandled_rejection' | 'uncaught_exception',
    reason: unknown,
  ): Promise<void> {
    const ctx = getJobContext()
    deps.logger.error(
      {
        event: `process.${eventName}`,
        jobContext: ctx ?? null,
        reason: reasonToWire(reason),
      },
      `process-error-handlers: ${eventName} caught`,
    )

    recent.push(deps.now())
    pruneOld()

    if (ctx !== undefined) {
      await markFailedBestEffort(ctx.worldId, ctx.campaignId)
    }

    if (recent.length >= ESCALATION_THRESHOLD) {
      deps.logger.fatal(
        {
          event: 'process.escalation_exit',
          recentCount: recent.length,
          windowMs: WINDOW_MS,
        },
        `process-error-handlers: ${String(ESCALATION_THRESHOLD)} rejections in ${String(WINDOW_MS / 1000)}s — exiting`,
      )
      deps.exit(1)
    }
  }

  const onRejection = (reason: unknown): void => {
    void handle('unhandled_rejection', reason)
  }
  const onException = (err: Error): void => {
    void handle('uncaught_exception', err)
  }

  process.on('unhandledRejection', onRejection)
  process.on('uncaughtException', onException)

  return {
    uninstall: () => {
      process.off('unhandledRejection', onRejection)
      process.off('uncaughtException', onException)
    },
  }
}
