import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { runStreamingStage } from '../streaming-extractor.js'

interface FakeRedis {
  publish: ReturnType<typeof vi.fn>
}

interface SsePayload {
  type: string
  name?: string
  from?: string
  to?: string
  relationship?: string
  entityKind?: string
  synthKey?: string
  data?: unknown
  description?: unknown
}

function makeRedis(): FakeRedis {
  return { publish: vi.fn().mockResolvedValue(1) }
}

const fakeJob = { updateProgress: vi.fn() }

// eslint-disable-next-line @typescript-eslint/require-await
async function* partials(snapshots: unknown[]): AsyncGenerator {
  for (const s of snapshots) yield s
}

describe('runStreamingStage — myth-exac closed-entry gate', () => {
  it('emits entity-added exactly once per known-tier entry on closure', async () => {
    const redis = makeRedis()
    const stream = partials([
      { regions: [{ name: 'R1' }] },
      { regions: [{ name: 'R1', access_level: 'known' }] },
      { regions: [{ name: 'R1', access_level: 'known', prose: 'p' }] },
      { regions: [{ name: 'R1', access_level: 'known', prose: 'pp', facts: [] }, { name: 'R2' }] },
    ])
    await runStreamingStage(stream, {
      stage: 'world_and_factions',
      campaignId: 'c1',
      job: fakeJob,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: false,
      endpointTierMap: new Map(),
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string) as SsePayload)
    const r1Emits = events.filter((e) => e.type === 'entity-added' && e.name === 'R1')
    expect(r1Emits).toHaveLength(1)
    expect(r1Emits[0]).toMatchObject({
      type: 'entity-added',
      entityKind: 'location',
      name: 'R1',
    })
    expect(r1Emits[0]?.data).toBeUndefined()
  })

  it('skips emission for discoverable/secret-tier entries', async () => {
    const redis = makeRedis()
    const stream = partials([
      {
        regions: [
          { name: 'R1', access_level: 'discoverable', prose: 'p', facts: [] },
          { name: 'R2', access_level: 'known', prose: 'pp', facts: [] },
        ],
      },
    ])
    await runStreamingStage(stream, {
      stage: 'world_and_factions',
      campaignId: 'c1',
      job: fakeJob,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: false,
      endpointTierMap: new Map(),
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string) as SsePayload)
    const names = events.filter((e) => e.type === 'entity-added').map((e) => e.name)
    expect(names).toEqual(['R2'])
  })

  it('emits all tiers when bypassAccessFilter is true', async () => {
    const redis = makeRedis()
    const stream = partials([
      {
        regions: [
          { name: 'R1', access_level: 'secret', prose: 'p', facts: [] },
          { name: 'R2', access_level: 'discoverable', prose: 'p', facts: [] },
        ],
      },
    ])
    await runStreamingStage(stream, {
      stage: 'world_and_factions',
      campaignId: 'c1',
      job: fakeJob,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: true,
      endpointTierMap: new Map(),
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string) as SsePayload)
    const names = events.filter((e) => e.type === 'entity-added').map((e) => e.name).sort()
    expect(names).toEqual(['R1', 'R2'])
  })

  it('emits edge only when both endpoints are known-tier (no bypass)', async () => {
    const redis = makeRedis()
    const e1 = 'aaaaaaaa-0000-7000-8000-000000000001'
    const e2 = 'aaaaaaaa-0000-7000-8000-000000000002'
    const e3 = 'aaaaaaaa-0000-7000-8000-000000000003'
    const endpointTierMap = new Map<string, 'known' | 'discoverable' | 'secret'>([
      [e1, 'known'],
      [e2, 'known'],
      [e3, 'secret'],
    ])
    const stream = partials([
      {
        relationships: [
          { from: e1, to: e2, relationship: 'controls' },
          { from: e1, to: e3, relationship: 'fears' },
        ],
      },
    ])
    await runStreamingStage(stream, {
      stage: 'entity_relationships',
      campaignId: 'c1',
      job: fakeJob,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [{ path: 'relationships', kind: 'edge', role: 'edge' }],
      bypassAccessFilter: false,
      endpointTierMap,
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string) as SsePayload)
    const edges = events.filter((e) => e.type === 'edge-added')
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ from: e1, to: e2, relationship: 'controls' })
    expect(edges[0]?.description).toBeUndefined()
  })

  it('skips emission and logs when closed entry lacks access_level', async () => {
    const redis = makeRedis()
    const warn = vi.fn()
    const stream = partials([
      { regions: [{ name: 'R1', prose: 'p', facts: [] }, { name: 'R2' }] },
    ])
    await runStreamingStage(stream, {
      stage: 'world_and_factions',
      campaignId: 'c1',
      job: fakeJob,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: false,
      endpointTierMap: new Map(),
      logger: { warn },
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string) as SsePayload)
    expect(events.filter((e) => e.type === 'entity-added')).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('repeated partials with no new closure do not re-emit', async () => {
    const redis = makeRedis()
    const stream = partials([
      {
        regions: [
          { name: 'R1', access_level: 'known', prose: 'p', facts: [] },
          { name: 'R2' },
        ],
      },
      {
        regions: [
          { name: 'R1', access_level: 'known', prose: 'p', facts: [] },
          { name: 'R2', access_level: 'known' },
        ],
      },
    ])
    await runStreamingStage(stream, {
      stage: 'world_and_factions',
      campaignId: 'c1',
      job: fakeJob,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: false,
      endpointTierMap: new Map(),
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string) as SsePayload)
    expect(events.filter((e) => e.type === 'entity-added').map((e) => e.name)).toEqual(['R1'])
  })

  it('drops items that fail sub_schema validation; survivors still emit', async () => {
    const redis = makeRedis()
    const warn = vi.fn()
    const itemSchema = z.object({
      name: z.string().min(5),
      access_level: z.enum(['known', 'discoverable', 'secret']),
      prose: z.string(),
    })
    // Three partial chunks. Middle chunk adds 'X' (fails min(5)). Final
    // chunk closes 'X' (now at index 1) and starts 'Thornwood'. Post-loop
    // pass closes 'Thornwood'. Expected emits: Aelmoor + Thornwood only.
    const stream = partials([
      { entities: [{ name: 'Aelmoor', access_level: 'known', prose: 'p' }] },
      {
        entities: [
          { name: 'Aelmoor', access_level: 'known', prose: 'p' },
          { name: 'X', access_level: 'known', prose: 'p' },
        ],
      },
      {
        entities: [
          { name: 'Aelmoor', access_level: 'known', prose: 'p' },
          { name: 'X', access_level: 'known', prose: 'p' },
          { name: 'Thornwood', access_level: 'known', prose: 'p' },
        ],
      },
    ])
    await runStreamingStage(stream, {
      stage: 'world_and_factions',
      campaignId: 'c1',
      job: fakeJob,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [
        { path: 'entities', kind: 'location', role: 'entity', sub_schema: itemSchema },
      ],
      bypassAccessFilter: true,
      endpointTierMap: new Map(),
      logger: { warn },
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string) as SsePayload)
    const names = events.filter((e) => e.type === 'entity-added').map((e) => e.name)
    expect(names).toEqual(['Aelmoor', 'Thornwood'])
    // The 'X' drop should have produced a structured warn log.
    const dropCalls = warn.mock.calls.filter((args) => {
      const first = args[0] as unknown
      return (
        typeof first === 'object' &&
        first !== null &&
        (first as Record<string, unknown>).event === 'llm.stream_item_dropped'
      )
    })
    expect(dropCalls).toHaveLength(1)
  })

  it('trailing entry failing sub_schema is dropped by post-loop pass', async () => {
    const redis = makeRedis()
    const warn = vi.fn()
    const itemSchema = z.object({
      name: z.string().min(5),
      access_level: z.enum(['known', 'discoverable', 'secret']),
      prose: z.string(),
    })
    // Two-chunk stream. Final chunk has 'Aelmoor' closed (index 0) and
    // 'X' as the trailing entry (index 1, fails min(5)). 'X' has no
    // successor, so it can only be caught by the post-loop pass —
    // which must run sub_schema validation through maybeEmit and drop
    // the failing entry from the wire feed.
    const stream = partials([
      { entities: [{ name: 'Aelmoor', access_level: 'known', prose: 'p' }] },
      {
        entities: [
          { name: 'Aelmoor', access_level: 'known', prose: 'p' },
          { name: 'X', access_level: 'known', prose: 'p' },
        ],
      },
    ])
    await runStreamingStage(stream, {
      stage: 'world_and_factions',
      campaignId: 'c1',
      job: fakeJob,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [
        { path: 'entities', kind: 'location', role: 'entity', sub_schema: itemSchema },
      ],
      bypassAccessFilter: true,
      endpointTierMap: new Map(),
      logger: { warn },
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string) as SsePayload)
    const names = events.filter((e) => e.type === 'entity-added').map((e) => e.name)
    expect(names).toEqual(['Aelmoor'])
    const dropCalls = warn.mock.calls.filter((args) => {
      const first = args[0] as unknown
      return (
        typeof first === 'object' &&
        first !== null &&
        (first as Record<string, unknown>).event === 'llm.stream_item_dropped'
      )
    })
    expect(dropCalls).toHaveLength(1)
  })

  it('last entry of array emits via post-loop pass on stream-end', async () => {
    const redis = makeRedis()
    const stream = partials([
      {
        regions: [
          { name: 'R1', access_level: 'known', prose: 'p', facts: [] },
        ],
      },
    ])
    await runStreamingStage(stream, {
      stage: 'world_and_factions',
      campaignId: 'c1',
      job: fakeJob,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: false,
      endpointTierMap: new Map(),
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string) as SsePayload)
    expect(events.filter((e) => e.type === 'entity-added').map((e) => e.name)).toEqual(['R1'])
  })

  it('myth-449j: stream rejection produces structured warn log and rethrows', async () => {
    const redis = makeRedis()
    const warn = vi.fn()
    const boom = new Error('upstream-stream-died')

    // Two yielded partials, then the generator rejects.
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* failingPartials(): AsyncGenerator {
      yield { regions: [{ name: 'R1', access_level: 'known', prose: 'p', facts: [] }] }
      yield {
        regions: [
          { name: 'R1', access_level: 'known', prose: 'p', facts: [] },
          { name: 'R2' },
        ],
      }
      throw boom
    }

    await expect(
      runStreamingStage(failingPartials(), {
        stage: 'world_and_factions',
        campaignId: 'c-stream-died',
        job: fakeJob,
        redisRealtime: redis,
        keyPrefix: 'test:',
        arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
        bypassAccessFilter: true,
        endpointTierMap: new Map(),
        logger: { warn },
      }),
    ).rejects.toBe(boom)

    const streamDiedCalls = warn.mock.calls.filter((c) => {
      const arg0 = c[0] as unknown
      if (typeof arg0 !== 'object' || arg0 === null) return false
      const obj = arg0 as Record<string, unknown>
      return obj.event === 'streaming.stream_died'
    })
    expect(streamDiedCalls).toHaveLength(1)
    const payload = streamDiedCalls[0]?.[0] as Record<string, unknown>
    expect(payload.stage).toBe('world_and_factions')
    expect(payload.survivors).toBe(1)
    expect(payload.error).toMatchObject({ message: 'upstream-stream-died' })
  })

  it('myth-449j: non-Error rejection (string thrown) is still serialized', async () => {
    const redis = makeRedis()
    const warn = vi.fn()

    // eslint-disable-next-line @typescript-eslint/require-await
    async function* stringRejection(): AsyncGenerator {
      yield { regions: [{ name: 'R1', access_level: 'known', prose: 'p', facts: [] }] }
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'plain-string-error'
    }

    await expect(
      runStreamingStage(stringRejection(), {
        stage: 'world_and_factions',
        campaignId: 'c-string',
        job: fakeJob,
        redisRealtime: redis,
        keyPrefix: 'test:',
        arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
        bypassAccessFilter: true,
        endpointTierMap: new Map(),
        logger: { warn },
      }),
    ).rejects.toBe('plain-string-error')

    const streamDiedCalls = warn.mock.calls.filter((c) => {
      const arg0 = c[0] as unknown
      if (typeof arg0 !== 'object' || arg0 === null) return false
      return (arg0 as Record<string, unknown>).event === 'streaming.stream_died'
    })
    expect(streamDiedCalls).toHaveLength(1)
    const payload = streamDiedCalls[0]?.[0] as Record<string, unknown>
    expect(payload.error).toEqual({ value: 'plain-string-error' })
  })
})
