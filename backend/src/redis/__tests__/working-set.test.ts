import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkingSetItem } from '../../session/working-set/types.js'
import { makeWorkingSetRepo } from '../working-set.js'

const KEY_PREFIX = 'test:use1:'
const cId = 'c-1'

/** Build a WorkingSetItem with overridable fields — keeps each test terse. */
function makeItem(overrides: Partial<WorkingSetItem> = {}): WorkingSetItem {
  return {
    id: 'i-1',
    kind: 'fact',
    content: 'The gate is barred.',
    subjectName: 'North Gate',
    tier: 'known',
    provenance: { kind: 'objective' },
    source: 'ft_delta',
    embedding: [0.1, 0.2, 0.3],
    turnId: 't-1',
    ...overrides,
  }
}

describe('makeWorkingSetRepo', () => {
  let redis: Redis

  beforeEach(async () => {
    redis = new IoRedisMock()
    // ioredis-mock backs every `new IoRedisMock()` with ONE shared in-memory
    // keyspace per process, so per-test instances do NOT isolate. Flush to
    // guarantee a clean keyspace per test.
    await redis.flushall()
  })
  afterEach(async () => {
    await redis.quit()
  })

  it('append then load round-trips items including embedding arrays + provenance', async () => {
    const ws = makeWorkingSetRepo(redis, KEY_PREFIX)
    const item = makeItem({
      embedding: [0.5, -0.25, 1.0],
      provenance: { kind: 'attributed', npcEntityId: 'e-9', npcName: 'Old Maren' },
    })
    await ws.append(cId, [item])
    const loaded = await ws.load(cId)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toEqual(item)
    expect(loaded[0]?.embedding).toEqual([0.5, -0.25, 1.0])
    expect(loaded[0]?.provenance).toEqual({
      kind: 'attributed',
      npcEntityId: 'e-9',
      npcName: 'Old Maren',
    })
  })

  it('append is an RPUSH — appends twice, load returns all four in order', async () => {
    const ws = makeWorkingSetRepo(redis, KEY_PREFIX)
    await ws.append(cId, [makeItem({ id: 'a' }), makeItem({ id: 'b' })])
    await ws.append(cId, [makeItem({ id: 'c' }), makeItem({ id: 'd' })])
    const loaded = await ws.load(cId)
    expect(loaded.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('append with an empty array is a no-op (no key created)', async () => {
    const ws = makeWorkingSetRepo(redis, KEY_PREFIX)
    await ws.append(cId, [])
    expect(await redis.exists(`${KEY_PREFIX}session:${cId}:workingset`)).toBe(0)
    expect(await ws.load(cId)).toEqual([])
  })

  it('append sets a TTL on the workingset key', async () => {
    const ws = makeWorkingSetRepo(redis, KEY_PREFIX)
    await ws.append(cId, [makeItem()])
    const ttl = await redis.ttl(`${KEY_PREFIX}session:${cId}:workingset`)
    expect(ttl).toBeGreaterThan(0)
  })

  it('evictIfOver(2) keeps all non-public + the newest public, drops the oldest public', async () => {
    const ws = makeWorkingSetRepo(redis, KEY_PREFIX)
    // Order: [oldest public, public, st_injection, retcon]
    await ws.append(cId, [
      makeItem({ id: 'p-old', source: 'ft_delta' }),
      makeItem({ id: 'p-new', source: 'ft_delta' }),
      makeItem({ id: 'st', source: 'st_injection' }),
      makeItem({ id: 'rc', source: 'retcon' }),
    ])
    await ws.evictIfOver(cId, 2)
    const loaded = await ws.load(cId)
    // 4 items, cap 2 → keep st_injection + retcon (never evicted) + newest public.
    // That's 3 (> cap), acceptable: non-public are never dropped. Oldest public gone.
    expect(loaded.map((i) => i.id)).toEqual(['p-new', 'st', 'rc'])
  })

  it('evictIfOver preserves original order of the kept items', async () => {
    const ws = makeWorkingSetRepo(redis, KEY_PREFIX)
    await ws.append(cId, [
      makeItem({ id: 'p1', source: 'ft_delta' }),
      makeItem({ id: 'st', source: 'st_injection' }),
      makeItem({ id: 'p2', source: 'ft_delta' }),
      makeItem({ id: 'p3', source: 'ft_delta' }),
    ])
    await ws.evictIfOver(cId, 2)
    const loaded = await ws.load(cId)
    // Keep st (non-public) + newest 1 public (p3); drop p1, p2. Original order: st, p3.
    expect(loaded.map((i) => i.id)).toEqual(['st', 'p3'])
  })

  it('evictIfOver is a no-op when the list is at or under cap', async () => {
    const ws = makeWorkingSetRepo(redis, KEY_PREFIX)
    await ws.append(cId, [makeItem({ id: 'a' }), makeItem({ id: 'b' })])
    await ws.evictIfOver(cId, 2)
    expect((await ws.load(cId)).map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('evictIfOver keeps all non-public + the newest public even when non-public alone exceeds cap', async () => {
    const ws = makeWorkingSetRepo(redis, KEY_PREFIX)
    await ws.append(cId, [
      makeItem({ id: 'st1', source: 'st_injection' }),
      makeItem({ id: 'rc1', source: 'retcon' }),
      makeItem({ id: 'st2', source: 'st_injection' }),
      makeItem({ id: 'p1', source: 'ft_delta' }),
    ])
    await ws.evictIfOver(cId, 1)
    const loaded = await ws.load(cId)
    // cap 1, 3 non-public are never dropped, and the newest public (p1, the only
    // one here) is always retained — so the set stays over-cap by design. All 4
    // survive; the over-cap residue is logged, not silently dropped.
    expect(loaded.map((i) => i.id)).toEqual(['st1', 'rc1', 'st2', 'p1'])
  })

  it('load on a missing key returns []', async () => {
    const ws = makeWorkingSetRepo(redis, KEY_PREFIX)
    expect(await ws.load('never-set')).toEqual([])
  })

  it('clear empties the list', async () => {
    const ws = makeWorkingSetRepo(redis, KEY_PREFIX)
    await ws.append(cId, [makeItem({ id: 'a' }), makeItem({ id: 'b' })])
    await ws.clear(cId)
    expect(await ws.load(cId)).toEqual([])
    expect(await redis.exists(`${KEY_PREFIX}session:${cId}:workingset`)).toBe(0)
  })

  it('isolates working sets per campaign', async () => {
    const ws = makeWorkingSetRepo(redis, KEY_PREFIX)
    await ws.append('c-A', [makeItem({ id: 'a' })])
    await ws.append('c-B', [makeItem({ id: 'b' })])
    expect((await ws.load('c-A')).map((i) => i.id)).toEqual(['a'])
    expect((await ws.load('c-B')).map((i) => i.id)).toEqual(['b'])
  })
})
