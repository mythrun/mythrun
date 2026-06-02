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
import { makePipelinePublishers } from './worker/publishers.js'

const HEALTH_PORT = 3001
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

  // Start health server last — only marks healthy once everything else is up.
  const health = await startHealthServer(HEALTH_PORT, {
    pg,
    redisBatch,
    redisRealtime,
    workers: [worldGenWorker, campaignSetupWorker, sessionPrepWorker],
  })

  logger.info(
    {
      event: 'worker.started',
      healthPort: HEALTH_PORT,
      queues: [QUEUE_WORLD_GEN, QUEUE_CAMPAIGN_SETUP, QUEUE_SESSION_PREP],
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
    ])

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
