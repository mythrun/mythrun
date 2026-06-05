// Drives the forward-check throw at app.ts:142-147 (a route registered
// with config.pipelineRoute=true whose key is NOT in PIPELINE_ROUTES).
//
// Mocks the contract module to OMIT one of the real entries — when the
// matching real route registers with pipelineRoute=true the onRoute hook
// fires, doesn't find the key in (mocked-shorter) PIPELINE_ROUTES, and
// throws during buildApp.
//
// Lives in its own file because vi.mock is hoisted per-file and the
// sibling app-pipeline-contract.test.ts mocks PIPELINE_ROUTES with the
// opposite shape (phantom entry added, no entry removed).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// createRepo (transitively imported via buildApp) composes usersNs ∪
// selfManagingUsers, so the mock must expose all three named exports.
const stubOnboarded = () => ({
  getByCognitoSubWithTimeout: vi.fn().mockResolvedValue({
    id: 'stub-user-id',
    cognitoSub: 'bypass:dev-1',
    username: 'bypass',
    displayName: 'Bypass',
    suspendedAt: null,
  }),
})
vi.mock('../repo/users.js', () => ({
  usersNs: () => ({}),
  selfManagingUsers: () => stubOnboarded(),
  createUsersRepo: () => stubOnboarded(),
}))

vi.mock('../contract/pipeline-routes.js', () => ({
  PIPELINE_ROUTES: [
    // Intentionally OMIT 'DELETE /api/campaigns/:campaignId' even though
    // the real campaigns plugin still registers it with pipelineRoute=true.
    // The forward check should fire on that route's registration.
    'GET /api/campaigns/:campaignId/status',
    'GET /api/campaigns/:campaignId/status/stream',
    'POST /api/campaigns',
    'GET /api/campaigns/:campaignId',
    'GET /api/campaigns/mine',
    'POST /api/campaigns/:campaignId/resume',
  ],
}))

import { buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'
import type { Pool } from 'pg'
import IoredisMock from 'ioredis-mock'
import { createRepo } from '../repo/index.js'
import { _resetSkuCacheForTests } from '../billing/sku-cache.js'
import { makeStubEnv } from './helpers/stub-env.js'
import { noopSessionSuspendQueue, noopSessionTurnQueue } from './helpers/stub-deps.js'

function makeStubDeps(): AppDeps {
  const pool = {} as Pool
  return {
    pg: pool,
    redisRealtime: new IoredisMock(),
    redisBatch: new IoredisMock(),
    redisKeyPrefix: 'test:',
    repo: createRepo(pool),
    worldGenQueue: {
      add: (): Promise<unknown> => Promise.resolve(undefined),
      getJobCounts: (): Promise<Record<string, number>> => Promise.resolve({}),
      getJob: (): Promise<null> => Promise.resolve(null),
    },
    sessionPrepQueue: { add: (): Promise<unknown> => Promise.resolve(undefined) },
    sessionSuspendQueue: noopSessionSuspendQueue(),
    sessionTurnQueue: noopSessionTurnQueue(),
  }
}

describe('buildApp pipeline-routes contract forward check', () => {
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

  it('throws when a real route registers with pipelineRoute=true but is not in PIPELINE_ROUTES', async () => {
    // buildApp tries to register DELETE /api/campaigns/:campaignId with
    // pipelineRoute=true; the onRoute hook fires, doesn't find that key
    // in the (mocked-shorter) PIPELINE_ROUTES list, and throws.
    await expect(
      buildApp(
        makeStubDeps(),
        { mode: 'bypass' },
        { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv() },
      ),
    ).rejects.toThrow(/is registered with config\.pipelineRoute=true but is not/)
  })
})
