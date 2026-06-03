import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { Queue, Worker, type Job } from 'bullmq'
import type {
  AppDeps,
} from './app-deps.js'
import {
  buildApp,
  createShutdown,
  type BullMqWorkerLike,
  type ShutdownHandler,
} from './app.js'
import type { RegisterAuthOptions } from './auth/index.js'
import { loadEnv, type Env } from './config/env.js'
import { installSignalHandlers } from './boot/signal-handlers.js'
import { installProcessErrorHandlers } from './boot/process-error-handlers.js'
import { probeMigrationsCurrent } from './boot/migrations-current.js'
import { waitFor } from './boot/wait-for.js'
import { createPgPool } from './db/postgres.js'
import { createRedisClient } from './redis/client.js'
import { createBullmqRedisClient } from './redis/bullmq-client.js'
import { createRepo } from './repo/index.js'
import { getStripeClient } from './billing/stripe-client.js'
import { probeStripeContract } from './billing/probe.js'
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
import { readCharacterCreationCostCap, readCostCap } from './llm/prep/cost-cap.js'
import {
  CONCURRENCY_CAMPAIGN_SETUP,
  CONCURRENCY_SESSION_PREP,
  CONCURRENCY_WORLD_GEN,
  QUEUE_CAMPAIGN_SETUP,
  QUEUE_SESSION_PREP,
  QUEUE_WORLD_GEN,
} from './worker/bullmq-config.js'
import {
  buildWorldGenQueue,
  buildCharacterCreationQueue,
  buildSessionPrepQueue,
  stubWorldGenQueue,
  stubCharacterCreationQueue,
  stubSessionPrepQueue,
} from './server-queues.js'
import type { Logger as PinoLogger } from 'pino'

// Build a RegisterAuthOptions from a loaded Env without emitting `undefined`
// fields explicitly — exactOptionalPropertyTypes forbids `userPoolId: undefined`
// against a `userPoolId?: string` signature.
function buildAuthOpts(env: Env): RegisterAuthOptions {
  const opts: RegisterAuthOptions = { mode: env.authMode }
  if (env.cognitoUserPoolId !== undefined) opts.userPoolId = env.cognitoUserPoolId
  if (env.cognitoAppClientId !== undefined) opts.appClientId = env.cognitoAppClientId
  if (env.cognitoIssuerUrl !== undefined) opts.issuerUrl = env.cognitoIssuerUrl
  if (env.cognitoHostedUiDomain !== undefined) opts.hostedUiDomain = env.cognitoHostedUiDomain
  return opts
}

/** Read both cost-cap settings rows at server boot. Workers stay stateless
 *  re. the settings table; an operator-edited cap requires a worker restart.
 *  Centralized here so main() doesn't blow its 100-line budget threading
 *  two parallel reads. */
async function readCostCapsAtBoot(pool: Pool): Promise<{
  worldGenCostCapUsd: number
  characterCreationCostCapUsd: number
}> {
  const [worldGenCostCapUsd, characterCreationCostCapUsd] = await Promise.all([
    readCostCap(pool),
    readCharacterCreationCostCap(pool),
  ])
  return { worldGenCostCapUsd, characterCreationCostCapUsd }
}

async function closePartials(
  pg: Pool | undefined,
  rTR: Redis | undefined,
  rTB: Redis | undefined,
): Promise<void> {
  await Promise.allSettled([
    pg ? pg.end() : Promise.resolve(),
    rTR ? rTR.quit() : Promise.resolve(),
    rTB ? rTB.quit() : Promise.resolve(),
  ])
}

// MYT-29 boot gate is opt-in. Default off so the deployed binary in
// staging/prod can stay at /health-only until Backend Core wires real
// schema/migrations + bootstrap-databases.sh sets the real RDS password
// (myth-ml8). Dev .env.development sets BOOT_GATE_ENABLED=1.
//
// Spec §3.7 ("this ticket does not yet exercise that path in prod") is
// honored by the default-off behavior; MYT-28's deploy pipeline stays
// green serving /health while the data-layer code path is dormant.
function bootGateEnabled(): boolean {
  const raw = process.env.BOOT_GATE_ENABLED ?? ''
  return raw === '1' || raw.toLowerCase() === 'true'
}

/** myth-epo4 T22 / MYT-53: build the world-gen Worker on a dedicated
 *  BullMQ-tuned ioredis connection. Extracted to keep main() under the
 *  100-line lint budget; mirrors buildCharacterCreationWorker below. */
async function buildWorldGenWorker(
  pool: Pool,
  redisRealtime: Redis,
  redisBatchUrl: string,
  redisKeyPrefix: string,
  logger: PinoLogger,
  costCapUsd: number,
  signal: AbortSignal,
): Promise<Worker> {
  const connection = createBullmqRedisClient(redisBatchUrl)
  await waitFor({
    label: 'Redis (worker bullmq)',
    probe: () => connection.ping(),
    signal,
  })
  return new Worker(
    QUEUE_WORLD_GEN,
    createWorldGenProcessor({ pool, redisRealtime, redisKeyPrefix, logger, costCapUsd }),
    { connection, concurrency: CONCURRENCY_WORLD_GEN },
  )
}

/** myth-epo4 T22 / MYT-53: build the character-creation Worker on a
 *  dedicated BullMQ-tuned ioredis connection. Extracted from main() so the
 *  boot orchestrator stays under the 100-line lint budget (this mirrors
 *  the rationale on buildWorldGenQueue). publishEvent is constructed here
 *  rather than inlined into the Worker call site so the channel-name +
 *  JSON-encode policy stays grep-friendly. */
async function buildCharacterCreationWorker(
  pool: Pool,
  redisRealtime: Redis,
  redisBatchUrl: string,
  redisKeyPrefix: string,
  costCapUsd: number,
  signal: AbortSignal,
): Promise<Worker> {
  const connection = createBullmqRedisClient(redisBatchUrl)
  await waitFor({
    label: 'Redis (worker bullmq cc)',
    probe: () => connection.ping(),
    signal,
  })
  // MYT-54 T20 fix: route on job.name so the campaign-setup queue serves
  // both 'character-creation' (per-player, MYT-53) and 'character-
  // integration' (campaign-scoped, MYT-54). Without this dispatch, an
  // integration job is silently swallowed by the character-creation
  // processor — it destructures the missing user_id, claims wrong stages
  // with user_id=NULL, and leaves pipeline_runs rows stuck `running`
  // while the campaign never flips to `active`. See dev-tool-verifier
  // smoke run on 2026-05-23 for the failure trace.
  const publishEvent = async (campaignId: string, event: Record<string, unknown>): Promise<void> => {
    const channel = `${redisKeyPrefix}pipeline:campaign:${campaignId}`
    await redisRealtime.publish(channel, JSON.stringify(event))
  }
  const characterCreationProcessor = createCharacterCreationProcessor({
    pool,
    costCapUsd,
    publishEvent,
  })
  const characterIntegrationProcessor = createCharacterIntegrationProcessor({
    pool,
    publishEvent,
  })
  return new Worker(
    QUEUE_CAMPAIGN_SETUP,
    async (job) => {
      if (job.name === 'character-integration') {
        await characterIntegrationProcessor(job as Job<CharacterIntegrationJobPayload>)
        return
      }
      await characterCreationProcessor(job as Job<CharacterCreationJobPayload>)
    },
    { connection, concurrency: CONCURRENCY_CAMPAIGN_SETUP },
  )
}

/** MYT-61 T4: build the session-prep Worker on a dedicated BullMQ-tuned
 *  ioredis connection. Mirrors buildWorldGenWorker / buildCharacterCreation-
 *  Worker. publishEvent is constructed here (same channel + JSON-encode policy
 *  as the other workers) so all worker-emitted events land on the single
 *  `pipeline:campaign:{id}` SSE channel. */
async function buildSessionPrepWorker(
  pool: Pool,
  redisRealtime: Redis,
  redisBatchUrl: string,
  redisKeyPrefix: string,
  signal: AbortSignal,
): Promise<Worker> {
  const connection = createBullmqRedisClient(redisBatchUrl)
  await waitFor({
    label: 'Redis (worker bullmq session-prep)',
    probe: () => connection.ping(),
    signal,
  })
  // Both channel formulas are single-sourced in worker/publishers.ts. The
  // dev-tool prose feed rides THIS in-process worker in dev, so publishProse
  // (the SEPARATE prep:campaign: channel; sd_playbook prose, never player-
  // facing) must be wired here too — not only in worker.ts.
  const { publishEvent, publishProse } = makePipelinePublishers(redisRealtime, redisKeyPrefix)
  return new Worker(
    QUEUE_SESSION_PREP,
    createSessionPrepProcessor({ pool, publishEvent, publishProse }),
    { connection, concurrency: CONCURRENCY_SESSION_PREP },
  )
}

/** MYT-61 T4: wrap the createShutdown handler to drain the session-prep
 *  worker + queue FIRST. createShutdown owns the existing drain chain and
 *  process.exit's at the end, so the session-prep pair can't be closed AFTER
 *  it; we close them up front (worker before queue — lets an in-flight Opus
 *  prep finish, then releases the queue's Redis bookkeeping) and delegate to
 *  the rest of the chain. Extracted so main() stays close to its line budget. */
function withSessionPrepShutdown(
  inner: ShutdownHandler,
  worker: Worker,
  queue: Queue,
): ShutdownHandler {
  return async (signal) => {
    await worker.close()
    await queue.close()
    await inner(signal)
  }
}

function stubBullMqWorker(): BullMqWorkerLike {
  return { close: () => Promise.resolve() }
}

async function fallbackStart(): Promise<void> {
  // Boot-gate-disabled path: equivalent to the MYT-28 entrypoint with
  // auth wiring layered on top (MYT-37). No client creation, no
  // data-layer probes — /health works, the auth plugin is registered so
  // future protected routes report 401 instead of 500, and everything
  // else is dormant until the boot gate is enabled.
  //
  // loadEnv() is still called: AUTH_MODE + Cognito vars are required to
  // build authOpts. The DB/Redis URLs it constructs go unused on this
  // path (the stub pool/redis below ignore them) but the env contract
  // remains a single source of truth.
  const env = loadEnv()
  const authOpts = buildAuthOpts(env)
  const stubPool = {
    end: () => Promise.resolve(),
    query: () => {
      throw new Error('repo unavailable: BOOT_GATE_ENABLED is off')
    },
  } as unknown as Pool
  const stubQueue = stubWorldGenQueue()
  const stubCharacterQueue = stubCharacterCreationQueue()
  const stubSessionPrep = stubSessionPrepQueue()
  const stubDeps: AppDeps = {
    pg: stubPool,
    redisRealtime: { quit: () => Promise.resolve('OK') } as unknown as Redis,
    redisBatch: { quit: () => Promise.resolve('OK') } as unknown as Redis,
    redisKeyPrefix: env.redisKeyPrefix,
    repo: createRepo(stubPool),
    worldGenQueue: stubQueue,
    characterCreationQueue: stubCharacterQueue,
    sessionPrepQueue: stubSessionPrep,
  }
  const app = await buildApp(stubDeps, authOpts, {
    frontendBaseUrl: env.frontendBaseUrl,
    env,
  })
  await app.listen({ port: env.port, host: '0.0.0.0' })
  const handleShutdown = createShutdown(app, {
    pg: stubDeps.pg,
    redisRealtime: stubDeps.redisRealtime,
    redisBatch: stubDeps.redisBatch,
    subscriber: app.mythrunSubscriber,
    stopPeriodicLog: app.mythrunStopPeriodicLog,
    worldGenWorker: stubBullMqWorker(),
    worldGenQueue: stubQueue,
    characterCreationWorker: stubBullMqWorker(),
    characterCreationQueue: stubCharacterQueue,
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void handleShutdown(signal))
  }
}

export async function main(): Promise<void> {
  if (!bootGateEnabled()) {
    await fallbackStart()
    return
  }

  // Signal handlers FIRST, before any resource creation. A SIGINT during
  // boot must close partial clients cleanly (see spec §9.7).
  const abortController = new AbortController()
  installSignalHandlers(abortController)

  let pg: Pool | undefined
  let rTR: Redis | undefined
  let rTB: Redis | undefined

  try {
    const env = loadEnv()
    pg = createPgPool(env.databaseUrl)
    rTR = createRedisClient(env.redisRealtimeUrl)
    rTB = createRedisClient(env.redisBatchUrl)

    // Capture local consts so the probe closures don't need non-null
    // assertions to satisfy strict TS narrowing.
    const pgRef = pg
    const rTRRef = rTR
    const rTBRef = rTB

    // myth-449j: install process-level error handlers as early as
    // possible after pg + rTR are constructed. They suppress Node 24's
    // default terminate-on-unhandled-rejection so we can soft-survive
    // a single failing BullMQ job under CONCURRENCY_WORLD_GEN=3 without
    // killing the two siblings. The handlers use the just-imported llm
    // logger so the structured-error frame goes through the same pino
    // instance that the rest of the app uses (pino.destination sync,
    // see backend/src/llm/logger.ts).
    const { logger: llmLogger } = await import('./llm/logger.js')
    installProcessErrorHandlers({
      pool: pgRef,
      redisRealtime: rTRRef,
      redisKeyPrefix: env.redisKeyPrefix,
      logger: llmLogger,
      exit: (code) => {
        process.exit(code)
      },
      now: Date.now,
    })

    // Sequential awaits per spec §7.10. Three local services starting
    // under `docker compose up -d --wait` reach healthy at the same
    // moment; sequential and parallel produce identical wall time.
    await waitFor({
      label: 'Postgres',
      probe: () => pgRef.query('SELECT 1'),
      signal: abortController.signal,
    })
    console.log('✓ Postgres ready')
    await waitFor({
      label: 'Redis (realtime)',
      probe: () => rTRRef.ping(),
      signal: abortController.signal,
    })
    console.log('✓ Redis (realtime) ready')
    await waitFor({
      label: 'Redis (batch)',
      probe: () => rTBRef.ping(),
      signal: abortController.signal,
    })
    console.log('✓ Redis (batch) ready')

    // Schema-readiness probe: refuse to start the API on a DB that has
    // not had every migration the image expects applied. The boot-gate
    // turns the throw into a non-zero process exit; ECS rolls back the
    // deploy. See docs/superpowers/specs/2026-05-11-migration-runner-design.md.
    await probeMigrationsCurrent(pgRef)
    console.log('✓ migrations-current verified')

    // MYT-41: Stripe contract verification. The probe lists the lookup_keys
    // in LOOKUP_KEYS, asserts each resolves to an active price with the
    // expected shape, and throws a typed error on mismatch / auth failure /
    // exhausted transient retries. The outer try/catch turns the throw into
    // a non-zero process exit; ECS rolls back the deploy.
    const stripeClient = getStripeClient(env)
    const probeLogger = console as unknown as import('pino').Logger
    await probeStripeContract(stripeClient, probeLogger)
    console.log('✓ Stripe contract verified')

    const repo = createRepo(pgRef)
    const authOpts = buildAuthOpts(env)

    // MYT-51 T12 + myth-epo4 T22 / MYT-53: BullMQ queues for world-gen +
    // character-creation. Queue connections share redisBatch (non-blocking
    // commands, fast-fail). Workers (built below after buildApp so they
    // can use app.log) each get their own BullMQ-tuned connection
    // (`maxRetriesPerRequest: null`, mirroring worker.ts).
    const { bullmqQueue, worldGenQueue } = buildWorldGenQueue(rTBRef)
    const { bullmqQueue: bullmqCharacterCreationQueue, characterCreationQueue } =
      buildCharacterCreationQueue(rTBRef)
    // MYT-61 T4 / MYT-63 T3: session-prep queue. The raw bullmqSessionPrepQueue
    // is closed at shutdown (after the worker drains); the sessionPrepQueue
    // adapter flows into AppDeps so the MYT-63 trigger route can enqueue.
    const { bullmqQueue: bullmqSessionPrepQueue, sessionPrepQueue } = buildSessionPrepQueue(rTBRef)

    const app = await buildApp(
      {
        pg: pgRef,
        redisRealtime: rTRRef,
        redisBatch: rTBRef,
        redisKeyPrefix: env.redisKeyPrefix,
        repo,
        worldGenQueue,
        characterCreationQueue,
        sessionPrepQueue,
      },
      authOpts,
      { frontendBaseUrl: env.frontendBaseUrl, env },
    )
    const caps = await readCostCapsAtBoot(pgRef)
    const worldGenWorker = await buildWorldGenWorker(
      pgRef, rTRRef, env.redisBatchUrl, env.redisKeyPrefix,
      app.log as PinoLogger, caps.worldGenCostCapUsd, abortController.signal,
    )
    const characterCreationWorker = await buildCharacterCreationWorker(
      pgRef, rTRRef, env.redisBatchUrl, env.redisKeyPrefix,
      caps.characterCreationCostCapUsd, abortController.signal,
    )
    const sessionPrepWorker = await buildSessionPrepWorker(
      pgRef, rTRRef, env.redisBatchUrl, env.redisKeyPrefix,
      abortController.signal,
    )

    await app.listen({ port: env.port, host: '0.0.0.0' })

    // MYT-61 T4: the session-prep worker + queue are drained ahead of the
    // existing chain via withSessionPrepShutdown (see that helper for the
    // worker-before-queue rationale).
    const innerShutdown = createShutdown(app, {
      pg: pgRef,
      redisRealtime: rTRRef,
      redisBatch: rTBRef,
      subscriber: app.mythrunSubscriber,
      stopPeriodicLog: app.mythrunStopPeriodicLog,
      worldGenWorker,
      // Pass the real BullMQ Queue here (not the WorldGenQueueLike
      // adapter, which has no close()) — shutdown needs the underlying
      // queue's close() to release its Redis-side connection bookkeeping.
      worldGenQueue: bullmqQueue,
      characterCreationWorker,
      // Same rationale as worldGenQueue: shutdown needs the raw BullMQ
      // Queue's close(), not the CharacterCreationQueueLike adapter.
      characterCreationQueue: bullmqCharacterCreationQueue,
    })
    // Pass the raw BullMQ Queue (bullmqSessionPrepQueue), not the
    // SessionPrepQueueLike adapter — shutdown needs the underlying queue's close().
    const handleShutdown = withSessionPrepShutdown(
      innerShutdown, sessionPrepWorker, bullmqSessionPrepQueue,
    )
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => void handleShutdown(signal))
    }
  } catch (err) {
    console.error('✗ Boot gate failed:', err instanceof Error ? err.message : err)
    await closePartials(pg, rTR, rTB)
    // Watchdog: if any client kept the event loop alive past closePartials,
    // force-exit. unref() so this doesn't block exit when cleanup succeeds.
    setTimeout(() => {
      process.exit(1)
    }, 5000).unref()
    process.exitCode = 1
  }
}

await main()
