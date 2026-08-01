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

// Stage 4b reads + writes go through the repo binders (the fake repo's
// recording spies — see makeFakeRepo). No standalone repo module mocks are
// needed; the binder SQL is covered by the per-namespace repo integration
// tests (src/repo/__tests__/*).

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
import { makeFakeRepo, type FakeRepo } from './_helpers/fake-repo.js'
import type { Repo } from '../../../../repo/index.js'
import type { VocabularyRegistry } from '../../../schemas/vocabulary-registry.js'

const EMPTY_REGISTRY: VocabularyRegistry = { entries: [], adjacent_franchises: [] }

// Fake repo whose pending-state read returns the given value. null = the
// worlds.id-race defensive arm (SELECT returned no row).
function makeRepoWithPending(pending: unknown): FakeRepo {
  const repo = makeFakeRepo()
  repo.worlds.getEntityConsolidationPending.mockResolvedValue(pending)
  return repo
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
  })

  it('skip path: empty pending state → zero-cost result, no LLM call, no finalizedEvents', async () => {
    const repo = makeRepoWithPending({ declarations: [], relationships: [] })
    const result = await runEntityConsolidationStage(repo as unknown as Repo, baseArgs)

    expect(result.costUsd).toBe(0)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
    expect(result.finalizedEvents).toEqual([])
    expect(result.capExhausted).toBe(false)

    // No LLM SDK call attempted on the skip path.
    expect(ai.generateObject).not.toHaveBeenCalled()
    expect(ai.streamObject).not.toHaveBeenCalled()
    expect(ai.generateText).not.toHaveBeenCalled()

    // Exactly one read: repo.worlds.getEntityConsolidationPending('wld-1').
    // No transaction opened on the skip path.
    expect(repo.worlds.getEntityConsolidationPending).toHaveBeenCalledTimes(1)
    expect(repo.worlds.getEntityConsolidationPending).toHaveBeenCalledWith('wld-1')
    expect(repo.transaction).not.toHaveBeenCalled()
  })

  it('skip path: row missing entirely (worlds.id race) → still zero-cost, no LLM call', async () => {
    // Defense-in-depth: if the read returns null (world deleted between
    // stage-4 commit and stage-4b dispatch), the handler applies its
    // EMPTY_PENDING default → "no phantoms to consolidate" rather than crash.
    const repo = makeRepoWithPending(null)
    const result = await runEntityConsolidationStage(repo as unknown as Repo, baseArgs)

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
          accessLevel: 'known',
        },
      ],
    }

    const repo = makeRepoWithPending(PENDING_STATE)

    // Inventory: one real faction; the Sonnet prompt renders it into the
    // existing-entities block. The ghost is NOT in the inventory.
    repo.entities.listByWorld.mockResolvedValue([
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

    const result = await runEntityConsolidationStage(repo as unknown as Repo, args)

    const consolidationCall = vi.mocked(ai.generateText).mock.calls[0]?.[0] as unknown as {
      providerOptions?: unknown
    }
    expect(consolidationCall.providerOptions).toMatchObject({
      mythrun: { stage: 'entity_consolidation', worldId: 'wld-1', campaignId: 'cmp-1' },
    })
    // Ghost persisted with the correct created_in marker + name.
    expect(repo.entities.insert).toHaveBeenCalledTimes(1)
    const insertCall = repo.entities.insert.mock.calls[0]?.[0] as {
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
    expect(repo.proseKernels.insert).toHaveBeenCalledTimes(1)
    const proseArg = repo.proseKernels.insert.mock.calls[0]?.[0] as {
      readonly entityId: string
      readonly content: string
    }
    expect(proseArg.entityId).toBe(insertCall.id)
    expect(proseArg.content).toContain('hunting bands')

    // Both facts persisted in a single insertMany call.
    expect(repo.facts.insertMany).toHaveBeenCalledTimes(1)
    const factRows = repo.facts.insertMany.mock.calls[0]?.[0] as readonly {
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
    expect(repo.relationships.insertMany).toHaveBeenCalledTimes(1)
    const relRows = repo.relationships.insertMany.mock.calls[0]?.[0] as readonly {
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
      // MYT-89 Phase A: tier carried from the stage-4 buffer.
      accessLevel: 'known',
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

    // Pending state cleared via repo.worlds.clearEntityConsolidationPending.
    expect(repo.worlds.clearEntityConsolidationPending).toHaveBeenCalledTimes(1)
    expect(repo.worlds.clearEntityConsolidationPending).toHaveBeenCalledWith('wld-1')

    // MYT-55: idempotency wipe (repo.entities.deleteByWorldAndCreatedIn) runs
    // AFTER the LLM call (inside the post-LLM persist transaction) so the LLM
    // call doesn't hold a BEGIN-open connection. The wipe is still atomic with
    // the re-inserts (same tx) — the FK cascade is preserved.
    expect(repo.entities.deleteByWorldAndCreatedIn).toHaveBeenCalledTimes(1)
    expect(repo.entities.deleteByWorldAndCreatedIn).toHaveBeenCalledWith(
      'wld-1',
      'stage:entity_consolidation',
    )
    const wipeOrder = repo.entities.deleteByWorldAndCreatedIn.mock.invocationCallOrder[0] ?? 0
    const llmOrder = vi.mocked(ai.generateText).mock.invocationCallOrder[0] ?? 0
    expect(wipeOrder).toBeGreaterThan(llmOrder)

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

  // ── myth-09jy8: stage 4b wire emits are tier-gated ─────────────────────────
  //
  // P1 enforced-ignorance (discovered-from myth-pq0ug): stage 4b's post-COMMIT
  // publishes were unconditional. Adversarial fixture covering all three
  // suppression classes:
  //   - a SECRET ghost entity must not emit entity-added,
  //   - a SECRET edge between two KNOWN endpoints must not emit edge-added
  //     (the deterministic known↔known leak class),
  //   - a known edge touching a secret ghost endpoint must not emit edge-added.
  // DB persistence is unaffected in every case (the world still knows).

  const TIER_R1 = '01923456-789a-7bcd-8ef0-000000000001'
  function makeTierGatePending(): unknown {
    return {
      declarations: [
        { placeholderId: 'new-001', name: 'The Ironjaw', entityType: 'faction' as const },
        { placeholderId: 'new-002', name: 'The Veiled Hand', entityType: 'faction' as const },
      ],
      relationships: [
        // 0: known edge, known real → known ghost — the only wire-visible edge.
        { from: TIER_R1, to: 'new-001', relationship: 'rival_of', description: 'Long Vigil rivals the Ironjaw over Bone Reach territory.', accessLevel: 'known' },
        // 1: SECRET edge between two KNOWN endpoints — the leak class.
        { from: TIER_R1, to: 'new-001', relationship: 'secretly_funds', description: 'Long Vigil quietly bankrolls the Ironjaw raids.', accessLevel: 'secret' },
        // 2: known edge but the ghost endpoint is SECRET.
        { from: TIER_R1, to: 'new-002', relationship: 'allied_with', description: 'Long Vigil answers to the Veiled Hand.', accessLevel: 'known' },
      ],
    }
  }
  function mockTierGateLlm(): void {
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: {
        ghost_entities: [
          {
            placeholder_id: 'new-001',
            name: 'The Ironjaw',
            entity_type: 'faction',
            access_level: 'known',
            parent_location_id: null,
            prose: 'The Ironjaw is one of the four hunting bands of the Bone Reach canyons.',
            facts: [
              { topic: 'territory', content: 'Ranges the eastern Bone Reach canyons.', access_level: 'known' },
              { topic: 'rivalry', content: 'Long Vigil disputes their Boneright claims.', access_level: 'known' },
            ],
          },
          {
            placeholder_id: 'new-002',
            name: 'The Veiled Hand',
            entity_type: 'faction',
            access_level: 'secret',
            parent_location_id: null,
            prose: 'The Veiled Hand pulls the strings of half the Reach from behind curtained doors.',
            facts: [
              { topic: 'reach', content: 'Its agents sit inside every hunting band council.', access_level: 'secret' },
              { topic: 'origin', content: 'Founded by exiles of the old canyon monarchy.', access_level: 'secret' },
            ],
          },
        ],
      },
      finishReason: 'stop',
      usage: { inputTokens: 500, outputTokens: 800, totalTokens: 1300 },
    } as never)
  }
  function tierGateInventory(repo: FakeRepo): void {
    repo.entities.listByWorld.mockResolvedValue([
      { id: TIER_R1, worldId: 'wld-1', entityType: 'faction', name: 'Long Vigil', accessLevel: 'known' },
    ])
  }

  it('myth-09jy8: secret ghost + secret known↔known edge + secret-endpoint edge persist to DB but do NOT publish', async () => {
    const redis = makeRedisStub()
    const args = makeArgs(redis)
    const repo = makeRepoWithPending(makeTierGatePending())
    tierGateInventory(repo)
    mockTierGateLlm()

    await runEntityConsolidationStage(repo as unknown as Repo, args)

    // DB: BOTH ghosts persist (including the secret one) and ALL THREE
    // relationships persist with stable, unshifted synthKey indices.
    expect(repo.entities.insert).toHaveBeenCalledTimes(2)
    const relRows = repo.relationships.insertMany.mock.calls[0]?.[0] as readonly {
      readonly synthKey: string
    }[]
    expect(relRows.map((r) => r.synthKey)).toEqual([
      'entity_consolidation/relationships/0',
      'entity_consolidation/relationships/1',
      'entity_consolidation/relationships/2',
    ])

    // Wire: exactly ONE entity-added (the known ghost) + ONE edge-added
    // (the known edge between known endpoints). Everything secret-touching
    // is suppressed.
    const payloads = redis.publish.mock.calls.map(
      (c) => JSON.parse(c[1] as string) as { type: string; name?: string; synthKey: string; relationship?: string },
    )
    const entityAdds = payloads.filter((p) => p.type === 'entity-added')
    expect(entityAdds.map((p) => p.name)).toEqual(['The Ironjaw'])
    const edgeAdds = payloads.filter((p) => p.type === 'edge-added')
    expect(edgeAdds.map((p) => p.relationship)).toEqual(['rival_of'])
    // The wire-visible edge keeps its INSERT-order synthKey (index 0) —
    // suppression must not compact later indices.
    expect(edgeAdds[0]?.synthKey).toBe('entity_consolidation/relationships/0')
    expect(redis.publish).toHaveBeenCalledTimes(2)
  })

  it('myth-09jy8: bypassAccessFilter=true publishes every ghost and every edge regardless of tier (dev affordance)', async () => {
    const redis = makeRedisStub()
    const args = { ...makeArgs(redis), bypassAccessFilter: true }
    const repo = makeRepoWithPending(makeTierGatePending())
    tierGateInventory(repo)
    mockTierGateLlm()

    await runEntityConsolidationStage(repo as unknown as Repo, args)

    const payloads = redis.publish.mock.calls.map(
      (c) => JSON.parse(c[1] as string) as { type: string; name?: string; relationship?: string },
    )
    expect(payloads.filter((p) => p.type === 'entity-added').map((p) => p.name)).toEqual([
      'The Ironjaw',
      'The Veiled Hand',
    ])
    expect(payloads.filter((p) => p.type === 'edge-added').map((p) => p.relationship)).toEqual([
      'rival_of',
      'secretly_funds',
      'allied_with',
    ])
    expect(redis.publish).toHaveBeenCalledTimes(5)
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
    const repo = makeRepoWithPending(PENDING_STATE)

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

    await runEntityConsolidationStage(repo as unknown as Repo, baseArgs)

    // Only the declared ghost is persisted.
    expect(repo.entities.insert).toHaveBeenCalledTimes(1)
    const insertCall = repo.entities.insert.mock.calls[0]?.[0] as { readonly name: string }
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
          accessLevel: 'known',
        },
      ],
    }
    const repo = makeRepoWithPending(PENDING_STATE)

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

    await runEntityConsolidationStage(repo as unknown as Repo, baseArgs)

    // Only the LLM-emitted ghost persists; the missing one is silently
    // skipped (WARN logged but no throw, no insert for new-002).
    expect(repo.entities.insert).toHaveBeenCalledTimes(1)
    const insertCall = repo.entities.insert.mock.calls[0]?.[0] as { readonly name: string }
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
    const repo = makeRepoWithPending(PENDING_STATE)
    repo.entities.listByWorld.mockResolvedValue([
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

    await runEntityConsolidationStage(repo as unknown as Repo, baseArgs)

    // Ghost was inserted as a location; the parent_location link fired.
    expect(repo.entities.insert).toHaveBeenCalledTimes(1)
    const insertCall = repo.entities.insert.mock.calls[0]?.[0] as {
      readonly id: string
      readonly entityType: string
    }
    expect(insertCall.entityType).toBe('location')

    expect(repo.entityHierarchy.insert).toHaveBeenCalledTimes(1)
    expect(repo.entityHierarchy.insert).toHaveBeenCalledWith({
      parentEntityId: PARENT_LOCATION_ID,
      childEntityId: insertCall.id,
    })
  })
})
