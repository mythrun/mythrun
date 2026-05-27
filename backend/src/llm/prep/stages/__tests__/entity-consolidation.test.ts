// backend/src/llm/prep/stages/__tests__/entity-consolidation.test.ts
//
// Per myth-pfke P4.3 + P4.4. Stage 4b (`entity_consolidation`):
//   - Skip path: empty pending → zero-cost result, no LLM call.
//   - Happy path: pending declarations → Sonnet generateObject, persist
//     ghost entity + facts + prose + resolved placeholder relationships,
//     clear the state column.
//
// Pattern mirrors entity-relationships.test.ts (mock-client + repo spies).
// The handler's `generateObject` is the wrapper at ../../ai.js, which
// internally invokes the SDK's `generateText`. We mock both layers:
//   - `ai` SDK: `generateText` for the wrapper's internal call.
//   - Repo modules (entities/relationships/facts/prose-kernels/
//     entity-hierarchy): spies so we can assert persist contracts.
// Real-DB coverage is at Layer 3.

/* eslint-disable @typescript-eslint/no-deprecated -- design §4.1 mandates streamObject; mocking the deprecated SDK function is intentional. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    streamObject: vi.fn(),
    generateObject: vi.fn(),
    generateText: vi.fn(),
    Output: { object: vi.fn((opts: unknown) => opts) },
  }
})

vi.mock('../../../../repo/entities.js', () => ({
  entities: {
    listByWorld: vi.fn(),
    insert: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../../../repo/relationships.js', () => ({
  relationships: {
    insertMany: vi
      .fn()
      .mockImplementation(
        // eslint-disable-next-line @typescript-eslint/require-await
        async (_client: unknown, rows: readonly unknown[]): Promise<readonly string[]> =>
          rows.map((_r, i) => `rel-${String(i)}`),
      ),
  },
}))

vi.mock('../../../../repo/facts.js', () => ({
  facts: {
    insertMany: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../../../repo/prose-kernels.js', () => ({
  proseKernels: {
    insert: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../../../repo/entity-hierarchy.js', () => ({
  entityHierarchy: {
    insert: vi.fn().mockResolvedValue(undefined),
  },
}))

// Deterministic UUIDv7 stream so we can assert IDs precisely. The handler
// calls uuidv7() once per surviving ghost; subsequent IDs return GHOST_UUID_N.
vi.mock('../../../../repo/uuidv7.js', () => {
  let counter = 0
  return {
    uuidv7: vi.fn(() => {
      counter += 1
      // RFC 4122 v7-shaped synthetic IDs — only the last hex byte varies.
      return `01923456-789a-7bcd-8ef0-99999999990${String(counter)}`
    }),
  }
})

import * as ai from 'ai'
import { runEntityConsolidationStage } from '../entity-consolidation.js'
import { entities } from '../../../../repo/entities.js'
import { relationships } from '../../../../repo/relationships.js'
import { facts } from '../../../../repo/facts.js'
import { proseKernels } from '../../../../repo/prose-kernels.js'
import { entityHierarchy } from '../../../../repo/entity-hierarchy.js'
import type { VocabularyRegistry } from '../../../schemas/vocabulary-registry.js'

const EMPTY_REGISTRY: VocabularyRegistry = { entries: [], adjacent_franchises: [] }

interface QuerySpy {
  query: ReturnType<typeof vi.fn>
}

function makeClientWithEmptyPending(): QuerySpy {
  return {
    query: vi.fn().mockResolvedValue({
      rows: [
        {
          entity_consolidation_pending: { declarations: [], relationships: [] },
        },
      ],
    }),
  }
}

// P5.2: a per-test Redis publish stub. Each `it` rebinds the spy via the
// `makeArgs` helper so assertions are isolated per case.
function makeRedisStub(): { publish: ReturnType<typeof vi.fn> } {
  return { publish: vi.fn().mockResolvedValue(1) }
}

function makeArgs(redis: { publish: ReturnType<typeof vi.fn> }) {
  return {
    campaignId: 'cmp-1',
    worldId: 'wld-1',
    worldName: 'Aelmoor',
    tone: 'misted, melancholy',
    themes: 'guardianship, secrets',
    keyTensions: 'spirits chafe in lanterns',
    vocabularyRegistry: EMPTY_REGISTRY,
    bypassAccessFilter: false,
    redisRealtime: redis as never,
    keyPrefix: 'mythrun:',
  }
}

const baseArgs = makeArgs(makeRedisStub())

describe('runEntityConsolidationStage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(entities.listByWorld).mockResolvedValue([])
    vi.mocked(relationships.insertMany).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/require-await
      async (_client, rows) => rows.map((_r, i) => `rel-${String(i)}`),
    )
  })

  it('skip path: empty pending state → zero-cost result, no LLM call, no finalizedEvents', async () => {
    const client = makeClientWithEmptyPending()
    const result = await runEntityConsolidationStage(client as never, baseArgs)

    expect(result.costUsd).toBe(0)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
    expect(result.finalizedEvents).toEqual([])
    expect(result.capExhausted).toBe(false)

    // No LLM SDK call attempted on the skip path.
    expect(ai.generateObject).not.toHaveBeenCalled()
    expect(ai.streamObject).not.toHaveBeenCalled()
    expect(ai.generateText).not.toHaveBeenCalled()

    // Exactly one DB call: the SELECT against `worlds` to read pending state.
    expect(client.query).toHaveBeenCalledTimes(1)
    const call = client.query.mock.calls[0] as unknown as readonly [string, readonly unknown[]]
    expect(call[0]).toContain('entity_consolidation_pending')
    expect(call[0]).toContain('FROM worlds')
    expect(call[1]).toEqual(['wld-1'])
  })

  it('skip path: row missing entirely (worlds.id race) → still zero-cost, no LLM call', async () => {
    // Defense-in-depth: if the SELECT returns zero rows (e.g., world was
    // deleted between stage-4 commit and stage-4b dispatch), the handler
    // must treat that as "no phantoms to consolidate" rather than crashing.
    const client: QuerySpy = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }
    const result = await runEntityConsolidationStage(client as never, baseArgs)

    expect(result.costUsd).toBe(0)
    expect(result.finalizedEvents).toEqual([])
    expect(ai.generateObject).not.toHaveBeenCalled()
  })

  // myth-pfke P4.4. Pending declarations → ghosts persist, pending
  // placeholder-touching relationships resolve to real UUIDs, state clears.
  // Mirrors the plan's happy-path test but uses the mock-client pattern
  // (matching this file's P4.3 setup), not real Postgres.
  it('happy path: pending declarations → ghosts persist, relationships resolve, state clears', async () => {
    const redis = makeRedisStub()
    const args = makeArgs(redis)
    const FACTION_E1 = '01923456-789a-7bcd-8ef0-000000000001'
    const PENDING_STATE = {
      declarations: [
        { placeholderId: 'new-001', name: 'The Ironjaw', entityType: 'faction' as const },
      ],
      relationships: [
        {
          from: FACTION_E1,
          to: 'new-001',
          relationship: 'rival_of',
          description: 'Long Vigil rivals the Ironjaw over Bone Reach territory.',
        },
      ],
    }

    // SELECT pending state → 1 declaration. All other client.query calls
    // (DELETE / UPDATE) return an empty rowset.
    const client: QuerySpy = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT entity_consolidation_pending')) {
          return Promise.resolve({
            rows: [{ entity_consolidation_pending: PENDING_STATE }],
          })
        }
        return Promise.resolve({ rows: [] })
      }),
    }

    // Inventory: one real faction; the Sonnet prompt renders it into the
    // existing-entities block. The ghost is NOT in the inventory.
    vi.mocked(entities.listByWorld).mockResolvedValue([
      {
        id: FACTION_E1,
        worldId: 'wld-1',
        entityType: 'faction',
        name: 'Long Vigil',
        accessLevel: 'known',
      },
    ])

    // Mock the Sonnet response (the wrapper hands back this shape).
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: {
        ghost_entities: [
          {
            placeholder_id: 'new-001',
            name: 'The Ironjaw',
            entity_type: 'faction',
            access_level: 'known',
            parent_location_id: null,
            prose:
              'The Ironjaw is one of the four hunting bands of the Bone Reach, contesting territory with the Long Vigil.',
            facts: [
              {
                topic: 'territory',
                content: 'Ranges the eastern Bone Reach canyons.',
                access_level: 'known',
              },
              {
                topic: 'rivalry',
                content: 'Long Vigil disputes their Boneright claims.',
                access_level: 'known',
              },
            ],
          },
        ],
      },
      finishReason: 'stop',
      usage: { inputTokens: 500, outputTokens: 800, totalTokens: 1300 },
    } as never)

    const result = await runEntityConsolidationStage(client as never, args)

    // Ghost persisted with the correct created_in marker + name.
    expect(entities.insert).toHaveBeenCalledTimes(1)
    const insertCall = vi.mocked(entities.insert).mock.calls[0]?.[1] as {
      readonly name: string
      readonly entityType: string
      readonly accessLevel: string
      readonly createdIn: string
      readonly id: string
    }
    expect(insertCall.name).toBe('The Ironjaw')
    expect(insertCall.entityType).toBe('faction')
    expect(insertCall.accessLevel).toBe('known')
    expect(insertCall.createdIn).toBe('stage:entity_consolidation')

    // Prose persisted.
    expect(proseKernels.insert).toHaveBeenCalledTimes(1)
    const proseArg = vi.mocked(proseKernels.insert).mock.calls[0]?.[1] as {
      readonly entityId: string
      readonly content: string
    }
    expect(proseArg.entityId).toBe(insertCall.id)
    expect(proseArg.content).toContain('hunting bands')

    // Both facts persisted in a single insertMany call.
    expect(facts.insertMany).toHaveBeenCalledTimes(1)
    const factRows = vi.mocked(facts.insertMany).mock.calls[0]?.[1] as readonly {
      readonly entityId: string
      readonly topic: string
      readonly content: string
      readonly accessLevel: string
    }[]
    expect(factRows).toHaveLength(2)
    expect(factRows[0]?.topic).toBe('territory')
    expect(factRows[1]?.topic).toBe('rivalry')
    for (const row of factRows) {
      expect(row.entityId).toBe(insertCall.id)
    }

    // Pending placeholder-touching relationship resolved + persisted.
    expect(relationships.insertMany).toHaveBeenCalledTimes(1)
    const relRows = vi.mocked(relationships.insertMany).mock.calls[0]?.[1] as readonly {
      readonly sourceEntityId: string
      readonly targetEntityId: string
      readonly relationshipType: string
      readonly description: string
      readonly synthKey: string
    }[]
    expect(relRows).toHaveLength(1)
    expect(relRows[0]).toEqual({
      sourceEntityId: FACTION_E1,
      targetEntityId: insertCall.id,
      relationshipType: 'rival_of',
      description: 'Long Vigil rivals the Ironjaw over Bone Reach territory.',
      // myth-imxg.5: insert-time synth_key carries the same wire identity
      // the per-resolved-relationship `edge-added` event publishes, so
      // stage 7 can address the row by the same string stage 4b established
      // on the wire.
      synthKey: 'entity_consolidation/relationships/0',
    })
    // synth_key shape: one per resolved relationship, indexed in insertMany
    // order (same `i` as the edge-added event emission below).
    expect(relRows.map((r) => r.synthKey)).toEqual([
      'entity_consolidation/relationships/0',
    ])

    // Pending state UPDATE clears declarations + relationships to empty.
    const clearCall = client.query.mock.calls.find((call) => {
      const sql = call[0] as string
      return sql.includes('UPDATE worlds') && sql.includes('entity_consolidation_pending')
    })
    expect(clearCall).toBeDefined()
    const clearSql = clearCall?.[0] as string
    expect(clearSql).toContain('declarations')
    expect(clearSql).toContain('relationships')
    // The cleared shape is empty arrays.
    expect(clearSql).toMatch(/\[\s*\]/)

    // Idempotency wipe ran BEFORE the LLM call.
    const ghostWipeIdx = client.query.mock.calls.findIndex((call) => {
      const sql = call[0] as string
      return (
        sql.includes('DELETE FROM entities') &&
        sql.includes("'stage:entity_consolidation'")
      )
    })
    expect(ghostWipeIdx).toBeGreaterThanOrEqual(0)
    const wipeOrder = client.query.mock.invocationCallOrder[ghostWipeIdx]
    const llmOrder = vi.mocked(ai.generateText).mock.invocationCallOrder[0]
    expect(wipeOrder).toBeLessThan(llmOrder ?? Number.MAX_SAFE_INTEGER)

    // Cost accounting: 500/1M * 3 + 800/1M * 15 = 0.0015 + 0.012 = 0.0135
    expect(result.costUsd).toBeCloseTo(0.0135, 6)
    expect(result.inputTokens).toBe(500)
    expect(result.outputTokens).toBe(800)
    expect(result.capExhausted).toBe(false)
    expect(result.finalizedEvents).toEqual([])

    // P5.2: per-ghost `entity-added` + per-resolved-relationship `edge-added`
    // events publish to `${keyPrefix}pipeline:campaign:${campaignId}`.
    // Exactly one ghost + one resolved relationship → 2 publishes total.
    expect(redis.publish).toHaveBeenCalledTimes(2)
    const CHANNEL = 'mythrun:pipeline:campaign:cmp-1'
    const entityAddedCall = redis.publish.mock.calls.find((c) => {
      const payload = JSON.parse(c[1] as string) as { type: string }
      return payload.type === 'entity-added'
    })
    expect(entityAddedCall?.[0]).toBe(CHANNEL)
    const entityAddedPayload = JSON.parse(entityAddedCall?.[1] as string) as {
      type: string
      synthKey: string
      entityKind: string
      name: string
      placeholderId: string
    }
    expect(entityAddedPayload).toEqual({
      type: 'entity-added',
      synthKey: 'entity_consolidation/ghosts/0',
      entityKind: 'faction',
      name: 'The Ironjaw',
      placeholderId: 'new-001',
    })

    const edgeAddedCall = redis.publish.mock.calls.find((c) => {
      const payload = JSON.parse(c[1] as string) as { type: string }
      return payload.type === 'edge-added'
    })
    expect(edgeAddedCall?.[0]).toBe(CHANNEL)
    const edgeAddedPayload = JSON.parse(edgeAddedCall?.[1] as string) as {
      type: string
      synthKey: string
      from: string
      to: string
      relationship: string
    }
    // Both endpoints are RESOLVED UUIDs (no placeholder strings on the wire).
    expect(edgeAddedPayload).toEqual({
      type: 'edge-added',
      synthKey: 'entity_consolidation/relationships/0',
      from: FACTION_E1,
      to: insertCall.id,
      relationship: 'rival_of',
    })
    expect(edgeAddedPayload.from.startsWith('new-')).toBe(false)
    expect(edgeAddedPayload.to.startsWith('new-')).toBe(false)
  })

  // Reconciliation arm: LLM emits a ghost whose placeholder_id is NOT in
  // the declarations map → drop it silently, persist only the survivors.
  // Also covers the inverse: a declared placeholder the LLM forgot → no
  // persist for that one; pending relationships referencing it are dropped.
  it('drops ghost_entities whose placeholder_id is not in the declarations map', async () => {
    const PENDING_STATE = {
      declarations: [
        { placeholderId: 'new-001', name: 'The Ironjaw', entityType: 'faction' as const },
      ],
      relationships: [],
    }
    const client: QuerySpy = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT entity_consolidation_pending')) {
          return Promise.resolve({
            rows: [{ entity_consolidation_pending: PENDING_STATE }],
          })
        }
        return Promise.resolve({ rows: [] })
      }),
    }
    vi.mocked(entities.listByWorld).mockResolvedValue([])

    // LLM emits two ghosts: one matches declarations, one is an undeclared
    // hallucination. The handler must persist only the matched one.
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: {
        ghost_entities: [
          {
            placeholder_id: 'new-001',
            name: 'The Ironjaw',
            entity_type: 'faction',
            access_level: 'known',
            parent_location_id: null,
            prose:
              'The Ironjaw is one of the four hunting bands of the Bone Reach, contesting territory with neighboring factions.',
            facts: [
              { topic: 'territory', content: 'Ranges the eastern Bone Reach canyons.', access_level: 'known' },
              { topic: 'rivalry', content: 'Hunted by the Long Vigil.', access_level: 'known' },
            ],
          },
          {
            placeholder_id: 'new-999',
            name: 'Phantom Faction',
            entity_type: 'faction',
            access_level: 'known',
            parent_location_id: null,
            prose:
              'A faction the LLM invented out of thin air without a corresponding stage-4 declaration.',
            facts: [
              { topic: 'a', content: 'invented detail one for ignored ghost', access_level: 'known' },
              { topic: 'b', content: 'invented detail two for ignored ghost', access_level: 'known' },
            ],
          },
        ],
      },
      finishReason: 'stop',
      usage: { inputTokens: 500, outputTokens: 800, totalTokens: 1300 },
    } as never)

    await runEntityConsolidationStage(client as never, baseArgs)

    // Only the declared ghost is persisted.
    expect(entities.insert).toHaveBeenCalledTimes(1)
    const insertCall = vi.mocked(entities.insert).mock.calls[0]?.[1] as { readonly name: string }
    expect(insertCall.name).toBe('The Ironjaw')
  })

  // Covers the missingIds WARN arm: LLM omits a ghost for a declared
  // placeholder. The handler must persist what the LLM did emit and WARN
  // about the unfulfilled declaration without throwing. Also covers the
  // `source === undefined || target === undefined → continue` branch on the
  // resolve-pending-relationships loop: the pending relationship that
  // references the omitted placeholder is dropped silently.
  it('WARNs when LLM omits ghost_entities for some declared placeholders', async () => {
    const FACTION_E1 = '01923456-789a-7bcd-8ef0-000000000001'
    const PENDING_STATE = {
      declarations: [
        { placeholderId: 'new-001', name: 'The Ironjaw', entityType: 'faction' as const },
        { placeholderId: 'new-002', name: 'The Forgotten', entityType: 'faction' as const },
      ],
      relationships: [
        // Endpoint references the placeholder the LLM forgot — must drop.
        {
          from: FACTION_E1,
          to: 'new-002',
          relationship: 'opposed_to',
          description: 'references the omitted placeholder',
        },
      ],
    }
    const client: QuerySpy = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT entity_consolidation_pending')) {
          return Promise.resolve({
            rows: [{ entity_consolidation_pending: PENDING_STATE }],
          })
        }
        return Promise.resolve({ rows: [] })
      }),
    }
    vi.mocked(entities.listByWorld).mockResolvedValue([])

    // LLM only emits one of the two declared placeholders.
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: {
        ghost_entities: [
          {
            placeholder_id: 'new-001',
            name: 'The Ironjaw',
            entity_type: 'faction',
            access_level: 'known',
            parent_location_id: null,
            prose:
              'The Ironjaw is one of the four hunting bands of the Bone Reach, contesting territory with neighboring factions.',
            facts: [
              { topic: 'territory', content: 'Ranges the eastern canyons.', access_level: 'known' },
              { topic: 'rivalry', content: 'Hunted by the Long Vigil.', access_level: 'known' },
            ],
          },
        ],
      },
      finishReason: 'stop',
      usage: { inputTokens: 500, outputTokens: 800, totalTokens: 1300 },
    } as never)

    await runEntityConsolidationStage(client as never, baseArgs)

    // Only the LLM-emitted ghost persists; the missing one is silently
    // skipped (WARN logged but no throw, no insert for new-002).
    expect(entities.insert).toHaveBeenCalledTimes(1)
    const insertCall = vi.mocked(entities.insert).mock.calls[0]?.[1] as { readonly name: string }
    expect(insertCall.name).toBe('The Ironjaw')
  })

  // Covers the location-ghost entity_hierarchy.insert branch: a ghost with
  // entity_type='location' and a non-null parent_location_id must link via
  // entityHierarchy.insert.
  it('links a location ghost with a parent_location_id into entity_hierarchy', async () => {
    const PARENT_LOCATION_ID = '01923456-789a-7bcd-8ef0-000000000abc'
    const PENDING_STATE = {
      declarations: [
        { placeholderId: 'new-001', name: 'Hidden Cove', entityType: 'location' as const },
      ],
      relationships: [],
    }
    const client: QuerySpy = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT entity_consolidation_pending')) {
          return Promise.resolve({
            rows: [{ entity_consolidation_pending: PENDING_STATE }],
          })
        }
        return Promise.resolve({ rows: [] })
      }),
    }
    vi.mocked(entities.listByWorld).mockResolvedValue([
      {
        id: PARENT_LOCATION_ID,
        worldId: 'wld-1',
        entityType: 'location',
        name: 'The Iron Coast',
        accessLevel: 'known',
      },
    ])

    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: {
        ghost_entities: [
          {
            placeholder_id: 'new-001',
            name: 'Hidden Cove',
            entity_type: 'location',
            access_level: 'known',
            parent_location_id: PARENT_LOCATION_ID,
            prose:
              'A sheltered cove on the lee side of the Iron Coast, only reachable at low tide through a slot in the cliffs.',
            facts: [
              { topic: 'access', content: 'Reachable only at low tide.', access_level: 'known' },
              { topic: 'fauna', content: 'Black-shell crabs nest here.', access_level: 'known' },
            ],
          },
        ],
      },
      finishReason: 'stop',
      usage: { inputTokens: 500, outputTokens: 800, totalTokens: 1300 },
    } as never)

    await runEntityConsolidationStage(client as never, baseArgs)

    // Ghost was inserted as a location; the parent_location link fired.
    expect(entities.insert).toHaveBeenCalledTimes(1)
    const insertCall = vi.mocked(entities.insert).mock.calls[0]?.[1] as {
      readonly id: string
      readonly entityType: string
    }
    expect(insertCall.entityType).toBe('location')

    expect(entityHierarchy.insert).toHaveBeenCalledTimes(1)
    expect(entityHierarchy.insert).toHaveBeenCalledWith(expect.anything(), {
      parentEntityId: PARENT_LOCATION_ID,
      childEntityId: insertCall.id,
    })
  })
})
