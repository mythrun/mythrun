// llm-outage-resilience Task 3 — Redis health tracker tests.
//
// Runs against the REAL realtime Redis (6379, the dev docker stack), never
// ioredis-mock: both state transitions are Lua scripts whose correctness IS
// their server-side atomicity (evaluate-window + SET NX + seed at arm;
// verify-counter + DEL at clear — design §2.1), which only exists against a
// real Redis. Mirrors session-lock.test.ts. No Postgres rows are created, so
// no TestScope; isolation is a unique key prefix per test (randomUUID), and
// every key carries a TTL so even an aborted run leaves nothing behind.
//
// Constructed-state idiom: stale window members are seeded directly via ZADD
// at back-dated Redis-TIME scores — the only way to exercise the 10-minute
// arming horizon and the 30-minute prune without waiting wall-clock time.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import pino from 'pino'
import { createRedisClient } from '../../redis/client.js'
import {
  createLlmHealthTracker,
  timeReplyToMs,
  type LlmHealthReport,
  type LlmHealthTracker,
} from '../llm-health.js'

const REDIS_URL = process.env.REDIS_REALTIME_URL ?? 'redis://127.0.0.1:6379'

/** Pino logger writing JSON lines into an array so tests can assert the
 *  llm_health.degraded / llm_health.recovered structured events. */
function makeCapturedLogger(): { logger: pino.Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = []
  const logger = pino(
    { level: 'debug' },
    {
      write: (line: string): void => {
        lines.push(JSON.parse(line) as Record<string, unknown>)
      },
    },
  )
  return { logger, lines }
}

function makeReport(overrides: Partial<LlmHealthReport> = {}): LlmHealthReport {
  return {
    callsite: 'stage:coherence-pass',
    jobId: 'job-1',
    modelId: 'model-opus',
    mode: 'streaming',
    ...overrides,
  }
}

/** Epoch-ms from Redis TIME — the same clock the tracker scores with, so
 *  back-dated seeds and horizon assertions never depend on the local clock. */
async function redisNowMs(redis: Redis): Promise<number> {
  const reply = await redis.time()
  return (reply[0] ?? 0) * 1000 + Math.floor((reply[1] ?? 0) / 1000)
}

/** Seed a window member shaped exactly like the tracker's own, back-dated to
 *  `score` — the constructed-state hook for horizon + prune tests. */
async function seedWindowEvent(
  redis: Redis,
  prefix: string,
  score: number,
  fields: { callsite: string; jobId: string; modelId: string },
): Promise<void> {
  const member = JSON.stringify({ ts: score, ...fields, nonce: randomUUID() })
  await redis.zadd(`${prefix}llm-health:window`, score, member)
}

describe('createLlmHealthTracker', () => {
  let redis: Redis

  beforeAll(async () => {
    redis = createRedisClient(REDIS_URL)
    // createRedisClient is lazyConnect — connect explicitly so the first
    // command doesn't race the TCP handshake.
    await redis.connect()
  })

  afterAll(async () => {
    await redis.quit()
  })

  /** Fresh tracker under a unique prefix per test — full keyspace isolation. */
  function makeTracker(): {
    tracker: LlmHealthTracker
    prefix: string
    lines: Record<string, unknown>[]
  } {
    const prefix = `test:llm-health:${randomUUID()}:`
    const { logger, lines } = makeCapturedLogger()
    return { tracker: createLlmHealthTracker(redis, prefix, logger), prefix, lines }
  }

  describe('arming (report)', () => {
    it('stays ok below the threshold: two events from one callsite + one job', async () => {
      const { tracker, lines } = makeTracker()
      await tracker.report(makeReport())
      await tracker.report(makeReport())
      expect(await tracker.read()).toEqual({ state: 'ok', since: null })
      expect(lines.some((l) => l.event === 'llm_health.degraded')).toBe(false)
    })

    it('arms exactly at the 3rd qualifying event when it adds a second callsite', async () => {
      const { tracker, lines } = makeTracker()
      await tracker.report(makeReport({ callsite: 'stage:a', modelId: 'model-a' }))
      await tracker.report(makeReport({ callsite: 'stage:a', modelId: 'model-a' }))
      expect(await tracker.read()).toEqual({ state: 'ok', since: null })

      await tracker.report(makeReport({ callsite: 'stage:b', modelId: 'model-b' }))
      const state = await tracker.read()
      expect(state.state).toBe('degraded')
      expect(state.since).toEqual(expect.any(Number))

      // Transition log: llm_health.degraded with a window summary + models
      // (triage works from CloudWatch without Redis access — §2.1).
      const degraded = lines.find((l) => l.event === 'llm_health.degraded')
      expect(degraded).toBeDefined()
      expect(degraded?.windowCount).toBe(3)
      expect(degraded?.callsites).toEqual(expect.arrayContaining(['stage:a', 'stage:b']))
      expect(degraded?.models).toEqual(expect.arrayContaining(['model-a', 'model-b']))
    })

    it('never arms on 3 events spanning one callsite AND one job (distinctness rule)', async () => {
      const { tracker, prefix } = makeTracker()
      await tracker.report(makeReport())
      await tracker.report(makeReport())
      await tracker.report(makeReport())
      expect(await tracker.read()).toEqual({ state: 'ok', since: null })
      // The events were still recorded — they just don't qualify.
      expect(await redis.zcard(`${prefix}llm-health:window`)).toBe(3)
    })

    it('arms on two distinct jobIds from the same callsite', async () => {
      const { tracker } = makeTracker()
      await tracker.report(makeReport({ jobId: 'job-1' }))
      await tracker.report(makeReport({ jobId: 'job-1' }))
      await tracker.report(makeReport({ jobId: 'job-2' }))
      expect((await tracker.read()).state).toBe('degraded')
    })

    it('ignores events older than the 10-minute arming horizon', async () => {
      const { tracker, prefix } = makeTracker()
      const now = await redisNowMs(redis)
      // Two distinct-callsite events just past the horizon: with the fresh
      // report below that is 3 events in retention — but only 1 counts.
      await seedWindowEvent(redis, prefix, now - 11 * 60_000, {
        callsite: 'stage:a',
        jobId: 'job-a',
        modelId: 'model-a',
      })
      await seedWindowEvent(redis, prefix, now - 11 * 60_000, {
        callsite: 'stage:b',
        jobId: 'job-b',
        modelId: 'model-b',
      })
      await tracker.report(makeReport({ callsite: 'stage:c', jobId: 'job-c' }))
      expect(await tracker.read()).toEqual({ state: 'ok', since: null })
    })

    it('prunes window members older than 30 minutes on report', async () => {
      const { tracker, prefix } = makeTracker()
      const now = await redisNowMs(redis)
      for (let i = 0; i < 4; i++) {
        await seedWindowEvent(redis, prefix, now - 31 * 60_000 - i, {
          callsite: `stage:${String(i)}`,
          jobId: `job-${String(i)}`,
          modelId: 'model-old',
        })
      }
      await tracker.report(makeReport())
      // The four stale members are gone; only the fresh event remains.
      expect(await redis.zcard(`${prefix}llm-health:window`)).toBe(1)
    })

    it('seeds the models set and resets the probe counter at arm', async () => {
      const { tracker, prefix } = makeTracker()
      // A stale probe counter from a previous episode must not survive into
      // the new degraded state (§2.1: counter reset on arming).
      await redis.set(`${prefix}llm-health:probe-successes`, '2')
      await tracker.report(makeReport({ callsite: 'stage:a', modelId: 'model-a' }))
      await tracker.report(makeReport({ callsite: 'stage:b', modelId: 'model-b' }))
      await tracker.report(makeReport({ callsite: 'stage:c', modelId: 'model-a' }))

      expect((await tracker.read()).state).toBe('degraded')
      expect(await tracker.readModels()).toEqual(['model-a', 'model-b'])
      expect(await redis.exists(`${prefix}llm-health:probe-successes`)).toBe(0)
      // State + models carry the 30-minute TTL.
      const stateTtl = await redis.ttl(`${prefix}llm-health:state`)
      expect(stateTtl).toBeGreaterThan(0)
      expect(stateTtl).toBeLessThanOrEqual(30 * 60)
      expect(await redis.ttl(`${prefix}llm-health:models`)).toBeGreaterThan(0)
    })

    it('keeps the window on a rolling 30-minute TTL', async () => {
      const { tracker, prefix } = makeTracker()
      await tracker.report(makeReport())
      const pttl = await redis.pttl(`${prefix}llm-health:window`)
      expect(pttl).toBeGreaterThan(0)
      expect(pttl).toBeLessThanOrEqual(30 * 60_000)
    })

    it('uses the four spec key names and a JSON {since} state payload', async () => {
      const { tracker, prefix } = makeTracker()
      await tracker.report(makeReport({ callsite: 'stage:a' }))
      await tracker.report(makeReport({ callsite: 'stage:b' }))
      await tracker.report(makeReport({ callsite: 'stage:c' }))
      await tracker.probeSuccess() // materializes the counter key
      expect(await redis.exists(`${prefix}llm-health:window`)).toBe(1)
      expect(await redis.exists(`${prefix}llm-health:state`)).toBe(1)
      expect(await redis.exists(`${prefix}llm-health:models`)).toBe(1)
      expect(await redis.exists(`${prefix}llm-health:probe-successes`)).toBe(1)
      // The state blob is exactly the §4.1-derivable JSON {since}.
      const raw = await redis.get(`${prefix}llm-health:state`)
      const parsed = JSON.parse(raw ?? '{}') as { since?: unknown }
      expect(parsed.since).toEqual(expect.any(Number))
      expect(parsed.since).toBe((await tracker.read()).since)
    })
  })

  describe('reports while degraded', () => {
    it('resets the probe counter and unions the model set; no second degraded log', async () => {
      const { tracker, prefix, lines } = makeTracker()
      await tracker.report(makeReport({ callsite: 'stage:a', modelId: 'model-a' }))
      await tracker.report(makeReport({ callsite: 'stage:b', modelId: 'model-a' }))
      await tracker.report(makeReport({ callsite: 'stage:c', modelId: 'model-a' }))
      expect((await tracker.read()).state).toBe('degraded')

      expect(await tracker.probeSuccess()).toBe('counting')
      expect(await redis.get(`${prefix}llm-health:probe-successes`)).toBe('1')

      await tracker.report(makeReport({ callsite: 'stage:d', modelId: 'model-d' }))
      // §2.1: any new connectivity-class report resets the clear counter…
      expect(await redis.exists(`${prefix}llm-health:probe-successes`)).toBe(0)
      // …and SADDs its model into the implicated set.
      expect(await tracker.readModels()).toEqual(['model-a', 'model-d'])
      // Still one arm transition — the degraded log fires once per episode.
      expect(lines.filter((l) => l.event === 'llm_health.degraded')).toHaveLength(1)
    })

    it('keeps the models TTL in lockstep with the state TTL', async () => {
      const { tracker, prefix } = makeTracker()
      await tracker.report(makeReport({ callsite: 'stage:a' }))
      await tracker.report(makeReport({ callsite: 'stage:b' }))
      await tracker.report(makeReport({ callsite: 'stage:c' }))
      // Shrink the state TTL; a degraded report must not out-live it via models.
      await redis.pexpire(`${prefix}llm-health:state`, 60_000)
      await tracker.report(makeReport({ callsite: 'stage:d' }))
      const modelsPttl = await redis.pttl(`${prefix}llm-health:models`)
      expect(modelsPttl).toBeGreaterThan(0)
      expect(modelsPttl).toBeLessThanOrEqual(60_000)
    })
  })

  describe('read + readModels', () => {
    it('reads ok/null and an empty model list on a fresh keyspace', async () => {
      const { tracker } = makeTracker()
      expect(await tracker.read()).toEqual({ state: 'ok', since: null })
      expect(await tracker.readModels()).toEqual([])
    })

    it('reads degraded with a null since on a corrupt state blob', async () => {
      // Presence ⇔ degraded (§2.1): a corrupt blob still means degraded — the
      // key existing is the signal; only the timestamp is lost.
      const { tracker, prefix } = makeTracker()
      await redis.set(`${prefix}llm-health:state`, '{not json')
      expect(await tracker.read()).toEqual({ state: 'degraded', since: null })
    })

    it('reads degraded with a null since when the blob is not an object or has no numeric since', async () => {
      const { tracker, prefix } = makeTracker()
      await redis.set(`${prefix}llm-health:state`, '42')
      expect(await tracker.read()).toEqual({ state: 'degraded', since: null })
      await redis.set(`${prefix}llm-health:state`, '{"since":"soon"}')
      expect(await tracker.read()).toEqual({ state: 'degraded', since: null })
    })
  })

  describe('probe cycle (probeSuccess / probeFailure)', () => {
    it('probeSuccess counts to 3 then clears all four keys and logs the recovery', async () => {
      const { tracker, prefix, lines } = makeTracker()
      await tracker.report(makeReport({ callsite: 'stage:a' }))
      await tracker.report(makeReport({ callsite: 'stage:b' }))
      await tracker.report(makeReport({ callsite: 'stage:c' }))
      expect((await tracker.read()).state).toBe('degraded')

      expect(await tracker.probeSuccess()).toBe('counting')
      // The counter carries its own 30-minute TTL while counting.
      expect(await redis.ttl(`${prefix}llm-health:probe-successes`)).toBeGreaterThan(0)
      expect(await tracker.probeSuccess()).toBe('counting')
      expect(await tracker.probeSuccess()).toBe('cleared')

      for (const key of ['window', 'state', 'models', 'probe-successes']) {
        expect(await redis.exists(`${prefix}llm-health:${key}`)).toBe(0)
      }
      expect(await tracker.read()).toEqual({ state: 'ok', since: null })

      const recovered = lines.find((l) => l.event === 'llm_health.recovered')
      expect(recovered).toBeDefined()
      expect(recovered?.durationMs).toEqual(expect.any(Number))
      expect(recovered?.durationMs as number).toBeGreaterThanOrEqual(0)
    })

    it('a clear that finds no state blob logs a null duration', async () => {
      // Defensive arm: the probe only runs while degraded, but a clear racing
      // a TTL lapse must still resolve — with no since to compute from.
      const { tracker, lines } = makeTracker()
      expect(await tracker.probeSuccess()).toBe('counting')
      expect(await tracker.probeSuccess()).toBe('counting')
      expect(await tracker.probeSuccess()).toBe('cleared')
      const recovered = lines.find((l) => l.event === 'llm_health.recovered')
      expect(recovered).toBeDefined()
      expect(recovered?.durationMs).toBeNull()
    })

    it('probeFailure resets the counter and refreshes the state + models TTLs', async () => {
      const { tracker, prefix } = makeTracker()
      await tracker.report(makeReport({ callsite: 'stage:a' }))
      await tracker.report(makeReport({ callsite: 'stage:b' }))
      await tracker.report(makeReport({ callsite: 'stage:c' }))
      await tracker.probeSuccess()
      await tracker.probeSuccess()
      // Shrink both TTLs so the refresh is observable.
      await redis.pexpire(`${prefix}llm-health:state`, 60_000)
      await redis.pexpire(`${prefix}llm-health:models`, 60_000)

      await tracker.probeFailure()

      expect(await redis.exists(`${prefix}llm-health:probe-successes`)).toBe(0)
      expect(await redis.pttl(`${prefix}llm-health:state`)).toBeGreaterThan(60_000)
      expect(await redis.pttl(`${prefix}llm-health:models`)).toBeGreaterThan(60_000)
      // The clear hysteresis restarts from zero — still counting after two.
      expect(await tracker.probeSuccess()).toBe('counting')
      expect(await tracker.probeSuccess()).toBe('counting')
      expect(await tracker.probeSuccess()).toBe('cleared')
    })
  })

  describe('timeReplyToMs', () => {
    it('converts both the typed (number) and wire (string) TIME reply shapes', () => {
      // ioredis types TIME as number[] but the server returns bulk strings —
      // both must land on the same epoch-ms.
      expect(timeReplyToMs([1785452656, 380591])).toBe(1785452656380)
      expect(timeReplyToMs(['1785452656', '380591'])).toBe(1785452656380)
    })

    it('degrades a malformed reply to 0 rather than NaN', () => {
      // NaN scores would poison every window comparison they touched.
      expect(timeReplyToMs([])).toBe(0)
    })
  })

  describe('fire-and-forget', () => {
    it('report resolves (never throws) when Redis is unreachable, and logs the failure', async () => {
      // A health-reporting failure must never fail the calling turn/stage —
      // ai.ts fires this without awaiting error handling (§1.4).
      const dead = new Redis('redis://127.0.0.1:1', {
        lazyConnect: true,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      })
      // Swallow the connection-refused 'error' events the dead client emits.
      dead.on('error', () => undefined)
      const { logger, lines } = makeCapturedLogger()
      const tracker = createLlmHealthTracker(dead, 'test:dead:', logger)
      await expect(tracker.report(makeReport())).resolves.toBeUndefined()
      expect(lines.some((l) => l.event === 'llm_health.report_failed')).toBe(true)
      dead.disconnect()
    })
  })

  // Task 7 round-1 fix: the §3.2 fire-once recovery net. The flag is owned by
  // the probe CYCLE (set post-clear, removed only after a promote scan
  // completes), so unlike the four state-machine keys it is not touched by the
  // Lua scripts — plain commands with the shared prefix + TTL discipline.
  describe('promote-pending flag', () => {
    it('absent by default, present after mark, absent after clear', async () => {
      const { tracker } = makeTracker()
      expect(await tracker.hasPromotePending()).toBe(false)
      await tracker.markPromotePending()
      expect(await tracker.hasPromotePending()).toBe(true)
      await tracker.clearPromotePending()
      expect(await tracker.hasPromotePending()).toBe(false)
    })

    it('lives under the shared prefix with the 30-min TTL bound', async () => {
      const { tracker, prefix } = makeTracker()
      await tracker.markPromotePending()
      const key = `${prefix}llm-health:promote-pending`
      expect(await redis.exists(key)).toBe(1)
      // TTL bounds a never-clearing flag (a scan that fails forever must not
      // bypass the §3.1 ladder indefinitely); 30 min matches the state keys.
      const ttl = await redis.ttl(key)
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(30 * 60)
    })

    it('clear is idempotent when the flag is absent', async () => {
      const { tracker } = makeTracker()
      await expect(tracker.clearPromotePending()).resolves.toBeUndefined()
      expect(await tracker.hasPromotePending()).toBe(false)
    })
  })
})
