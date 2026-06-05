// MYT-50 cross-process SSE integration test.
//
// Boots TWO `buildApp()` instances against the SAME dev Redis with the same
// `redisKeyPrefix`. Instance A hosts the SSE attachment; a SEPARATE publisher
// connection (third ioredis client) publishes a phase event. The test asserts
// instance A's SSE stream forwards the event — proving the in-memory
// `Map<campaignId, Set<SseSink>>` fans messages out from a real PSUBSCRIBE
// rather than something accidentally process-scoped that would break a
// multi-task ECS deployment.
//
// Mirrors `rate-limit-cross-worker.test.ts` for the dual-app boot pattern,
// and `routes/__tests__/campaigns-status.test.ts` (Task 7) for the auth +
// SSE drain pattern. Each app gets its own ioredis client; both share one
// Redis URL + key prefix. The publisher is a third distinct connection —
// closer to the production layout where workers publish from their own
// connections.
//
// Spec: docs/superpowers/specs/2026-05-12-myt-50-pipeline-status-surface-design.md
// Plan: docs/superpowers/plans/2026-05-12-myt-50-pipeline-status-surface.md §Task 9

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { buildApp } from '../app.js'
import { createPgPool } from '../db/postgres.js'
import { createRedisClient } from '../redis/client.js'
import { guardTestDatabase } from '../db/__tests__/guard-db.js'
import { createRepo } from '../repo/index.js'
import { uuidv7 } from '../repo/uuidv7.js'
import type { AppDeps } from '../app-deps.js'
import { makeStubEnv } from './helpers/stub-env.js'
import {
  noopWorldGenQueue,
  noopSessionPrepQueue,
  noopSessionSuspendQueue,
  noopSessionTurnQueue,
} from './helpers/stub-deps.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const FRONTEND_BASE_URL = 'http://localhost:5173'

// Unique per-test-run prefix so re-runs / parallel CI lanes don't observe
// each other's pub/sub traffic. Both buildApp instances MUST share this
// prefix so the publisher's channel name matches instance A's PSUBSCRIBE
// pattern. Channel format: `${prefix}pipeline:campaign:${campaignId}` —
// see `backend/src/sse/pipeline-subscriber.ts`.
const REDIS_KEY_PREFIX = `test:xprc-${String(Date.now())}:`

describe('pipeline status cross-process', () => {
  let pool: Pool
  let redisA: Redis
  let redisB: Redis
  let publisher: Redis
  let appA: Awaited<ReturnType<typeof buildApp>>
  let appB: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })

    // Three distinct ioredis connections pointed at the same Redis URL.
    // Each buildApp instance holds its own connection — mirrors prod where
    // each ECS task has its own connection to the shared ElastiCache
    // cluster. The publisher is a third client so the test exercises a
    // worker-style publish (different process / different connection)
    // rather than reusing the API client.
    const redisUrl = process.env.REDIS_REALTIME_URL ?? 'redis://127.0.0.1:6379'
    redisA = createRedisClient(redisUrl)
    redisB = createRedisClient(redisUrl)
    publisher = createRedisClient(redisUrl)
    await redisA.connect()
    await redisB.connect()
    await publisher.connect()

    const repo = createRepo(pool)

    const depsA: AppDeps = {
      pg: pool,
      redisRealtime: redisA,
      // batch is unused by the routes under test; reuse the realtime
      // client so we don't open extra connections.
      redisBatch: redisA,
      redisKeyPrefix: REDIS_KEY_PREFIX,
      repo,
      worldGenQueue: noopWorldGenQueue(),
      sessionPrepQueue: noopSessionPrepQueue(),
      sessionSuspendQueue: noopSessionSuspendQueue(),
      sessionTurnQueue: noopSessionTurnQueue(),
    }
    const depsB: AppDeps = { ...depsA, redisRealtime: redisB, redisBatch: redisB }

    appA = await buildApp(
      depsA,
      { mode: 'bypass' },
      {
        frontendBaseUrl: FRONTEND_BASE_URL,
        env: makeStubEnv({ frontendBaseUrl: FRONTEND_BASE_URL, redisKeyPrefix: REDIS_KEY_PREFIX }),
      },
    )
    appB = await buildApp(
      depsB,
      { mode: 'bypass' },
      {
        frontendBaseUrl: FRONTEND_BASE_URL,
        env: makeStubEnv({ frontendBaseUrl: FRONTEND_BASE_URL, redisKeyPrefix: REDIS_KEY_PREFIX }),
      },
    )
  })

  afterAll(async () => {
    // The subscriber's dedicated PSUBSCRIBE client is closed via
    // `mythrunSubscriber.close()` — without that, the duplicate ioredis
    // client keeps the event loop alive past test teardown and vitest
    // hangs. Same pattern as campaigns-status.test.ts.
    appA.mythrunStopPeriodicLog()
    appB.mythrunStopPeriodicLog()
    await appA.mythrunSubscriber.close()
    await appB.mythrunSubscriber.close()
    await appA.close()
    await appB.close()
    await publisher.quit()
    await redisA.quit()
    await redisB.quit()
    await pool.end()
  })

  it('SSE attached to instance A receives an event published by an external publisher', async () => {
    // Seed the FK chain: user → world → campaign → campaign_member.
    // The bypass-plugin reads `x-mythrun-dev-sub` and sets request.user.sub
    // to that value; requireOnboarded then looks up users by cognito_sub.
    // Putting the same string in the users row + the request header is what
    // makes this user "known" to the auth chain.
    const userId = uuidv7()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    const devSub = `bypass:xprc-${userId.slice(-6)}`
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, devSub, 'X', `x${userId.slice(-6)}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept) VALUES ($1, $2, 'W', 'C')`,
      [worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name) VALUES ($1, $2, $3, 'C')`,
      [campaignId, worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'owner', true)`,
      [uuidv7(), campaignId, userId],
    )

    // Attach SSE on instance A.
    const res = await appA.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status/stream`,
      headers: { 'x-mythrun-dev-sub': devSub },
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)
    const contentType = res.headers['content-type']
    expect(typeof contentType).toBe('string')
    expect(contentType).toContain('text/event-stream')

    const stream = res.stream()

    // Two-phase drain: single listener for the whole test, append into a
    // shared buffer, resolve once we observe the snapshot frame (sink is
    // attached at that point) — then publish — then resolve again on the
    // live event. One listener keeps buffer ordering deterministic and
    // prevents data-loss between phases. Mirrors campaigns-status.test.ts.
    let buf = ''
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
    }
    stream.on('data', onData)

    await new Promise<void>((resolveSnapshot) => {
      const check = (): void => {
        if (buf.includes('event: snapshot')) resolveSnapshot()
      }
      stream.on('data', check)
      // Safety: if the snapshot never arrives, surface a clear failure
      // downstream rather than hang vitest. Keepalive is 15s, so nothing
      // else can show up in <2s.
      setTimeout(resolveSnapshot, 2000)
    })
    expect(buf).toContain('event: snapshot')

    // Publish via the SEPARATE publisher connection — i.e. a connection
    // neither buildApp instance owns. If instance A's in-memory subscriber
    // map were accidentally process-scoped (e.g. waiting on its own
    // command-mode client to publish locally), this event would never
    // reach the SSE sink. The fan-out only works because instance A's
    // PSUBSCRIBE on the shared Redis sees the publish from a third party.
    await publisher.publish(
      `${REDIS_KEY_PREFIX}pipeline:campaign:${campaignId}`,
      JSON.stringify({ type: 'phase', phase: 'world_gen' }),
    )

    await new Promise<void>((resolveEvent) => {
      const check = (): void => {
        if (buf.includes('"phase":"world_gen"')) resolveEvent()
      }
      stream.on('data', check)
      // 3s: publish round-trip + PSUBSCRIBE dispatch is observably ~50ms
      // locally but can spike under CI load. Matches the budget in
      // campaigns-status.test.ts step 4.
      setTimeout(resolveEvent, 3000)
    })

    expect(buf).toContain('"phase":"world_gen"')
    stream.off('data', onData)
    stream.destroy()
  })
})
