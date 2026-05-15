// backend/src/llm/prep/stages/__tests__/locations-and-npcs.test.ts
//
// Stage 3 (locations_and_npcs) integration test. Real Postgres + mocked
// Vercel SDK streamObject. Asserts the persistence contract (entities +
// prose_kernels + facts + entity_hierarchy via the three-pass resolver)
// and the repair-chain fallthrough behavior (Zod-fail → Haiku → Sonnet
// → throw). Also covers the §D8 corner cases: nested hierarchy
// (region → city → inn), unresolvable parent_location (typo), and the
// stage-2-wins name-collision rule.
//
// Unified-contract (T13) shape:
//   - Tests acquire a PoolClient + BEGIN before invoking the handler.
//   - Tests COMMIT explicitly after the handler returns.
//   - finalizedEvents are inspected on the returned StageDispatchResult,
//     NOT on Redis (the caller is responsible for publishing them after
//     its own COMMIT).
//   - On unrecoverable error the handler THROWS; the caller (here, the
//     test) is responsible for ROLLBACK + publishing stage-reset.
//
// Pattern crib: src/llm/prep/stages/__tests__/world-and-factions.test.ts
// — same scaffold, with the stage-2 seed entities (an Eredil region +
// House Korren faction) inserted in beforeEach to give the resolver
// something to bind to.

/* eslint-disable @typescript-eslint/no-deprecated -- mirrors source: Vercel SDK
 * flags streamObject deprecated but design §D1 mandates it. */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import IoredisMock from 'ioredis-mock'
import type { Job } from 'bullmq'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../../../db/postgres.js'
import { runMigrations } from '../../../../db/migrate.js'
import { guardTestDatabase } from '../../../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../../../repo/uuidv7.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../../../repo/__tests__/_helpers/test-scope.js'

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
import { runLocationsAndNpcsStage } from '../locations-and-npcs.js'

const mockStreamObject = vi.mocked(streamObject)
const mockGenerateText = vi.mocked(generateText)

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: (): void => undefined }
  return pino({ base: { component: 'migrate' } }, sink)
}

function fakeJob(): Job {
  return { updateProgress: vi.fn().mockResolvedValue(undefined) } as unknown as Job
}

interface Fact {
  topic: string
  content: string
  access_level: 'public' | 'private' | 'secret'
}
interface LocationBlock {
  name: string
  prose: string
  facts: Fact[]
  parent_location: string | null
}
interface NpcBlock {
  name: string
  prose: string
  facts: Fact[]
  home_location: string | null
}
interface Tree {
  locations: LocationBlock[]
  npcs: NpcBlock[]
}

// Helper: fact array meeting the schema's min(2) floor.
function pubFacts(seed: string): Fact[] {
  return [
    {
      topic: 'history',
      content: `History of ${seed} stretches back generations beyond memory.`,
      access_level: 'public',
    },
    {
      topic: 'rumor',
      content: `A persistent rumor in ${seed} hints at hidden tunnels below.`,
      access_level: 'private',
    },
  ]
}

// Nested-hierarchy fixture: Region (stage-2 seed) → City → Inn.
// Plus 3 free-floating locations to meet the schema's min(5) floor.
// NPC count also meets min(5). Compact tuple form to keep the file
// under the max-lines warning.
function nestedFixture(regionName: string): Tree {
  const locSeed: readonly (readonly [string, string, string | null])[] = [
    ['Anul-dan', `A wind-scoured city perched above ${regionName}. Markets spill into alleys; rain channels run with rust.`, regionName],
    ['The Silent Bowstring', 'An inn at the city wall. Smoke clings to the rafters; the proprietor never looks up.', 'Anul-dan'],
    ['Old Causeway', 'A stone road half-claimed by the sea, exposed only at low tide each morning.', null],
    ['Broken Shrine', 'A wayside shrine, the lintel collapsed long ago, candles still burning at dusk.', null],
    ['Crow Bridge', 'A wooden footbridge over a slow brown river. Crows watch from the rails.', null],
  ]
  const npcSeed: readonly (readonly [string, string, string | null])[] = [
    ['Eilra of the Wharf', 'She moves with the slow patience of someone used to waiting on the tides each morning.', 'Old Causeway'],
    ['Master Vorin', 'A wiry innkeeper, his apron stained with a decade of beer. He polishes the same glass.', 'The Silent Bowstring'],
    ['Sister Anwe', 'An itinerant priestess, her robes dusty, her smile crooked. She speaks in proverbs.', 'Broken Shrine'],
    ['Korr the Quiet', 'A bridge-keeper, his shoulders broad, his eyes always on the far bank. He counts crows.', 'Crow Bridge'],
    ['The Wandering Tinker', 'A wiry old man with a back full of pots. He whistles a tune nobody recognizes here.', null],
  ]
  return {
    locations: locSeed.map(([name, prose, parent]) => ({
      name,
      prose,
      facts: pubFacts(name),
      parent_location: parent,
    })),
    npcs: npcSeed.map(([name, prose, home]) => ({
      name,
      prose,
      facts: pubFacts(name),
      home_location: home,
    })),
  }
}

function brokenTree(): Tree {
  const t = nestedFixture('Eredil')
  const first = t.locations[0]
  if (first === undefined) throw new Error('fixture invariant: locations[0] must exist')
  first.prose = 'too short' // below the 40-char floor
  return t
}

function typoedTree(): Tree {
  const t = nestedFixture('Eredil')
  const third = t.locations[2]
  if (third === undefined) throw new Error('fixture invariant: locations[2] must exist')
  // Replace the immutable record cleanly: third was free-floating null;
  // we re-point it at a name that doesn't exist anywhere.
  t.locations[2] = { ...third, parent_location: 'Erediilll-Typo' }
  return t
}

function emptyTree(): Tree {
  return { locations: [], npcs: [] }
}

function makeStream(tree: Tree): ReturnType<typeof streamObject> {
  function* gen(): Generator<Tree> {
    yield tree
  }
  return {
    partialObjectStream: gen(),
    object: Promise.resolve(tree),
    usage: Promise.resolve({ inputTokens: 8000, outputTokens: 10000, totalTokens: 18000 }),
  } as unknown as ReturnType<typeof streamObject>
}

type StageArgs = Parameters<typeof runLocationsAndNpcsStage>[1]

function makeArgs(opts: {
  worldId: string
  userId: string
  campaignId: string
  worldName: string
  redisRealtime?: InstanceType<typeof IoredisMock>
}): StageArgs {
  return {
    world: {
      id: opts.worldId,
      createdBy: opts.userId,
      name: opts.worldName,
      concept: 'C',
      tone: 't',
      themes: 'th',
      era: 'medieval',
      worldOverview: 'A misted coast where lanterns mark every causeway.',
      regionsSummary: '- Eredil — a misted coastal region',
      factionsSummary: '- House Korren — the dominant merchant clan',
    },
    campaignId: opts.campaignId,
    job: fakeJob(),
    redisRealtime: opts.redisRealtime ?? new IoredisMock(),
    keyPrefix: 'test:',
  }
}

// Helper: acquire a client and BEGIN — the unified contract puts txn
// lifecycle in the CALLER's hands. Always pair with `commit` or
// `rollback` below.
async function beginTxn(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect()
  await client.query('BEGIN')
  return client
}

async function commit(client: PoolClient): Promise<void> {
  try {
    await client.query('COMMIT')
  } finally {
    client.release()
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } finally {
    client.release()
  }
}

describe('runLocationsAndNpcsStage', () => {
  let pool: Pool
  let scope: TestScope
  let userId: string
  let campaignId: string
  let worldId: string
  let regionEntityId: string
  let factionEntityId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
    scope = makeTestScope('locations-npcs')
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
    // Entity/prose/fact/hierarchy rows live under the world we create,
    // so the worlds CASCADE in cleanupTestScope drops them.
    await cleanupTestScope(pool, scope)
    userId = uuidv7()
    worldId = uuidv7()
    campaignId = uuidv7()
    regionEntityId = uuidv7()
    factionEntityId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status)
       VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES ($1, $2, $3, $4, 'setup')`,
      [campaignId, worldId, userId, scope.campaignName(0)],
    )
    await pool.query(
      `INSERT INTO entities (id, world_id, entity_type, name) VALUES ($1, $2, 'location', 'Eredil')`,
      [regionEntityId, worldId],
    )
    await pool.query(
      `INSERT INTO entities (id, world_id, entity_type, name) VALUES ($1, $2, 'faction', 'House Korren')`,
      [factionEntityId, worldId],
    )
  })

  it('persists locations + npcs + prose + facts; resolves nested parent_location chain (region → city → inn); returns finalized events; does NOT publish stage-reset', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(nestedFixture('Eredil')))

    const redisRealtime = new IoredisMock()
    const publishSpy = vi.spyOn(redisRealtime, 'publish')

    const client = await beginTxn(pool)
    const result = await runLocationsAndNpcsStage(
      client,
      makeArgs({ worldId, userId, campaignId, worldName: scope.worldName(0), redisRealtime }),
    )
    await commit(client)

    expect(result.costUsd).toBeGreaterThan(0)
    expect(result.capExhausted).toBe(false)

    // finalizedEvents: 10 `finalized` (5 locations + 5 NPCs), 0
    // entity-updated{parent_location:null} (all parents resolved).
    const finalizedCount = result.finalizedEvents.filter((e) => e.type === 'finalized').length
    expect(finalizedCount).toBe(10)
    const parentClearedCount = result.finalizedEvents.filter(
      (e) => e.type === 'entity-updated',
    ).length
    expect(parentClearedCount).toBe(0)

    // Handler MUST NOT publish stage-reset (caller's job on throw; not
    // applicable on success).
    const stageResetPublished = publishSpy.mock.calls.some(([, payload]) => {
      if (typeof payload !== 'string') return false
      const parsed = JSON.parse(payload) as { type?: string }
      return parsed.type === 'stage-reset'
    })
    expect(stageResetPublished).toBe(false)

    // Handler MUST NOT publish `finalized` directly (deferred to caller
    // via finalizedEvents).
    const finalizedPublished = publishSpy.mock.calls.some(([, payload]) => {
      if (typeof payload !== 'string') return false
      const parsed = JSON.parse(payload) as { type?: string }
      return parsed.type === 'finalized'
    })
    expect(finalizedPublished).toBe(false)

    // Entities: 5 locations + 5 NPCs from stage 3, plus the two stage-2
    // seeds (Eredil region + House Korren faction) = 12.
    const ent = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM entities WHERE world_id = $1`,
      [worldId],
    )
    expect(ent.rows[0]?.count).toBe('12')

    const pk = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM prose_kernels pk
         JOIN entities e ON e.id = pk.entity_id
        WHERE e.world_id = $1`,
      [worldId],
    )
    expect(pk.rows[0]?.count).toBe('10')

    const fc = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM facts f
         JOIN entities e ON e.id = f.entity_id
        WHERE e.world_id = $1`,
      [worldId],
    )
    expect(fc.rows[0]?.count).toBe('20')

    const ns = await pool.query<{ narrative_status: string; source: string }>(
      `SELECT DISTINCT narrative_status, source FROM facts
        WHERE entity_id IN (SELECT id FROM entities WHERE world_id = $1)`,
      [worldId],
    )
    expect(ns.rows).toEqual([{ narrative_status: 'undelivered', source: 'prep' }])

    // entity_hierarchy: two rows.
    //   Anul-dan → Eredil (stage-2 region)
    //   The Silent Bowstring → Anul-dan (stage-3 city)
    const eh = await pool.query<{ parent_name: string; child_name: string }>(
      `SELECT p.name AS parent_name, c.name AS child_name
         FROM entity_hierarchy h
         JOIN entities p ON p.id = h.parent_entity_id
         JOIN entities c ON c.id = h.child_entity_id
        WHERE c.world_id = $1
        ORDER BY c.name`,
      [worldId],
    )
    expect(eh.rows).toHaveLength(2)
    expect(eh.rows[0]).toEqual({ parent_name: 'Eredil', child_name: 'Anul-dan' })
    expect(eh.rows[1]).toEqual({ parent_name: 'Anul-dan', child_name: 'The Silent Bowstring' })
  })

  it('unresolvable parent_location (LLM typo): persists parentless + returns entity-updated { parent_location: null } in finalizedEvents (NOT published mid-handler)', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(typoedTree()))

    const redisRealtime = new IoredisMock()
    const publishSpy = vi.spyOn(redisRealtime, 'publish')

    const client = await beginTxn(pool)
    const result = await runLocationsAndNpcsStage(
      client,
      makeArgs({ worldId, userId, campaignId, worldName: scope.worldName(0), redisRealtime }),
    )
    await commit(client)

    // No entity_hierarchy row for the typo'd location.
    const eh = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM entity_hierarchy h
         JOIN entities c ON c.id = h.child_entity_id
        WHERE c.name = 'Old Causeway'`,
    )
    expect(eh.rows[0]?.count).toBe('0')

    // The handler returns the parent-cleared patch in finalizedEvents.
    const parentClearedInBatch = result.finalizedEvents.some(
      (e) =>
        e.type === 'entity-updated' &&
        e.synthKey === 'locations_and_npcs/locations/2' &&
        (e.patch as { parent_location?: string | null }).parent_location === null,
    )
    expect(parentClearedInBatch).toBe(true)

    // And does NOT publish that patch itself.
    const parentClearedPublished = publishSpy.mock.calls.some(([, payload]) => {
      if (typeof payload !== 'string') return false
      const parsed = JSON.parse(payload) as { type?: string }
      return parsed.type === 'entity-updated'
    })
    expect(parentClearedPublished).toBe(false)
  })

  it('name-collision: stage-2 entity wins (older) over a stage-3 location of the same name', async () => {
    // Re-seed: rename the stage-2 region to "Anul-dan" — same name as the
    // stage-3 city in the fixture. The resolver must pick the stage-2
    // (older) entity when "The Silent Bowstring" declares
    // parent_location: "Anul-dan".
    await pool.query(`UPDATE entities SET name = 'Anul-dan' WHERE id = $1`, [regionEntityId])

    mockStreamObject.mockReturnValueOnce(makeStream(nestedFixture('Anul-dan')))

    const client = await beginTxn(pool)
    await runLocationsAndNpcsStage(client, makeArgs({ worldId, userId, campaignId, worldName: scope.worldName(0) }))
    await commit(client)

    const eh = await pool.query<{ parent_id: string }>(
      `SELECT h.parent_entity_id AS parent_id
         FROM entity_hierarchy h
         JOIN entities c ON c.id = h.child_entity_id
        WHERE c.name = 'The Silent Bowstring'`,
    )
    expect(eh.rows).toHaveLength(1)
    expect(eh.rows[0]?.parent_id).toBe(regionEntityId)
  })

  it('Zod-fail → Haiku-repair-success: persists the repaired tree', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(brokenTree()))

    // Haiku repair returns a valid tree.
    mockGenerateText.mockResolvedValueOnce({
      output: nestedFixture('Eredil'),
      usage: { inputTokens: 1500, outputTokens: 800, totalTokens: 2300 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const client = await beginTxn(pool)
    const result = await runLocationsAndNpcsStage(
      client,
      makeArgs({ worldId, userId, campaignId, worldName: scope.worldName(0) }),
    )
    await commit(client)

    expect(result.costUsd).toBeGreaterThan(0)
    expect(mockGenerateText).toHaveBeenCalledTimes(1) // Haiku only

    const ent = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM entities WHERE world_id = $1`,
      [worldId],
    )
    expect(ent.rows[0]?.count).toBe('12')
  })

  it('Zod-fail → Haiku-fail → Sonnet-success: persists the Sonnet-repaired tree', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(brokenTree()))

    // Haiku fails (still broken); Sonnet succeeds.
    mockGenerateText.mockResolvedValueOnce({
      output: brokenTree(),
      usage: { inputTokens: 1500, outputTokens: 800, totalTokens: 2300 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)
    mockGenerateText.mockResolvedValueOnce({
      output: nestedFixture('Eredil'),
      usage: { inputTokens: 1800, outputTokens: 900, totalTokens: 2700 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const client = await beginTxn(pool)
    const result = await runLocationsAndNpcsStage(
      client,
      makeArgs({ worldId, userId, campaignId, worldName: scope.worldName(0) }),
    )
    await commit(client)

    expect(result.costUsd).toBeGreaterThan(0)
    expect(mockGenerateText).toHaveBeenCalledTimes(2) // Haiku + Sonnet

    const ent = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM entities WHERE world_id = $1`,
      [worldId],
    )
    expect(ent.rows[0]?.count).toBe('12')
  })

  it('repair-chain exhausted: throws; does NOT publish stage-reset (caller publishes after ROLLBACK)', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(emptyTree()))

    // Both Haiku and Sonnet return invalid (empty) output.
    mockGenerateText.mockResolvedValueOnce({
      output: emptyTree(),
      usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)
    mockGenerateText.mockResolvedValueOnce({
      output: emptyTree(),
      usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const redisRealtime = new IoredisMock()
    const publishSpy = vi.spyOn(redisRealtime, 'publish')

    const client = await beginTxn(pool)
    try {
      await expect(
        runLocationsAndNpcsStage(client, makeArgs({ worldId, userId, campaignId, worldName: scope.worldName(0), redisRealtime })),
      ).rejects.toThrow(/repair chain exhausted/)
    } finally {
      await rollback(client)
    }

    // Handler does NOT publish stage-reset under the unified contract;
    // that's now the caller's responsibility.
    const stageResetPublished = publishSpy.mock.calls.some(([, payload]) => {
      if (typeof payload !== 'string') return false
      const parsed = JSON.parse(payload) as { type?: string }
      return parsed.type === 'stage-reset'
    })
    expect(stageResetPublished).toBe(false)
  })

  it('persistence write-failure: throws; does NOT publish stage-reset; rollback (test-driven) leaves stage-2 seeds intact', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(nestedFixture('Eredil')))

    // Patch the client's query method to fail on the first
    // entity_hierarchy INSERT — that mimics a write failure during
    // Pass 3 of the resolver.
    const client = await beginTxn(pool)
    const originalQuery = client.query.bind(client)
    const patchedQuery = ((...args: unknown[]): unknown => {
      const sql = args[0]
      if (typeof sql === 'string' && /INSERT INTO entity_hierarchy/i.test(sql)) {
        return Promise.reject(new Error('simulated write failure'))
      }
      return (originalQuery as (...a: unknown[]) => unknown)(...args)
    }) as typeof client.query
    ;(client as unknown as { query: typeof client.query }).query = patchedQuery

    const redisRealtime = new IoredisMock()
    const publishSpy = vi.spyOn(redisRealtime, 'publish')

    try {
      await expect(
        runLocationsAndNpcsStage(client, makeArgs({ worldId, userId, campaignId, worldName: scope.worldName(0), redisRealtime })),
      ).rejects.toThrow(/simulated write failure/)
    } finally {
      // Restore the original query so ROLLBACK isn't itself blocked.
      ;(client as unknown as { query: typeof client.query }).query = originalQuery
      await rollback(client)
    }

    // Handler does NOT publish stage-reset under the unified contract.
    const stageResetPublished = publishSpy.mock.calls.some(([, payload]) => {
      if (typeof payload !== 'string') return false
      const parsed = JSON.parse(payload) as { type?: string }
      return parsed.type === 'stage-reset'
    })
    expect(stageResetPublished).toBe(false)

    // After our ROLLBACK only the two stage-2 seeds remain.
    const counts = await pool.query<{ ent: string }>(
      `SELECT count(*)::text AS ent FROM entities WHERE world_id = $1`,
      [worldId],
    )
    expect(Number(counts.rows[0]?.ent)).toBe(2)
  })
})
