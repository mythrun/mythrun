// MYT-38 invite-flow integration tests. Real Postgres + bypass auth.
//
// The bypass user (sub='bypass:dev-1') is the SAME caller across every
// inject() in this file. To test "non-member"/"non-owner" cases we set up
// scenarios where the bypass user is NOT the campaign's owner / member.
// "Other" users are seeded via the repo so their cognito_sub never collides
// with the bypass identity.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { createPgPool } from '../db/postgres.js'
import { runMigrations } from '../db/migrate.js'
import { guardTestDatabase } from '../db/__tests__/guard-db.js'
import { resetData } from '../repo/__tests__/_helpers/reset-data.js'
import { buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'
import { createRepo, type Repo } from '../repo/index.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../migrations')
const FRONTEND_BASE_URL = 'http://localhost:5173'
const BYPASS_SUB = 'bypass:dev-1'

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: (): void => {
      // discard log output
    },
  }
  return pino({ base: { component: 'migrate' } }, sink)
}

async function seedBypassUser(repo: Repo, pool: Pool): Promise<string> {
  const u = await repo.users.create(pool, {
    cognitoSub: BYPASS_SUB,
    username: 'bypass',
    displayName: 'Bypass',
  })
  return u.id
}

interface SeededOther {
  readonly userId: string
  readonly worldId: string
  readonly campaignId: string
}

async function seedOtherOwnedCampaign(
  repo: Repo,
  pool: Pool,
  suffix: string,
): Promise<SeededOther> {
  const owner = await repo.users.create(pool, {
    cognitoSub: `other-sub-${suffix}`,
    username: `other${suffix}`,
    displayName: `Other ${suffix}`,
  })
  const world = await repo.worlds.create({
    createdBy: owner.id,
    name: 'World',
    concept: 'concept',
  })
  const campaign = await repo.campaigns.create({
    worldId: world.id,
    createdBy: owner.id,
    name: 'Campaign',
  })
  await repo.campaigns.addMember({
    campaignId: campaign.id,
    userId: owner.id,
    role: 'owner',
  })
  return { userId: owner.id, worldId: world.id, campaignId: campaign.id }
}

async function seedBypassOwnedCampaign(repo: Repo, pool: Pool): Promise<{
  readonly bypassUserId: string
  readonly campaignId: string
}> {
  const bypassUserId = await seedBypassUser(repo, pool)
  const world = await repo.worlds.create({
    createdBy: bypassUserId,
    name: 'World',
    concept: 'concept',
  })
  const campaign = await repo.campaigns.create({
    worldId: world.id,
    createdBy: bypassUserId,
    name: 'Campaign',
  })
  await repo.campaigns.addMember({
    campaignId: campaign.id,
    userId: bypassUserId,
    role: 'owner',
  })
  return { bypassUserId, campaignId: campaign.id }
}

describe('invite routes (integration)', () => {
  let pool: Pool
  let repo: Repo
  let app: Awaited<ReturnType<typeof buildApp>>
  // Each test gets a unique remoteAddress so the in-memory rate-limit
  // store (keyed by request.ip) doesn't bleed between tests.
  let testIpCounter = 0
  let currentTestIp = ''

  function inject(opts: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject({ ...opts, remoteAddress: currentTestIp })
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
      redisRealtime: { ping: () => Promise.resolve('PONG'), quit: () => Promise.resolve('OK') } as unknown as Redis,
      redisBatch: { ping: () => Promise.resolve('PONG'), quit: () => Promise.resolve('OK') } as unknown as Redis,
      repo,
    }
    app = await buildApp(deps, { mode: 'bypass' }, { frontendBaseUrl: FRONTEND_BASE_URL })
  })

  afterAll(async () => {
    await app.close()
    await pool.end()
    vi.unstubAllEnvs()
  })

  beforeEach(async () => {
    testIpCounter += 1
    currentTestIp = `10.0.${String(Math.floor(testIpCounter / 256))}.${String(testIpCounter % 256)}`
    await resetData(pool)
  })

  describe('POST /api/campaigns/:id/invites', () => {
    it('owner creates invite → 201 with code, url, Location header', async () => {
      const { campaignId } = await seedBypassOwnedCampaign(repo, pool)
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
      await seedBypassUser(repo, pool)
      const other = await seedOtherOwnedCampaign(repo, pool, 'a')
      const res = await inject({
        method: 'POST',
        url: `/api/campaigns/${other.campaignId}/invites`,
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ code: 'not_campaign_owner' })
    })

    it('unknown campaign → 404 campaign_not_found', async () => {
      await seedBypassUser(repo, pool)
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
      const { campaignId } = await seedBypassOwnedCampaign(repo, pool)
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
      await seedBypassUser(repo, pool)
      const other = await seedOtherOwnedCampaign(repo, pool, 'b')
      const res = await inject({ method: 'GET', url: `/api/campaigns/${other.campaignId}/invites` })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ code: 'not_campaign_owner' })
    })
  })

  describe('DELETE /api/campaigns/:id/invites/:inviteCode', () => {
    it('owner revokes invite → 204', async () => {
      const { campaignId } = await seedBypassOwnedCampaign(repo, pool)
      const created = await inject({ method: 'POST', url: `/api/campaigns/${campaignId}/invites` })
      const code = created.json<{ inviteCode: string }>().inviteCode

      const res = await inject({
        method: 'DELETE',
        url: `/api/campaigns/${campaignId}/invites/${code}`,
      })
      expect(res.statusCode).toBe(204)
    })

    it('unknown invite code → 404 invite_not_found', async () => {
      const { campaignId } = await seedBypassOwnedCampaign(repo, pool)
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
      const other = await seedOtherOwnedCampaign(repo, pool, 'pv1')
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
      expect(body.campaignName).toBe('Campaign')
      expect(body.ownerUsername).toBe('otherpv1')
      expect(body.valid).toBe(true)
    })

    it('revoked invite → 200 valid:false', async () => {
      const other = await seedOtherOwnedCampaign(repo, pool, 'pv2')
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
      await seedBypassUser(repo, pool)
      const other = await seedOtherOwnedCampaign(repo, pool, 'ac1')
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
      const { bypassUserId, campaignId } = await seedBypassOwnedCampaign(repo, pool)
      // bypass user is already the owner of this campaign — count as member.
      void bypassUserId
      const inv = await repo.invites.create({
        campaignId,
        createdBy: bypassUserId,
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
      await seedBypassUser(repo, pool)
      const other = await seedOtherOwnedCampaign(repo, pool, 'ac3')
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
      const { bypassUserId, campaignId } = await seedBypassOwnedCampaign(repo, pool)
      const inv = await repo.invites.create({
        campaignId,
        createdBy: bypassUserId,
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
      await seedBypassUser(repo, pool)
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
      const { campaignId } = await seedBypassOwnedCampaign(repo, pool)
      const res = await inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/members`,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{
        members: { userId: string; role: string; username: string }[]
      }>()
      expect(body.members.length).toBe(1)
      expect(body.members[0]?.username).toBe('bypass')
      expect(body.members[0]?.role).toBe('owner')
    })

    it('non-member → 403 not_campaign_member', async () => {
      await seedBypassUser(repo, pool)
      const other = await seedOtherOwnedCampaign(repo, pool, 'm1')
      const res = await inject({
        method: 'GET',
        url: `/api/campaigns/${other.campaignId}/members`,
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ code: 'not_campaign_member' })
    })

    it('unknown campaign → 404 campaign_not_found', async () => {
      await seedBypassUser(repo, pool)
      const res = await inject({
        method: 'GET',
        url: '/api/campaigns/00000000-0000-7000-8000-000000000000/members',
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ code: 'campaign_not_found' })
    })
  })
})
