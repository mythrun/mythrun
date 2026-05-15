// Focused coverage for routes/invites.ts error-mapping arms that the
// sibling integration tests don't reach. The route file's try/catch
// blocks include arms for InviteCreationError (500) and
// InviteTimeoutError (503). The repo wraps real pg timeouts into those
// types, but the existing tests exercise the repo helper directly and
// don't surface the typed error through the HTTP boundary. Here we
// mock the createInvitesRepo factory so the repo throws on cue and the
// route's catch-arm runs.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { requireOnboarded } from '../../auth/require-onboarded.js'
import {
  InviteCreationError,
  InviteTimeoutError,
} from '../../repo/invites-errors.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'

// Mock the invites repo factory. The routes plugin calls createRepo()
// which composes createInvitesRepo() internally; we mock the inner
// factory so the route's `ctx.repo.invites.*` calls go through our stub.
const stubCreate = vi.fn()
const stubAcceptInvite = vi.fn()
const stubGetCodePreview = vi.fn()
const stubListForCampaign = vi.fn()
const stubRevoke = vi.fn()

vi.mock('../../repo/invites.js', async () => {
  const actual = await vi.importActual<typeof import('../../repo/invites.js')>(
    '../../repo/invites.js',
  )
  return {
    ...actual,
    createInvitesRepo: () => ({
      create: stubCreate,
      acceptInvite: stubAcceptInvite,
      getCodePreview: stubGetCodePreview,
      listForCampaign: stubListForCampaign,
      revoke: stubRevoke,
    }),
  }
})

import { invitesRoutes } from '../invites.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')
const FRONTEND_BASE_URL = 'http://localhost:5173'

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: (): void => {
      // discard
    },
  }
  return pino({ base: { component: 'migrate' } }, sink)
}

async function seedOwnerAndCampaign(
  pool: Pool,
  scope: TestScope,
): Promise<{ ownerSub: string; ownerId: string; campaignId: string }> {
  const ownerId = uuidv7()
  const ownerSub = scope.userSub(0)
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [ownerId, ownerSub, scope.displayName(0), scope.username(0)],
  )
  const worldId = uuidv7()
  const campaignId = uuidv7()
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status)
     VALUES ($1, $2, $3, 'Concept', 'complete')`,
    [worldId, ownerId, scope.worldName(0)],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, 'setup')`,
    [campaignId, worldId, ownerId, scope.campaignName(0)],
  )
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaignId, ownerId],
  )
  return { ownerSub, ownerId, campaignId }
}

async function buildApp(pool: Pool): Promise<FastifyInstance> {
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(bypassPlugin)
  await app.register(requireOnboarded, { pool })
  await app.register(invitesRoutes, { pool, frontendBaseUrl: FRONTEND_BASE_URL })
  await app.ready()
  return app
}

describe('routes/invites — error mapping', () => {
  let pool: Pool
  let app: FastifyInstance
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 4 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
    scope = makeTestScope('invites-error')
  })

  afterAll(async () => {
    // myth-5jdo: scoped cleanup only — seeded dev users + system user
    // survive for the next test file.
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')
    stubCreate.mockReset()
    stubAcceptInvite.mockReset()
    stubGetCodePreview.mockReset()
    stubListForCampaign.mockReset()
    stubRevoke.mockReset()
    // myth-5jdo: scoped cleanup replaces the blanket DELETEs.
    await cleanupTestScope(pool, scope)
    app = await buildApp(pool)
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  it('500 invite_creation_error when repo.invites.create throws InviteCreationError', async () => {
    const seed = await seedOwnerAndCampaign(pool, scope)
    stubCreate.mockRejectedValueOnce(new InviteCreationError(3))
    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${seed.campaignId}/invites`,
      headers: { 'x-mythrun-dev-sub': seed.ownerSub },
    })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ code: 'invite_creation_error' })
  })

  it('rethrows non-Mythrun errors from invite-create handler (falls through to Fastify 500)', async () => {
    const seed = await seedOwnerAndCampaign(pool, scope)
    stubCreate.mockRejectedValueOnce(new Error('some random repo failure'))
    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${seed.campaignId}/invites`,
      headers: { 'x-mythrun-dev-sub': seed.ownerSub },
    })
    // Untyped rethrow → Fastify default 500.
    expect(res.statusCode).toBe(500)
  })

  it('503 invite_timeout when repo.invites.acceptInvite throws InviteTimeoutError', async () => {
    // Joiner user.
    const joinerId = uuidv7()
    const joinerSub = scope.userSub(1)
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [joinerId, joinerSub, scope.displayName(1), scope.username(1)],
    )
    stubGetCodePreview.mockResolvedValueOnce({
      campaignId: uuidv7(),
      campaignName: 'X',
      ownerUsername: 'owner',
      revoked: false,
      expiresAt: null,
    })
    stubAcceptInvite.mockRejectedValueOnce(new InviteTimeoutError('abc123', 'lock', '55P03'))
    const res = await app.inject({
      method: 'POST',
      url: `/api/invites/abc123/accept`,
      headers: { 'x-mythrun-dev-sub': joinerSub },
    })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ code: 'invite_timeout', retryAfterSec: 1 })
    expect(res.headers['retry-after']).toBe('1')
  })

  it('rethrows non-Timeout errors from accept handler (falls through to Fastify 500)', async () => {
    const joinerId = uuidv7()
    const joinerSub = scope.userSub(2)
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [joinerId, joinerSub, scope.displayName(2), scope.username(2)],
    )
    stubGetCodePreview.mockResolvedValueOnce({
      campaignId: uuidv7(),
      campaignName: 'X',
      ownerUsername: 'owner',
      revoked: false,
      expiresAt: null,
    })
    stubAcceptInvite.mockRejectedValueOnce(new Error('unexpected failure'))
    const res = await app.inject({
      method: 'POST',
      url: `/api/invites/abc123/accept`,
      headers: { 'x-mythrun-dev-sub': joinerSub },
    })
    expect(res.statusCode).toBe(500)
  })
})
