// backend/src/__tests__/helpers/stub-deps.ts
//
// Shape-only stubs for backend tests. NO real ioredis / pg clients —
// importing the real modules at test-load time can hang CI on
// connect-refused retry loops (Titan Round-2 H1).
//
// The Redis side uses ioredis-mock (in-process, no network) as the
// underlying client. @fastify/rate-limit calls redis.defineCommand at
// register time; a {ping, quit}-only stub fails there. ioredis-mock
// supports defineCommand + Lua scripts so the plugin registers cleanly.
// Tests that need ping failure paths override the ping method on top
// of the mock instance.

import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import IoredisMock from 'ioredis-mock'
import type { AppDeps } from '../../app-deps.js'
import { createRepo } from '../../repo/index.js'

export interface StubDepsOverrides {
  pgQuery?: () => Promise<unknown>
  pingRealtime?: () => Promise<string>
  pingBatch?: () => Promise<string>
}

function makeMockRedis(pingOverride?: () => Promise<string>): Redis {
  const mock = new IoredisMock()
  if (pingOverride) {
    // ioredis's ping() return type is Promise<'PONG'> (the literal),
    // but for tests we want to inject reject paths. Cast through unknown
    // to widen the slot to a generic Promise<string>; the runtime contract
    // is just "thenable" anyway.
    ;(mock as unknown as { ping: () => Promise<string> }).ping = pingOverride
  }
  return mock
}

export function makeStubDeps(overrides: StubDepsOverrides = {}): AppDeps {
  // Promise.resolve / Promise.reject form (not `async () =>`) avoids the
  // @typescript-eslint/require-await lint on stubs that don't internally
  // await anything — same Promise<T> shape, lint-clean.
  const pg = {
    query: overrides.pgQuery ?? ((): Promise<{ rows: unknown[] }> => Promise.resolve({ rows: [] })),
    end: (): Promise<void> => Promise.resolve(),
  } as unknown as Pool
  return {
    pg,
    redisRealtime: makeMockRedis(overrides.pingRealtime),
    redisBatch: makeMockRedis(overrides.pingBatch),
    redisKeyPrefix: 'test:use1:',
    repo: createRepo(pg),
  }
}
