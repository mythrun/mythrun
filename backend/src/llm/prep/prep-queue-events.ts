// backend/src/llm/prep/prep-queue-events.ts
//
// llm-outage-resilience §3.2 (Task 9) — broker-side terminal-failure recovery
// for the three prep queues, mirroring the MYT-67 session-turn QueueEvents
// precedent (session/session-turn-queue-events.ts).
//
// The gap this closes: a parked run's wake (or any prep job) whose worker
// dies terminally — maxStalledCount exhaustion, or attempts exhausted while
// no worker-side listener could run — leaves the entity in-progress forever.
// The §3.2 overdue arm can't catch the post-claim case (an in-flight stamp
// has nextResumeAt NULL, and the claim that cleared it IS the stage start the
// predicate waits for), so the broker `failed` stream is the only net.
//
// The prep queues keep `removeOnFail: {count: 0}` (age-retention would
// reintroduce the D9 dedup landmine), so the handlers operate from the broker
// event's jobId ALONE — parsed at FIXED UUID WIDTHS (ids embed hyphens, never
// split('-')), never via getJob/job.data:
//
//   world-gen        jobId = `${campaignId}`                     (36 chars)
//   session-prep     jobId = `sp-${campaignId}-${sessionNumber}`
//   campaign-setup   jobId = `cc-${campaignId}-${userId}`        (cc- only;
//                    character-integration ids parse null → no-op)
//
// A broker `failed` on these queues is terminal by construction (BullMQ
// emits it only from moveToFinished target=failed / the stalled-terminal
// script; retryable attempts go through retryJob/moveToDelayed) and the job
// is already removed — so "armed AND job gone" reduces to: a resume stamp
// exists for the recovered identity. The handler then marks the entity
// failed via that pipeline's existing terminal path and clears the stamp.
//
// IMPORTANT — dedicated blocking connections. Each QueueEvents BRPOPs its
// own stream, so each gets its own duplicate()d ioredis connection (never
// the Worker's shared connection); close() must run at shutdown or a
// connection leaks per deploy (§4.8 precedent).

import { QueueEvents } from 'bullmq'
import type { Redis } from 'ioredis'
import type { Pool } from 'pg'
import { makeReconnectStrategy } from '../../redis/reconnect-strategy.js'
import { createRepo, type Repo } from '../../repo/index.js'
import type { PipelineEvent } from '../../contract/pipeline-events.js'
import {
  parseCharacterCreationJobId,
  parseSessionPrepJobId,
} from '../llm-health-probe.js'
import {
  QUEUE_CAMPAIGN_SETUP,
  QUEUE_SESSION_PREP,
  QUEUE_WORLD_GEN,
} from '../../worker/bullmq-config.js'

/** Minimal pino-compatible logger surface the recovery needs. */
interface MinimalLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void
  warn: (obj: Record<string, unknown>, msg?: string) => void
  error: (obj: Record<string, unknown>, msg?: string) => void
}

/** Stable code for the recovered terminal — lands on the stage-failed
 *  errorCode field and in character_concepts.error, greppable alongside
 *  `job_timeout` / `stage_failed`. */
export const PREP_TERMINAL_RECOVERY_CODE = 'job_terminal_failure'

/** Mirror of sanitizeError's message cap — failedReason is broker-authored
 *  text (e.g. "job stalled more than allowable limit") but cap defensively. */
const MAX_REASON_LEN = 200

export interface PrepTerminalRecoveryDeps {
  readonly repo: Repo
  readonly publishEvent: (campaignId: string, event: PipelineEvent) => Promise<void>
  readonly logger: MinimalLogger
}

/** A world-gen jobId IS the campaignId — 36 chars at fixed UUID width. */
const UUID_LEN = 36

/** world-gen: flip the world to today's terminal surface (worlds.markFailed +
 *  the world_gen_failed phase — the entity-level slice of handleStageError,
 *  reachable without a stage identity) and clear the stamp LAST so a crash
 *  mid-handler leaves the stamp for the next signal rather than stranding a
 *  generating world with no net. */
export async function handleWorldGenTerminalFailure(
  deps: PrepTerminalRecoveryDeps,
  jobId: string,
  failedReason: string,
): Promise<void> {
  if (jobId.length !== UUID_LEN) return
  const stamp = await deps.repo.resumeStamps.get('world_gen', jobId)
  if (stamp === null) return
  const worldId = await deps.repo.campaigns.getWorldId(jobId)
  if (worldId === null) {
    // The campaign vanished under the stamp (admin delete) — the stamp is an
    // orphan; clear it so the promote scan stops carrying it.
    deps.logger.warn(
      { event: 'prep_queue_events.orphan_stamp', pipeline: 'world_gen', campaignId: jobId },
      'terminal failed event for a stamped world-gen run whose campaign no longer exists',
    )
    await deps.repo.resumeStamps.clearStamp('world_gen', jobId)
    return
  }
  await deps.repo.worlds.markFailed(worldId)
  await deps.publishEvent(jobId, { type: 'phase', phase: 'world_gen_failed' })
  await deps.repo.resumeStamps.clearStamp('world_gen', jobId)
  deps.logger.warn(
    {
      event: 'prep_queue_events.terminal_recovered',
      pipeline: 'world_gen',
      campaignId: jobId,
      worldId,
      failedReason: failedReason.slice(0, MAX_REASON_LEN),
    },
    'terminally-failed world-gen job with a live resume stamp — world marked failed',
  )
}

/** session-prep: mark the per-session stage row failed + publish the terminal
 *  prep-failed (the processor's exact terminal shape) + clear the stamp. */
export async function handleSessionPrepTerminalFailure(
  deps: PrepTerminalRecoveryDeps,
  jobId: string,
  failedReason: string,
): Promise<void> {
  const parsed = parseSessionPrepJobId(jobId)
  if (parsed === null) return
  const stamp = await deps.repo.resumeStamps.get('session_prep', parsed.campaignId)
  if (stamp === null) return
  await deps.repo.pipelineRuns.markStageFailed({
    kind: 'campaign',
    campaignId: parsed.campaignId,
    stage: `session-prep:${String(parsed.sessionNumber)}`,
    error: `${PREP_TERMINAL_RECOVERY_CODE}: ${failedReason.slice(0, MAX_REASON_LEN)}`,
  })
  // Deliberately NOT campaigns.setFailed — a prep failure is session-scoped
  // (the processor's own pinned invariant).
  await deps.publishEvent(parsed.campaignId, {
    type: 'prep-failed',
    sessionNumber: parsed.sessionNumber,
    terminal: true,
  })
  await deps.repo.resumeStamps.clearStamp('session_prep', parsed.campaignId)
  deps.logger.warn(
    {
      event: 'prep_queue_events.terminal_recovered',
      pipeline: 'session_prep',
      campaignId: parsed.campaignId,
      sessionNumber: parsed.sessionNumber,
      failedReason: failedReason.slice(0, MAX_REASON_LEN),
    },
    'terminally-failed session-prep job with a live resume stamp — prep marked failed',
  )
}

/** character-creation: flip the concept to failed (the exhausted-transient
 *  listener's exact terminal shape, incl. its never-unwind-completed guard)
 *  + clear the stamp. Non-cc jobIds on the campaign-setup queue
 *  (character-integration) parse null and no-op. */
export async function handleCharacterCreationTerminalFailure(
  deps: PrepTerminalRecoveryDeps,
  jobId: string,
  failedReason: string,
): Promise<void> {
  const parsed = parseCharacterCreationJobId(jobId)
  if (parsed === null) return
  const concept = await deps.repo.characterConcepts.getByCampaignAndUser(
    parsed.campaignId,
    parsed.userId,
  )
  if (concept === null) return
  const stamp = await deps.repo.resumeStamps.get('character_creation', concept.id)
  if (stamp === null) return
  // Never unwind a completed concept (the stale-event race guard the
  // exhausted-transient listener pins); the stamp is stale — drop it.
  if (concept.status === 'completed') {
    await deps.repo.resumeStamps.clearStamp('character_creation', concept.id)
    return
  }
  await deps.repo.characterConcepts.markFailed(parsed.campaignId, parsed.userId, {
    code: PREP_TERMINAL_RECOVERY_CODE,
    message: failedReason.slice(0, MAX_REASON_LEN),
  })
  await deps.publishEvent(parsed.campaignId, {
    type: 'stage-failed',
    stage: 'character_creation',
    userId: parsed.userId,
    willRetry: false,
    errorCode: PREP_TERMINAL_RECOVERY_CODE,
  })
  await deps.repo.resumeStamps.clearStamp('character_creation', concept.id)
  deps.logger.warn(
    {
      event: 'prep_queue_events.terminal_recovered',
      pipeline: 'character_creation',
      campaignId: parsed.campaignId,
      userId: parsed.userId,
      conceptId: concept.id,
      failedReason: failedReason.slice(0, MAX_REASON_LEN),
    },
    'terminally-failed character-creation job with a live resume stamp — concept marked failed',
  )
}

export interface PrepQueueEventsDeps {
  readonly redisBatch: Redis
  readonly pool: Pool
  readonly publishEvent: (campaignId: string, event: PipelineEvent) => Promise<void>
  readonly logger: MinimalLogger
}

/** The built subscriber handle — three QueueEvents plus a close() that tears
 *  down each subscriber and its dedicated blocking connection. Registered
 *  into worker.ts's shutdown path (the §4.8 no-leaked-connections rule). */
export interface PrepQueueEvents {
  readonly close: () => Promise<void>
}

type TerminalHandler = (
  deps: PrepTerminalRecoveryDeps,
  jobId: string,
  failedReason: string,
) => Promise<void>

/** Build the three prep-queue QueueEvents subscribers (§3.2). */
export function buildPrepQueueEvents(deps: PrepQueueEventsDeps): PrepQueueEvents {
  const recoveryDeps: PrepTerminalRecoveryDeps = {
    repo: createRepo(deps.pool),
    publishEvent: deps.publishEvent,
    logger: deps.logger,
  }

  const wired: { queueEvents: QueueEvents; connection: { quit: () => Promise<unknown> } }[] = []
  const subscribe = (queueName: string, handler: TerminalHandler): void => {
    // Dedicated blocking connection per subscriber (QueueEvents BRPOPs);
    // its own reconnect label so outage forensics stay legible.
    const connection = deps.redisBatch.duplicate({
      retryStrategy: makeReconnectStrategy({
        label: `prep-queue-events-${queueName}`,
        logger: deps.logger,
      }),
    })
    const queueEvents = new QueueEvents(queueName, { connection })
    queueEvents.on('failed', ({ jobId, failedReason }) => {
      // Floating-promise guard: nothing in the broker callback may reject.
      void handler(recoveryDeps, jobId, failedReason).catch((err: unknown) => {
        deps.logger.error(
          { event: 'prep_queue_events.handler_failed', queue: queueName, jobId, err },
          'failed to handle a prep-queue broker failed event',
        )
      })
    })
    wired.push({ queueEvents, connection })
  }

  subscribe(QUEUE_WORLD_GEN, handleWorldGenTerminalFailure)
  subscribe(QUEUE_SESSION_PREP, handleSessionPrepTerminalFailure)
  subscribe(QUEUE_CAMPAIGN_SETUP, handleCharacterCreationTerminalFailure)

  return {
    close: async (): Promise<void> => {
      for (const { queueEvents, connection } of wired) {
        await queueEvents.close()
        await connection.quit()
      }
    },
  }
}
