// backend/src/contract/__tests__/backend-routes.test.ts
//
// Drift-prevention test for the full-route contract source. Boots a Fastify
// app via the production app factory, enumerates every registered route via
// app.printRoutes({ commonPrefix: false }), and asserts the in-memory set is
// identical to BACKEND_ROUTES. New routes added to a handler without
// updating the contract source fail this test.
//
// The mocks below mirror app.test.ts: we stub the users repo so
// requireOnboarded can register without a real DB, and we stub fetch so the
// bypass plugin's ECS task-metadata probe fails cleanly.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'

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
vi.mock('../../repo/users.js', () => ({
  usersNs: () => ({}),
  selfManagingUsers: () => stubOnboarded(),
  createUsersRepo: () => stubOnboarded(),
}))

import IoredisMock from 'ioredis-mock'
import type { Pool } from 'pg'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../app.js'
import type { AppDeps } from '../../app-deps.js'
import { createRepo } from '../../repo/index.js'
import { _resetSkuCacheForTests } from '../../billing/sku-cache.js'
import { makeStubEnv } from '../../__tests__/helpers/stub-env.js'
import { noopSessionSuspendQueue, noopSessionTurnQueue } from '../../__tests__/helpers/stub-deps.js'
import { BACKEND_ROUTES } from '../backend-routes.js'

interface PrintedRoute {
  readonly method: string
  readonly path: string
}

// Filtered out because Fastify auto-generates HEAD for every GET and we
// don't want to surface that as contract noise. The drift test cares about
// the routes the application actually defines.
const FILTERED_METHODS = new Set(['HEAD', 'OPTIONS'])

// Fastify's `app.printRoutes({ commonPrefix: false })` returns a tree-formatted
// string that walks down the route radix-trie:
//
//   ├── /api/campaigns (POST)
//   │   ├── /mine (GET, HEAD)
//   │   └── /:id|:campaignId (GET, HEAD, DELETE)
//   │       ├── /invites (POST, GET, HEAD)
//   │       │   └── /:inviteCode (DELETE)
//
// Each line is `<indent + box-drawing> <path-segment> (METHODS)`. The full
// path of any line is the concatenation of every ancestor's segment plus
// the current line's segment. The `commonPrefix:false` flag gives one
// segment per node (otherwise siblings get squashed under a shared prefix).
//
// `:id|:campaignId` is Fastify's display for a parameterized node that
// multiple plugins named differently — both campaigns.ts and invites.ts
// declare `:campaignId`, and one of them lands in a pre-existing radix node
// labeled `:id` from another plugin. `:id|:campaignId|:sessionId` is the
// 3-way version under `/api/sessions/`: the sessions plugin declares the same
// radix param node under four route names (ws-ticket `:id`, start/active
// `:campaignId`, messages `:sessionId`), so Fastify prints the merged label.
//
// These merged tokens appear EITHER as a standalone tree-node segment
// (`└── /:id|:campaignId (...)`, the campaigns case) OR embedded mid-string
// in a flat full-path line (`/api/sessions/:id|:campaignId|:sessionId/start`,
// the sessions case — those routes share no collapsible parent node). So we
// replace the token wherever it occurs in the segment rather than exact-match
// the whole segment. Each merged token collapses to the single canonical name
// the corresponding BACKEND_ROUTES entries use.
//
// Order matters: replace the 3-way token before the 2-way so the longer one
// wins (the 2-way is a substring of the 3-way).
const PARAM_TOKEN_ALIASES: readonly (readonly [string, string])[] = [
  [':id|:campaignId|:sessionId', ':id'],
  [':id|:campaignId', ':campaignId'],
]

function normalizeParamTokens(segment: string): string {
  let out = segment
  for (const [token, canonical] of PARAM_TOKEN_ALIASES) {
    out = out.split(token).join(canonical)
  }
  return out
}

function parsePrintedRoutes(app: FastifyInstance): PrintedRoute[] {
  const raw = app.printRoutes({ commonPrefix: false })
  const lines = raw.split('\n')
  // Each entry on the stack is { depth, accumulatedPath }. depth is the
  // visual column where the path-segment starts (after the box-drawing).
  const stack: { depth: number; path: string }[] = []
  const out: PrintedRoute[] = []
  const seen = new Set<string>()

  for (const rawLine of lines) {
    // Match: optional indent of box-drawing/whitespace, then the path
    // segment, then ' (METHODS)' optionally. The path segment ends at the
    // first ' (' that introduces the methods.
    //
    // Fastify's radix-trie collapses common prefixes, so a path segment is
    // EITHER one that starts with '/' (a top-level or child route node)
    // OR a suffix-only segment with no leading slash (a longer-prefix
    // continuation; e.g. parent `/starting-situation` + child `s` =
    // `/starting-situations`). Both cases concatenate cleanly because the
    // parent's full path is parentPath + segment regardless of whether
    // segment starts with '/'.
    const match = /^([\s│├└─]*)([\/\w:.\-{}|]+)(?:\s+\(([^)]+)\))?\s*$/.exec(rawLine)
    if (!match) continue
    const indent = match[1] ?? ''
    let segment = match[2] ?? ''
    const methodsRaw = match[3]
    const depth = indent.length

    // Normalize merged param tokens (`:id|:campaignId`, the 3-way sessions
    // variant) to their canonical name so the tree walk reconstructs the
    // path BACKEND_ROUTES uses. Token-level (not exact-segment) replacement
    // handles both standalone param nodes and flat full-path lines.
    segment = normalizeParamTokens(segment)

    // Pop stack entries that are at the same depth or deeper — we're
    // descending into a new sibling/uncle.
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top && top.depth >= depth) stack.pop()
      else break
    }

    const parentPath = stack.length > 0 ? (stack[stack.length - 1]?.path ?? '') : ''
    // Joining path segments: parent might be '/api/campaigns', segment
    // might be '/mine' → '/api/campaigns/mine'. Root segment is its own
    // full path.
    const fullPath = parentPath + segment
    stack.push({ depth, path: fullPath })

    if (!methodsRaw) continue
    const methods = methodsRaw.split(',').map((m) => m.trim())
    for (const method of methods) {
      if (FILTERED_METHODS.has(method)) continue
      const key = `${method} ${fullPath}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ method, path: fullPath })
    }
  }
  return out
}

function toKey(r: { method: string; path: string }): string {
  return `${r.method} ${r.path}`
}

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
    sessionPrepQueue: { add: (): Promise<unknown> => Promise.resolve(undefined) },
    sessionSuspendQueue: noopSessionSuspendQueue(),
    sessionTurnQueue: noopSessionTurnQueue(),
  }
}

describe('BACKEND_ROUTES contract drift', () => {
  let app: FastifyInstance

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

  beforeAll(async () => {
    // Match app.test.ts's stub-env setup so registerAuth / billing plugin
    // / requireOnboarded all complete registration. We never serve a
    // request — we only need every route attached so printRoutes() sees
    // them.
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('COGNITO_USER_POOL_ID', '')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
    vi.stubEnv('COGNITO_ISSUER_URL', '')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
    globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
    _resetSkuCacheForTests()

    app = await buildApp(
      makeStubDeps(),
      { mode: 'bypass' },
      { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv() },
    )
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('BACKEND_ROUTES enumerates every route the Fastify app registers', () => {
    const printed = parsePrintedRoutes(app).map(toKey).sort()
    const contracted = BACKEND_ROUTES.map(toKey).sort()
    expect(printed).toEqual(contracted)
  })
})
