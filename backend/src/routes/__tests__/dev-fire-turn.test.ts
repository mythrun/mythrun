// backend/src/routes/__tests__/dev-fire-turn.test.ts
//
// MYT-66 Task 10. Tests for the dev-only POST
// /api/dev/campaigns/:campaignId/fire-turn route — the curl-able poke that
// enqueues ONE session-turn job. Mirrors dev-credits.test.ts's standalone
// Fastify-app + AUTH_MODE pattern and sessions.test.ts's repo-mock approach:
// `createRepo` is stubbed so the route's only DB read
// (`sessions.getActiveByCampaign`) is driven per-test without a real Postgres
// session FK chain, and a recording `queue.add` captures the enqueue.

import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import type { Session } from '../../repo/types.js'
import type { TurnJobPayload, TurnQueueLike } from '../../session/turn-queue.js'

// Mock the repo factory so dev-fire-turn.ts uses our stub. The route reads
// sessions.getActiveByCampaign (active-session resolution) and
// sessionMessages.maxSeq (the §4.6 maxConsumedSeq watermark).
const getActiveByCampaignMock = vi.fn()
const maxSeqMock = vi.fn()

vi.mock('../../repo/index.js', () => ({
  createRepo: () => ({
    sessions: {
      getActiveByCampaign: getActiveByCampaignMock,
    },
    sessionMessages: {
      maxSeq: maxSeqMock,
    },
  }),
}))

import { devFireTurnRoutes } from '../dev-fire-turn.js'

// The mocked createRepo ignores the pool entirely, so an empty stub typed as
// Pool is sufficient (matches sessions.test.ts's `{} as Pool`).
const fakePool = {} as Pool

const ACTIVE_SESSION: Session = {
  id: 's-fire-1',
  campaignId: 'c-fire-1',
  sessionNumber: 1,
  status: 'active',
  startedAt: new Date(),
  endedAt: null,
  summary: null,
  stRunningSummary: null,
  handoff: null,
}

/** A recording TurnQueueLike: captures each `add(name, payload)` call so the
 *  enqueue contract (job name + payload shape) can be asserted without a real
 *  BullMQ broker. The hand-rolled spy is widened to TurnQueueLike via the same
 *  `as unknown as` idiom the other route tests use for BullMQ queue spies
 *  (campaigns-create.test.ts) — the real `Queue['add']` overload set is too
 *  heavy to satisfy structurally, and the route only ever calls `.add()`. */
interface QueueCall {
  readonly name: string
  readonly payload: TurnJobPayload
}
function recordingQueue(calls: QueueCall[]): TurnQueueLike {
  const add = vi.fn((name: string, payload: TurnJobPayload) => {
    calls.push({ name, payload })
    return Promise.resolve({ id: 'job-1' })
  })
  return { add } as unknown as TurnQueueLike
}

async function buildTestApp(queue: TurnQueueLike): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(devFireTurnRoutes, { queue, pool: fakePool })
  await app.ready()
  return app
}

describe('POST /api/dev/campaigns/:campaignId/fire-turn (MYT-66 T10)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    getActiveByCampaignMock.mockReset()
    maxSeqMock.mockReset()
  })

  // -------------------------------------------------------------------------
  // AUTH_MODE gating — the plugin registers no route off-bypass.
  // -------------------------------------------------------------------------

  describe('AUTH_MODE gating', () => {
    it('does NOT register the route when AUTH_MODE!=bypass (404)', async () => {
      vi.stubEnv('AUTH_MODE', 'real')
      const calls: QueueCall[] = []
      const app = await buildTestApp(recordingQueue(calls))
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/campaigns/c-fire-1/fire-turn',
          headers: { 'content-type': 'application/json' },
          payload: { triggerText: 'I open the door' },
        })
        expect(res.statusCode).toBe(404)
        expect(calls).toHaveLength(0)
      } finally {
        await app.close()
      }
    })

    it('registers the route when AUTH_MODE=bypass (non-404)', async () => {
      vi.stubEnv('AUTH_MODE', 'bypass')
      getActiveByCampaignMock.mockResolvedValue(ACTIVE_SESSION)
      const calls: QueueCall[] = []
      const app = await buildTestApp(recordingQueue(calls))
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/campaigns/c-fire-1/fire-turn',
          headers: { 'content-type': 'application/json' },
          payload: { triggerText: 'I open the door' },
        })
        expect(res.statusCode).not.toBe(404)
      } finally {
        await app.close()
      }
    })
  })

  // -------------------------------------------------------------------------
  // Body validation + active-session resolution (AUTH_MODE=bypass).
  // -------------------------------------------------------------------------

  describe('handler (AUTH_MODE=bypass)', () => {
    beforeEach(() => {
      vi.stubEnv('AUTH_MODE', 'bypass')
      // Default watermark: no prior messages. Tests that exercise the enqueue
      // override this to assert the real value rides the payload.
      maxSeqMock.mockResolvedValue(0)
    })

    it('400 invalid_body when triggerText is missing', async () => {
      const calls: QueueCall[] = []
      const app = await buildTestApp(recordingQueue(calls))
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/campaigns/c-fire-1/fire-turn',
          headers: { 'content-type': 'application/json' },
          payload: {},
        })
        expect(res.statusCode).toBe(400)
        expect(res.json<{ code: string }>().code).toBe('invalid_body')
        // No session lookup, no enqueue when the body fails validation.
        expect(getActiveByCampaignMock).not.toHaveBeenCalled()
        expect(calls).toHaveLength(0)
      } finally {
        await app.close()
      }
    })

    it('400 invalid_body when triggerText is empty', async () => {
      const calls: QueueCall[] = []
      const app = await buildTestApp(recordingQueue(calls))
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/campaigns/c-fire-1/fire-turn',
          headers: { 'content-type': 'application/json' },
          payload: { triggerText: '' },
        })
        expect(res.statusCode).toBe(400)
        expect(res.json<{ code: string }>().code).toBe('invalid_body')
        expect(calls).toHaveLength(0)
      } finally {
        await app.close()
      }
    })

    it('409 no_active_session when the campaign has no live session', async () => {
      getActiveByCampaignMock.mockResolvedValue(null)
      const calls: QueueCall[] = []
      const app = await buildTestApp(recordingQueue(calls))
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/campaigns/c-fire-1/fire-turn',
          headers: { 'content-type': 'application/json' },
          payload: { triggerText: 'I open the door' },
        })
        expect(res.statusCode).toBe(409)
        expect(res.json()).toEqual({ code: 'no_active_session' })
        expect(getActiveByCampaignMock).toHaveBeenCalledWith('c-fire-1')
        expect(calls).toHaveLength(0)
      } finally {
        await app.close()
      }
    })

    it('202 with a turnId and enqueues exactly one job with the dev trigger', async () => {
      getActiveByCampaignMock.mockResolvedValue(ACTIVE_SESSION)
      // The route reads the active session's durable max seq as the §4.6
      // maxConsumedSeq watermark — assert the real value rides the payload.
      maxSeqMock.mockResolvedValue(5)
      const calls: QueueCall[] = []
      const app = await buildTestApp(recordingQueue(calls))
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/campaigns/c-fire-1/fire-turn',
          headers: { 'content-type': 'application/json' },
          payload: { triggerText: 'I open the door' },
        })
        expect(res.statusCode).toBe(202)
        const body = res.json<{ turnId: string }>()
        expect(body.turnId).toMatch(/^[0-9a-f-]{36}$/)

        // The session was resolved for THIS campaign and exactly one job
        // enqueued, carrying the resolved sessionId, the request-allocated
        // turnId, and the fixed dev trigger identity.
        expect(getActiveByCampaignMock).toHaveBeenCalledWith('c-fire-1')
        // The watermark is read for the resolved active session.
        expect(maxSeqMock).toHaveBeenCalledWith(ACTIVE_SESSION.id)
        expect(calls).toHaveLength(1)
        expect(calls[0]?.payload).toEqual({
          campaignId: 'c-fire-1',
          sessionId: ACTIVE_SESSION.id,
          turnId: body.turnId,
          triggerMessages: [{ userId: 'dev', characterName: 'Dev', text: 'I open the door' }],
          // MYT-67 §4.6 metadata (dev poke → explicit, real maxSeq watermark).
          maxConsumedSeq: 5,
          trigger: { kind: 'explicit' },
        })
      } finally {
        await app.close()
      }
    })
  })
})
