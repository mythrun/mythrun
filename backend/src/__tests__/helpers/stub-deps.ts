// backend/src/__tests__/helpers/stub-deps.ts
//
// Shape-only stubs for backend tests. NO real ioredis / pg clients —
// importing the real modules at test-load time can hang CI on
// connect-refused retry loops (Titan Round-2 H1).

import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { AppDeps } from '../../app-deps.js'
import { createRepo } from '../../repo/index.js'

export interface StubDepsOverrides {
  pgQuery?: () => Promise<unknown>
  pingRealtime?: () => Promise<string>
  pingBatch?: () => Promise<string>
}

export function makeStubDeps(overrides: StubDepsOverrides = {}): AppDeps {
  // Promise.resolve / Promise.reject form (not `async () =>`) avoids the
  // @typescript-eslint/require-await lint on stubs that don't internally
  // await anything — same Promise<T> shape, lint-clean.
  const pg = {
    query: overrides.pgQuery ?? ((): Promise<{ rows: unknown[] }> => Promise.resolve({ rows: [] })),
    end: (): Promise<void> => Promise.resolve(),
  } as unknown as Pool
  const redisRealtime = {
    ping: overrides.pingRealtime ?? ((): Promise<string> => Promise.resolve('PONG')),
    quit: (): Promise<string> => Promise.resolve('OK'),
  } as unknown as Redis
  const redisBatch = {
    ping: overrides.pingBatch ?? ((): Promise<string> => Promise.resolve('PONG')),
    quit: (): Promise<string> => Promise.resolve('OK'),
  } as unknown as Redis
  return {
    pg,
    redisRealtime,
    redisBatch,
    repo: createRepo(pg),
  }
}
