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
import type { WorldGenQueueLike } from '../../routes/campaigns.js'
import type { SessionPrepQueueLike } from '../../routes/session-preps.js'
import type { SuspendQueueLike } from '../../session/session-suspend.js'
import type { TurnQueueLike } from '../../session/turn-queue.js'
import { createRepo } from '../../repo/index.js'

export interface StubDepsOverrides {
  pgQuery?: () => Promise<unknown>
  pingRealtime?: () => Promise<string>
  pingBatch?: () => Promise<string>
  worldGenQueue?: WorldGenQueueLike
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

/**
 * Hand-rolled no-op queue. Suffices for buildApp callers that never
 * exercise POST /api/campaigns (the majority — health-ready, onboarding,
 * invite-flow, etc.); tests that DO drive enqueue paths build their own
 * spy with assertion hooks (see routes/__tests__/campaigns-create.test.ts).
 *
 * Exported so other tests that build their own `AppDeps` inline (rather
 * than calling makeStubDeps) can satisfy the type contract without
 * re-hand-rolling the shape.
 */
export function noopWorldGenQueue(): WorldGenQueueLike {
  return {
    add: () => Promise.resolve(undefined),
    getJobCounts: () => Promise.resolve({}),
    getJob: () => Promise.resolve(null),
  }
}

/**
 * Hand-rolled no-op session-prep queue. Mirrors noopWorldGenQueue — suffices
 * for buildApp callers that never exercise the MYT-63 trigger route; tests
 * that drive enqueue build their own spy.
 */
export function noopSessionPrepQueue(): SessionPrepQueueLike {
  return {
    add: (): Promise<unknown> => Promise.resolve(undefined),
  }
}

/**
 * Hand-rolled no-op session-suspend queue (MYT-65 Task 11). Mirrors the other
 * noop queues — suffices for buildApp callers that don't drive the WS
 * schedule/cancel path; tests that exercise suspend build their own spy.
 *
 * `SuspendQueueLike.add` is BullMQ's real `Queue['add']` signature (returns a
 * `Promise<Job>`), which a no-op can't honestly construct; the resolved-
 * undefined stub is cast through `unknown` at the single function boundary —
 * none of these buildApp callers read the returned Job.
 */
export function noopSessionSuspendQueue(): SuspendQueueLike {
  return {
    add: (() => Promise.resolve(undefined)) as unknown as SuspendQueueLike['add'],
    getJob: () => Promise.resolve(undefined),
    remove: () => Promise.resolve(0),
  }
}

/**
 * Hand-rolled no-op session-turn queue (MYT-66 Task 8). Mirrors the other noop
 * queues — suffices for buildApp callers that don't drive the turn-enqueue
 * path; tests that exercise enqueueTurn build their own spy.
 *
 * Like noopSessionSuspendQueue, `TurnQueueLike.add` is BullMQ's real
 * `Queue['add']` signature (returns a `Promise<Job>`), which a no-op can't
 * honestly construct; the resolved-undefined stub is cast through `unknown` at
 * the single function boundary — none of these buildApp callers read the Job.
 */
export function noopSessionTurnQueue(): TurnQueueLike {
  return {
    add: (() => Promise.resolve(undefined)) as unknown as TurnQueueLike['add'],
  }
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
    worldGenQueue: overrides.worldGenQueue ?? noopWorldGenQueue(),
    sessionPrepQueue: noopSessionPrepQueue(),
    sessionSuspendQueue: noopSessionSuspendQueue(),
    sessionTurnQueue: noopSessionTurnQueue(),
  }
}
