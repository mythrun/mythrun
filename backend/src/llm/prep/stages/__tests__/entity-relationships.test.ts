/* eslint-disable @typescript-eslint/no-deprecated -- design §4.1 mandates streamObject; test must mock the deprecated SDK function. */
// backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts
//
// Per MYT-52 design §3.3 + §D9. Stage 4 (`entity_relationships`):
//   - Reads entity inventory at start
//   - Calls relationships.deleteByWorld for retry idempotency
//   - Streams via streamObject(Sonnet), publishes edge-added events
//   - Pre-filters hallucinated UUIDs before INSERT (WARN, no throw)
//   - Persists via relationships.insertMany + entityHierarchy.insert
//     (caller pre-filters hierarchy stragglers against existing rows)
//   - Repair chain: Haiku → Sonnet → BullMQ retry (stage-reset)
//
// Pattern mirrors structured-output-repair.test.ts + starting-situation.test.ts:
//   - vi.mock('ai') with both generateText (repair) + streamObject (stream)
//   - QuerySpy / makeClient for client.query inspection
//   - Spy on relationships repo + entityHierarchy repo
//
// Mocked LLM, mocked client — no real Postgres. Real Postgres integration is
// covered at Layer 3 (wire smoke) per design §8.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    streamObject: vi.fn(),
    generateText: vi.fn(),
    Output: { object: vi.fn((opts: unknown) => opts) },
  }
})

vi.mock('../../../../repo/entities.js', () => ({
  entities: {
    listByWorld: vi.fn(),
  },
}))

vi.mock('../../../../repo/relationships.js', () => ({
  relationships: {
    insertMany: vi.fn().mockResolvedValue(undefined),
    deleteByWorld: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../../../repo/entity-hierarchy.js', () => ({
  entityHierarchy: {
    insert: vi.fn().mockResolvedValue(undefined),
  },
}))

import * as ai from 'ai'
import { runEntityRelationshipsStage } from '../entity-relationships.js'
import { entities } from '../../../../repo/entities.js'
import { relationships } from '../../../../repo/relationships.js'
import { entityHierarchy } from '../../../../repo/entity-hierarchy.js'

interface QuerySpy {
  query: ReturnType<typeof vi.fn>
}

function makeClient(rows: Record<string, unknown>[] = []): QuerySpy {
  return { query: vi.fn().mockResolvedValue({ rows }) }
}

interface FakeJob {
  updateProgress: (n: number) => Promise<void>
}

function fakeJob(): FakeJob {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    updateProgress: async (): Promise<void> => undefined,
  }
}

interface FakeRedis {
  publish: (channel: string, message: string) => Promise<number>
  publishes: { channel: string; payload: unknown }[]
}

function fakeRedis(): FakeRedis {
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

const E1 = '01923456-789a-7bcd-8ef0-123456789001'
const E2 = '01923456-789a-7bcd-8ef0-123456789002'
const E3 = '01923456-789a-7bcd-8ef0-123456789003'
const E4 = '01923456-789a-7bcd-8ef0-123456789004'
const E5 = '01923456-789a-7bcd-8ef0-123456789005'
const E6 = '01923456-789a-7bcd-8ef0-123456789006'
const GHOST = '01923456-789a-7bcd-8ef0-1234567890ff'

const INVENTORY = [
  { id: E1, worldId: 'wld-1', entityType: 'location' as const, name: 'The Iron Coast' },
  { id: E2, worldId: 'wld-1', entityType: 'faction' as const, name: 'Silver Brotherhood' },
  { id: E3, worldId: 'wld-1', entityType: 'npc' as const, name: 'Captain Aerion' },
  { id: E4, worldId: 'wld-1', entityType: 'location' as const, name: 'Saltwatch Keep' },
  { id: E5, worldId: 'wld-1', entityType: 'location' as const, name: 'Stormhaven' },
  { id: E6, worldId: 'wld-1', entityType: 'npc' as const, name: 'Magister Vance' },
]

interface TreeRelationship {
  readonly from: string
  readonly to: string
  readonly relationship: string
  readonly description: string
}
interface TreeStraggler {
  readonly parent_entity_id: string
  readonly child_entity_id: string
}
interface RelationshipsTree {
  readonly relationships: readonly TreeRelationship[]
  readonly hierarchy_stragglers: readonly TreeStraggler[]
}

function makeValidTree(): RelationshipsTree {
  return {
    relationships: [
      { from: E1, to: E2, relationship: 'controls', description: 'Coast under brotherhood rule' },
      { from: E2, to: E3, relationship: 'leads', description: 'Aerion commands the brotherhood' },
      { from: E3, to: E4, relationship: 'protects', description: 'Aerion holds the keep' },
      { from: E4, to: E1, relationship: 'located_in', description: 'Keep sits on the Iron Coast' },
      { from: E5, to: E6, relationship: 'opposed_to', description: 'Vance schemes against Stormhaven' },
    ],
    hierarchy_stragglers: [],
  }
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* makeStream(finalTree: unknown): AsyncGenerator {
  // Emit the closed tree directly — extractor's emit predicate triggers on
  // the single full snapshot. Mirrors structured-output-repair test pattern.
  yield finalTree
}

const baseArgs = {
  campaignId: 'cmp-1',
  worldId: 'wld-1',
  worldName: 'Aelmoor',
  tone: 'misted, melancholy',
  themes: 'guardianship, secrets',
  keyTensions: 'spirits chafe in lanterns',
}

describe('runEntityRelationshipsStage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(entities.listByWorld).mockResolvedValue(INVENTORY)
    vi.mocked(relationships.insertMany).mockResolvedValue(undefined)
    vi.mocked(relationships.deleteByWorld).mockResolvedValue(undefined)
    vi.mocked(entityHierarchy.insert).mockResolvedValue(undefined)
  })

  it('happy path: streams 5 valid relationships and persists them with deleteByWorld first', async () => {
    const tree = makeValidTree()
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const redis = fakeRedis()
    const client = makeClient()
    const result = await runEntityRelationshipsStage(client as never, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: redis,
      redisKeyPrefix: 'test:',
    })

    // deleteByWorld called BEFORE insertMany (retry idempotency, design §D9)
    const deleteOrder = vi.mocked(relationships.deleteByWorld).mock.invocationCallOrder[0]
    const insertOrder = vi.mocked(relationships.insertMany).mock.invocationCallOrder[0]
    expect(deleteOrder).toBeLessThan(insertOrder ?? Number.MAX_SAFE_INTEGER)

    expect(relationships.insertMany).toHaveBeenCalledTimes(1)
    const insertedRows = vi.mocked(relationships.insertMany).mock.calls[0]?.[1] as readonly {
      readonly sourceEntityId: string
      readonly targetEntityId: string
      readonly relationshipType: string
      readonly description: string
    }[]
    expect(insertedRows).toHaveLength(5)
    expect(insertedRows[0]).toEqual({
      sourceEntityId: E1,
      targetEntityId: E2,
      relationshipType: 'controls',
      description: 'Coast under brotherhood rule',
    })

    // 4000/1M * 3 + 1200/1M * 15 = 0.012 + 0.018 = 0.030
    expect(result.costUsd).toBeCloseTo(0.03, 4)
    expect(result.inputTokens).toBe(4000)
    expect(result.outputTokens).toBe(1200)

    // Five edge-added events emitted
    const edgeEvents = redis.publishes.filter(
      (p) => (p.payload as { type: string }).type === 'edge-added',
    )
    expect(edgeEvents).toHaveLength(5)
  })

  it('drops hallucinated UUIDs (not in inventory) without throwing — WARN, INSERT continues with valid rows', async () => {
    const tree = {
      relationships: [
        // Valid
        { from: E1, to: E2, relationship: 'controls', description: 'Coast under brotherhood rule' },
        // Hallucinated source — drop
        { from: GHOST, to: E2, relationship: 'serves', description: 'Phantom serves brotherhood' },
        // Hallucinated target — drop
        { from: E3, to: GHOST, relationship: 'pursues', description: 'Aerion pursues a ghost' },
        // Valid
        { from: E2, to: E3, relationship: 'leads', description: 'Aerion commands the brotherhood' },
        { from: E3, to: E4, relationship: 'protects', description: 'Aerion holds the keep' },
        { from: E4, to: E1, relationship: 'located_in', description: 'Keep sits on the Iron Coast' },
        { from: E5, to: E6, relationship: 'opposed_to', description: 'Vance schemes against Stormhaven' },
      ],
      hierarchy_stragglers: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const redis = fakeRedis()
    const client = makeClient()
    await expect(
      runEntityRelationshipsStage(client as never, {
        ...baseArgs,
        job: fakeJob(),
        redisRealtime: redis,
        redisKeyPrefix: 'test:',
      }),
    ).resolves.toBeDefined()

    const insertedRows = vi.mocked(relationships.insertMany).mock.calls[0]?.[1] as readonly {
      readonly sourceEntityId: string
      readonly targetEntityId: string
    }[]
    expect(insertedRows).toHaveLength(5)
    // No row references GHOST
    for (const row of insertedRows) {
      expect(row.sourceEntityId).not.toBe(GHOST)
      expect(row.targetEntityId).not.toBe(GHOST)
    }
  })

  it('hierarchy stragglers — pre-filters against entity inventory + existing child rows', async () => {
    const tree = {
      relationships: makeValidTree().relationships,
      hierarchy_stragglers: [
        // Valid (E4 is in inventory, E1 is in inventory, E4 not yet in entity_hierarchy)
        { parent_entity_id: E1, child_entity_id: E4 },
        // Drop: child already has a parent (stage 3 wins)
        { parent_entity_id: E1, child_entity_id: E5 },
        // Drop: parent UUID not in inventory
        { parent_entity_id: GHOST, child_entity_id: E6 },
      ],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const client = makeClient([{ child_entity_id: E5 }])

    await runEntityRelationshipsStage(client as never, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      redisKeyPrefix: 'test:',
    })

    // Only one hierarchy insert: E1→E4
    expect(entityHierarchy.insert).toHaveBeenCalledTimes(1)
    expect(entityHierarchy.insert).toHaveBeenCalledWith(expect.anything(), {
      parentEntityId: E1,
      childEntityId: E4,
    })
  })

  it('Zod-fail → Haiku repair succeeds → persists repaired tree', async () => {
    // Invalid stream: only 3 relationships (below min(5))
    const invalidTree = {
      relationships: makeValidTree().relationships.slice(0, 3),
      hierarchy_stragglers: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(invalidTree),
      object: Promise.resolve(invalidTree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 800, totalTokens: 4800 }),
    } as never)

    // Haiku repair returns a valid tree
    const repairedTree = makeValidTree()
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: repairedTree,
      finishReason: 'stop',
      usage: { inputTokens: 1000, outputTokens: 800, totalTokens: 1800 },
    } as never)

    const client = makeClient()
    await runEntityRelationshipsStage(client as never, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      redisKeyPrefix: 'test:',
    })

    expect(ai.generateText).toHaveBeenCalledTimes(1)
    const insertedRows = vi.mocked(relationships.insertMany).mock.calls[0]?.[1] as unknown[]
    expect(insertedRows).toHaveLength(5)
  })

  it('Zod-fail → Haiku fails → Sonnet repair succeeds → persists Sonnet tree', async () => {
    const invalidTree = {
      relationships: makeValidTree().relationships.slice(0, 3),
      hierarchy_stragglers: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(invalidTree),
      object: Promise.resolve(invalidTree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 800, totalTokens: 4800 }),
    } as never)

    // Haiku returns still-invalid (4 relationships, still below min)
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: {
        relationships: makeValidTree().relationships.slice(0, 4),
        hierarchy_stragglers: [],
      },
      finishReason: 'stop',
      usage: { inputTokens: 1000, outputTokens: 800, totalTokens: 1800 },
    } as never)
    // Sonnet returns valid
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: makeValidTree(),
      finishReason: 'stop',
      usage: { inputTokens: 1200, outputTokens: 1000, totalTokens: 2200 },
    } as never)

    const client = makeClient()
    const result = await runEntityRelationshipsStage(client as never, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      redisKeyPrefix: 'test:',
    })

    expect(ai.generateText).toHaveBeenCalledTimes(2)
    expect(result.inputTokens).toBe(4000 + 1000 + 1200)
    expect(result.outputTokens).toBe(800 + 800 + 1000)
  })

  it('repair exhausted → throws LlmStructuredOutputError and publishes stage-reset', async () => {
    const invalidTree = {
      relationships: makeValidTree().relationships.slice(0, 3),
      hierarchy_stragglers: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(invalidTree),
      object: Promise.resolve(invalidTree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 800, totalTokens: 4800 }),
    } as never)

    // Both repairs fail
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: invalidTree,
      finishReason: 'stop',
      usage: { inputTokens: 1000, outputTokens: 800, totalTokens: 1800 },
    } as never)
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: invalidTree,
      finishReason: 'stop',
      usage: { inputTokens: 1200, outputTokens: 1000, totalTokens: 2200 },
    } as never)

    const redis = fakeRedis()
    const client = makeClient()
    await expect(
      runEntityRelationshipsStage(client as never, {
        ...baseArgs,
        job: fakeJob(),
        redisRealtime: redis,
        redisKeyPrefix: 'test:',
      }),
    ).rejects.toThrow(/repair chain exhausted/i)

    const resetEvents = redis.publishes.filter(
      (p) => (p.payload as { type: string }).type === 'stage-reset',
    )
    expect(resetEvents).toHaveLength(1)
    expect((resetEvents[0]?.payload as { stage: string }).stage).toBe('entity_relationships')
    expect(relationships.insertMany).not.toHaveBeenCalled()
  })

  it('renders the entity inventory + world-summary placeholders into the prompt', async () => {
    const tree = makeValidTree()
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const client = makeClient()
    await runEntityRelationshipsStage(client as never, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      redisKeyPrefix: 'test:',
    })

    const call = vi.mocked(ai.streamObject).mock.calls.at(0)?.[0] as unknown as Record<
      string,
      unknown
    >
    const prompt = call.prompt as string
    expect(prompt).toContain('Aelmoor')
    expect(prompt).toContain('misted, melancholy')
    expect(prompt).toContain('The Iron Coast')
    expect(prompt).toContain(E1)
    expect(prompt).toContain('Silver Brotherhood')
    expect(prompt).not.toContain('{{entityInventory}}')
    expect(prompt).not.toContain('{{worldName}}')
  })

  it('all hierarchy stragglers fail inventory filter — early-return, no SQL probe + no inserts', async () => {
    // Every straggler references at least one unknown UUID — the filter
    // strips them all and the persister skips the existing-row probe.
    const tree = {
      relationships: makeValidTree().relationships,
      hierarchy_stragglers: [
        { parent_entity_id: GHOST, child_entity_id: E1 },
        { parent_entity_id: E1, child_entity_id: GHOST },
      ],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const client = makeClient()
    await runEntityRelationshipsStage(client as never, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      redisKeyPrefix: 'test:',
    })

    expect(entityHierarchy.insert).not.toHaveBeenCalled()
    // No probe SQL was issued (the early-return path skipped it). Only the
    // existing-row probe queries on the client; happy-path stragglers test
    // exercises that arm explicitly.
    for (const call of client.query.mock.calls) {
      const sql = call[0] as string
      expect(sql).not.toContain('FROM entity_hierarchy')
    }
  })

  it('empty hierarchy_stragglers — no entityHierarchy.insert calls + no straggler SQL probe', async () => {
    const tree = makeValidTree()
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const client = makeClient()
    await runEntityRelationshipsStage(client as never, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      redisKeyPrefix: 'test:',
    })

    expect(entityHierarchy.insert).not.toHaveBeenCalled()
  })
})
