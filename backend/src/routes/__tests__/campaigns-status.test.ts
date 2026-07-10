// backend/src/routes/__tests__/campaigns-status.test.ts
//
// Integration tests for the campaigns status + SSE stream routes.
// Boots `buildApp` against the real local Postgres + Redis (mirrors
// `rate-limit-per-sub.test.ts`) so the full auth + access-control +
// rate-limit + onboarded chain exercises end-to-end. The bypass-auth
// plugin's `x-mythrun-dev-sub` header lets each test pin its own user
// without collapsing onto the default bypass:dev-1.
//
// Spec: docs/superpowers/specs/2026-05-12-myt-50-pipeline-status-surface.md
// Plan: docs/superpowers/plans/2026-05-12-myt-50-pipeline-status-surface.md §Task 6 step 1
//
// SSE assertions use `payloadAsStream: true` so app.inject returns a
// readable response stream. The 4th test publishes via a separate
// ioredis client (not the buildApp realtime client — that one is in
// PSUBSCRIBE mode via the dedicated subscriber duplicate, but publishing
// from the same connection would still race with subscriber readiness
// in CI). A separate client is also closer to the production layout
// where workers publish from their own connections.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { buildApp } from '../../app.js'
import { createRedisClient } from '../../redis/client.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createRepo } from '../../repo/index.js'
import { entities } from '../../repo/entities.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import type { AppDeps } from '../../app-deps.js'
import { makeStubEnv } from '../../__tests__/helpers/stub-env.js'
import {
  noopWorldGenQueue,
  noopSessionPrepQueue,
  noopSessionSuspendQueue,
  noopSessionTurnQueue,
  noopDmTriggerQueue,
  noopSessionReconcileQueue,
} from '../../__tests__/helpers/stub-deps.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const FRONTEND_BASE_URL = 'http://localhost:5173'

const REDIS_KEY_PREFIX = `test:campaigns-status-${String(Date.now())}:`

interface SeededCampaign {
  campaignId: string
  userId: string
  devSub: string
}

describe('campaigns status routes', () => {
  let pool: Pool
  let redis: Redis
  let publisher: Redis
  let app: Awaited<ReturnType<typeof buildApp>>
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('camp-status')

    const redisUrl = process.env.REDIS_REALTIME_URL ?? 'redis://127.0.0.1:6379'
    redis = createRedisClient(redisUrl)
    publisher = createRedisClient(redisUrl)
    await redis.connect()
    await publisher.connect()

    const repo = createRepo(pool)
    const deps: AppDeps = {
      pg: pool,
      redisRealtime: redis,
      // batch is unused by the routes under test; reuse the realtime
      // client so we don't open a third connection.
      redisBatch: redis,
      redisKeyPrefix: REDIS_KEY_PREFIX,
      repo,
      worldGenQueue: noopWorldGenQueue(),
      sessionPrepQueue: noopSessionPrepQueue(),
      sessionSuspendQueue: noopSessionSuspendQueue(),
      sessionTurnQueue: noopSessionTurnQueue(),
      dmTriggerQueue: noopDmTriggerQueue(),
      sessionReconcileQueue: noopSessionReconcileQueue(),
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
    // app.close stops HTTP; the subscriber's dedicated PSUBSCRIBE client
    // is closed via app.mythrunSubscriber.close() — without that, the
    // duplicate ioredis client keeps the event loop alive past test
    // teardown and vitest hangs.
    app.mythrunStopPeriodicLog()
    await app.mythrunSubscriber.close()
    await app.close()
    await publisher.quit()
    await cleanupTestScope(pool, scope)
    await redis.quit()
    await pool.end()
  })

  beforeEach(async () => {
    // myth-5jdo: scoped cleanup replaces blanket DELETEs.
    await cleanupTestScope(pool, scope)
  })

  async function seedCampaignWithMember(index = 0): Promise<SeededCampaign> {
    const userId = uuidv7()
    // The bypass-plugin reads `x-mythrun-dev-sub` and sets request.user.sub
    // to that value; requireOnboarded then looks up users by cognito_sub.
    // Putting the same string in the users row + the request header is what
    // makes this user "known" to the auth chain.
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

  it('GET /api/campaigns/:campaignId/status returns 200 with snapshot for a member', async () => {
    const { campaignId, devSub } = await seedCampaignWithMember()
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status`,
      headers: { 'x-mythrun-dev-sub': devSub },
    })
    expect(res.statusCode).toBe(200)
    const body: {
      phase: string
      stages: readonly unknown[]
      cumulativeCostUsd: number
    } = res.json()
    expect(body.phase).toBe('not_started')
    expect(body.stages).toEqual([])
    expect(body.cumulativeCostUsd).toBe(0)
  })

  // myth-zeiw: per-stage timing on the wire. Status surface must
  // include startedAt + completedAt (ISO-8601 strings) on each
  // pipeline_runs row so the dev-tool can compute a live count-up
  // duration for running stages and a fixed duration for completed
  // ones. Both timestamps are sourced from pipeline_runs.started_at /
  // completed_at.
  it('GET /api/campaigns/:campaignId/status emits startedAt + completedAt per stage', async () => {
    const { campaignId, devSub, userId } = await seedCampaignWithMember()
    // Seed one completed worldgen row + one running worldgen row.
    // user_id IS NULL for worldgen stages — owner attribution lives
    // on the campaign row, not the pipeline_runs row.
    const worldRow = await pool.query<{ world_id: string }>(
      `SELECT world_id FROM campaigns WHERE id = $1`,
      [campaignId],
    )
    const worldId = worldRow.rows[0]?.world_id
    if (typeof worldId !== 'string') throw new Error('expected world row')
    const startedCompleted = new Date('2026-05-12T00:00:00.000Z')
    const endCompleted = new Date('2026-05-12T00:00:42.000Z')
    const startedRunning = new Date('2026-05-12T00:01:00.000Z')
    await pool.query(
      `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, completed_at, cost_usd, user_id)
       VALUES ($1, $2, 'concept_intake', 'completed', $3, $4, 0.0042, NULL),
              ($5, $2, 'world_and_factions', 'running', $6, NULL, 0, NULL)`,
      [uuidv7(), worldId, startedCompleted, endCompleted, uuidv7(), startedRunning],
    )
    void userId
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status`,
      headers: { 'x-mythrun-dev-sub': devSub },
    })
    expect(res.statusCode).toBe(200)
    interface WireStage {
      stage: string
      status: string
      startedAt: string | null
      completedAt: string | null
    }
    const body: { stages: readonly WireStage[] } = res.json()
    const completed = body.stages.find((s) => s.stage === 'concept_intake')
    const running = body.stages.find((s) => s.stage === 'world_and_factions')
    if (!completed) throw new Error('expected concept_intake row')
    if (!running) throw new Error('expected world_and_factions row')
    expect(completed.startedAt).toBe(startedCompleted.toISOString())
    expect(completed.completedAt).toBe(endCompleted.toISOString())
    expect(running.startedAt).toBe(startedRunning.toISOString())
    expect(running.completedAt).toBeNull()
  })

  it('GET /api/campaigns/:campaignId/status returns 403 for non-members', async () => {
    const { campaignId } = await seedCampaignWithMember(0)
    const otherUserId = uuidv7()
    const otherSub = scope.userSub(1)
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [otherUserId, otherSub, scope.displayName(1), scope.username(1)],
    )
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status`,
      headers: { 'x-mythrun-dev-sub': otherSub },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_member' })
  })

  it('GET /api/campaigns/:campaignId/status/stream returns text/event-stream + initial snapshot frame', async () => {
    const { campaignId, devSub } = await seedCampaignWithMember()
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status/stream`,
      headers: { 'x-mythrun-dev-sub': devSub },
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)
    const contentType = res.headers['content-type']
    expect(typeof contentType).toBe('string')
    expect(contentType).toContain('text/event-stream')

    // Drain until we see the snapshot frame, with a 2s wall-clock safety
    // net so a never-arriving frame fails the test loudly rather than
    // hanging vitest. The keepalive interval is 15s, so the only thing
    // that can arrive in <2s is the snapshot frame the handler writes
    // right after attaching the sink.
    const stream = res.stream()
    const collected = await new Promise<string>((resolveCollected) => {
      let buf = ''
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf8')
        if (buf.includes('event: snapshot')) {
          stream.off('data', onData)
          resolveCollected(buf)
        }
      }
      stream.on('data', onData)
      setTimeout(() => {
        stream.off('data', onData)
        resolveCollected(buf)
      }, 2000)
    })
    expect(collected).toContain('event: snapshot')
    expect(collected).toContain('"phase":"not_started"')
    stream.destroy()
  })

  it('SSE snapshot frame carries the KNOWN-TIER gen-seed for a generating world (myth-gcsp1)', async () => {
    // A mid-gen refresh must return to a populated graph. The connect frame widens
    // with the known-tier entities/relationships so far; a secret entity + a secret
    // connection between two known entities must NOT appear (tier discipline —
    // exactly what the live stream already withheld).
    const { campaignId, devSub } = await seedCampaignWithMember()
    const worldRow = await pool.query<{ world_id: string }>(
      `SELECT world_id FROM campaigns WHERE id = $1`,
      [campaignId],
    )
    const worldId = worldRow.rows[0]?.world_id
    if (typeof worldId !== 'string') throw new Error('expected world row')
    // A running worldgen stage → phase computes to `world_gen` (a gen-seed phase).
    await pool.query(
      `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, cost_usd, user_id)
       VALUES ($1, $2, 'world_and_factions', 'running', now(), 0, NULL)`,
      [uuidv7(), worldId],
    )
    const known1 = uuidv7()
    const known2 = uuidv7()
    const secret = uuidv7()
    await entities.insert(pool, {
      id: known1, worldId, entityType: 'faction',
      name: `${scope.id}-KnownCourt`, accessLevel: 'known', createdIn: 'stage:test',
    })
    await entities.insert(pool, {
      id: known2, worldId, entityType: 'location',
      name: `${scope.id}-KnownKeep`, accessLevel: 'known', createdIn: 'stage:test',
    })
    await entities.insert(pool, {
      id: secret, worldId, entityType: 'npc',
      name: `${scope.id}-SecretMole`, accessLevel: 'secret', createdIn: 'stage:test',
    })
    await pool.query(
      `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description, access_level)
       VALUES ($1, $2, $3, 'allies_with', 'd', 'known'),
              ($4, $2, $3, 'secretly_controls', 'd', 'secret')`,
      [uuidv7(), known1, known2, uuidv7()],
    )

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status/stream`,
      headers: { 'x-mythrun-dev-sub': devSub },
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)
    const stream = res.stream()
    const collected = await new Promise<string>((resolveCollected) => {
      let buf = ''
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf8')
        if (buf.includes('event: snapshot')) {
          stream.off('data', onData)
          resolveCollected(buf)
        }
      }
      stream.on('data', onData)
      setTimeout(() => {
        stream.off('data', onData)
        resolveCollected(buf)
      }, 2000)
    })
    stream.destroy()

    const dataLine = collected.split('\n').find((l) => l.startsWith('data:'))
    if (dataLine === undefined) throw new Error('no snapshot data line')
    const parsed: unknown = JSON.parse(dataLine.slice('data:'.length).trim())
    const frame = parsed as {
      phase: string
      entities?: readonly { id: string; entityType: string; name: string }[]
      relationships?: readonly {
        sourceEntityId: string
        targetEntityId: string
        relationshipType: string
      }[]
    }

    expect(frame.phase).toBe('world_gen')
    // Known-tier entities present; the secret one withheld.
    const names = (frame.entities ?? []).map((e) => e.name)
    expect(names).toContain(`${scope.id}-KnownCourt`)
    expect(names).toContain(`${scope.id}-KnownKeep`)
    expect(names).not.toContain(`${scope.id}-SecretMole`)
    // Exactly the known→known @ known edge — the secret connection is withheld.
    expect(frame.relationships).toHaveLength(1)
    expect(frame.relationships?.[0]).toMatchObject({
      sourceEntityId: known1,
      targetEntityId: known2,
      relationshipType: 'allies_with',
    })
  })

  it('SSE snapshot frame OMITS the gen-seed for a not-yet-started world (no wasted composition)', async () => {
    // not_started → outside the gen-seed window: the connect frame stays lean
    // (no entities/relationships keys), so the FE's resumedMidGen stays false and
    // the deliberate loading beat is preserved.
    const { campaignId, devSub } = await seedCampaignWithMember()
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status/stream`,
      headers: { 'x-mythrun-dev-sub': devSub },
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)
    const stream = res.stream()
    const collected = await new Promise<string>((resolveCollected) => {
      let buf = ''
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf8')
        if (buf.includes('event: snapshot')) {
          stream.off('data', onData)
          resolveCollected(buf)
        }
      }
      stream.on('data', onData)
      setTimeout(() => {
        stream.off('data', onData)
        resolveCollected(buf)
      }, 2000)
    })
    stream.destroy()

    const dataLine = collected.split('\n').find((l) => l.startsWith('data:'))
    if (dataLine === undefined) throw new Error('no snapshot data line')
    const parsed: unknown = JSON.parse(dataLine.slice('data:'.length).trim())
    const frame = parsed as Record<string, unknown>
    expect(frame.phase).toBe('not_started')
    expect('entities' in frame).toBe(false)
    expect('relationships' in frame).toBe(false)
  })

  it('SSE stream forwards a published phase event', async () => {
    const { campaignId, devSub } = await seedCampaignWithMember()
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status/stream`,
      headers: { 'x-mythrun-dev-sub': devSub },
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)
    const stream = res.stream()

    // Two-phase drain: collect everything; resolve once the snapshot
    // frame arrives (sink is attached at that point); publish; resolve
    // again once the live event arrives. Single listener keeps buffer
    // ordering deterministic and prevents data-loss between phases.
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
      // Safety: if the snapshot never arrives, fail downstream rather
      // than hang. The keepalive interval is 15s so there's nothing
      // else that can show up in <2s.
      setTimeout(resolveSnapshot, 2000)
    })

    await publisher.publish(
      `${REDIS_KEY_PREFIX}pipeline:campaign:${campaignId}`,
      JSON.stringify({ type: 'phase', phase: 'world_gen' }),
    )

    await new Promise<void>((resolveEvent) => {
      const check = (): void => {
        if (buf.includes('"phase":"world_gen"')) resolveEvent()
      }
      stream.on('data', check)
      // Bump to 3s because the publish round-trip + PSUBSCRIBE dispatch
      // is observably ~50ms locally but can spike under load.
      setTimeout(resolveEvent, 3000)
    })

    expect(buf).toContain('"phase":"world_gen"')
    stream.off('data', onData)
    stream.destroy()
  })
})
