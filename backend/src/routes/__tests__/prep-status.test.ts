// backend/src/routes/__tests__/prep-status.test.ts
//
// MYT-62 Task 6. Integration tests for the player-facing SSE route
// GET /api/campaigns/:campaignId/prep-status — the "DM is preparing
// tonight's session…" loading-screen feed.
//
// The route is phase-ONLY by construction: it rides the existing
// `pipeline:campaign:{id}` channel (where prep-started / prep-ready /
// prep-failed phase events are published), and the Task-2 tripwire in
// pipeline-subscriber.ts drops any event whose `type` is not in
// PIPELINE_SSE_EVENTS. A `prep-delta` (sd_playbook prose) published on
// that channel — simulating a wiring bug — is dropped before it can reach
// a player sink. That tripwire is the structural enforced-ignorance
// guarantee this route depends on; the third test pins it.
//
// Harness mirrors campaigns-status.test.ts: buildApp against the real
// local Postgres + Redis, bypass-auth via x-mythrun-dev-sub, a separate
// publisher client (the realtime client is in PSUBSCRIBE mode via the
// subscriber duplicate). SSE assertions use payloadAsStream: true.
//
// Spec: docs/superpowers/plans/2026-05-21-... MYT-62 (T6).

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { buildApp } from '../../app.js'
import { createRedisClient } from '../../redis/client.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createRepo } from '../../repo/index.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import type { AppDeps } from '../../app-deps.js'
import { makeStubEnv } from '../../__tests__/helpers/stub-env.js'
import { noopWorldGenQueue } from '../../__tests__/helpers/stub-deps.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const FRONTEND_BASE_URL = 'http://localhost:5173'

const REDIS_KEY_PREFIX = `test:prep-status-${String(Date.now())}:`

// MVP: session 1 only (mirrors PREP_SESSION_NUMBER in campaigns.ts).
const PREP_SESSION_NUMBER = 1

interface SeededCampaign {
  campaignId: string
  userId: string
  devSub: string
}

describe('GET /api/campaigns/:campaignId/prep-status (MYT-62 T6)', () => {
  let pool: Pool
  let redis: Redis
  let publisher: Redis
  let app: Awaited<ReturnType<typeof buildApp>>
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('prep-status')

    const redisUrl = process.env.REDIS_REALTIME_URL ?? 'redis://127.0.0.1:6379'
    redis = createRedisClient(redisUrl)
    publisher = createRedisClient(redisUrl)
    await redis.connect()
    await publisher.connect()

    const repo = createRepo(pool)
    const deps: AppDeps = {
      pg: pool,
      redisRealtime: redis,
      redisBatch: redis,
      redisKeyPrefix: REDIS_KEY_PREFIX,
      repo,
      worldGenQueue: noopWorldGenQueue(),
    }
    app = await buildApp(
      deps,
      { mode: 'bypass' },
      {
        frontendBaseUrl: FRONTEND_BASE_URL,
        env: makeStubEnv({ frontendBaseUrl: FRONTEND_BASE_URL, redisKeyPrefix: REDIS_KEY_PREFIX }),
      },
    )
  })

  afterAll(async () => {
    app.mythrunStopPeriodicLog()
    await app.mythrunSubscriber.close()
    await app.close()
    await publisher.quit()
    await cleanupTestScope(pool, scope)
    await redis.quit()
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  async function seedCampaignWithMember(index = 0): Promise<SeededCampaign> {
    const userId = uuidv7()
    const devSub = scope.userSub(index)
    const worldId = uuidv7()
    const campaignId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, devSub, scope.displayName(index), scope.username(index)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept) VALUES ($1, $2, $3, 'C')`,
      [worldId, userId, scope.worldName(index)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name) VALUES ($1, $2, $3, $4)`,
      [campaignId, worldId, userId, scope.campaignName(index)],
    )
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'owner', true)`,
      [uuidv7(), campaignId, userId],
    )
    return { campaignId, userId, devSub }
  }

  // Drain the response stream until `marker` appears (resolving the
  // returned promise with the accumulated buffer), or until `timeoutMs`
  // elapses. A single 'data' listener keeps buffer ordering deterministic.
  function drainUntil(
    stream: NodeJS.ReadableStream,
    marker: string,
    timeoutMs: number,
  ): { buf: () => string; reached: Promise<string> } {
    let buf = ''
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
    }
    stream.on('data', onData)
    const reached = new Promise<string>((resolveReached) => {
      const check = (): void => {
        if (buf.includes(marker)) resolveReached(buf)
      }
      stream.on('data', check)
      setTimeout(() => {
        resolveReached(buf)
      }, timeoutMs)
    })
    return { buf: () => buf, reached }
  }

  it('emits snapshot {"status":"generating"} when no session_preps row exists', async () => {
    const { campaignId, devSub } = await seedCampaignWithMember()
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/prep-status`,
      headers: { 'x-mythrun-dev-sub': devSub },
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')

    const stream = res.stream()
    const { reached } = drainUntil(stream, 'event: snapshot', 2000)
    const collected = await reached
    expect(collected).toContain('event: snapshot')
    expect(collected).toContain('"status":"generating"')
    stream.destroy()
  })

  it('emits snapshot {"status":"ready"} when a session_preps row exists for (campaignId, 1)', async () => {
    const { campaignId, devSub } = await seedCampaignWithMember()
    const repo = createRepo(pool)
    await repo.sessionPreps.insert({
      campaignId,
      sessionNumber: PREP_SESSION_NUMBER,
      ftContext: 'public-ft-context',
      sdPlaybook: 'SECRET-PLAYBOOK',
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/prep-status`,
      headers: { 'x-mythrun-dev-sub': devSub },
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)

    const stream = res.stream()
    const { reached } = drainUntil(stream, 'event: snapshot', 2000)
    const collected = await reached
    expect(collected).toContain('"status":"ready"')
    // The snapshot is phase-only — the sd_playbook prose never appears.
    expect(collected).not.toContain('SECRET-PLAYBOOK')
    stream.destroy()
  })

  it('forwards published prep-started + prep-ready phase events', async () => {
    const { campaignId, devSub } = await seedCampaignWithMember()
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/prep-status`,
      headers: { 'x-mythrun-dev-sub': devSub },
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)
    const stream = res.stream()
    const { buf, reached: snapshotSeen } = drainUntil(stream, 'event: snapshot', 2000)
    await snapshotSeen

    // Sink is attached by the time the snapshot frame is written. Publish
    // both phase events on the pipeline:campaign: channel.
    const channel = `${REDIS_KEY_PREFIX}pipeline:campaign:${campaignId}`
    await publisher.publish(channel, JSON.stringify({ type: 'prep-started', sessionNumber: 1 }))
    await publisher.publish(
      channel,
      JSON.stringify({ type: 'prep-ready', sessionNumber: 1, costUsd: 0.12 }),
    )

    await new Promise<void>((resolveEvent) => {
      const check = (): void => {
        if (buf().includes('"prep-ready"')) resolveEvent()
      }
      stream.on('data', check)
      setTimeout(resolveEvent, 3000)
    })

    expect(buf()).toContain('"prep-started"')
    expect(buf()).toContain('"prep-ready"')
    stream.destroy()
  })

  it('tripwire: a prep-delta (sd_playbook prose) published on the pipeline channel is NOT forwarded', async () => {
    const { campaignId, devSub } = await seedCampaignWithMember()
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/prep-status`,
      headers: { 'x-mythrun-dev-sub': devSub },
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)
    const stream = res.stream()
    const { buf, reached: snapshotSeen } = drainUntil(stream, 'event: snapshot', 2000)
    await snapshotSeen

    const channel = `${REDIS_KEY_PREFIX}pipeline:campaign:${campaignId}`
    // Simulate a wiring bug: a prose event leaking onto the player channel.
    await publisher.publish(
      channel,
      JSON.stringify({ type: 'prep-delta', field: 'sd_playbook', text: 'LEAKED-SECRET' }),
    )
    // Publish an allowed phase event AFTER the forbidden one. When the
    // allowed frame arrives, the tripwire-dropped one has already been
    // processed (same channel, ordered delivery) — so its absence is a
    // real assertion, not a race against an in-flight message.
    await publisher.publish(channel, JSON.stringify({ type: 'prep-started', sessionNumber: 1 }))

    await new Promise<void>((resolveEvent) => {
      const check = (): void => {
        if (buf().includes('"prep-started"')) resolveEvent()
      }
      stream.on('data', check)
      setTimeout(resolveEvent, 3000)
    })

    expect(buf()).toContain('"prep-started"')
    expect(buf()).not.toContain('LEAKED-SECRET')
    expect(buf()).not.toContain('prep-delta')
    stream.destroy()
  })

  it('returns 403 for a non-member', async () => {
    const { campaignId } = await seedCampaignWithMember(0)
    const otherUserId = uuidv7()
    const otherSub = scope.userSub(1)
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [otherUserId, otherSub, scope.displayName(1), scope.username(1)],
    )
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/prep-status`,
      headers: { 'x-mythrun-dev-sub': otherSub },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_member' })
  })
})
