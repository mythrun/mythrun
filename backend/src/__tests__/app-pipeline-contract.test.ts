// Drives the onReady contract throw at app.ts:151-160 (reverse check:
// an entry in PIPELINE_ROUTES that no route ever registered with
// config.pipelineRoute=true).
//
// Mocks the contract module to ADD a phantom route that no plugin
// registers — the existing forward check (onRoute hook at line 134) is
// not triggered because the phantom isn't registered anywhere; only the
// onReady reverse check fires.
//
// Lives in its own file because vi.mock is hoisted per-file and the
// sibling app.test.ts asserts against the real PIPELINE_ROUTES shape.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../repo/users.js', () => ({
  createUsersRepo: () => ({
    getByCognitoSubWithTimeout: vi.fn().mockResolvedValue({
      id: 'stub-user-id',
      cognitoSub: 'bypass:dev-1',
      username: 'bypass',
      displayName: 'Bypass',
      suspendedAt: null,
    }),
  }),
}))

vi.mock('../contract/pipeline-routes.js', () => ({
  PIPELINE_ROUTES: [
    // The real entries — these stay registered by the real routes/plugins.
    // EVERY entry the campaigns + campaign-characters plugins register
    // must be listed here, otherwise the forward-check onRoute hook
    // (app.ts:146-167) throws BEFORE the reverse-check onReady hook gets
    // to fire — and this test is specifically about the reverse-check
    // path.
    'GET /api/campaigns/:campaignId/status',
    'GET /api/campaigns/:campaignId/status/stream',
    'POST /api/campaigns',
    'GET /api/campaigns/:campaignId',
    'GET /api/campaigns/mine',
    'POST /api/campaigns/:campaignId/resume',
    'DELETE /api/campaigns/:campaignId',
    'PATCH /api/campaigns/:campaignId/name',
    'GET /api/campaigns/:campaignId/world-snapshot',
    // MYT-53 per-player character creation (campaign-characters plugin):
    'POST /api/campaigns/:campaignId/starting-situation',
    'POST /api/campaigns/:campaignId/characters',
    'GET /api/campaigns/:campaignId/starting-situations',
    'GET /api/campaigns/:campaignId/characters',
    'GET /api/campaigns/:campaignId/characters/:charId',
    'GET /api/campaigns/:campaignId/hierarchy',
    'GET /api/campaigns/:campaignId/random-tables',
    // MYT-54 cross-PC integration (campaign-characters plugin):
    'GET /api/campaigns/:campaignId/character-creation-progress',
    'POST /api/campaigns/:campaignId/finalize-character-creation',
    // Phantom entry — no plugin registers this route. The onReady hook
    // sees it in PIPELINE_ROUTES, can't find it in registeredPipelineRoutes,
    // and throws.
    'GET /api/phantom-never-registered',
  ],
}))

import { buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'
import type { Pool } from 'pg'
import IoredisMock from 'ioredis-mock'
import { createRepo } from '../repo/index.js'
import { _resetSkuCacheForTests } from '../billing/sku-cache.js'
import { makeStubEnv } from './helpers/stub-env.js'

const makeStubDeps = (): AppDeps => {
  const mockPool = {} as Pool
  return {
    pg: mockPool,
    redisRealtime: new IoredisMock(),
    redisBatch: new IoredisMock(),
    redisKeyPrefix: 'test:use1:',
    repo: createRepo(mockPool),
    worldGenQueue: {
      add: (): Promise<unknown> => Promise.resolve(undefined),
      getJobCounts: (): Promise<Record<string, number>> => Promise.resolve({}),
      getJob: (): Promise<null> => Promise.resolve(null),
    },
  }
}

describe('buildApp pipeline-routes contract reverse check', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('COGNITO_USER_POOL_ID', '')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
    vi.stubEnv('COGNITO_ISSUER_URL', '')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
    globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
    _resetSkuCacheForTests()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    _resetSkuCacheForTests()
  })

  it('throws on app.ready() when PIPELINE_ROUTES has an unregistered entry', async () => {
    // buildApp registers everything but does NOT await ready(). Build it
    // then ask for ready() — that runs the onReady hook which iterates
    // PIPELINE_ROUTES looking for registered handlers and throws.
    const app = await buildApp(
      makeStubDeps(),
      { mode: 'bypass' },
      { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv() },
    )
    try {
      await expect(app.ready()).rejects.toThrow(
        /no route ever registered.*phantom-never-registered/,
      )
    } finally {
      await app.close()
    }
  })
})
