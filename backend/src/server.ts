import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { Queue, Worker, type JobType } from 'bullmq'
import type {
  AppDeps,
} from './app-deps.js'
import {
  buildApp,
  createShutdown,
  type WorldGenQueueShutdown,
  type WorldGenWorkerLike,
} from './app.js'
import type { RegisterAuthOptions } from './auth/index.js'
import { loadEnv, type Env } from './config/env.js'
import { installSignalHandlers } from './boot/signal-handlers.js'
import { probeMigrationsCurrent } from './boot/migrations-current.js'
import { waitFor } from './boot/wait-for.js'
import { createPgPool } from './db/postgres.js'
import { createRedisClient } from './redis/client.js'
import { createBullmqRedisClient } from './redis/bullmq-client.js'
import { createRepo } from './repo/index.js'
import { getStripeClient } from './billing/stripe-client.js'
import { probeStripeContract } from './billing/probe.js'
import { createWorldGenProcessor } from './llm/prep/world-gen-processor.js'
import { CONCURRENCY_WORLD_GEN, QUEUE_WORLD_GEN } from './worker/bullmq-config.js'
import type { WorldGenQueueLike } from './routes/campaigns.js'
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

/** MYT-51 T12: build the world-gen BullMQ queue + its plugin-facing
 *  adapter. Extracted from main() so the boot orchestrator stays under
 *  the 100-line lint budget. Returns the raw `bullmqQueue` (for
 *  shutdown.close) AND the `WorldGenQueueLike` adapter that bridges
 *  campaigns.ts's contract to BullMQ's variadic `getJobCounts` API. */
function buildWorldGenQueue(redisBatch: Redis): {
  bullmqQueue: Queue
  worldGenQueue: WorldGenQueueLike
} {
  // SHOWSTOPPER fix from Hydra-C2 / spec D9:
  //   `removeOnComplete: { count: 0 } + removeOnFail: { count: 0 }` —
  //   BullMQ keeps terminal jobs permanently by default; with their
  //   jobIds still in the dedupe set, our resume flow's
  //   `queue.add(..., { jobId: campaignId })` silently no-ops on a
  //   completed/failed job. The { count: 0 } config prunes terminal
  //   jobs so resume's enqueue contract holds.
  //
  // MYT-52 T1: `attempts: 2 + exponential backoff (30s)` — BullMQ's
  // default is `attempts: 1` (no retries), which makes every "BullMQ
  // retries the stage" recovery path in the MYT-52 design's §7.2 error
  // matrix (transient API, persistence COMMIT, repair-chain exhausted,
  // max-tokens truncation, in-stream error) fictional. The retry budget
  // here is the surface those paths rely on.
  const bullmqQueue = new Queue(QUEUE_WORLD_GEN, {
    connection: redisBatch,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: { count: 0 },
      removeOnFail: { count: 0 },
    },
  })
  // Adapter from the campaigns plugin's WorldGenQueueLike contract
  // (which takes states as a readonly string[]) to BullMQ Queue's real
  // `getJobCounts(...types)` variadic signature.
  const worldGenQueue: WorldGenQueueLike = {
    add: (name, data, opts) => bullmqQueue.add(name, data, opts),
    // The contract types `states` as readonly string[]; BullMQ's
    // getJobCounts narrows to JobType[]. Cast at this single boundary
    // — caller-supplied values come from the route handler, which
    // hardcodes 'waiting'/'active'/'delayed' (all valid JobType).
    getJobCounts: (states) => bullmqQueue.getJobCounts(...(states as JobType[])),
    getJob: (jobId) => bullmqQueue.getJob(jobId),
  }
  return { bullmqQueue, worldGenQueue }
}

// Stub queue/worker for the boot-gate-disabled fallback path. The fallback
// never connects to Redis, so we can't construct real BullMQ handles; the
// app-deps + shutdown contracts both expect a non-undefined value, so
// supply shape-conforming no-ops. None of the routes that USE the queue
// are reachable on the fallback path (no DB, requireOnboarded 500s), so
// `add` returning a rejected promise is operator-safe.
function stubWorldGenQueue(): WorldGenQueueLike & WorldGenQueueShutdown {
  return {
    add: () => Promise.reject(new Error('queue unavailable: BOOT_GATE_ENABLED is off')),
    getJobCounts: () => Promise.resolve({}),
    getJob: () => Promise.resolve(null),
    close: () => Promise.resolve(),
  }
}

function stubWorldGenWorker(): WorldGenWorkerLike {
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
  const stubDeps: AppDeps = {
    pg: stubPool,
    redisRealtime: { quit: () => Promise.resolve('OK') } as unknown as Redis,
    redisBatch: { quit: () => Promise.resolve('OK') } as unknown as Redis,
    redisKeyPrefix: env.redisKeyPrefix,
    repo: createRepo(stubPool),
    worldGenQueue: stubQueue,
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
    worldGenWorker: stubWorldGenWorker(),
    worldGenQueue: stubQueue,
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

    // MYT-51 T12: world-gen BullMQ queue + worker.
    //
    // Queue connection uses redisBatch directly (non-blocking commands;
    // fast-fail `maxRetriesPerRequest: 1` is fine). Worker requires
    // `maxRetriesPerRequest: null` (BullMQ contract — BRPOPLPUSH must
    // not have a retry ceiling); build a dedicated BullMQ-compatible
    // connection from the same URL, mirroring worker.ts's pattern.
    const { bullmqQueue, worldGenQueue } = buildWorldGenQueue(rTBRef)
    const worldGenWorkerRedis = createBullmqRedisClient(env.redisBatchUrl)
    await waitFor({
      label: 'Redis (worker bullmq)',
      probe: () => worldGenWorkerRedis.ping(),
      signal: abortController.signal,
    })

    const app = await buildApp(
      {
        pg: pgRef,
        redisRealtime: rTRRef,
        redisBatch: rTBRef,
        redisKeyPrefix: env.redisKeyPrefix,
        repo,
        worldGenQueue,
      },
      authOpts,
      { frontendBaseUrl: env.frontendBaseUrl, env },
    )
    const worldGenWorker: Worker = new Worker(
      QUEUE_WORLD_GEN,
      createWorldGenProcessor({
        pool: pgRef,
        redisRealtime: rTRRef,
        redisKeyPrefix: env.redisKeyPrefix,
        logger: app.log as PinoLogger,
      }),
      {
        connection: worldGenWorkerRedis,
        concurrency: CONCURRENCY_WORLD_GEN,
      },
    )

    await app.listen({ port: env.port, host: '0.0.0.0' })

    const handleShutdown = createShutdown(app, {
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
    })
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
