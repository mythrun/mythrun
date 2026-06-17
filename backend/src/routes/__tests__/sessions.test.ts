import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify'
import fp from 'fastify-plugin'
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import type { CampaignMember, CampaignMemberRole, Session, User } from '../../repo/types.js'

// Mock the repo factory so routes/sessions.ts uses our stubs.
const getMembershipMock = vi.fn()
const getSessionByIdMock = vi.fn()
// /start handler dependencies — all vi.fn()s, configured per-test. Declared
// here (not inside the factory) so each test can drive them deterministically;
// the factory below closes over them.
const getCampaignByIdMock = vi.fn()
const getOwnerMock = vi.fn()
const maxSessionNumberMock = vi.fn()
const prepExistsForMock = vi.fn()
const getActiveByCampaignMock = vi.fn()
const sessionCreateMock = vi.fn()
const sessionDeleteByIdMock = vi.fn()
const tryDebitForSessionMock = vi.fn()
// Happy-path-only reads (the 200 /start path reaches them after the debit):
const prepGetByMock = vi.fn()
const getWorldIdMock = vi.fn()
const getToneAndEraMock = vi.fn()
const setStateMock = vi.fn()
// §8 session-boundary hygiene resets — driven on the injected fakes. The route
// constructs sessionState via makeSessionState (mocked) and triggerState via
// makeTriggerState (mocked); the /start handler calls resetSessionSpend +
// resetSessionKeys after setState. `resetSessionSpend` is added to SessionState
// by the sibling MYT-69 T12; here we stub it on the mocked makeSessionState
// return so the route's call resolves at runtime (the prod symbol converges
// when T12 lands).
const resetSessionSpendMock = vi.fn()
const resetSessionKeysMock = vi.fn()

vi.mock('../../repo/index.js', () => ({
  createRepo: () => ({
    campaigns: {
      getMembership: getMembershipMock,
      getById: getCampaignByIdMock,
      getOwner: getOwnerMock,
      getWorldId: getWorldIdMock,
    },
    sessions: {
      getById: getSessionByIdMock,
      maxSessionNumber: maxSessionNumberMock,
      getActiveByCampaign: getActiveByCampaignMock,
      create: sessionCreateMock,
      deleteById: sessionDeleteByIdMock,
    },
    sessionPreps: { existsFor: prepExistsForMock, getBy: prepGetByMock },
    credits: { tryDebitForSession: tryDebitForSessionMock },
    worlds: { getToneAndEra: getToneAndEraMock },
  }),
}))

// makeSessionState wraps the redis client; the /start handler only calls
// setState on it. Mock the module so we can assert setState without a real
// Redis state read (and so a throwing setState is controllable).
vi.mock('../../redis/session-state.js', () => ({
  makeSessionState: () => ({
    setState: setStateMock,
    resetSessionSpend: resetSessionSpendMock,
  }),
}))

// makeTriggerState wraps the realtime redis client; the /start handler only
// calls resetSessionKeys on it (§8). Mock the module so we can assert the reset
// without a real Redis round-trip.
vi.mock('../../session/trigger-state.js', () => ({
  makeTriggerState: () => ({ resetSessionKeys: resetSessionKeysMock }),
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
  reconciledAt: null,
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
const BASE_PREFIX = 'staging:use1:'
// The mint route appends the `ws:ticket:` sub-prefix to the base redisKeyPrefix,
// so the route receives BASE_PREFIX and the stored key lands at KEY_PREFIX+nonce.
const KEY_PREFIX = `${BASE_PREFIX}ws:ticket:`

async function build(opts: { user: User | undefined; redis: Redis }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(attachDbUserPlugin(opts.user))
  await app.register(sessionsRoutes, {
    pool: fakePool,
    redisRealtime: opts.redis,
    redisKeyPrefix: BASE_PREFIX,
  })
  return app
}

describe('POST /api/sessions/:id/ws-ticket', () => {
  let app: FastifyInstance | undefined
  let redis: Redis

  beforeEach(() => {
    redis = new IoRedisMock()
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
    const body: { ticket: string; expiresAt: string } = res.json()
    expect(body.ticket).toMatch(/^[0-9a-f]{64}$/)
    expect(Date.parse(body.expiresAt)).not.toBeNaN()

    const stored = await redis.get(`${KEY_PREFIX}${body.ticket}`)
    if (stored === null) throw new Error('expected stored ticket value')
    const parsed = JSON.parse(stored) as Record<string, string>
    expect(parsed).toEqual({
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

// POST /:campaignId/start fault-injection arms. The happy path + the
// precondition/402 paths run against real Postgres in sessions-start.test.ts;
// here we drive the arms that need deterministic fault injection (a 23505 on
// the one-active INSERT, a throwing rollback deleteById) via the mocked repo.
describe('POST /api/sessions/:campaignId/start (mocked repo fault arms)', () => {
  let app: FastifyInstance | undefined
  let redis: Redis

  beforeEach(() => {
    redis = new IoRedisMock()
    for (const m of [
      getMembershipMock,
      getCampaignByIdMock,
      getOwnerMock,
      maxSessionNumberMock,
      prepExistsForMock,
      getActiveByCampaignMock,
      sessionCreateMock,
      sessionDeleteByIdMock,
      tryDebitForSessionMock,
      setStateMock,
      resetSessionSpendMock,
      resetSessionKeysMock,
      prepGetByMock,
      getWorldIdMock,
      getToneAndEraMock,
    ]) {
      m.mockReset()
    }
    // Default: an active campaign, a member, an owner, a prep, no active session.
    getMembershipMock.mockResolvedValue(memberRow())
    getCampaignByIdMock.mockResolvedValue({ id: 'c-1', status: 'active' })
    getOwnerMock.mockResolvedValue({ userId: 'owner-1' })
    maxSessionNumberMock.mockResolvedValue(0)
    prepExistsForMock.mockResolvedValue(true)
    getActiveByCampaignMock.mockResolvedValue(null)
    setStateMock.mockResolvedValue(undefined)
    resetSessionSpendMock.mockResolvedValue(undefined)
    resetSessionKeysMock.mockResolvedValue(undefined)
    // Happy-path reads after the debit (200 path): a prep with an ft_context,
    // a world id, and a tone.
    prepGetByMock.mockResolvedValue({ ftContext: 'ft-ctx' })
    getWorldIdMock.mockResolvedValue('w-1')
    getToneAndEraMock.mockResolvedValue({ tone: 'wry', era: null })
  })

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    await redis.quit()
  })

  function start(): Promise<LightMyRequestResponse> {
    if (!app) throw new Error('app not built')
    return app.inject({ method: 'POST', url: '/api/sessions/c-1/start', payload: {} })
  }

  it('a 23505 on idx_sessions_one_active during INSERT → 409 session_already_active', async () => {
    // The concurrent-/start race: the precondition saw no active session, but
    // the INSERT loses the partial-unique slot to a parallel winner.
    sessionCreateMock.mockRejectedValueOnce(
      Object.assign(new Error('dup'), {
        code: '23505',
        constraint: 'idx_sessions_one_active',
      }),
    )
    app = await build({ user: fakeUser, redis })
    const res = await start()
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ code: 'session_already_active' })
    // No debit attempted — the INSERT failed before the debit step.
    expect(tryDebitForSessionMock).not.toHaveBeenCalled()
  })

  it('a NON-23505 error from the INSERT re-throws → 500 (only the one-active arm is mapped)', async () => {
    // isOneActiveViolation(err) is false for a generic pg/protocol error, so the
    // catch re-throws and Fastify surfaces a 500 — distinct from the mapped 409.
    sessionCreateMock.mockRejectedValueOnce(
      Object.assign(new Error('connection terminated'), { code: '08006' }),
    )
    app = await build({ user: fakeUser, redis })
    const res = await start()
    expect(res.statusCode).toBe(500)
    // The debit step is never reached on a re-thrown INSERT error.
    expect(tryDebitForSessionMock).not.toHaveBeenCalled()
  })

  it('insufficient credits → 402; the unpaid row is rolled back via deleteById', async () => {
    sessionCreateMock.mockResolvedValueOnce(undefined)
    tryDebitForSessionMock.mockResolvedValueOnce({
      ok: false,
      code: 'insufficient_credits',
      available: 0,
      required: 1,
    })
    sessionDeleteByIdMock.mockResolvedValueOnce(undefined)
    app = await build({ user: fakeUser, redis })
    const res = await start()
    expect(res.statusCode).toBe(402)
    expect(res.json()).toEqual({ code: 'insufficient_credits', available: 0, required: 1 })
    // The just-created row was rolled back.
    expect(sessionDeleteByIdMock).toHaveBeenCalledTimes(1)
    // Redis state was NOT initialized on the 402 path.
    expect(setStateMock).not.toHaveBeenCalled()
  })

  it('a throwing rollback deleteById still returns the clean 402 (catch swallows)', async () => {
    sessionCreateMock.mockResolvedValueOnce(undefined)
    tryDebitForSessionMock.mockResolvedValueOnce({
      ok: false,
      code: 'insufficient_credits',
      available: 0,
      required: 1,
    })
    // deleteById throws (broken-connection edge) — the catch logs and the 402
    // is returned regardless; the wedged row is the only fallout.
    sessionDeleteByIdMock.mockRejectedValueOnce(new Error('connection reset'))
    app = await build({ user: fakeUser, redis })
    const res = await start()
    expect(res.statusCode).toBe(402)
    expect(res.json<{ code: string }>().code).toBe('insufficient_credits')
  })

  it('a successful start resets the spend + ST-owned session keys (§8 boundary hygiene)', async () => {
    // §8: a same-campaign session started within the 2h state TTL must NOT
    // inherit the prior session's usage/summary or a standing wind-down
    // directive. The handler resets BOTH spend keys (resetSessionSpend →
    // :usage/:usage:st/:summary) AND the ST-owned slots + counter
    // (resetSessionKeys → direction:oneshot/standing + turns-since-st) AFTER the
    // Redis state init, on the 200 path only.
    sessionCreateMock.mockResolvedValueOnce(undefined)
    tryDebitForSessionMock.mockResolvedValueOnce({ ok: true })
    app = await build({ user: fakeUser, redis })
    const res = await start()
    expect(res.statusCode).toBe(200)
    expect(res.json<{ sessionId: string }>().sessionId).toMatch(/^[0-9a-f-]{36}$/)
    // setState ran (Redis init), THEN both resets fired exactly once.
    expect(setStateMock).toHaveBeenCalledTimes(1)
    expect(resetSessionSpendMock).toHaveBeenCalledTimes(1)
    expect(resetSessionSpendMock).toHaveBeenCalledWith('c-1')
    expect(resetSessionKeysMock).toHaveBeenCalledTimes(1)
    expect(resetSessionKeysMock).toHaveBeenCalledWith('c-1')
  })

  it('the 402 path does NOT reset session keys (no fresh session to hygiene)', async () => {
    // The resets are part of the 200 session-init sequence; an unpaid /start
    // that rolls back must not touch the spend/ST keys.
    sessionCreateMock.mockResolvedValueOnce(undefined)
    tryDebitForSessionMock.mockResolvedValueOnce({
      ok: false,
      code: 'insufficient_credits',
      available: 0,
      required: 1,
    })
    sessionDeleteByIdMock.mockResolvedValueOnce(undefined)
    app = await build({ user: fakeUser, redis })
    const res = await start()
    expect(res.statusCode).toBe(402)
    expect(resetSessionSpendMock).not.toHaveBeenCalled()
    expect(resetSessionKeysMock).not.toHaveBeenCalled()
  })
})

// GET /:campaignId/active — the §9 enforced-ignorance LEAK FIX. The full mapped
// Session row carries `stRunningSummary` (ST-authored, secret-adjacent) +
// checkpoint material (`summary`, `handoff`). Once the ST writes real summaries,
// returning the whole row to ANY campaign member is a one-REST-call read of
// secret-adjacent state. The route must strip to an explicit player-safe
// allowlist: { id, status, sessionNumber, startedAt, endedAt }.
describe('GET /api/sessions/:campaignId/active (response allowlist)', () => {
  let app: FastifyInstance | undefined
  let redis: Redis

  beforeEach(() => {
    redis = new IoRedisMock()
    getMembershipMock.mockReset()
    getActiveByCampaignMock.mockReset()
    // Member by default — the allowlist (not access control) is under test here.
    getMembershipMock.mockResolvedValue(memberRow())
  })

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    await redis.quit()
  })

  function getActive(): Promise<LightMyRequestResponse> {
    if (!app) throw new Error('app not built')
    return app.inject({ method: 'GET', url: '/api/sessions/c-1/active' })
  }

  it('an active session → ONLY the allowlisted fields; ST/checkpoint material is ABSENT', async () => {
    // Seed a row with a NON-null stRunningSummary + summary + handoff to prove
    // the strip is real, not just "null happens not to serialize".
    getActiveByCampaignMock.mockResolvedValueOnce({
      ...sessionRow,
      summary: 'recap players never see',
      stRunningSummary: 'rapport: wary; ladder: rung 3; secret: the regent lies',
      handoff: 'next-session seed the ST authored',
    })
    app = await build({ user: fakeUser, redis })
    const res = await getActive()
    expect(res.statusCode).toBe(200)
    const body = res.json<{ session: Record<string, unknown> }>()
    // EXACTLY the allowlist key set — no more, no less.
    expect(Object.keys(body.session).sort()).toEqual(
      ['endedAt', 'id', 'sessionNumber', 'startedAt', 'status'].sort(),
    )
    expect(body.session.id).toBe('s-1')
    expect(body.session.status).toBe('active')
    expect(body.session.sessionNumber).toBe(1)
    // The leak-bearing fields are NOT present (not "present but null" — absent).
    expect(body.session).not.toHaveProperty('stRunningSummary')
    expect(body.session).not.toHaveProperty('summary')
    expect(body.session).not.toHaveProperty('handoff')
    expect(body.session).not.toHaveProperty('campaignId')
  })

  it('no active session → { session: null }', async () => {
    getActiveByCampaignMock.mockResolvedValueOnce(null)
    app = await build({ user: fakeUser, redis })
    const res = await getActive()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ session: null })
  })

  it('a non-member is rejected before the row is ever read', async () => {
    getMembershipMock.mockResolvedValueOnce(null)
    app = await build({ user: fakeUser, redis })
    const res = await getActive()
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_member' })
  })
})
