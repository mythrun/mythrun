// MYT-38 invite-flow integration tests. Real Postgres + bypass auth.
//
// Phase-4 wave-4d (myth-oehx): migrated from resetData() + the fixed
// `BYPASS_SUB = 'bypass:dev-1'` caller convention to scoped fixtures.
// Each test asserts as a per-test sub injected via the
// `x-mythrun-dev-sub` header; "other" users are seeded under the same
// scope under different `scope.userSub(n)` indices.
//
// Why per-test subs:
//   - cleanupTestScope can only delete rows whose cognito_sub LIKEs the
//     scope's id prefix. The previous hardcoded 'bypass:dev-1' default
//     wouldn't match, so its row would survive between tests and break
//     the "owner is X" assertions on subsequent tests.
//   - Per-test isolation is now scope-based, not blanket-DELETE-based.
//     Each test uses a unique scope.userSub(testIdx) for the caller and
//     scope.userSub(testIdx + 1) for any "other" seeded user.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import IoredisMock from 'ioredis-mock'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { createPgPool } from '../db/postgres.js'
import { runMigrations } from '../db/migrate.js'
import { guardTestDatabase } from '../db/__tests__/guard-db.js'
import {
  cleanupTestScope,
  makeTestScope,
  type ScopedSub,
  type TestScope,
} from '../repo/__tests__/_helpers/test-scope.js'
import { buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'
import { createRepo, type Repo } from '../repo/index.js'
import { makeStubEnv } from './helpers/stub-env.js'
import { noopWorldGenQueue } from './helpers/stub-deps.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../migrations')
const FRONTEND_BASE_URL = 'http://localhost:5173'

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: (): void => {
      // discard log output
    },
  }
  return pino({ base: { component: 'migrate' } }, sink)
}

async function seedCallerUser(repo: Repo, pool: Pool, scope: TestScope, idx: number): Promise<string> {
  void pool
  const u = await repo.users.create(pool, {
    cognitoSub: scope.userSub(idx),
    username: scope.username(idx),
    displayName: scope.displayName(idx),
  })
  return u.id
}

interface SeededOther {
  readonly userId: string
  readonly worldId: string
  readonly campaignId: string
  readonly username: string
}

async function seedOtherOwnedCampaign(
  repo: Repo,
  pool: Pool,
  scope: TestScope,
  idx: number,
): Promise<SeededOther> {
  const owner = await repo.users.create(pool, {
    cognitoSub: scope.userSub(idx),
    username: scope.username(idx),
    displayName: scope.displayName(idx),
  })
  const world = await repo.worlds.create({
    createdBy: owner.id,
    name: scope.worldName(idx),
    concept: 'concept',
  })
  const campaign = await repo.campaigns.create({
    worldId: world.id,
    createdBy: owner.id,
    name: scope.campaignName(idx),
  })
  await repo.campaigns.addMember({
    campaignId: campaign.id,
    userId: owner.id,
    role: 'owner',
  })
  return {
    userId: owner.id,
    worldId: world.id,
    campaignId: campaign.id,
    username: scope.username(idx),
  }
}

async function seedCallerOwnedCampaign(
  repo: Repo,
  pool: Pool,
  scope: TestScope,
  callerIdx: number,
): Promise<{ readonly callerUserId: string; readonly campaignId: string }> {
  const callerUserId = await seedCallerUser(repo, pool, scope, callerIdx)
  const world = await repo.worlds.create({
    createdBy: callerUserId,
    name: scope.worldName(callerIdx),
    concept: 'concept',
  })
  const campaign = await repo.campaigns.create({
    worldId: world.id,
    createdBy: callerUserId,
    name: scope.campaignName(callerIdx),
  })
  await repo.campaigns.addMember({
    campaignId: campaign.id,
    userId: callerUserId,
    role: 'owner',
  })
  return { callerUserId, campaignId: campaign.id }
}

describe('invite routes (integration)', () => {
  let pool: Pool
  let repo: Repo
  let app: Awaited<ReturnType<typeof buildApp>>
  // Label kept short ('inv'): scope.username(n) must fit the route's
  // ^[a-zA-Z0-9](?:[a-zA-Z0-9_]{1,18}[a-zA-Z0-9])?$ regex (max 20 chars).
  // id = `tst-${label}-${rand8}`, then `${id-stripped}u${n}` is the
  // username. label='inv' → 11-char id-stripped + 'u' + 2-digit index =
  // up to 14 chars; comfortable headroom for 2 * testIpCounter indices.
  const scope = makeTestScope('inv')
  // Each test gets a unique remoteAddress so the in-memory rate-limit
  // store (keyed by request.ip) doesn't bleed between tests.
  let testIpCounter = 0
  let currentTestIp = ''
  // Per-test caller sub. Tests bump `callerIdx` so each test asserts
  // against an isolated (sub, user-row) pair the scope owns.
  let currentCallerSub: ScopedSub = scope.userSub(0)

  function inject(opts: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject({
      ...opts,
      remoteAddress: currentTestIp,
      headers: { ...(opts.headers ?? {}), 'x-mythrun-dev-sub': currentCallerSub },
    })
  }

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })

    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('COGNITO_USER_POOL_ID', '')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
    vi.stubEnv('COGNITO_ISSUER_URL', '')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
    globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))

    repo = createRepo(pool)
    const deps: AppDeps = {
      pg: pool,
      redisRealtime: new IoredisMock(),
      redisBatch: new IoredisMock(),
      redisKeyPrefix: 'test:use1:',
      repo,
      worldGenQueue: noopWorldGenQueue(),
    }
    app = await buildApp(
      deps,
      { mode: 'bypass' },
      {
        frontendBaseUrl: FRONTEND_BASE_URL,
        env: makeStubEnv({ frontendBaseUrl: FRONTEND_BASE_URL }),
      },
    )
  })

  afterAll(async () => {
    await app.close()
    await cleanupTestScope(pool, scope)
    await pool.end()
    vi.unstubAllEnvs()
  })

  beforeEach(() => {
    testIpCounter += 1
    currentTestIp = `10.0.${String(Math.floor(testIpCounter / 256))}.${String(testIpCounter % 256)}`
    // Each test reserves a fresh caller index. Allocates `callerIdx`
    // (= 2*testIpCounter) for the caller and `callerIdx + 1` for any
    // "other" seeded user — guaranteeing no two tests collide on a sub.
    currentCallerSub = scope.userSub(2 * testIpCounter)
  })

  describe('POST /api/campaigns/:id/invites', () => {
    it('owner creates invite → 201 with code, url, Location header', async () => {
      const { campaignId } = await seedCallerOwnedCampaign(repo, pool, scope, 2 * testIpCounter)
      const res = await inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/invites`,
      })
      expect(res.statusCode).toBe(201)
      const body = res.json<{ inviteCode: string; inviteUrl: string; uses: number }>()
      expect(body.inviteCode).toMatch(/^[A-Za-z0-9]{12}$/)
      expect(body.inviteUrl).toBe(`${FRONTEND_BASE_URL}/join/${body.inviteCode}`)
      expect(body.uses).toBe(0)
      expect(res.headers.location).toBe(`/api/invites/${body.inviteCode}/preview`)
    })

    it('non-owner (non-member) → 403 not_campaign_owner', async () => {
      await seedCallerUser(repo, pool, scope, 2 * testIpCounter)
      const other = await seedOtherOwnedCampaign(repo, pool, scope, 2 * testIpCounter + 1)
      const res = await inject({
        method: 'POST',
        url: `/api/campaigns/${other.campaignId}/invites`,
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ code: 'not_campaign_owner' })
    })

    it('unknown campaign → 404 campaign_not_found', async () => {
      await seedCallerUser(repo, pool, scope, 2 * testIpCounter)
      const res = await inject({
        method: 'POST',
        url: '/api/campaigns/00000000-0000-7000-8000-000000000000/invites',
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ code: 'campaign_not_found' })
    })
  })

  describe('GET /api/campaigns/:id/invites', () => {
    it('owner lists invites → 200 with array including primary', async () => {
      const { campaignId } = await seedCallerOwnedCampaign(repo, pool, scope, 2 * testIpCounter)
      // create 2 invites
      const c1 = await inject({ method: 'POST', url: `/api/campaigns/${campaignId}/invites` })
      const c2 = await inject({ method: 'POST', url: `/api/campaigns/${campaignId}/invites` })
      expect(c1.statusCode).toBe(201)
      expect(c2.statusCode).toBe(201)

      const res = await inject({ method: 'GET', url: `/api/campaigns/${campaignId}/invites` })
      expect(res.statusCode).toBe(200)
      const body = res.json<{
        invites: { inviteCode: string; inviteUrl: string; primary: boolean }[]
      }>()
      expect(body.invites.length).toBe(2)
      // First (oldest) is primary.
      expect(body.invites[0]?.primary).toBe(true)
      expect(body.invites[1]?.primary).toBe(false)
      expect(body.invites[0]?.inviteUrl.startsWith(`${FRONTEND_BASE_URL}/join/`)).toBe(true)
    })

    it('non-owner → 403 not_campaign_owner', async () => {
      await seedCallerUser(repo, pool, scope, 2 * testIpCounter)
      const other = await seedOtherOwnedCampaign(repo, pool, scope, 2 * testIpCounter + 1)
      const res = await inject({ method: 'GET', url: `/api/campaigns/${other.campaignId}/invites` })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ code: 'not_campaign_owner' })
    })
  })

  describe('DELETE /api/campaigns/:id/invites/:inviteCode', () => {
    it('owner revokes invite → 204', async () => {
      const { campaignId } = await seedCallerOwnedCampaign(repo, pool, scope, 2 * testIpCounter)
      const created = await inject({ method: 'POST', url: `/api/campaigns/${campaignId}/invites` })
      const code = created.json<{ inviteCode: string }>().inviteCode

      const res = await inject({
        method: 'DELETE',
        url: `/api/campaigns/${campaignId}/invites/${code}`,
      })
      expect(res.statusCode).toBe(204)
    })

    it('unknown invite code → 404 invite_not_found', async () => {
      const { campaignId } = await seedCallerOwnedCampaign(repo, pool, scope, 2 * testIpCounter)
      const res = await inject({
        method: 'DELETE',
        url: `/api/campaigns/${campaignId}/invites/NOTAREALCODE`,
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ code: 'invite_not_found' })
    })
  })

  describe('GET /api/invites/:inviteCode/preview', () => {
    it('valid invite → 200 valid:true with campaign + owner identity', async () => {
      // Preview is jwt-no-db / public-ish — caller doesn't need to be
      // onboarded. We still seed the caller because the bypass plugin
      // attaches a sub regardless; not seeding would 403 any other route
      // hit in the same describe block. Preview itself only reads the
      // invite + the campaign owner's identity, both of which come from
      // the "other" user.
      await seedCallerUser(repo, pool, scope, 2 * testIpCounter)
      const other = await seedOtherOwnedCampaign(repo, pool, scope, 2 * testIpCounter + 1)
      const inv = await repo.invites.create({
        campaignId: other.campaignId,
        createdBy: other.userId,
      })
      const res = await inject({
        method: 'GET',
        url: `/api/invites/${inv.inviteCode}/preview`,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ campaignName: string; ownerUsername: string; valid: boolean }>()
      expect(body.campaignName).toBe(scope.campaignName(2 * testIpCounter + 1))
      expect(body.ownerUsername).toBe(other.username)
      expect(body.valid).toBe(true)
    })

    it('revoked invite → 200 valid:false', async () => {
      await seedCallerUser(repo, pool, scope, 2 * testIpCounter)
      const other = await seedOtherOwnedCampaign(repo, pool, scope, 2 * testIpCounter + 1)
      const inv = await repo.invites.create({
        campaignId: other.campaignId,
        createdBy: other.userId,
      })
      await repo.invites.revoke(inv.inviteCode, other.campaignId)

      const res = await inject({
        method: 'GET',
        url: `/api/invites/${inv.inviteCode}/preview`,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ valid: boolean }>()
      expect(body.valid).toBe(false)
    })

    it('unknown code → 404 invite_not_found', async () => {
      await seedCallerUser(repo, pool, scope, 2 * testIpCounter)
      const res = await inject({
        method: 'GET',
        url: '/api/invites/NOTAREALCODE/preview',
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ code: 'invite_not_found' })
    })
  })

  describe('POST /api/invites/:inviteCode/accept', () => {
    it('accept new invite → 201 alreadyMember:false + Location header', async () => {
      await seedCallerUser(repo, pool, scope, 2 * testIpCounter)
      const other = await seedOtherOwnedCampaign(repo, pool, scope, 2 * testIpCounter + 1)
      const inv = await repo.invites.create({
        campaignId: other.campaignId,
        createdBy: other.userId,
      })

      const res = await inject({
        method: 'POST',
        url: `/api/invites/${inv.inviteCode}/accept`,
      })
      expect(res.statusCode).toBe(201)
      expect(res.headers.location).toBe(`/api/campaigns/${other.campaignId}`)
      const body = res.json<{ campaignId: string; alreadyMember: boolean }>()
      expect(body.campaignId).toBe(other.campaignId)
      expect(body.alreadyMember).toBe(false)
    })

    it('already member → 200 alreadyMember:true (no Location)', async () => {
      const { callerUserId, campaignId } = await seedCallerOwnedCampaign(
        repo,
        pool,
        scope,
        2 * testIpCounter,
      )
      // caller user is already the owner of this campaign — count as member.
      const inv = await repo.invites.create({
        campaignId,
        createdBy: callerUserId,
      })

      const res = await inject({
        method: 'POST',
        url: `/api/invites/${inv.inviteCode}/accept`,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ campaignId: string; alreadyMember: boolean }>()
      expect(body.campaignId).toBe(campaignId)
      expect(body.alreadyMember).toBe(true)
    })

    it('revoked invite, non-member → 410 invite_revoked', async () => {
      await seedCallerUser(repo, pool, scope, 2 * testIpCounter)
      const other = await seedOtherOwnedCampaign(repo, pool, scope, 2 * testIpCounter + 1)
      const inv = await repo.invites.create({
        campaignId: other.campaignId,
        createdBy: other.userId,
      })
      await repo.invites.revoke(inv.inviteCode, other.campaignId)

      const res = await inject({
        method: 'POST',
        url: `/api/invites/${inv.inviteCode}/accept`,
      })
      expect(res.statusCode).toBe(410)
      expect(res.json()).toEqual({ code: 'invite_revoked' })
    })

    it('membership trumps revoke: already-member of revoked invite → 200 alreadyMember:true', async () => {
      const { callerUserId, campaignId } = await seedCallerOwnedCampaign(
        repo,
        pool,
        scope,
        2 * testIpCounter,
      )
      const inv = await repo.invites.create({
        campaignId,
        createdBy: callerUserId,
      })
      await repo.invites.revoke(inv.inviteCode, campaignId)

      const res = await inject({
        method: 'POST',
        url: `/api/invites/${inv.inviteCode}/accept`,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ alreadyMember: boolean }>()
      expect(body.alreadyMember).toBe(true)
    })

    it('unknown code → 404 invite_not_found', async () => {
      await seedCallerUser(repo, pool, scope, 2 * testIpCounter)
      const res = await inject({
        method: 'POST',
        url: '/api/invites/NOTAREALCODE/accept',
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ code: 'invite_not_found' })
    })
  })

  describe('GET /api/campaigns/:id/members', () => {
    it('member lists members → 200 with members array', async () => {
      const { campaignId } = await seedCallerOwnedCampaign(repo, pool, scope, 2 * testIpCounter)
      const res = await inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/members`,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{
        members: { userId: string; role: string; username: string }[]
      }>()
      expect(body.members.length).toBe(1)
      expect(body.members[0]?.username).toBe(scope.username(2 * testIpCounter))
      expect(body.members[0]?.role).toBe('owner')
    })

    it('non-member → 403 not_campaign_member', async () => {
      await seedCallerUser(repo, pool, scope, 2 * testIpCounter)
      const other = await seedOtherOwnedCampaign(repo, pool, scope, 2 * testIpCounter + 1)
      const res = await inject({
        method: 'GET',
        url: `/api/campaigns/${other.campaignId}/members`,
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ code: 'not_campaign_member' })
    })

    it('unknown campaign → 404 campaign_not_found', async () => {
      await seedCallerUser(repo, pool, scope, 2 * testIpCounter)
      const res = await inject({
        method: 'GET',
        url: '/api/campaigns/00000000-0000-7000-8000-000000000000/members',
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ code: 'campaign_not_found' })
    })
  })
})
