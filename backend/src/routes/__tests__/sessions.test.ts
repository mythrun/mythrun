import Fastify, { type FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import type {
  CampaignMember,
  CampaignMemberRole,
  Session,
  User,
} from '../../repo/types.js'

// Mock the repo factory so routes/sessions.ts uses our stubs.
const getMembershipMock = vi.fn()
const getSessionByIdMock = vi.fn()
vi.mock('../../repo/index.js', () => ({
  createRepo: () => ({
    campaigns: { getMembership: getMembershipMock },
    sessions: { getById: getSessionByIdMock },
    worlds: { getById: vi.fn() },
  }),
}))

import { sessionsRoutes } from '../sessions.js'

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

const memberRow = (role: CampaignMemberRole = 'player'): CampaignMember => ({
  id: 'cm-1',
  campaignId: 'c-1',
  userId: 'u-1',
  role,
  inviteAccepted: true,
  joinedAt: new Date(),
})

const sessionRow: Session = {
  id: 's-1',
  campaignId: 'c-1',
  sessionNumber: 1,
  status: 'active',
  startedAt: new Date(),
  endedAt: null,
  summary: null,
  stRunningSummary: null,
  handoff: null,
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

const fakePool = {} as Pool
const KEY_PREFIX = 'staging:use1:ws:ticket:'

async function build(opts: {
  user: User | undefined
  redis: Redis
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(attachDbUserPlugin(opts.user))
  await app.register(sessionsRoutes, {
    pool: fakePool,
    redisRealtime: opts.redis,
    redisKeyPrefix: KEY_PREFIX,
  })
  return app
}

describe('POST /api/sessions/:id/ws-ticket', () => {
  let app: FastifyInstance | undefined
  let redis: Redis

  beforeEach(() => {
    redis = new IoRedisMock() as unknown as Redis
    getMembershipMock.mockReset()
    getSessionByIdMock.mockReset()
  })

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    await redis.quit()
  })

  it('session does not exist → 404 session_not_found', async () => {
    getSessionByIdMock.mockResolvedValueOnce(null)
    app = await build({ user: fakeUser, redis })
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s-1/ws-ticket' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ code: 'session_not_found' })
  })

  it('session exists, user not a member → 403 not_campaign_member', async () => {
    getSessionByIdMock.mockResolvedValueOnce(sessionRow)
    getMembershipMock.mockResolvedValueOnce(null)
    app = await build({ user: fakeUser, redis })
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s-1/ws-ticket' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_member' })
  })

  it('member → 200 with ticket and expiresAt; ticket fetchable from Redis', async () => {
    getSessionByIdMock.mockResolvedValueOnce(sessionRow)
    getMembershipMock.mockResolvedValueOnce(memberRow())
    app = await build({ user: fakeUser, redis })
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s-1/ws-ticket' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ticket: string; expiresAt: string }
    expect(body.ticket).toMatch(/^[0-9a-f]{64}$/)
    expect(Date.parse(body.expiresAt)).not.toBeNaN()

    const stored = await redis.get(`${KEY_PREFIX}${body.ticket}`)
    expect(stored).not.toBeNull()
    expect(JSON.parse(stored!) as Record<string, string>).toEqual({
      userId: 'u-1',
      sessionId: 's-1',
      campaignId: 'c-1',
    })
  })

  it('no dbUser → 500 (boot-time misconfig surfaced)', async () => {
    getSessionByIdMock.mockResolvedValueOnce(sessionRow)
    app = await build({ user: undefined, redis })
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s-1/ws-ticket' })
    expect(res.statusCode).toBe(500)
  })
})
