import Fastify, { type FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../repo/index.js'
import type { CampaignMember, CampaignMemberRole, User, World } from '../../repo/types.js'
import { requireCampaignMember, requireWorldCreator } from '../access-control.js'

const fakeUser: User = {
  id: 'u-1',
  cognitoSub: 'sub-1',
  username: 'tester',
  displayName: 'Tester',
  stripeCustomerId: null,
  freeTrialUsed: false,
  suspendedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

function attachDbUserPlugin(user: User | undefined) {
  return fp(
    // eslint-disable-next-line @typescript-eslint/require-await
    async (app) => {
      // eslint-disable-next-line @typescript-eslint/require-await
      app.addHook('preHandler', async (request) => {
        if (user) {
          ;(request as unknown as { dbUser: User }).dbUser = Object.freeze(user)
        }
      })
    },
    { fastify: '5.x', name: 'fake-attach-db-user' },
  )
}

function makeRepo(overrides: { membership?: CampaignMember | null; world?: World | null }): Repo {
  return {
    campaigns: {
      getMembership: vi.fn().mockResolvedValue(overrides.membership ?? null),
    },
    worlds: {
      getById: vi.fn().mockResolvedValue(overrides.world ?? null),
    },
  } as unknown as Repo
}

const memberRow = (role: CampaignMemberRole, inviteAccepted = true): CampaignMember => ({
  id: 'cm-1',
  campaignId: 'c-1',
  userId: 'u-1',
  role,
  inviteAccepted,
  joinedAt: new Date(),
})

const worldRow = (createdBy: string): World => ({
  id: 'w-1',
  createdBy,
  sourceWorldId: null,
  name: 'Test',
  concept: 'X',
  tone: null,
  themes: null,
  geographySummary: null,
  politicalSummary: null,
  era: null,
  keyTensions: null,
  worldOverview: null,
  followUpQuestions: null,
  startingSituations: null,
  isPublic: false,
  forkCount: 0,
  status: 'complete',
  language: 'en',
  moderationStatus: 'unreviewed',
  isDemo: false,
  devBypassAccessFilter: false,
  createdAt: new Date(),
  updatedAt: new Date(),
})

describe('requireCampaignMember', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
  })

  it('member with no role gate passes; attaches request.campaignMember', async () => {
    const repo = makeRepo({ membership: memberRow('player') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    let attached: unknown
    app.get('/c/:campaignId/x', { preHandler: requireCampaignMember(repo) }, (req) => {
      attached = (req as unknown as { campaignMember?: unknown }).campaignMember
      return { ok: true }
    })
    const res = await app.inject({ method: 'GET', url: '/c/c-1/x' })
    expect(res.statusCode).toBe(200)
    expect(attached).toMatchObject({ campaignId: 'c-1', userId: 'u-1', role: 'player' })
  })

  it('member with matching role gate passes', async () => {
    const repo = makeRepo({ membership: memberRow('owner') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get('/c/:campaignId/x', { preHandler: requireCampaignMember(repo, 'owner') }, () => ({
      ok: true,
    }))
    const res = await app.inject({ method: 'GET', url: '/c/c-1/x' })
    expect(res.statusCode).toBe(200)
  })

  it('member with mismatching role gate returns 403 not_campaign_owner', async () => {
    const repo = makeRepo({ membership: memberRow('player') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get('/c/:campaignId/x', { preHandler: requireCampaignMember(repo, 'owner') }, () => ({
      ok: true,
    }))
    const res = await app.inject({ method: 'GET', url: '/c/c-1/x' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_owner' })
  })

  it('non-member returns 403 not_campaign_member', async () => {
    const repo = makeRepo({ membership: null })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get('/c/:campaignId/x', { preHandler: requireCampaignMember(repo) }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/c/c-1/x' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_member' })
  })

  it('member with invite_accepted=false returns 403 not_campaign_member', async () => {
    const repo = makeRepo({ membership: memberRow('player', false) })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get('/c/:campaignId/x', { preHandler: requireCampaignMember(repo) }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/c/c-1/x' })
    expect(res.statusCode).toBe(403)
  })

  it('uses request.resolvedCampaignId when set (no :campaignId in URL)', async () => {
    const repo = makeRepo({ membership: memberRow('player') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get(
      '/sessions/:id/x',
      {
        preHandler: [
          // eslint-disable-next-line @typescript-eslint/require-await
          async (req) => {
            ;(req as unknown as { resolvedCampaignId: string }).resolvedCampaignId = 'c-1'
          },
          requireCampaignMember(repo),
        ],
      },
      () => ({ ok: true }),
    )
    const res = await app.inject({ method: 'GET', url: '/sessions/s-1/x' })
    expect(res.statusCode).toBe(200)
  })

  it('throws (500) when neither :campaignId nor resolvedCampaignId set', async () => {
    const repo = makeRepo({ membership: memberRow('player') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get('/x', { preHandler: requireCampaignMember(repo) }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/x' })
    expect(res.statusCode).toBe(500)
  })

  it('throws (500) when request.dbUser is missing', async () => {
    const repo = makeRepo({ membership: memberRow('player') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(undefined))
    app.get('/c/:campaignId/x', { preHandler: requireCampaignMember(repo) }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/c/c-1/x' })
    expect(res.statusCode).toBe(500)
  })
})

describe('requireWorldCreator', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
  })

  it('creator passes; attaches request.world', async () => {
    const repo = makeRepo({ world: worldRow('u-1') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    let attached: unknown
    app.get('/w/:worldId', { preHandler: requireWorldCreator(repo) }, (req) => {
      attached = (req as unknown as { world?: unknown }).world
      return { ok: true }
    })
    const res = await app.inject({ method: 'GET', url: '/w/w-1' })
    expect(res.statusCode).toBe(200)
    expect(attached).toMatchObject({ id: 'w-1', createdBy: 'u-1' })
  })

  it('non-creator returns 403 not_world_creator', async () => {
    const repo = makeRepo({ world: worldRow('other-user') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get('/w/:worldId', { preHandler: requireWorldCreator(repo) }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/w/w-1' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_world_creator' })
  })

  it('non-existent world returns 404 world_not_found', async () => {
    const repo = makeRepo({ world: null })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get('/w/:worldId', { preHandler: requireWorldCreator(repo) }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/w/w-1' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ code: 'world_not_found' })
  })

  it('throws (500) when :worldId missing', async () => {
    const repo = makeRepo({ world: worldRow('u-1') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get('/w', { preHandler: requireWorldCreator(repo) }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/w' })
    expect(res.statusCode).toBe(500)
  })

  it('throws (500) when request.dbUser is missing', async () => {
    const repo = makeRepo({ world: worldRow('u-1') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(undefined))
    app.get('/w/:worldId', { preHandler: requireWorldCreator(repo) }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/w/w-1' })
    expect(res.statusCode).toBe(500)
  })
})
