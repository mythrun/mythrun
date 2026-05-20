// backend/src/llm/prep/stages/__tests__/world-and-factions.test.ts
//
// Stage 2 (world_and_factions) integration test. Real Postgres + mocked
// Vercel SDK streamObject. Asserts the persistence contract (entities +
// prose_kernels + facts + worlds.world_overview) and the repair-chain
// fallthrough behavior (Zod-fail → Haiku → Sonnet → throw).
//
// Unified dispatch contract: the test scaffold (not the handler) owns
// the transaction lifecycle. Each test acquires a client, BEGINs, runs
// the handler against the client, COMMITs (or ROLLBACKs on error), then
// asserts pool-level state. The handler returns `finalizedEvents` for
// the test to inspect; it does NOT publish `finalized` or `stage-reset`
// itself — those are the outer scope's responsibility.
//
// Pattern crib: src/llm/prep/__tests__/structured-output-repair.test.ts
// for the ai-module mock pattern; src/llm/prep/stages/__tests__/concept-intake.test.ts
// for the (client, args) stage-handler shape.

/* eslint-disable @typescript-eslint/no-deprecated -- mirrors source: Vercel SDK
 * flags streamObject deprecated but design §D1 mandates it. */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import IoredisMock from 'ioredis-mock'
import type { Job } from 'bullmq'
import { guardTestDatabase } from '../../../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../../../repo/uuidv7.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../../../repo/__tests__/_helpers/test-pool.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    streamObject: vi.fn(),
    generateText: vi.fn(),
    Output: { object: vi.fn((opts: unknown) => opts) },
  }
})

import { streamObject, generateText } from 'ai'
import { LlmStructuredOutputError } from '../../../errors.js'
import {
  runWorldAndFactionsStage,
  type RunWorldAndFactionsArgs,
} from '../world-and-factions.js'
import type { VocabularyRegistry } from '../../../schemas/vocabulary-registry.js'

const mockStreamObject = vi.mocked(streamObject)
const mockGenerateText = vi.mocked(generateText)

const databaseUrl = process.env.DATABASE_URL ?? ''

function fakeJob(): Job {
  return { updateProgress: vi.fn().mockResolvedValue(undefined) } as unknown as Job
}

type AccessLevel = 'known' | 'discoverable' | 'secret'

interface Fact {
  topic: string
  content: string
  access_level: AccessLevel
}
interface NamedBlock {
  name: string
  access_level: AccessLevel
  prose: string
  facts: Fact[]
}
interface Tree {
  world_overview: string
  regions: NamedBlock[]
  factions: NamedBlock[]
}

function fixtureTree(): Tree {
  return {
    world_overview:
      'A forested kingdom on the edge of an ancient elven wood. '.repeat(2),
    regions: Array.from({ length: 3 }, (_, i) => ({
      name: `Region ${String(i)}`,
      access_level: 'known' as const,
      prose: `Description of region ${String(i)}. `.repeat(3),
      facts: [
        {
          topic: 'history',
          content: 'Founded long ago by elven settlers.',
          access_level: 'known' as const,
        },
        {
          topic: 'secret',
          content: 'Hides an ancient burial mound below the meadow.',
          access_level: 'secret' as const,
        },
      ],
    })),
    factions: Array.from({ length: 3 }, (_, i) => ({
      name: `Faction ${String(i)}`,
      access_level: 'known' as const,
      prose: `Description of faction ${String(i)}. `.repeat(3),
      facts: [
        {
          topic: 'goal',
          content: 'Reclaim the lost sword of the founders.',
          access_level: 'known' as const,
        },
        {
          topic: 'enemy',
          content: 'Rivals with the Iron Coast factions.',
          access_level: 'known' as const,
        },
      ],
    })),
  }
}

// Fixture where each region carries a distinct tier — exercises the
// SSE-emit tier filter inside the persister (the DB insert still happens
// for all three; only finalizedEvents is gated).
function tieredFixtureTree(): Tree {
  const base = fixtureTree()
  const tiers: AccessLevel[] = ['known', 'discoverable', 'secret']
  base.regions = base.regions.map((r, i) => ({
    ...r,
    access_level: tiers[i] ?? 'known',
  }))
  // factions stay 'known' so they don't pollute the region-filter count.
  return base
}

function brokenTree(): Tree {
  const t = fixtureTree()
  // Region 0's prose is too short to satisfy Zod's min(40).
  const first = t.regions[0]
  if (first === undefined) throw new Error('fixture invariant: regions[0] must exist')
  first.prose = 'too short'
  return t
}

function makeStream(tree: Tree): ReturnType<typeof streamObject> {
  function* gen(): Generator<Tree> {
    yield tree
  }
  return {
    partialObjectStream: gen(),
    object: Promise.resolve(tree),
    usage: Promise.resolve({ inputTokens: 5000, outputTokens: 6000, totalTokens: 11000 }),
  } as unknown as ReturnType<typeof streamObject>
}

// myth-t1qz: simulates the canonical wrapper's "SDK rejected with
// LlmStructuredOutputError" path. The wrapper inspects `.cause.text` on
// the error, runs JSON.parse + safeParse, and on Zod-fail calls
// repairStructuredOutput (which routes through the mocked `ai.generateText`).
function makeBrokenObjectStream(
  tree: Tree,
  brokenTreeForCause: Tree,
): ReturnType<typeof streamObject> {
  function* gen(): Generator<Tree> {
    yield tree
  }
  const cause = Object.assign(new Error('AI_NoObjectGeneratedError'), {
    name: 'AI_NoObjectGeneratedError',
    text: JSON.stringify(brokenTreeForCause),
  })
  const rejection = new LlmStructuredOutputError(
    'llm returned unparseable structured output',
    { cause },
  )
  // .catch on the promise prevents an unhandled rejection if the wrapper
  // installs its .then handler asynchronously; the wrapper's .then still
  // fires the rejection path.
  const objectPromise = Promise.reject<Tree>(rejection)
  objectPromise.catch(() => undefined)
  return {
    partialObjectStream: gen(),
    object: objectPromise,
    usage: Promise.resolve({ inputTokens: 5000, outputTokens: 6000, totalTokens: 11000 }),
  } as unknown as ReturnType<typeof streamObject>
}

function emptyRegistry(): VocabularyRegistry {
  return { entries: [], adjacent_franchises: [] }
}

function makeArgs(opts: {
  worldId: string
  userId: string
  campaignId: string
  worldName: string
  redisRealtime?: InstanceType<typeof IoredisMock>
  bypassAccessFilter?: boolean
  vocabularyRegistry?: VocabularyRegistry
}): RunWorldAndFactionsArgs {
  return {
    world: { id: opts.worldId, createdBy: opts.userId, name: opts.worldName, concept: 'C' },
    vocabularyRegistry: opts.vocabularyRegistry ?? emptyRegistry(),
    campaignId: opts.campaignId,
    job: fakeJob(),
    // ioredis-mock implements the surface area the handler uses (`publish`)
    // and matches Redis structurally for our purposes.
    redisRealtime: opts.redisRealtime ?? new IoredisMock(),
    keyPrefix: 'test:',
    bypassAccessFilter: opts.bypassAccessFilter ?? false,
  }
}

// Simulates the outer-scope dispatch wrapper: acquires a client, BEGINs,
// runs the handler, COMMITs on success and ROLLBACKs on throw. The
// handler under test is responsible for neither — the unified contract
// puts that on the caller (world-gen-processor.runStage).
async function withTxn<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const value = await fn(client)
    await client.query('COMMIT')
    return value
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

describe('runWorldAndFactionsStage', () => {
  let pool: Pool
  let scope: TestScope
  let userId: string
  let campaignId: string
  let worldId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('world-factions')
  })
  afterAll(async () => {
    // myth-5jdo: scoped cleanup before pool teardown.
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    mockStreamObject.mockReset()
    mockGenerateText.mockReset()
    // myth-5jdo: scoped cleanup replaces the prior blanket DELETEs.
    // Entity/prose/fact rows live under the world we create, so the
    // worlds CASCADE in cleanupTestScope drops them along the way.
    await cleanupTestScope(pool, scope)
    userId = uuidv7()
    worldId = uuidv7()
    campaignId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES ($1, $2, $3, $4, 'setup')`,
      [campaignId, worldId, userId, scope.campaignName(0)],
    )
  })

  it('persists regions + factions + prose + facts + world_overview', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(fixtureTree()))

    const result = await withTxn(pool, (client) =>
      runWorldAndFactionsStage(client, makeArgs({ worldId, userId, campaignId, worldName: scope.worldName(0) })),
    )
    expect(result.costUsd).toBeGreaterThan(0)
    expect(result.inputTokens).toBe(5000)
    expect(result.outputTokens).toBe(6000)
    expect(result.capExhausted).toBe(false)

    const counts = await pool.query<{ ent: string; pk: string; f: string }>(
      `
      SELECT
        (SELECT count(*)::text FROM entities WHERE world_id = $1) AS ent,
        (SELECT count(*)::text FROM prose_kernels pk JOIN entities e ON e.id = pk.entity_id WHERE e.world_id = $1) AS pk,
        (SELECT count(*)::text FROM facts f JOIN entities e ON e.id = f.entity_id WHERE e.world_id = $1) AS f
    `,
      [worldId],
    )
    expect(Number(counts.rows[0]?.ent)).toBe(6) // 3 regions + 3 factions
    expect(Number(counts.rows[0]?.pk)).toBe(6)
    expect(Number(counts.rows[0]?.f)).toBe(12) // 2 facts × 6 entities

    const w = await pool.query<{ world_overview: string | null }>(
      `SELECT world_overview FROM worlds WHERE id = $1`,
      [worldId],
    )
    expect(w.rows[0]?.world_overview).toBeTruthy()
  })

  it('returns one finalized event per persisted entity (regions then factions)', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(fixtureTree()))

    const result = await withTxn(pool, (client) =>
      runWorldAndFactionsStage(client, makeArgs({ worldId, userId, campaignId, worldName: scope.worldName(0) })),
    )

    expect(result.finalizedEvents).toHaveLength(6)
    const synthKeys = result.finalizedEvents.map((e) =>
      e.type === 'finalized' ? e.synthKey : null,
    )
    expect(synthKeys).toEqual([
      'world_and_factions/regions/0',
      'world_and_factions/regions/1',
      'world_and_factions/regions/2',
      'world_and_factions/factions/0',
      'world_and_factions/factions/1',
      'world_and_factions/factions/2',
    ])

    // Every finalized event carries a real entityId that maps to a row
    // persisted under this world.
    const entityIds: string[] = []
    for (const event of result.finalizedEvents) {
      if (event.type !== 'finalized') throw new Error('expected finalized event type')
      expect(event.entityId.length).toBeGreaterThan(0)
      entityIds.push(event.entityId)
    }
    const rows = await pool.query<{ id: string }>(
      `SELECT id FROM entities WHERE world_id = $1`,
      [worldId],
    )
    const persistedIds = new Set(rows.rows.map((r) => r.id))
    for (const id of entityIds) {
      expect(persistedIds.has(id)).toBe(true)
    }
  })

  it('does NOT publish stage-reset or finalized itself (outer scope owns those)', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(fixtureTree()))

    const redisRealtime = new IoredisMock()
    const publishSpy = vi.spyOn(redisRealtime, 'publish')

    await withTxn(pool, (client) =>
      runWorldAndFactionsStage(
        client,
        makeArgs({ worldId, userId, campaignId, worldName: scope.worldName(0), redisRealtime }),
      ),
    )

    const types = publishSpy.mock.calls
      .map(([, payload]) => {
        if (typeof payload !== 'string') return null
        try {
          return (JSON.parse(payload) as { type?: string }).type ?? null
        } catch {
          return null
        }
      })
      .filter((t): t is string => t !== null)

    expect(types).not.toContain('stage-reset')
    expect(types).not.toContain('finalized')
  })

  it('stamps facts.narrative_status = undelivered and source = prep', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(fixtureTree()))

    await withTxn(pool, (client) =>
      runWorldAndFactionsStage(client, makeArgs({ worldId, userId, campaignId, worldName: scope.worldName(0) })),
    )

    const rows = await pool.query<{ narrative_status: string; source: string }>(
      `SELECT DISTINCT narrative_status, source FROM facts WHERE entity_id IN (SELECT id FROM entities WHERE world_id = $1)`,
      [worldId],
    )
    expect(rows.rows).toEqual([{ narrative_status: 'undelivered', source: 'prep' }])
  })

  it('does NOT write to relationships table (stage 4 owns edges)', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(fixtureTree()))

    await withTxn(pool, (client) =>
      runWorldAndFactionsStage(client, makeArgs({ worldId, userId, campaignId, worldName: scope.worldName(0) })),
    )
    // Scope to entities in THIS test's world — parallel siblings may
    // have their own relationship rows in flight (myth-oehx).
    const c = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM relationships
        WHERE source_entity_id IN (SELECT id FROM entities WHERE world_id = $1)`,
      [worldId],
    )
    expect(c.rows[0]?.count).toBe('0')
  })

  it('Zod-fail at stream end → Haiku repair succeeds → persists repaired tree', async () => {
    // myth-t1qz: under the wrapper, repair fires when the SDK rejects
    // `.object` with LlmStructuredOutputError (carrying the broken raw
    // text on .cause). The wrapper parses + Zod-checks the rawText, then
    // calls repairStructuredOutput → which calls ai.generateText (mocked).
    mockStreamObject.mockReturnValueOnce(
      makeBrokenObjectStream(brokenTree(), brokenTree()),
    )

    // Haiku repair returns a valid tree.
    mockGenerateText.mockResolvedValueOnce({
      output: fixtureTree(),
      usage: { inputTokens: 800, outputTokens: 700, totalTokens: 1500 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const result = await withTxn(pool, (client) =>
      runWorldAndFactionsStage(client, makeArgs({ worldId, userId, campaignId, worldName: scope.worldName(0) })),
    )
    // Opus stream cost surfaces (the wrapper folds repair-chain cost
    // internally — see ai.ts header).
    expect(result.costUsd).toBeGreaterThan(0)
    expect(mockGenerateText).toHaveBeenCalledTimes(1) // only Haiku; no Sonnet escalation
    expect(result.finalizedEvents).toHaveLength(6)

    const counts = await pool.query<{ ent: string }>(
      `SELECT count(*)::text AS ent FROM entities WHERE world_id = $1`,
      [worldId],
    )
    expect(Number(counts.rows[0]?.ent)).toBe(6)
  })

  it('Zod-fail → Haiku-fail → Sonnet-success → persists Sonnet-repaired tree', async () => {
    mockStreamObject.mockReturnValueOnce(
      makeBrokenObjectStream(brokenTree(), brokenTree()),
    )

    // Haiku fails; Sonnet returns a valid tree.
    mockGenerateText.mockResolvedValueOnce({
      output: brokenTree(),
      usage: { inputTokens: 800, outputTokens: 700, totalTokens: 1500 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)
    mockGenerateText.mockResolvedValueOnce({
      output: fixtureTree(),
      usage: { inputTokens: 1000, outputTokens: 900, totalTokens: 1900 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const result = await withTxn(pool, (client) =>
      runWorldAndFactionsStage(client, makeArgs({ worldId, userId, campaignId, worldName: scope.worldName(0) })),
    )
    expect(result.costUsd).toBeGreaterThan(0)
    expect(mockGenerateText).toHaveBeenCalledTimes(2) // Haiku + Sonnet
    expect(result.finalizedEvents).toHaveLength(6)

    const counts = await pool.query<{ ent: string }>(
      `SELECT count(*)::text AS ent FROM entities WHERE world_id = $1`,
      [worldId],
    )
    expect(Number(counts.rows[0]?.ent)).toBe(6)
  })

  it('Zod-fail → Haiku-fail → Sonnet-fail → throws (outer scope owns ROLLBACK + stage-reset)', async () => {
    mockStreamObject.mockReturnValueOnce(
      makeBrokenObjectStream(brokenTree(), brokenTree()),
    )

    // Both Haiku and Sonnet return broken output.
    mockGenerateText.mockResolvedValueOnce({
      output: brokenTree(),
      usage: { inputTokens: 800, outputTokens: 700, totalTokens: 1500 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)
    mockGenerateText.mockResolvedValueOnce({
      output: brokenTree(),
      usage: { inputTokens: 1000, outputTokens: 900, totalTokens: 1900 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const redisRealtime = new IoredisMock()
    const publishSpy = vi.spyOn(redisRealtime, 'publish')

    await expect(
      withTxn(pool, (client) =>
        runWorldAndFactionsStage(
          client,
          makeArgs({ worldId, userId, campaignId, worldName: scope.worldName(0), redisRealtime }),
        ),
      ),
    ).rejects.toThrow(/unparseable structured output/)

    expect(mockGenerateText).toHaveBeenCalledTimes(2) // Haiku + Sonnet

    // Handler must NOT publish stage-reset itself — the outer scope does.
    const stageResetPublished = publishSpy.mock.calls.some(([channel, payload]) => {
      if (typeof channel !== 'string' || typeof payload !== 'string') return false
      if (!channel.includes(`pipeline:campaign:${campaignId}`)) return false
      const parsed = JSON.parse(payload) as { type?: string; stage?: string }
      return parsed.type === 'stage-reset' && parsed.stage === 'world_and_factions'
    })
    expect(stageResetPublished).toBe(false)

    // The test's withTxn ROLLBACKs on throw — no rows landed.
    const counts = await pool.query<{ ent: string }>(
      `SELECT count(*)::text AS ent FROM entities WHERE world_id = $1`,
      [worldId],
    )
    expect(Number(counts.rows[0]?.ent)).toBe(0)
  })

  // myth-exac T13: tier-aware persist. DB inserts always happen for all
  // tiers; only finalizedEvents (the SSE-emitted entries) are gated. When
  // bypassAccessFilter is false, only `known` entities surface as
  // finalized events. When true, every persisted entity surfaces.
  it('persists all tiers; finalizedEvents filtered to known when bypass=false', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(tieredFixtureTree()))

    const result = await withTxn(pool, (client) =>
      runWorldAndFactionsStage(
        client,
        makeArgs({ worldId, userId, campaignId, worldName: scope.worldName(0) }),
      ),
    )

    // 3 regions (known, discoverable, secret) + 3 factions (known x3)
    // all land in the DB.
    const counts = await pool.query<{ ent: string }>(
      `SELECT count(*)::text AS ent FROM entities WHERE world_id = $1`,
      [worldId],
    )
    expect(Number(counts.rows[0]?.ent)).toBe(6)

    const tiered = await pool.query<{ access_level: string; count: string }>(
      `SELECT access_level, count(*)::text AS count
         FROM entities WHERE world_id = $1 GROUP BY access_level`,
      [worldId],
    )
    const byTier = new Map(tiered.rows.map((r) => [r.access_level, Number(r.count)]))
    expect(byTier.get('known')).toBe(4) // 1 known region + 3 known factions
    expect(byTier.get('discoverable')).toBe(1)
    expect(byTier.get('secret')).toBe(1)

    // finalizedEvents: only `known` items — 1 region + 3 factions = 4.
    const synthKeys = result.finalizedEvents.map((e) =>
      e.type === 'finalized' ? e.synthKey : null,
    )
    expect(synthKeys).toEqual([
      'world_and_factions/regions/0',
      'world_and_factions/factions/0',
      'world_and_factions/factions/1',
      'world_and_factions/factions/2',
    ])
  })

  // myth-pfke task 9a: vocabulary registry placeholder substitution.
  it('substitutes {{vocabularyRegistry}} with the rendered registry prose', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(fixtureTree()))
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

    await withTxn(pool, (client) =>
      runWorldAndFactionsStage(
        client,
        makeArgs({
          worldId,
          userId,
          campaignId,
          worldName: scope.worldName(0),
          vocabularyRegistry: registry,
        }),
      ),
    )

    const captured = mockStreamObject.mock.calls[0]?.[0] as { prompt: string } | undefined
    const prompt = captured?.prompt ?? ''
    expect(prompt).toContain("This world's distinctive vocabulary:")
    expect(prompt).toContain('the unwitched')
    expect(prompt).not.toContain('{{vocabularyRegistry}}')
  })

  it('bypassAccessFilter=true emits finalized events for every persisted entity', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(tieredFixtureTree()))

    const result = await withTxn(pool, (client) =>
      runWorldAndFactionsStage(
        client,
        makeArgs({
          worldId,
          userId,
          campaignId,
          worldName: scope.worldName(0),
          bypassAccessFilter: true,
        }),
      ),
    )

    expect(result.finalizedEvents).toHaveLength(6)
    const synthKeys = result.finalizedEvents.map((e) =>
      e.type === 'finalized' ? e.synthKey : null,
    )
    expect(synthKeys).toEqual([
      'world_and_factions/regions/0',
      'world_and_factions/regions/1',
      'world_and_factions/regions/2',
      'world_and_factions/factions/0',
      'world_and_factions/factions/1',
      'world_and_factions/factions/2',
    ])
  })
})
