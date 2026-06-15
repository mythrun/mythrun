import { pathToFileURL } from 'node:url'
import { Worker as BullmqWorker, type Job } from 'bullmq'
import { waitFor } from './boot/wait-for.js'
import { loadEnv } from './config/env.js'
import { createPgPool } from './db/postgres.js'
import { createBullmqRedisClient } from './redis/bullmq-client.js'
import { createRedisClient } from './redis/client.js'
import {
  CONCURRENCY_CAMPAIGN_SETUP,
  CONCURRENCY_SESSION_PREP,
  CONCURRENCY_WORLD_GEN,
  QUEUE_CAMPAIGN_SETUP,
  QUEUE_SESSION_PREP,
  QUEUE_WORLD_GEN,
} from './worker/bullmq-config.js'
import { startHealthServer } from './worker/health-server.js'
import { logger } from './llm/logger.js'
import { readCostCap, readCharacterCreationCostCap } from './llm/prep/cost-cap.js'
import { createWorldGenProcessor } from './llm/prep/world-gen-processor.js'
import {
  createCharacterCreationProcessor,
  type CharacterCreationJobPayload,
} from './llm/prep/character-creation-processor.js'
import {
  createCharacterIntegrationProcessor,
  type CharacterIntegrationJobPayload,
} from './llm/prep/character-integration-processor.js'
import { createSessionPrepProcessor } from './llm/prep/session-prep-processor.js'
import { buildSessionTurnWorker } from './session/turn-worker.js'
import { QUEUE_SESSION_TURN } from './session/turn-queue.js'
import { buildDmTriggerWorker } from './session/dm-trigger-worker.js'
import { buildStEvaluationWorker } from './session/st-evaluation-worker.js'
import { QUEUE_ST_EVAL } from './session/st-eval-queue.js'
import { buildSessionTurnQueueEvents } from './session/session-turn-queue-events.js'
import { QUEUE_DM_TRIGGER } from './session/dm-trigger-config.js'
import { makePipelinePublishers } from './worker/publishers.js'

/** Default worker health-server port. Overridable via WORKER_HEALTH_PORT for
 *  local dev, where :3001 can collide with an unrelated process (the env var
 *  is read at main() time in resolveHealthPort, not module load). ECS keeps
 *  the default — no task-def change needed. */
const HEALTH_PORT = 3001

/** Local-dev escape hatch for the health-server bind (see HEALTH_PORT). */
export function resolveHealthPort(): number {
  const raw = process.env.WORKER_HEALTH_PORT
  return raw !== undefined && raw !== '' ? Number(raw) : HEALTH_PORT
}
const WORKER_PG_POOL_SIZE = 4
// Reserve ~20s headroom under ECS stopTimeout=120s for pg + Redis cleanup.
const WORKER_CLOSE_GRACE_MS = 100_000

export async function main(): Promise<void> {
  const env = loadEnv()

  // Establish connections. Each probe is wrapped in waitFor() (200/500/
  // 1000/2000ms backoff, 5 attempts total) to mirror the API's boot
  // pattern in server.ts — without it, ioredis with
  // `maxRetriesPerRequest: null` (BullMQ requirement) throws
  // "Stream isn't writeable" on the first ping if the TCP socket isn't
  // writable yet. Boot still fails fast on a real outage; it just
  // tolerates the normal connection-establishment race.
  const redisBatch = createBullmqRedisClient(env.redisBatchUrl)
  await waitFor({ label: 'Redis (batch)', probe: () => redisBatch.ping() })
  // redisRealtime uses the regular client — only used for PUBLISH later
  // (MYT-52); BullMQ constraints don't apply.
  const redisRealtime = createRedisClient(env.redisRealtimeUrl)
  await waitFor({ label: 'Redis (realtime)', probe: () => redisRealtime.ping() })
  const pg = createPgPool(env.databaseUrl, { max: WORKER_PG_POOL_SIZE })
  await waitFor({ label: 'Postgres', probe: () => pg.query('SELECT 1') })

  // Cost caps come from the settings table — pulled at boot so the worker
  // operates on the same values the API uses (server.ts:readCostCapsAtBoot).
  // The cap is enforced per-stage inside the processors; a change to the
  // settings row requires a worker restart, matching the API's lifecycle.
  const [worldGenCostCapUsd, characterCreationCostCapUsd] = await Promise.all([
    readCostCap(pg),
    readCharacterCreationCostCap(pg),
  ])

  // Shared publishers (MYT-62). publishEvent → pipeline:campaign:{id} is the
  // single SSE channel for all worker-emitted lifecycle events (MYT-50); all
  // three processors publish there so the API's SSE subscriber sees one ordered
  // stream per campaign. publishProse → prep:campaign:{id} is the SEPARATE
  // dev-only channel for session-prep prose (sd_playbook may carry secrets).
  // Both channel formulas are single-sourced in worker/publishers.ts.
  const { publishEvent, publishProse } = makePipelinePublishers(
    redisRealtime,
    env.redisKeyPrefix,
  )

  // World-gen — real processor wired here. MYT-51 landed the non-streaming
  // stages, MYT-52 the streaming stages + coherence pass. The API container
  // (server.ts:buildWorldGenWorker) wires the same processor; both compete
  // for jobs on the same QUEUE_WORLD_GEN. The smoke surfaced that this
  // worker.ts entrypoint was never updated alongside server.ts.
  const worldGenWorker = new BullmqWorker(
    QUEUE_WORLD_GEN,
    createWorldGenProcessor({
      pool: pg,
      redisRealtime,
      redisKeyPrefix: env.redisKeyPrefix,
      logger,
      costCapUsd: worldGenCostCapUsd,
      voyageApiKey: env.voyageApiKey,
    }),
    { connection: redisBatch, concurrency: CONCURRENCY_WORLD_GEN },
  )

  // Campaign-setup is a router on job.name (MYT-54 T20 fix). Both arms get
  // the real processor — no stub fallthrough.
  const characterCreationProcessor = createCharacterCreationProcessor({
    pool: pg,
    costCapUsd: characterCreationCostCapUsd,
    publishEvent,
  })
  const integrationProcessor = createCharacterIntegrationProcessor({
    pool: pg,
    publishEvent,
    voyageApiKey: env.voyageApiKey,
  })

  const campaignSetupRouter = async (job: Job): Promise<void> => {
    if (job.name === 'character-integration') {
      await integrationProcessor(job as Job<CharacterIntegrationJobPayload>)
      return
    }
    await characterCreationProcessor(job as Job<CharacterCreationJobPayload>)
  }

  const campaignSetupWorker = new BullmqWorker(QUEUE_CAMPAIGN_SETUP, campaignSetupRouter, {
    connection: redisBatch,
    concurrency: CONCURRENCY_CAMPAIGN_SETUP,
  })

  // Session-prep (MYT-61) — one job per (campaign, session_number), enqueued
  // by MYT-63 with jobId `sp-${campaignId}-${sessionNumber}`. Streams two prose
  // docs through Opus; the processor owns the per-session pipeline_runs
  // (`session-prep:${n}`) lifecycle. A prep failure is session-scoped and never
  // fails the campaign. The API container (server.ts) wires the same processor.
  const sessionPrepWorker = new BullmqWorker(
    QUEUE_SESSION_PREP,
    createSessionPrepProcessor({ pool: pg, publishEvent, publishProse }),
    { connection: redisBatch, concurrency: CONCURRENCY_SESSION_PREP },
  )

  // Session-turn (MYT-66) — the lock-fenced DM-turn conductor. Wired HERE in the
  // dedicated worker process (NOT the API server, which only enqueues turns).
  // Reuses the already-probed `redisBatch` for BullMQ and constructs its lock /
  // session-state / publisher on `redisRealtime`. The builder owns the H1 timing
  // inequality + the H8 terminal-turn_error `failed` handler.
  const sessionTurnWorker = buildSessionTurnWorker(
    redisBatch,
    redisRealtime,
    env.redisKeyPrefix,
    logger,
    pg,
  )

  // DM-trigger (MYT-67 §4.3) — the ordered decision shell that runs when the
  // quiet-window debounce matures and enqueues at most one `session-turn`. Wired
  // HERE in the dedicated worker process. Takes the pg `Pool` (it builds its own
  // repo internally) plus both Redis connections; its `Queue` producers ride the
  // shared `redisBatch`, so they need no extra teardown beyond `redisBatch.quit()`.
  const dmTriggerWorker = buildDmTriggerWorker(
    redisBatch,
    redisRealtime,
    env.redisKeyPrefix,
    pg,
    logger,
  )

  // ST-evaluation (MYT-69) — the post-hoc narrative director, OFF the hot path.
  // Wired HERE in the dedicated worker process. Takes the pg Pool (builds its
  // own repo) + both Redis connections; its Queue producer rides redisBatch.
  const stEvaluationWorker = buildStEvaluationWorker(
    redisBatch,
    redisRealtime,
    env.redisKeyPrefix,
    pg,
    logger,
  )

  // Session-turn QueueEvents subscriber (MYT-67 §4.8) — the broker-side terminal
  // `turn_error` publisher that closes the `maxStalledCount`-exhaustion gap the
  // per-worker `on('failed')` listener can't see. It `duplicate()`s `redisBatch`
  // for a dedicated BRPOP blocking connection, so its `close()` MUST run on
  // shutdown (handled below) — that connection is NOT torn down by
  // `redisBatch.quit()`.
  const sessionTurnEvents = buildSessionTurnQueueEvents(
    redisBatch,
    redisRealtime,
    env.redisKeyPrefix,
    logger,
  )

  // Start health server last — only marks healthy once everything else is up.
  const healthPort = resolveHealthPort()
  const health = await startHealthServer(healthPort, {
    pg,
    redisBatch,
    redisRealtime,
    workers: [
      worldGenWorker,
      campaignSetupWorker,
      sessionPrepWorker,
      sessionTurnWorker,
      dmTriggerWorker,
      stEvaluationWorker,
    ],
  })

  logger.info(
    {
      event: 'worker.started',
      healthPort,
      queues: [
        QUEUE_WORLD_GEN,
        QUEUE_CAMPAIGN_SETUP,
        QUEUE_SESSION_PREP,
        QUEUE_SESSION_TURN,
        QUEUE_DM_TRIGGER,
        QUEUE_ST_EVAL,
      ],
    },
    'worker started',
  )

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ event: 'worker.shutting_down', signal }, 'worker stopping')

    await health.close().catch((err: unknown) => {
      logger.error({ err }, 'health server close failed')
    })

    await Promise.all([
      closeWithDeadline(worldGenWorker, WORKER_CLOSE_GRACE_MS),
      closeWithDeadline(campaignSetupWorker, WORKER_CLOSE_GRACE_MS),
      closeWithDeadline(sessionPrepWorker, WORKER_CLOSE_GRACE_MS),
      closeWithDeadline(sessionTurnWorker, WORKER_CLOSE_GRACE_MS),
      closeWithDeadline(dmTriggerWorker, WORKER_CLOSE_GRACE_MS),
      closeWithDeadline(stEvaluationWorker, WORKER_CLOSE_GRACE_MS),
    ])

    // Tear down the session-turn QueueEvents subscriber's dedicated blocking
    // connection (the duplicate()d redisBatch) — it is NOT covered by
    // redisBatch.quit() below, so skipping this leaks a connection per deploy.
    await sessionTurnEvents.close().catch((err: unknown) => {
      logger.error({ err }, 'session-turn queue-events close failed')
    })

    await pg.end().catch((err: unknown) => {
      logger.error({ err }, 'pg pool end failed')
    })

    await redisBatch.quit().catch(() => undefined)
    await redisRealtime.quit().catch(() => undefined)

    process.exit(0)
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal)
    })
  }

  await new Promise<never>(() => undefined)
}

async function closeWithDeadline(worker: BullmqWorker, deadlineMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      worker.close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`worker ${worker.name} close exceeded ${String(deadlineMs)}ms`))
        }, deadlineMs)
      }),
    ])
  } catch (err) {
    logger.error(
      { event: 'worker.close.deadline_exceeded', worker: worker.name, err },
      'worker close deadline exceeded; forcing close — in-flight jobs left as stalled',
    )
    await worker.close(true).catch(() => undefined)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntryPoint) {
  await main()
}
