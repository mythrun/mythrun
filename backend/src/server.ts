import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { AppDeps } from './app-deps.js'
import { buildApp, createShutdown } from './app.js'
import type { RegisterAuthOptions } from './auth/index.js'
import { loadEnv, type Env } from './config/env.js'
import { installSignalHandlers } from './boot/signal-handlers.js'
import { waitFor } from './boot/wait-for.js'
import { createPgPool } from './db/postgres.js'
import { createRedisClient } from './redis/client.js'
import { createRepo } from './repo/index.js'
import { getStripeClient } from './billing/stripe-client.js'
import { probeStripeContract } from './billing/probe.js'

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
  const stubDeps: AppDeps = {
    pg: stubPool,
    redisRealtime: { quit: () => Promise.resolve('OK') } as unknown as Redis,
    redisBatch: { quit: () => Promise.resolve('OK') } as unknown as Redis,
    repo: createRepo(stubPool),
  }
  const app = await buildApp(stubDeps, authOpts, {
    frontendBaseUrl: env.frontendBaseUrl,
    env,
  })
  await app.listen({ port: env.port, host: '0.0.0.0' })
  const handleShutdown = createShutdown(app, stubDeps)
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
    const app = await buildApp(
      { pg: pgRef, redisRealtime: rTRRef, redisBatch: rTBRef, repo },
      authOpts,
      { frontendBaseUrl: env.frontendBaseUrl, env },
    )
    await app.listen({ port: env.port, host: '0.0.0.0' })

    const handleShutdown = createShutdown(app, {
      pg: pgRef,
      redisRealtime: rTRRef,
      redisBatch: rTBRef,
    })
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => void handleShutdown(signal))
    }
  } catch (err) {
    console.error('✗ Boot gate failed:', err instanceof Error ? err.message : err)
    await closePartials(pg, rTR, rTB)
    // Watchdog: if any client kept the event loop alive past closePartials,
    // force-exit. unref() so this doesn't block exit when cleanup succeeds.
    setTimeout(() => { process.exit(1) }, 5000).unref()
    process.exitCode = 1
  }
}

await main()
