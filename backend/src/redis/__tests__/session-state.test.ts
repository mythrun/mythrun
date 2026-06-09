import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CheckpointStore, PRESENCE_TTL, makeSessionState } from '../session-state.js'

const KEY_PREFIX = 'test:use1:'
const cId = 'c-1'

describe('makeSessionState — seq', () => {
  let redis: Redis

  beforeEach(async () => {
    redis = new IoRedisMock()
    // ioredis-mock backs every `new IoRedisMock()` with ONE shared in-memory
    // keyspace per process (verified), so per-test instances do NOT isolate.
    // Flush to guarantee a clean keyspace per test — the ws-ticket test
    // dodges this only because its keys are random nonces.
    await redis.flushall()
  })
  afterEach(async () => {
    await redis.quit()
  })

  it('nextSeq is a monotonic INCR starting at 1', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    expect(await ss.nextSeq(cId)).toBe(1)
    expect(await ss.nextSeq(cId)).toBe(2)
  })

  it('reseedSeq only ever raises the counter (continues above max)', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    expect(await ss.nextSeq(cId)).toBe(1)
    expect(await ss.nextSeq(cId)).toBe(2)
    await ss.reseedSeq(cId, 5)
    expect(await ss.nextSeq(cId)).toBe(6) // raised to 5, next INCR -> 6
    await ss.reseedSeq(cId, 3)
    expect(await ss.nextSeq(cId)).toBe(7) // 3 < 6, no lowering; INCR continues
  })

  it('reseedSeq onto a fresh counter seeds it, then nextSeq is max+1', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    await ss.reseedSeq(cId, 10)
    expect(await ss.nextSeq(cId)).toBe(11)
  })

  it('reseedSeq to 0 (fresh session, no messages) leaves nextSeq at 1', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    await ss.reseedSeq(cId, 0)
    expect(await ss.nextSeq(cId)).toBe(1)
  })

  it('per-campaign isolation: two campaigns have independent counters', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    expect(await ss.nextSeq('c-A')).toBe(1)
    expect(await ss.nextSeq('c-B')).toBe(1)
    expect(await ss.nextSeq('c-A')).toBe(2)
  })
})

describe('makeSessionState — presence (crash-safe TTL)', () => {
  let redis: Redis

  beforeEach(async () => {
    redis = new IoRedisMock()
    // ioredis-mock backs every `new IoRedisMock()` with ONE shared in-memory
    // keyspace per process (verified), so per-test instances do NOT isolate.
    // Flush to guarantee a clean keyspace per test — the ws-ticket test
    // dodges this only because its keys are random nonces.
    await redis.flushall()
  })
  afterEach(async () => {
    await redis.quit()
  })

  it('addPresence/countPresence/dropPresence track live connections', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    await ss.addPresence(cId, 'cont1', 'userA')
    await ss.addPresence(cId, 'cont1', 'userB')
    expect(await ss.countPresence(cId)).toBe(2)
    await ss.dropPresence(cId, 'cont1', 'userA')
    expect(await ss.countPresence(cId)).toBe(1)
  })

  it('addPresence sets a TTL on each per-connection key (~PRESENCE_TTL)', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    await ss.addPresence(cId, 'cont1', 'userA')
    const ttl = await redis.ttl(`${KEY_PREFIX}session:${cId}:conn:cont1:userA`)
    expect(ttl).toBeGreaterThan(PRESENCE_TTL - 5)
    expect(ttl).toBeLessThanOrEqual(PRESENCE_TTL)
  })

  it('re-adding the same connection refreshes (idempotent count)', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    await ss.addPresence(cId, 'cont1', 'userA')
    await ss.addPresence(cId, 'cont1', 'userA')
    expect(await ss.countPresence(cId)).toBe(1)
  })

  it('countPresence is 0 for an unknown session', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    expect(await ss.countPresence('never-seen')).toBe(0)
  })

  it('presence is isolated per campaign and per container', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    await ss.addPresence('c-A', 'cont1', 'userA')
    await ss.addPresence('c-A', 'cont2', 'userA') // same user, two containers
    await ss.addPresence('c-B', 'cont1', 'userA')
    expect(await ss.countPresence('c-A')).toBe(2)
    expect(await ss.countPresence('c-B')).toBe(1)
  })
})

describe('makeSessionState — state blob', () => {
  let redis: Redis

  beforeEach(async () => {
    redis = new IoRedisMock()
    // ioredis-mock backs every `new IoRedisMock()` with ONE shared in-memory
    // keyspace per process (verified), so per-test instances do NOT isolate.
    // Flush to guarantee a clean keyspace per test — the ws-ticket test
    // dodges this only because its keys are random nonces.
    await redis.flushall()
  })
  afterEach(async () => {
    await redis.quit()
  })

  it('setState then getState round-trips the JSON blob', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    await ss.setState(cId, { participants: ['userA'], mode: 'exploration', status: 'active' })
    const state = await ss.getState(cId)
    expect(state?.mode).toBe('exploration')
    expect(state?.participants).toEqual(['userA'])
    expect(state?.status).toBe('active')
  })

  it('getState returns null for an unset session', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    expect(await ss.getState('never-set')).toBeNull()
  })

  it('getState returns null on corrupt JSON rather than throwing', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    await redis.set(`${KEY_PREFIX}session:${cId}:state`, '{not json')
    expect(await ss.getState(cId)).toBeNull()
  })

  it('getState returns null when the blob is valid JSON but not an object', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    // Valid JSON that parses to a non-object (a bare number) → fails the
    // `typeof parsed !== 'object'` narrowing arm, treated as absent.
    await redis.set(`${KEY_PREFIX}session:${cId}:state`, '42')
    expect(await ss.getState(cId)).toBeNull()
  })

  it('getState returns null when the blob is an object missing a participants array', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    // Valid JSON object but `participants` is absent / not an array → fails the
    // `Array.isArray(...participants)` narrowing arm, treated as absent.
    await redis.set(
      `${KEY_PREFIX}session:${cId}:state`,
      JSON.stringify({ mode: 'exploration', status: 'active' }),
    )
    expect(await ss.getState(cId)).toBeNull()
  })
})

describe('makeSessionState — refreshTtls', () => {
  let redis: Redis

  beforeEach(async () => {
    redis = new IoRedisMock()
    // ioredis-mock backs every `new IoRedisMock()` with ONE shared in-memory
    // keyspace per process (verified), so per-test instances do NOT isolate.
    // Flush to guarantee a clean keyspace per test — the ws-ticket test
    // dodges this only because its keys are random nonces.
    await redis.flushall()
  })
  afterEach(async () => {
    await redis.quit()
  })

  it('bumps the TTL on :state and :seq', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    await ss.nextSeq(cId)
    await ss.setState(cId, { participants: [], mode: 'exploration', status: 'active' })
    // Before refresh both keys are persistent (no TTL set on INCR / SET).
    expect(await redis.ttl(`${KEY_PREFIX}session:${cId}:seq`)).toBe(-1)
    await ss.refreshTtls(cId)
    const seqTtl = await redis.ttl(`${KEY_PREFIX}session:${cId}:seq`)
    const stateTtl = await redis.ttl(`${KEY_PREFIX}session:${cId}:state`)
    expect(seqTtl).toBeGreaterThan(0)
    expect(stateTtl).toBeGreaterThan(0)
  })

  it('does not create keys that do not exist', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    await ss.refreshTtls('empty')
    expect(await redis.exists(`${KEY_PREFIX}session:empty:seq`)).toBe(0)
    expect(await redis.exists(`${KEY_PREFIX}session:empty:state`)).toBe(0)
  })
})

describe('makeSessionState — turn state', () => {
  let redis: Redis

  beforeEach(async () => {
    redis = new IoRedisMock()
    // ioredis-mock backs every `new IoRedisMock()` with ONE shared in-memory
    // keyspace per process (verified), so per-test instances do NOT isolate.
    // Flush to guarantee a clean keyspace per test — the ws-ticket test
    // dodges this only because its keys are random nonces.
    await redis.flushall()
  })
  afterEach(async () => {
    await redis.quit()
  })

  it('loadTurnState round-trips an atomic flushTurnState', async () => {
    const s = makeSessionState(redis, 'p:')
    // ft_history retired — PG-direct (MYT-68 §3.7); only summary/usage flush.
    await s.flushTurnState('c1', {
      summary: 'sum',
      usage: { input: 2, output: 3 },
    })
    expect(await s.loadTurnState('c1')).toEqual({
      summary: 'sum',
      usage: { input: 2, output: 3 },
    })
  })

  it('loadTurnState returns empties when unset', async () => {
    expect(await makeSessionState(redis, 'p:').loadTurnState('c-none')).toEqual({
      summary: '',
      usage: { input: 0, output: 0 },
    })
  })

  it('loadTurnState falls back to the zero values when a turn-state key holds corrupt JSON', async () => {
    // parseJson's catch arm: a corrupt :usage key must NOT throw — it falls
    // back to its empty default so the session still loads cleanly. :summary is
    // read raw (no JSON parse) so a corrupt value there is simply returned as
    // the string.
    await redis.set('p:session:c-corrupt:usage', 'not-json-either')
    expect(await makeSessionState(redis, 'p:').loadTurnState('c-corrupt')).toEqual({
      summary: '',
      usage: { input: 0, output: 0 },
    })
  })

  it('flushTurnState sets a TTL on both turn-state keys', async () => {
    const s = makeSessionState(redis, 'p:')
    await s.flushTurnState('c1', {
      summary: 's',
      usage: { input: 1, output: 1 },
    })
    expect(await redis.ttl('p:session:c1:summary')).toBeGreaterThan(0)
    expect(await redis.ttl('p:session:c1:usage')).toBeGreaterThan(0)
  })
})

describe('makeSessionState — checkpoint', () => {
  let redis: Redis

  beforeEach(async () => {
    redis = new IoRedisMock()
    // ioredis-mock backs every `new IoRedisMock()` with ONE shared in-memory
    // keyspace per process (verified), so per-test instances do NOT isolate.
    // Flush to guarantee a clean keyspace per test — the ws-ticket test
    // dodges this only because its keys are random nonces.
    await redis.flushall()
  })
  afterEach(async () => {
    await redis.quit()
  })

  it('reads the durable MAX seq (not the raw :seq counter) and writes the state blob', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    // :seq counter sits one ahead of the persisted MAX between INCR and INSERT.
    await ss.reseedSeq(cId, 7)
    await ss.nextSeq(cId) // counter now 8, but no row 8 persisted yet
    await ss.setState(cId, { participants: ['userA'], mode: 'exploration', status: 'active' })

    const writes: { sessionId: string; envelope: string }[] = []
    const readMaxSeq = vi.fn(() => Promise.resolve(7)) // repo-backed MAX(seq) = 7
    const store: CheckpointStore = {
      readMaxSeq,
      writeCheckpoint: vi.fn((sessionId: string, envelope: string) => {
        writes.push({ sessionId, envelope })
        return Promise.resolve()
      }),
    }

    // Seed turn-state so the widened envelope (H6) carries a non-empty turnState.
    await ss.flushTurnState(cId, {
      summary: 'a running summary',
      usage: { input: 5, output: 9 },
    })

    const result = await ss.checkpoint(cId, 's-1', store)
    expect(result.maxSeq).toBe(7) // from the durable store, NOT the :seq counter (8)
    expect(readMaxSeq).toHaveBeenCalledWith('s-1')
    // The checkpoint envelope carries the durable maxSeq + the live state blob.
    expect(writes).toHaveLength(1)
    expect(writes[0]?.sessionId).toBe('s-1')
    const parsed = JSON.parse(writes[0]?.envelope ?? '{}') as {
      kind: string
      maxSeq: number
      state: { mode?: string } | null
      turnState: {
        summary: string
        usage: { input: number; output: number }
      }
    }
    // H6: envelope kind bumped to myt68; the turn-state superset shed ft_history
    // (PG-direct — §3.7), so the snapshot now carries only summary + usage.
    expect(parsed.kind).toBe('myt68-checkpoint')
    expect(parsed.maxSeq).toBe(7)
    expect(parsed.state?.mode).toBe('exploration')
    expect(parsed.turnState).toEqual({
      summary: 'a running summary',
      usage: { input: 5, output: 9 },
    })
  })

  it('treats a 0 MAX seq (no messages yet) as 0', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    const store: CheckpointStore = {
      readMaxSeq: vi.fn(() => Promise.resolve(0)),
      writeCheckpoint: vi.fn(() => Promise.resolve()),
    }
    const result = await ss.checkpoint(cId, 's-1', store)
    expect(result.maxSeq).toBe(0)
  })

  it('checkpoints a null state when the live :state blob is corrupt JSON', async () => {
    const ss = makeSessionState(redis, KEY_PREFIX)
    // readRawState re-reads the live blob without re-validating; corrupt JSON
    // falls into its catch arm → null state. The checkpoint still succeeds (a
    // corrupt blob is the connect path's problem on restore, not here).
    await redis.set(`${KEY_PREFIX}session:${cId}:state`, '{not json')

    const writes: { sessionId: string; envelope: string }[] = []
    const store: CheckpointStore = {
      readMaxSeq: vi.fn(() => Promise.resolve(3)),
      writeCheckpoint: vi.fn((sessionId: string, envelope: string) => {
        writes.push({ sessionId, envelope })
        return Promise.resolve()
      }),
    }

    const result = await ss.checkpoint(cId, 's-1', store)
    expect(result.maxSeq).toBe(3)
    const parsed = JSON.parse(writes[0]?.envelope ?? '{}') as { maxSeq: number; state: unknown }
    expect(parsed.maxSeq).toBe(3)
    expect(parsed.state).toBeNull()
  })
})
