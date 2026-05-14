// backend/src/llm/prep/__tests__/streaming-extractor.test.ts
import { describe, it, expect } from 'vitest'
import { runStreamingStage } from '../streaming-extractor.js'

interface FakeJob {
  updateProgress: (n: number) => Promise<void>
}

function fakeJob(): FakeJob & { progressCalls: number[] } {
  const progressCalls: number[] = []
  return {
    progressCalls,
    // eslint-disable-next-line @typescript-eslint/require-await
    updateProgress: async (n: number): Promise<void> => {
      progressCalls.push(n)
    },
  }
}

interface FakeRedis {
  publish: (channel: string, message: string) => Promise<number>
}

function fakeRedis(): FakeRedis & { publishes: { channel: string; payload: unknown }[] } {
  const publishes: { channel: string; payload: unknown }[] = []
  return {
    publishes,
    // eslint-disable-next-line @typescript-eslint/require-await
    publish: async (channel: string, message: string): Promise<number> => {
      publishes.push({ channel, payload: JSON.parse(message) as unknown })
      return 1
    },
  }
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* twoFactionStream(): AsyncGenerator<{
  factions?: Partial<{ name: string; prose: string }>[]
}> {
  // Three deltas: name appears alone (not emittable), then prose starts
  // (emittable -> entity-added), then prose grows (entity-updated).
  yield { factions: [{ name: 'House Eyrin' }] }
  yield { factions: [{ name: 'House Eyrin', prose: 'The eyrie' }] }
  yield { factions: [{ name: 'House Eyrin', prose: 'The eyrie clings to the cliffs.' }] }
}

describe('runStreamingStage', () => {
  it('publishes entity-added when name is non-empty AND another field has begun', async () => {
    const job = fakeJob()
    const redis = fakeRedis()
    const result = await runStreamingStage(twoFactionStream(), {
      stage: 'world_and_factions',
      campaignId: 'cmp-1',
      job,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [{ path: 'factions', kind: 'faction', role: 'entity' }],
    })
    const events = redis.publishes.map((p) => p.payload as { type: string; synthKey?: string })
    const added = events.filter((e) => e.type === 'entity-added')
    expect(added).toHaveLength(1)
    expect(added[0]?.synthKey).toBe('world_and_factions/factions/0')
    expect(result.finalTree.factions?.[0]?.name).toBe('House Eyrin')
  })

  it('publishes entity-updated when emitted entry grows', async () => {
    const job = fakeJob()
    const redis = fakeRedis()
    await runStreamingStage(twoFactionStream(), {
      stage: 'world_and_factions',
      campaignId: 'cmp-1',
      job,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [{ path: 'factions', kind: 'faction', role: 'entity' }],
    })
    const updated = redis.publishes.filter(
      (p) => (p.payload as { type: string }).type === 'entity-updated',
    )
    expect(updated.length).toBeGreaterThanOrEqual(1)
  })

  it('publishes one progress update per partial-tree iteration', async () => {
    const job = fakeJob()
    const redis = fakeRedis()
    await runStreamingStage(twoFactionStream(), {
      stage: 'world_and_factions',
      campaignId: 'cmp-1',
      job,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [{ path: 'factions', kind: 'faction', role: 'entity' }],
    })
    expect(job.progressCalls.length).toBe(3) // three partial trees
  })

  it('skips entries where name is empty', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* stream(): AsyncGenerator<{
      factions?: Partial<{ name: string; prose: string }>[]
    }> {
      yield { factions: [{ name: '' }] }
      yield { factions: [{ name: '', prose: 'mystery' }] }
    }
    const job = fakeJob()
    const redis = fakeRedis()
    await runStreamingStage(stream(), {
      stage: 'world_and_factions',
      campaignId: 'cmp-1',
      job,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [{ path: 'factions', kind: 'faction', role: 'entity' }],
    })
    expect(
      redis.publishes.filter((p) => (p.payload as { type: string }).type === 'entity-added'),
    ).toHaveLength(0)
  })

  it('publishes edge-added when role is edge', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* stream(): AsyncGenerator<{
      rels?: Partial<{ from: string; to: string; relationship: string }>[]
    }> {
      yield { rels: [{ from: 'A', to: 'B', relationship: 'rules' }] }
    }
    const job = fakeJob()
    const redis = fakeRedis()
    await runStreamingStage(stream(), {
      stage: 'entity_relationships',
      campaignId: 'cmp-1',
      job,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [{ path: 'rels', kind: 'edge', role: 'edge' }],
    })
    const edgeAdded = redis.publishes.filter(
      (p) => (p.payload as { type: string }).type === 'edge-added',
    )
    expect(edgeAdded).toHaveLength(1)
  })

  it('publishes a follow-up edge-added with growth when an edge entry grows', async () => {
    // Covers the role=edge branch of the entry-updated path (lines 142-153
    // of streaming-extractor.ts). An edge entry that closes (emit) and then
    // grows (description appears) emits a second edge-added with the
    // updated fields.
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* stream(): AsyncGenerator<{
      rels?: Partial<{ from: string; to: string; relationship: string; description: string }>[]
    }> {
      yield { rels: [{ from: 'A', to: 'B', relationship: 'rules' }] }
      yield { rels: [{ from: 'A', to: 'B', relationship: 'rules', description: 'Rules with iron fist.' }] }
    }
    const job = fakeJob()
    const redis = fakeRedis()
    await runStreamingStage(stream(), {
      stage: 'entity_relationships',
      campaignId: 'cmp-1',
      job,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [{ path: 'rels', kind: 'edge', role: 'edge' }],
    })
    const edgeEvents = redis.publishes.filter(
      (p) => (p.payload as { type: string }).type === 'edge-added',
    )
    expect(edgeEvents).toHaveLength(2)
    const second = edgeEvents[1]?.payload as { description?: string }
    expect(second.description).toBe('Rules with iron fist.')
  })

  it('skips non-array path values + null entries + no-change diffs (defensive guards)', async () => {
    // Covers three defensive branches in one stream:
    //   - Line 107: an array path that yields a non-array value (e.g., the
    //     LLM emitted `regions: "oops"` as a string). Extractor skips it.
    //   - Line 111: an array entry that isn't a record (e.g., null).
    //   - Line 81: diffPatch returns null when nothing changed between the
    //     previous emitted snapshot and the current entry.
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* stream(): AsyncGenerator<{
      regions?: unknown
      factions?: unknown[]
    }> {
      // First chunk: regions is wrong-shape (number), factions has a null + a real entry
      yield { regions: 42, factions: [null, { name: 'A', prose: 'p' }] }
      // Second chunk: regions wrong-shape again; factions has the SAME real entry (no change)
      yield { regions: 42, factions: [null, { name: 'A', prose: 'p' }] }
    }
    const job = fakeJob()
    const redis = fakeRedis()
    await runStreamingStage(stream(), {
      stage: 'world_and_factions',
      campaignId: 'cmp-1',
      job,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [
        { path: 'regions', kind: 'location', role: 'entity' },
        { path: 'factions', kind: 'faction', role: 'entity' },
      ],
    })
    // Exactly one entity-added: factions[1] in the first chunk.
    const added = redis.publishes.filter(
      (p) => (p.payload as { type: string }).type === 'entity-added',
    )
    expect(added).toHaveLength(1)
    // Zero entity-updated: the second chunk had no diff.
    const updated = redis.publishes.filter(
      (p) => (p.payload as { type: string }).type === 'entity-updated',
    )
    expect(updated).toHaveLength(0)
  })

  it('throws when partialObjectStream yields zero values', async () => {
    // Covers the defensive throw at end-of-loop when nothing was emitted.
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* emptyStream(): AsyncGenerator {
      // No yields.
    }
    await expect(
      runStreamingStage(emptyStream(), {
        stage: 'world_and_factions',
        campaignId: 'cmp-1',
        job: fakeJob(),
        redisRealtime: fakeRedis(),
        keyPrefix: 'test:',
        arrays: [{ path: 'factions', kind: 'faction', role: 'entity' }],
      }),
    ).rejects.toThrow(/yielded no values/)
  })
})
