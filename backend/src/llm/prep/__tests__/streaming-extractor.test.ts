import { describe, it, expect, vi } from 'vitest'
import { runStreamingStage } from '../streaming-extractor.js'

interface FakeRedis {
  publish: ReturnType<typeof vi.fn>
}

function makeRedis(): FakeRedis {
  return { publish: vi.fn().mockResolvedValue(1) }
}

const fakeJob = { updateProgress: vi.fn() }

async function* partials(snapshots: unknown[]): AsyncGenerator<unknown> {
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
      redisRealtime: redis as never,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: false,
      endpointTierMap: new Map(),
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string))
    const r1Emits = events.filter((e) => e.type === 'entity-added' && e.name === 'R1')
    expect(r1Emits).toHaveLength(1)
    expect(r1Emits[0]).toMatchObject({
      type: 'entity-added',
      entityKind: 'location',
      name: 'R1',
    })
    expect((r1Emits[0] as Record<string, unknown>).data).toBeUndefined()
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
      redisRealtime: redis as never,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: false,
      endpointTierMap: new Map(),
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string))
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
      redisRealtime: redis as never,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: true,
      endpointTierMap: new Map(),
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string))
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
      redisRealtime: redis as never,
      keyPrefix: 'test:',
      arrays: [{ path: 'relationships', kind: 'edge', role: 'edge' }],
      bypassAccessFilter: false,
      endpointTierMap,
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string))
    const edges = events.filter((e) => e.type === 'edge-added')
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ from: e1, to: e2, relationship: 'controls' })
    expect((edges[0] as Record<string, unknown>).description).toBeUndefined()
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
      redisRealtime: redis as never,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: false,
      endpointTierMap: new Map(),
      logger: { warn },
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string))
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
      redisRealtime: redis as never,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: false,
      endpointTierMap: new Map(),
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string))
    expect(events.filter((e) => e.type === 'entity-added').map((e) => e.name)).toEqual(['R1'])
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
      redisRealtime: redis as never,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: false,
      endpointTierMap: new Map(),
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string))
    expect(events.filter((e) => e.type === 'entity-added').map((e) => e.name)).toEqual(['R1'])
  })
})
