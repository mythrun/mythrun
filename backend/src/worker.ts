import { pathToFileURL } from 'node:url'
import { Worker as BullmqWorker, type Job } from 'bullmq'
import { waitFor } from './boot/wait-for.js'
import { loadEnv } from './config/env.js'
import { createPgPool } from './db/postgres.js'
import { createBullmqRedisClient } from './redis/bullmq-client.js'
import { createRedisClient } from './redis/client.js'
import {
  CONCURRENCY_CAMPAIGN_SETUP,
  CONCURRENCY_WORLD_GEN,
  QUEUE_CAMPAIGN_SETUP,
  QUEUE_WORLD_GEN,
} from './worker/bullmq-config.js'
import { makeStubProcessor } from './worker/stub-processor.js'
import { startHealthServer } from './worker/health-server.js'
import { logger } from './llm/logger.js'
import {
  createCharacterIntegrationProcessor,
  type CharacterIntegrationJobPayload,
} from './llm/prep/character-integration-processor.js'

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

  // Register BullMQ Workers. World-gen still routes through the stub at
  // boot — MYT-51/52 own its real processor wiring. campaign-setup is now
  // a router: 'character-integration' jobs hit the MYT-54 T11 processor;
  // everything else (including MYT-53's 'character-creation' until that
  // wiring lands) falls through to the stub so unrelated payloads still
  // succeed.
  const stubProcessor = makeStubProcessor(logger)
  const worldGenWorker = new BullmqWorker(QUEUE_WORLD_GEN, stubProcessor, {
    connection: redisBatch,
    concurrency: CONCURRENCY_WORLD_GEN,
  })

  const integrationProcessor = createCharacterIntegrationProcessor({
    pool: pg,
    // MYT-54 T11 placeholder publishEvent: the real Redis PUBLISH wiring
    // depends on MYT-53's character-creation processor sharing the same
    // SSE channel (`pipeline:campaign:${campaignId}`). Drop in the real
    // helper once that lands; logging here keeps boot-time events visible
    // in the worker stdout without coupling to the realtime client shape.
    publishEvent: (campaignId, event) => {
      logger.info(
        { event: 'worker.integration.publish_event', campaignId, payload: event },
        'character-integration event (placeholder publish)',
      )
      return Promise.resolve()
    },
  })

  const campaignSetupRouter = async (job: Job): Promise<void> => {
    if (job.name === 'character-integration') {
      await integrationProcessor(job as Job<CharacterIntegrationJobPayload>)
      return
    }
    await stubProcessor(job)
  }

  const campaignSetupWorker = new BullmqWorker(QUEUE_CAMPAIGN_SETUP, campaignSetupRouter, {
    connection: redisBatch,
    concurrency: CONCURRENCY_CAMPAIGN_SETUP,
  })

  // Start health server last — only marks healthy once everything else is up.
  const health = await startHealthServer(HEALTH_PORT, {
    pg,
    redisBatch,
    redisRealtime,
    workers: [worldGenWorker, campaignSetupWorker],
  })

  logger.info(
    {
      event: 'worker.started',
      healthPort: HEALTH_PORT,
      queues: [QUEUE_WORLD_GEN, QUEUE_CAMPAIGN_SETUP],
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
