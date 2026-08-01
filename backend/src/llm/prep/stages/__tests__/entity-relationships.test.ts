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

import * as ai from 'ai'
import { LlmStructuredOutputError } from '../../../errors.js'
import { runEntityRelationshipsStage } from '../entity-relationships.js'
import { makeFakeRepo, type FakeRepo } from './_helpers/fake-repo.js'
import type { Repo } from '../../../../repo/index.js'
import type { WorldInventory } from '../../../../repo/world-inventory.js'
import type { VocabularyRegistry } from '../../../schemas/vocabulary-registry.js'

const EMPTY_REGISTRY: VocabularyRegistry = { entries: [], adjacent_franchises: [] }

// The stage reads the full world inventory through `repo.worldInventory.load`
// (pool-bound, OUTSIDE the persist tx). The handler only consumes the
// entitiesById map (name → UUID + tier); build a WorldInventory whose
// entitiesById carries the fixture entities and whose other maps are empty.
function inventoryFromEntities(
  entries: readonly {
    readonly id: string
    readonly entityType: string
    readonly name: string
    readonly accessLevel: 'known' | 'discoverable' | 'secret'
  }[],
): WorldInventory {
  return {
    entitiesById: new Map(
      entries.map((e) => [
        e.id,
        { id: e.id, name: e.name, entityType: e.entityType, accessLevel: e.accessLevel },
      ]),
    ),
    proseByEntityId: new Map(),
    factsById: new Map(),
    relationshipsById: new Map(),
  }
}

// myth-t1qz: under the wrapper, repair fires when the SDK rejects
// `.object` with LlmStructuredOutputError. The wrapper inspects
// `.cause.text`, JSON.parses + Zod-checks, then on Zod-fail calls
// repairStructuredOutput → ai.generateText (mocked).
function makeRejectedObject(brokenTreeForCause: unknown): Promise<unknown> {
  const cause = Object.assign(new Error('AI_NoObjectGeneratedError'), {
    name: 'AI_NoObjectGeneratedError',
    text: JSON.stringify(brokenTreeForCause),
  })
  const rejection = Promise.reject<unknown>(
    new LlmStructuredOutputError('llm returned unparseable structured output', { cause }),
  )
  rejection.catch(() => undefined)
  return rejection
}

// Build a fake repo wired for stage 4. The hierarchy-straggler pre-filter
// probe (formerly a raw client.query) is now
// repo.entityHierarchy.listExistingChildIds — `existingChildIds` seeds the
// child ids it returns (the rows the probe would have found). The
// world-inventory read defaults to the all-known DEFAULT_INVENTORY; mixed-tier
// tests override repo.worldInventory.load with their own inventory.
function makeRepo(existingChildIds: readonly string[] = []): FakeRepo {
  const repo = makeFakeRepo()
  repo.entityHierarchy.listExistingChildIds.mockResolvedValue(existingChildIds)
  repo.worldInventory.load.mockResolvedValue(DEFAULT_INVENTORY)
  return repo
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
  { id: E1, worldId: 'wld-1', entityType: 'location' as const, name: 'The Iron Coast', accessLevel: 'known' as const },
  { id: E2, worldId: 'wld-1', entityType: 'faction' as const, name: 'Silver Brotherhood', accessLevel: 'known' as const },
  { id: E3, worldId: 'wld-1', entityType: 'npc' as const, name: 'Captain Aerion', accessLevel: 'known' as const },
  { id: E4, worldId: 'wld-1', entityType: 'location' as const, name: 'Saltwatch Keep', accessLevel: 'known' as const },
  { id: E5, worldId: 'wld-1', entityType: 'location' as const, name: 'Stormhaven', accessLevel: 'known' as const },
  { id: E6, worldId: 'wld-1', entityType: 'npc' as const, name: 'Magister Vance', accessLevel: 'known' as const },
]

// Default inventory used by makeRepo. Mixed-tier tests pass a different
// inventory directly to repo.worldInventory.load.
const DEFAULT_INVENTORY: WorldInventory = inventoryFromEntities(INVENTORY)

interface TreeRelationship {
  readonly from_name: string
  readonly to_name: string
  readonly relationship: string
  readonly description: string
  readonly access_level: 'known' | 'discoverable' | 'secret'
}
interface TreeStraggler {
  readonly parent_name: string
  readonly child_name: string
}
interface TreeDeclaration {
  readonly name: string
  readonly entity_type: 'faction' | 'location' | 'npc'
}
interface RelationshipsTree {
  readonly relationships: readonly TreeRelationship[]
  readonly hierarchy_stragglers: readonly TreeStraggler[]
  readonly new_entity_declarations: readonly TreeDeclaration[]
}

// myth-2ob3: name-based fixtures. Names match the INVENTORY entries above;
// the resolver maps them to UUIDs at persist time.
const NAME_E1 = 'The Iron Coast'
const NAME_E2 = 'Silver Brotherhood'
const NAME_E3 = 'Captain Aerion'
const NAME_E4 = 'Saltwatch Keep'
const NAME_E5 = 'Stormhaven'
const NAME_E6 = 'Magister Vance'
const NAME_GHOST = 'Ghostly Apparition' // unresolvable — not in inventory

function makeValidTree(): RelationshipsTree {
  return {
    relationships: [
      { from_name: NAME_E1, to_name: NAME_E2, relationship: 'controls', description: 'Coast under brotherhood rule', access_level: 'known' },
      { from_name: NAME_E2, to_name: NAME_E3, relationship: 'leads', description: 'Aerion commands the brotherhood', access_level: 'known' },
      { from_name: NAME_E3, to_name: NAME_E4, relationship: 'protects', description: 'Aerion holds the keep', access_level: 'known' },
      { from_name: NAME_E4, to_name: NAME_E1, relationship: 'located_in', description: 'Keep sits on the Iron Coast', access_level: 'known' },
      { from_name: NAME_E5, to_name: NAME_E6, relationship: 'opposed_to', description: 'Vance schemes against Stormhaven', access_level: 'secret' },
    ],
    hierarchy_stragglers: [],
    new_entity_declarations: [],
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
  vocabularyRegistry: EMPTY_REGISTRY,
  bypassAccessFilter: false,
}

describe('runEntityRelationshipsStage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('happy path: streams 5 valid relationships and persists them with deleteByWorld first', async () => {
    const tree = makeValidTree()
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const redis = fakeRedis()
    const repo = makeRepo()
    const result = await runEntityRelationshipsStage(repo as unknown as Repo, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: redis,
      keyPrefix: 'test:',
    })

    const streamCall = vi.mocked(ai.streamObject).mock.calls[0]?.[0] as unknown as {
      providerOptions?: unknown
    }
    expect(streamCall.providerOptions).toMatchObject({
      mythrun: { stage: 'entity_relationships', worldId: 'wld-1', campaignId: 'cmp-1' },
    })

    // deleteByWorld called BEFORE insertMany (retry idempotency, design §D9)
    const deleteOrder = repo.relationships.deleteByWorld.mock.invocationCallOrder[0]
    const insertOrder = repo.relationships.insertMany.mock.invocationCallOrder[0]
    expect(deleteOrder).toBeLessThan(insertOrder ?? Number.MAX_SAFE_INTEGER)

    expect(repo.relationships.insertMany).toHaveBeenCalledTimes(1)
    const insertedRows = repo.relationships.insertMany.mock.calls[0]?.[0] as readonly {
      readonly sourceEntityId: string
      readonly targetEntityId: string
      readonly relationshipType: string
      readonly description: string
      readonly synthKey: string
    }[]
    expect(insertedRows).toHaveLength(5)
    expect(insertedRows[0]).toEqual({
      sourceEntityId: E1,
      targetEntityId: E2,
      relationshipType: 'controls',
      description: 'Coast under brotherhood rule',
      // MYT-89 Phase A: the persisted tier comes from the LLM-emitted row.
      accessLevel: 'known',
      // myth-imxg.4: insert-time synth_key carries the same wire identity
      // the post-commit `finalized` event uses, so stage 7 can address the
      // row by the same string the wire feed established at stage 4.
      synthKey: 'entity_relationships/relationships/0',
    })
    // synth_key shape: one per accepted row, indexed by LLM emit order.
    expect(insertedRows.map((r) => r.synthKey)).toEqual([
      'entity_relationships/relationships/0',
      'entity_relationships/relationships/1',
      'entity_relationships/relationships/2',
      'entity_relationships/relationships/3',
      'entity_relationships/relationships/4',
    ])

    // 4000/1M * 3 + 1200/1M * 15 = 0.012 + 0.018 = 0.030
    expect(result.costUsd).toBeCloseTo(0.03, 4)
    expect(result.inputTokens).toBe(4000)
    expect(result.outputTokens).toBe(1200)

    // Stage 4 dispatch-contract fields: edges are also surfaced as post-commit
    // `finalized` events (myth-exac T15) for rows whose endpoints AND own tier
    // pass the filter. makeValidTree's index-4 edge (Stormhaven→Magister Vance)
    // is itself access_level:'secret' — with all-known inventory the four known
    // edges surface but the secret one is suppressed (myth-pq0ug: the edge's own
    // tier gates the wire even between known endpoints). Stage 4 doesn't cap-fire.
    expect(result.finalizedEvents).toHaveLength(4)
    for (const ev of result.finalizedEvents) {
      expect(ev.type).toBe('finalized')
    }
    const finalizedKeys = result.finalizedEvents.map((ev) =>
      ev.type === 'finalized' ? ev.synthKey : '',
    )
    expect(finalizedKeys).not.toContain('entity_relationships/relationships/4')
    expect(result.capExhausted).toBe(false)

    // Four edge-added events emitted (the secret edge is filtered from the wire).
    const edgeEvents = redis.publishes.filter(
      (p) => (p.payload as { type: string }).type === 'edge-added',
    )
    expect(edgeEvents).toHaveLength(4)
  })

  it('drops hallucinated names (not in inventory) without throwing — WARN, INSERT continues with valid rows', async () => {
    const tree = {
      relationships: [
        // Valid
        { from_name: NAME_E1, to_name: NAME_E2, relationship: 'controls', description: 'Coast under brotherhood rule', access_level: 'known' },
        // Hallucinated source — drop
        { from_name: NAME_GHOST, to_name: NAME_E2, relationship: 'serves', description: 'Phantom serves brotherhood', access_level: 'known' },
        // Hallucinated target — drop
        { from_name: NAME_E3, to_name: NAME_GHOST, relationship: 'pursues', description: 'Aerion pursues a ghost', access_level: 'known' },
        // Valid
        { from_name: NAME_E2, to_name: NAME_E3, relationship: 'leads', description: 'Aerion commands the brotherhood', access_level: 'known' },
        { from_name: NAME_E3, to_name: NAME_E4, relationship: 'protects', description: 'Aerion holds the keep', access_level: 'known' },
        { from_name: NAME_E4, to_name: NAME_E1, relationship: 'located_in', description: 'Keep sits on the Iron Coast', access_level: 'known' },
        { from_name: NAME_E5, to_name: NAME_E6, relationship: 'opposed_to', description: 'Vance schemes against Stormhaven', access_level: 'known' },
      ],
      hierarchy_stragglers: [],
      new_entity_declarations: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const redis = fakeRedis()
    const repo = makeRepo()
    await expect(
      runEntityRelationshipsStage(repo as unknown as Repo, {
        ...baseArgs,
        job: fakeJob(),
        redisRealtime: redis,
        keyPrefix: 'test:',
      }),
    ).resolves.toBeDefined()

    const insertedRows = repo.relationships.insertMany.mock.calls[0]?.[0] as readonly {
      readonly sourceEntityId: string
      readonly targetEntityId: string
    }[]
    expect(insertedRows).toHaveLength(5)
    // No row references GHOST UUID
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
        { parent_name: NAME_E1, child_name: NAME_E4 },
        // Drop: child already has a parent (stage 3 wins)
        { parent_name: NAME_E1, child_name: NAME_E5 },
        // Drop: parent name not in inventory
        { parent_name: NAME_GHOST, child_name: NAME_E6 },
      ],
      new_entity_declarations: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    // myth-2ob3: the existing-child-id probe queries with entity UUIDs
    // (resolved from names by the partitioner), so the mock returns E5.
    const repo = makeRepo([E5])

    await runEntityRelationshipsStage(repo as unknown as Repo, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      keyPrefix: 'test:',
    })

    // Only one hierarchy insert: E1→E4 (names resolved to UUIDs)
    expect(repo.entityHierarchy.insert).toHaveBeenCalledTimes(1)
    expect(repo.entityHierarchy.insert).toHaveBeenCalledWith({
      parentEntityId: E1,
      childEntityId: E4,
    })
  })

  it('Zod-fail → Haiku repair succeeds → persists repaired tree', async () => {
    // Invalid stream: only 3 relationships (below min(5))
    const invalidTree = {
      relationships: makeValidTree().relationships.slice(0, 3),
      hierarchy_stragglers: [],
      new_entity_declarations: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(invalidTree),
      object: makeRejectedObject(invalidTree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 800, totalTokens: 4800 }),
    } as never)

    // Haiku repair returns a valid tree
    const repairedTree = makeValidTree()
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: repairedTree,
      finishReason: 'stop',
      usage: { inputTokens: 1000, outputTokens: 800, totalTokens: 1800 },
    } as never)

    const repo = makeRepo()
    await runEntityRelationshipsStage(repo as unknown as Repo, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      keyPrefix: 'test:',
    })

    expect(ai.generateText).toHaveBeenCalledTimes(1)
    const insertedRows = repo.relationships.insertMany.mock.calls[0]?.[0] as unknown[]
    expect(insertedRows).toHaveLength(5)
  })

  it('Zod-fail → Haiku fails → Sonnet repair succeeds → persists Sonnet tree', async () => {
    const invalidTree = {
      relationships: makeValidTree().relationships.slice(0, 3),
      hierarchy_stragglers: [],
      new_entity_declarations: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(invalidTree),
      object: makeRejectedObject(invalidTree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 800, totalTokens: 4800 }),
    } as never)

    // Haiku returns still-invalid (4 relationships, still below min)
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: {
        relationships: makeValidTree().relationships.slice(0, 4),
        hierarchy_stragglers: [],
        new_entity_declarations: [],
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

    const repo = makeRepo()
    const result = await runEntityRelationshipsStage(repo as unknown as Repo, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      keyPrefix: 'test:',
    })

    expect(ai.generateText).toHaveBeenCalledTimes(2)
    // myth-t1qz: repair-chain usage is folded inside the wrapper and not
    // separately attributed to the stage's result.inputTokens.
    expect(result.inputTokens).toBe(4000)
    expect(result.outputTokens).toBe(800)
  })

  it('repair exhausted → throws LlmStructuredOutputError; outer scope owns stage-reset', async () => {
    // Per the unified stage-dispatch contract (MYT-52 T13), the handler does
    // NOT publish `stage-reset` itself — it just throws. The outer
    // `runStage` dispatcher in world-gen-processor catches, ROLLBACKs, and
    // publishes stage-reset uniformly across all wave-4 stages.
    const invalidTree = {
      relationships: makeValidTree().relationships.slice(0, 3),
      hierarchy_stragglers: [],
      new_entity_declarations: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(invalidTree),
      object: makeRejectedObject(invalidTree),
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
    const repo = makeRepo()
    await expect(
      runEntityRelationshipsStage(repo as unknown as Repo, {
        ...baseArgs,
        job: fakeJob(),
        redisRealtime: redis,
        keyPrefix: 'test:',
      }),
    ).rejects.toThrow(/unparseable structured output/i)

    // Contract: handler does not publish stage-reset on repair exhaustion.
    const resetEvents = redis.publishes.filter(
      (p) => (p.payload as { type: string }).type === 'stage-reset',
    )
    expect(resetEvents).toHaveLength(0)
    expect(repo.relationships.insertMany).not.toHaveBeenCalled()
  })

  it('renders the entity inventory + world-summary placeholders into the prompt', async () => {
    const tree = makeValidTree()
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const repo = makeRepo()
    await runEntityRelationshipsStage(repo as unknown as Repo, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      keyPrefix: 'test:',
    })

    const call = vi.mocked(ai.streamObject).mock.calls.at(0)?.[0] as unknown as Record<
      string,
      unknown
    >
    const prompt = call.prompt as string
    expect(prompt).toContain('Aelmoor')
    expect(prompt).toContain('misted, melancholy')
    expect(prompt).toContain('The Iron Coast')
    // myth-2ob3: the LLM sees NAMES, not UUIDs. The rendered inventory
    // line is "- <name>  [<entityType>]" — no UUID.
    expect(prompt).not.toContain(E1)
    expect(prompt).toContain('Silver Brotherhood')
    expect(prompt).not.toContain('{{entityInventory}}')
    expect(prompt).not.toContain('{{worldName}}')
  })

  it('all hierarchy stragglers fail inventory filter — early-return, no SQL probe + no inserts', async () => {
    // Every straggler references at least one unknown name — the resolver
    // drops them all and the persister skips the existing-row probe.
    const tree = {
      relationships: makeValidTree().relationships,
      hierarchy_stragglers: [
        { parent_name: NAME_GHOST, child_name: NAME_E1 },
        { parent_name: NAME_E1, child_name: NAME_GHOST },
      ],
      new_entity_declarations: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const repo = makeRepo()
    await runEntityRelationshipsStage(repo as unknown as Repo, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      keyPrefix: 'test:',
    })

    expect(repo.entityHierarchy.insert).not.toHaveBeenCalled()
    // No existing-row probe was issued (the early-return path skipped it):
    // every straggler failed name resolution, so persistStragglers returns
    // before calling repo.entityHierarchy.listExistingChildIds.
    expect(repo.entityHierarchy.listExistingChildIds).not.toHaveBeenCalled()
  })

  it('empty hierarchy_stragglers — no entityHierarchy.insert calls + no straggler SQL probe', async () => {
    const tree = makeValidTree()
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const repo = makeRepo()
    await runEntityRelationshipsStage(repo as unknown as Repo, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      keyPrefix: 'test:',
    })

    expect(repo.entityHierarchy.insert).not.toHaveBeenCalled()
  })

  it('myth-exac T15: tier filter on endpoints — inserts all rows in DB but only emits finalized for known→known', async () => {
    // Mixed-tier inventory: E1 known, E2 known, E3 secret. The LLM emits
    // 5 relationships (min schema cardinality) — one known→known, the rest
    // touch the secret entity. Expected DB writes: 5 rows. Expected
    // finalizedEvents: 1 (the known→known edge only).
    const mixedTierInventory = inventoryFromEntities([
      { id: E1, entityType: 'location', name: 'Iron Coast', accessLevel: 'known' },
      { id: E2, entityType: 'faction', name: 'Brotherhood', accessLevel: 'known' },
      { id: E3, entityType: 'npc', name: 'Hidden Cabal', accessLevel: 'secret' },
    ])
    const padded = {
      relationships: [
        // known → known (the only edge that should surface as finalized).
        // Every edge here is access_level:'known', so the finalized gate is
        // exercised purely on endpoint tiers. myth-pq0ug adds a dedicated
        // test below proving the edge's OWN tier ALSO gates the finalized
        // event (a secret edge between known endpoints must NOT finalize).
        { from_name: 'Iron Coast', to_name: 'Brotherhood', relationship: 'controls', description: 'Coast under brotherhood rule', access_level: 'known' },
        // known → secret
        { from_name: 'Iron Coast', to_name: 'Hidden Cabal', relationship: 'opposed_to', description: 'Coast threatened by hidden cabal', access_level: 'known' },
        // secret → secret (self-loop on same entity name)
        { from_name: 'Hidden Cabal', to_name: 'Hidden Cabal', relationship: 'allied_with', description: 'Cabal members protect each other', access_level: 'known' },
        // secret → known
        { from_name: 'Hidden Cabal', to_name: 'Iron Coast', relationship: 'pursues', description: 'Cabal watches the iron coast', access_level: 'known' },
        // secret → known
        { from_name: 'Hidden Cabal', to_name: 'Brotherhood', relationship: 'betrayed_by', description: 'Cabal sabotages brotherhood plans', access_level: 'known' },
      ],
      hierarchy_stragglers: [],
      new_entity_declarations: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(padded),
      object: Promise.resolve(padded),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const repo = makeRepo()
    repo.worldInventory.load.mockResolvedValue(mixedTierInventory)
    const result = await runEntityRelationshipsStage(repo as unknown as Repo, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      keyPrefix: 'test:',
    })

    // DB: every accepted row is inserted, regardless of tier.
    const insertedRows = repo.relationships.insertMany.mock.calls[0]?.[0] as readonly unknown[]
    expect(insertedRows).toHaveLength(5)
    // SSE: only the single known→known relationship surfaces.
    const finalized = result.finalizedEvents.filter((e) => e.type === 'finalized')
    expect(finalized).toHaveLength(1)
    if (finalized[0]?.type !== 'finalized') throw new Error('expected finalized event')
    // synthKey is keyed off the LLM-stream index (0 = the known→known edge).
    expect(finalized[0].synthKey).toBe('entity_relationships/relationships/0')
    expect(finalized[0].entityId).toBe('rel-0')
  })

  it('myth-pq0ug: tier filter on the EDGE itself — a secret edge between two KNOWN endpoints is inserted but NOT finalized', async () => {
    // All three entities are KNOWN, so endpoint-tier gating alone would emit
    // every edge. One relationship is itself access_level:'secret' — the
    // deterministic known↔known leak class. It must persist to the DB (the
    // world still knows it) but must NOT surface as a `finalized` wire event.
    const allKnownInventory = inventoryFromEntities([
      { id: E1, entityType: 'location', name: 'Iron Coast', accessLevel: 'known' },
      { id: E2, entityType: 'faction', name: 'Brotherhood', accessLevel: 'known' },
      { id: E3, entityType: 'npc', name: 'Hidden Cabal', accessLevel: 'known' },
    ])
    const padded = {
      relationships: [
        { from_name: 'Iron Coast', to_name: 'Brotherhood', relationship: 'controls', description: 'Coast under brotherhood rule', access_level: 'known' },
        // known↔known but the EDGE is SECRET — must be suppressed from the wire.
        { from_name: 'Iron Coast', to_name: 'Hidden Cabal', relationship: 'secretly_funds', description: 'Coast quietly bankrolls the cabal', access_level: 'secret' },
        { from_name: 'Brotherhood', to_name: 'Hidden Cabal', relationship: 'allied_with', description: 'Brotherhood and cabal cooperate openly', access_level: 'known' },
        { from_name: 'Hidden Cabal', to_name: 'Iron Coast', relationship: 'watches', description: 'Cabal watches the coast', access_level: 'known' },
        { from_name: 'Brotherhood', to_name: 'Iron Coast', relationship: 'defends', description: 'Brotherhood defends the coast', access_level: 'known' },
      ],
      hierarchy_stragglers: [],
      new_entity_declarations: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(padded),
      object: Promise.resolve(padded),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const repo = makeRepo()
    repo.worldInventory.load.mockResolvedValue(allKnownInventory)
    const result = await runEntityRelationshipsStage(repo as unknown as Repo, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      keyPrefix: 'test:',
    })

    // DB: every accepted row is inserted, regardless of the edge's tier.
    const insertedRows = repo.relationships.insertMany.mock.calls[0]?.[0] as readonly unknown[]
    expect(insertedRows).toHaveLength(5)
    // SSE: the four known edges finalize; the secret edge (index 1) does NOT.
    const finalized = result.finalizedEvents.filter((e) => e.type === 'finalized')
    const finalizedKeys = finalized.map((e) => e.synthKey)
    expect(finalizedKeys).not.toContain('entity_relationships/relationships/1')
    expect(finalizedKeys).toHaveLength(4)
  })

  // myth-pfke task 9c: vocabulary registry placeholder substitution.
  it('substitutes {{vocabularyRegistry}} with the rendered registry prose', async () => {
    const tree = makeValidTree()
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const registry: VocabularyRegistry = {
      entries: [
        {
          term: 'the unwitched',
          definition:
            "non-magical people; this world's term for those without arcane sight.",
          avoids: 'muggle',
          source: 'stage_1_5',
          access_level: 'known',
        },
      ],
      adjacent_franchises: ['Harry Potter'],
    }

    const repo = makeRepo()
    await runEntityRelationshipsStage(repo as unknown as Repo, {
      ...baseArgs,
      vocabularyRegistry: registry,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      keyPrefix: 'test:',
    })

    const captured = vi.mocked(ai.streamObject).mock.calls[0]?.[0] as
      | { prompt: string }
      | undefined
    const prompt = captured?.prompt ?? ''
    expect(prompt).toContain("This world's distinctive vocabulary:")
    expect(prompt).toContain('the unwitched')
    expect(prompt).not.toContain('{{vocabularyRegistry}}')
  })

  it('myth-exac T15: bypassAccessFilter=true surfaces every relationship regardless of endpoint tier', async () => {
    // Same mixed-tier inventory but bypass on: every persisted row also
    // emits a finalized event (dev-tool / author mode).
    const mixedTierInventory = inventoryFromEntities([
      { id: E1, entityType: 'location', name: 'Iron Coast', accessLevel: 'known' },
      { id: E2, entityType: 'faction', name: 'Brotherhood', accessLevel: 'known' },
      { id: E3, entityType: 'npc', name: 'Hidden Cabal', accessLevel: 'secret' },
    ])
    const tree = {
      relationships: [
        { from_name: 'Iron Coast', to_name: 'Brotherhood', relationship: 'controls', description: 'Coast under brotherhood rule', access_level: 'known' },
        { from_name: 'Iron Coast', to_name: 'Hidden Cabal', relationship: 'opposed_to', description: 'Coast threatened by hidden cabal', access_level: 'known' },
        { from_name: 'Hidden Cabal', to_name: 'Hidden Cabal', relationship: 'allied_with', description: 'Cabal members protect each other', access_level: 'known' },
        { from_name: 'Hidden Cabal', to_name: 'Iron Coast', relationship: 'pursues', description: 'Cabal watches the iron coast', access_level: 'known' },
        { from_name: 'Hidden Cabal', to_name: 'Brotherhood', relationship: 'betrayed_by', description: 'Cabal sabotages brotherhood plans', access_level: 'known' },
      ],
      hierarchy_stragglers: [],
      new_entity_declarations: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const repo = makeRepo()
    repo.worldInventory.load.mockResolvedValue(mixedTierInventory)
    const result = await runEntityRelationshipsStage(repo as unknown as Repo, {
      ...baseArgs,
      bypassAccessFilter: true,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      keyPrefix: 'test:',
    })

    const insertedRows = repo.relationships.insertMany.mock.calls[0]?.[0] as readonly unknown[]
    expect(insertedRows).toHaveLength(5)
    const finalized = result.finalizedEvents.filter((e) => e.type === 'finalized')
    expect(finalized).toHaveLength(5)
  })

  // myth-pfke P3.3: phantom-reference reconciliation. Stage 4 now accepts
  // placeholder endpoints (`new-NNN`) + a `new_entity_declarations` array.
  // The handler partitions: real→real relationships persist into the
  // `relationships` table; placeholder-touching relationships + declarations
  // are written to `worlds.entity_consolidation_pending` for stage 4b.
  it('routes placeholder-endpoint relationships to pending state column', async () => {
    // myth-2ob3: the streaming extractor mints synthIds (`new-NNN`) for
    // each declaration as it streams. With one declaration, the synthId is
    // `new-001`. The natural streaming-emit order pulls declarations into
    // pendingDeclarations BEFORE relationships resolve.
    const tree = {
      // declarations FIRST so the streaming extractor populates the
      // pendingDeclarations map before resolving relationship items.
      new_entity_declarations: [{ name: 'The Ironjaw', entity_type: 'faction' as const }],
      relationships: [
        // Real → real (persists into relationships table)
        { from_name: NAME_E1, to_name: NAME_E2, relationship: 'rival_of', description: 'Iron Coast rivals the brotherhood', access_level: 'known' },
        // Real → declared-phantom (routed to pending state via synthId)
        { from_name: NAME_E2, to_name: 'The Ironjaw', relationship: 'opposed_to', description: 'Brotherhood opposes phantom faction', access_level: 'discoverable' },
      ],
      hierarchy_stragglers: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const repo = makeRepo()
    await runEntityRelationshipsStage(repo as unknown as Repo, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      keyPrefix: 'test:',
    })

    // Real-endpoint relationship persists; placeholder one does NOT.
    expect(repo.relationships.insertMany).toHaveBeenCalledTimes(1)
    const insertedRows = repo.relationships.insertMany.mock.calls[0]?.[0] as readonly {
      readonly sourceEntityId: string
      readonly targetEntityId: string
      readonly relationshipType: string
    }[]
    expect(insertedRows).toHaveLength(1)
    expect(insertedRows[0]).toEqual({
      sourceEntityId: E1,
      targetEntityId: E2,
      relationshipType: 'rival_of',
      description: 'Iron Coast rivals the brotherhood',
      // MYT-89 Phase A: tier carried from the LLM row.
      accessLevel: 'known',
      // myth-imxg.4: real→real row is at LLM-stream index 0 in this tree.
      synthKey: 'entity_relationships/relationships/0',
    })

    // Pending state persisted via repo.worlds.setEntityConsolidationPending
    // (worldId, json).
    expect(repo.worlds.setEntityConsolidationPending).toHaveBeenCalledTimes(1)
    const pendingCall = repo.worlds.setEntityConsolidationPending.mock.calls[0] as [string, string]
    expect(pendingCall[0]).toBe('wld-1')
    const pendingJson = JSON.parse(pendingCall[1]) as {
      declarations: { placeholderId: string; name: string; entityType: string }[]
      relationships: { from: string; to: string; relationship: string; description: string; accessLevel: string }[]
    }
    expect(pendingJson.declarations).toHaveLength(1)
    expect(pendingJson.declarations[0]).toEqual({
      placeholderId: 'new-001',
      name: 'The Ironjaw',
      entityType: 'faction',
    })
    expect(pendingJson.relationships).toHaveLength(1)
    expect(pendingJson.relationships[0]).toEqual({
      from: E2,
      to: 'new-001',
      relationship: 'opposed_to',
      description: 'Brotherhood opposes phantom faction',
      // MYT-89 Phase A: stage 4 stamps the phantom edge's tier into the
      // buffer so stage 4b persists it when the ghost materializes.
      accessLevel: 'discoverable',
    })
  })

  it('drops hallucinated-name→placeholder relationships (unknown from, placeholder to)', async () => {
    // myth-2ob3: covers the from-side unknown arm — the `to` is a declared
    // phantom name, the `from` is a name NOT in the inventory. Must drop,
    // not throw.
    const tree = {
      new_entity_declarations: [{ name: 'The Ironjaw', entity_type: 'faction' as const }],
      relationships: [
        // Pad with 4 valid real→real rows so the schema's min(5) holds.
        { from_name: NAME_E1, to_name: NAME_E2, relationship: 'controls', description: 'a', access_level: 'known' },
        { from_name: NAME_E2, to_name: NAME_E3, relationship: 'leads', description: 'b', access_level: 'known' },
        { from_name: NAME_E3, to_name: NAME_E4, relationship: 'protects', description: 'c', access_level: 'known' },
        { from_name: NAME_E4, to_name: NAME_E1, relationship: 'located_in', description: 'd', access_level: 'known' },
        // The drop target: hallucinated name from, phantom to.
        { from_name: NAME_GHOST, to_name: 'The Ironjaw', relationship: 'pursues', description: 'ghost→phantom', access_level: 'known' },
      ],
      hierarchy_stragglers: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const repo = makeRepo()
    await runEntityRelationshipsStage(repo as unknown as Repo, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      keyPrefix: 'test:',
    })

    const insertedRows = repo.relationships.insertMany.mock.calls[0]?.[0] as readonly {
      readonly sourceEntityId: string
      readonly targetEntityId: string
    }[]
    expect(insertedRows).toHaveLength(4)
    // The placeholder side dropped too — no placeholder rel survived.
    const pendingCall = repo.worlds.setEntityConsolidationPending.mock.calls[0] as [string, string]
    const pendingJson = JSON.parse(pendingCall[1]) as { relationships: unknown[] }
    expect(pendingJson.relationships).toHaveLength(0)
  })

  it('drops placeholder→hallucinated-name relationships (placeholder from, unknown to)', async () => {
    // myth-2ob3: covers the to-side unknown arm — the `from` is a declared
    // phantom name, the `to` is a name NOT in the inventory. Must drop,
    // not throw.
    const tree = {
      new_entity_declarations: [{ name: 'The Ironjaw', entity_type: 'faction' as const }],
      relationships: [
        // Pad with 4 valid real→real rows so the schema's min(5) holds.
        { from_name: NAME_E1, to_name: NAME_E2, relationship: 'controls', description: 'a', access_level: 'known' },
        { from_name: NAME_E2, to_name: NAME_E3, relationship: 'leads', description: 'b', access_level: 'known' },
        { from_name: NAME_E3, to_name: NAME_E4, relationship: 'protects', description: 'c', access_level: 'known' },
        { from_name: NAME_E4, to_name: NAME_E1, relationship: 'located_in', description: 'd', access_level: 'known' },
        // The drop target: phantom from, hallucinated name to.
        { from_name: 'The Ironjaw', to_name: NAME_GHOST, relationship: 'pursues', description: 'phantom→ghost', access_level: 'known' },
      ],
      hierarchy_stragglers: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const repo = makeRepo()
    await runEntityRelationshipsStage(repo as unknown as Repo, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      keyPrefix: 'test:',
    })

    // The 4 real→real rows persist; the placeholder→GHOST row is dropped.
    const insertedRows = repo.relationships.insertMany.mock.calls[0]?.[0] as readonly {
      readonly sourceEntityId: string
      readonly targetEntityId: string
    }[]
    expect(insertedRows).toHaveLength(4)
    for (const row of insertedRows) {
      expect(row.sourceEntityId).not.toBe(GHOST)
      expect(row.targetEntityId).not.toBe(GHOST)
    }
  })

  it('drops relationship rows with unresolvable name endpoints (unknown-name WARN)', async () => {
    // myth-2ob3: covers the unknown-name drop arm — the LLM emits a
    // relationship referencing a name that's neither in inventory nor in
    // new_entity_declarations. The row must drop without throwing; the
    // pending-state UPDATE still fires but no placeholder row appears.
    const tree = {
      relationships: [
        { from_name: NAME_E1, to_name: NAME_E2, relationship: 'controls', description: 'a', access_level: 'known' },
        { from_name: NAME_E2, to_name: NAME_E3, relationship: 'leads', description: 'b', access_level: 'known' },
        { from_name: NAME_E3, to_name: NAME_E4, relationship: 'protects', description: 'c', access_level: 'known' },
        { from_name: NAME_E4, to_name: NAME_E1, relationship: 'located_in', description: 'd', access_level: 'known' },
        // Unknown name on the to side — no inventory match, no declaration.
        { from_name: NAME_E1, to_name: 'Some Unknown Entity', relationship: 'opposed_to', description: 'phantom orphan', access_level: 'known' },
      ],
      hierarchy_stragglers: [],
      new_entity_declarations: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const repo = makeRepo()
    await runEntityRelationshipsStage(repo as unknown as Repo, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      keyPrefix: 'test:',
    })

    // The 4 real rows persist; the orphan-placeholder row drops — the
    // pending-state UPDATE still fires (always written) but its payload
    // contains zero declarations + zero placeholder rows.
    const insertedRows = repo.relationships.insertMany.mock.calls[0]?.[0] as readonly unknown[]
    expect(insertedRows).toHaveLength(4)
    expect(repo.worlds.setEntityConsolidationPending).toHaveBeenCalledTimes(1)
    const pendingCall = repo.worlds.setEntityConsolidationPending.mock.calls[0] as [string, string]
    const pendingJson = JSON.parse(pendingCall[1]) as {
      declarations: unknown[]
      relationships: unknown[]
    }
    expect(pendingJson.declarations).toHaveLength(0)
    expect(pendingJson.relationships).toHaveLength(0)
  })

  it('cascade-clears prior stage_consolidation ghosts on stage-4 retry', async () => {
    // myth-tt2g: a stage-4 retry must clear prior stage-4b ghost entities
    // (created_in='stage:entity_consolidation') so the new stage-4 attempt
    // doesn't leave orphan ghosts mismatched with its new declaration set.
    // Stage 4 + 4b are a single retry unit (design §D9 + P3.4).
    const tree = {
      relationships: [
        { from_name: NAME_E1, to_name: NAME_E2, relationship: 'rival_of', description: 'Fresh rel', access_level: 'known' },
      ],
      hierarchy_stragglers: [],
      new_entity_declarations: [],
    }
    vi.mocked(ai.streamObject).mockReturnValueOnce({
      partialObjectStream: makeStream(tree),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 4000, outputTokens: 1200, totalTokens: 5200 }),
    } as never)

    const repo = makeRepo()
    await runEntityRelationshipsStage(repo as unknown as Repo, {
      ...baseArgs,
      job: fakeJob(),
      redisRealtime: fakeRedis(),
      keyPrefix: 'test:',
    })

    // The handler must wipe entities scoped to the world AND
    // created_in='stage:entity_consolidation' via
    // repo.entities.deleteByWorldAndCreatedIn. CASCADE on relationships takes
    // care of the orphaned rows pointing at those ghosts.
    expect(repo.entities.deleteByWorldAndCreatedIn).toHaveBeenCalledTimes(1)
    expect(repo.entities.deleteByWorldAndCreatedIn).toHaveBeenCalledWith(
      'wld-1',
      'stage:entity_consolidation',
    )

    // And it must run AFTER relationships.deleteByWorld — the two together
    // form the stage's idempotency wipe (both inside the same tx).
    const deleteByWorldOrder = repo.relationships.deleteByWorld.mock.invocationCallOrder[0] ?? 0
    const ghostWipeOrder =
      repo.entities.deleteByWorldAndCreatedIn.mock.invocationCallOrder[0] ??
      Number.MAX_SAFE_INTEGER
    expect(deleteByWorldOrder).toBeLessThan(ghostWipeOrder)
  })
})
