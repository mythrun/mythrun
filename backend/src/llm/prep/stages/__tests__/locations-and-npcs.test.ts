// backend/src/llm/prep/stages/__tests__/locations-and-npcs.test.ts
//
// Stage 3 (locations_and_npcs) integration test. Real Postgres + mocked
// Vercel SDK streamObject. Asserts the persistence contract (entities +
// prose_kernels + facts + entity_hierarchy via the three-pass resolver)
// and the repair-chain fallthrough behavior (Zod-fail → Haiku → Sonnet
// → stage-reset). Also covers the §D8 corner cases: nested hierarchy
// (region → city → inn), unresolvable parent_location (typo), and the
// stage-2-wins name-collision rule.
//
// Pattern crib: src/llm/prep/stages/__tests__/world-and-factions.test.ts
// — same scaffold, with the stage-2 seed entities (an Eredil region +
// House Korren faction) inserted in beforeEach to give the resolver
// something to bind to.

/* eslint-disable @typescript-eslint/no-deprecated -- mirrors source: Vercel SDK
 * flags streamObject deprecated but design §D1 mandates it. */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import IoredisMock from 'ioredis-mock'
import type { Job } from 'bullmq'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../../../db/postgres.js'
import { runMigrations } from '../../../../db/migrate.js'
import { guardTestDatabase } from '../../../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../../../repo/uuidv7.js'

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

type StageInput = Parameters<typeof runLocationsAndNpcsStage>[0]

function makeInput(opts: {
  pool: Pool
  worldId: string
  userId: string
  campaignId: string
  redisRealtime?: InstanceType<typeof IoredisMock>
}): StageInput {
  return {
    pool: opts.pool,
    world: {
      id: opts.worldId,
      createdBy: opts.userId,
      name: 'W',
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

describe('runLocationsAndNpcsStage', () => {
  let pool: Pool
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
  })
  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    mockStreamObject.mockReset()
    mockGenerateText.mockReset()
    await pool.query('DELETE FROM entity_hierarchy')
    await pool.query('DELETE FROM facts')
    await pool.query('DELETE FROM prose_kernels')
    await pool.query('DELETE FROM entities')
    await pool.query('DELETE FROM campaigns')
    await pool.query('DELETE FROM worlds')
    await pool.query("DELETE FROM users WHERE cognito_sub != 'system:mythrun'")
    userId = uuidv7()
    worldId = uuidv7()
    campaignId = uuidv7()
    regionEntityId = uuidv7()
    factionEntityId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, `bypass:ln-${userId.slice(-6)}`, 'LN', `ln${userId.slice(-6)}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status)
       VALUES ($1, $2, 'W', 'C', 'generating')`,
      [worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES ($1, $2, $3, 'Smoke', 'setup')`,
      [campaignId, worldId, userId],
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

  it('persists locations + npcs + prose + facts; resolves nested parent_location chain (region → city → inn)', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(nestedFixture('Eredil')))

    const result = await runLocationsAndNpcsStage(makeInput({ pool, worldId, userId, campaignId }))
    expect(result.costUsd).toBeGreaterThan(0)

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

  it('unresolvable parent_location (LLM typo): persists parentless + publishes entity-updated { parent_location: null }', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(typoedTree()))

    const redisRealtime = new IoredisMock()
    const publishSpy = vi.spyOn(redisRealtime, 'publish')

    await runLocationsAndNpcsStage(makeInput({ pool, worldId, userId, campaignId, redisRealtime }))

    // No entity_hierarchy row for the typo'd location.
    const eh = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM entity_hierarchy h
         JOIN entities c ON c.id = h.child_entity_id
        WHERE c.name = 'Old Causeway'`,
    )
    expect(eh.rows[0]?.count).toBe('0')

    // entity-updated event with patch: { parent_location: null } for the typo'd synthKey.
    const parentClearedPublished = publishSpy.mock.calls.some(([channel, payload]) => {
      if (typeof channel !== 'string' || typeof payload !== 'string') return false
      if (!channel.includes(`pipeline:campaign:${campaignId}`)) return false
      const parsed = JSON.parse(payload) as {
        type?: string
        synthKey?: string
        patch?: { parent_location?: string | null }
      }
      return (
        parsed.type === 'entity-updated' &&
        parsed.synthKey === 'locations_and_npcs/locations/2' &&
        parsed.patch?.parent_location === null
      )
    })
    expect(parentClearedPublished).toBe(true)
  })

  it('name-collision: stage-2 entity wins (older) over a stage-3 location of the same name', async () => {
    // Re-seed: rename the stage-2 region to "Anul-dan" — same name as the
    // stage-3 city in the fixture. The resolver must pick the stage-2
    // (older) entity when "The Silent Bowstring" declares
    // parent_location: "Anul-dan".
    await pool.query(`UPDATE entities SET name = 'Anul-dan' WHERE id = $1`, [regionEntityId])

    mockStreamObject.mockReturnValueOnce(makeStream(nestedFixture('Anul-dan')))

    await runLocationsAndNpcsStage(makeInput({ pool, worldId, userId, campaignId }))

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

    const result = await runLocationsAndNpcsStage(makeInput({ pool, worldId, userId, campaignId }))
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

    const result = await runLocationsAndNpcsStage(makeInput({ pool, worldId, userId, campaignId }))
    expect(result.costUsd).toBeGreaterThan(0)
    expect(mockGenerateText).toHaveBeenCalledTimes(2) // Haiku + Sonnet

    const ent = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM entities WHERE world_id = $1`,
      [worldId],
    )
    expect(ent.rows[0]?.count).toBe('12')
  })

  it('repair-chain exhausted: throws + publishes stage-reset', async () => {
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

    await expect(
      runLocationsAndNpcsStage(makeInput({ pool, worldId, userId, campaignId, redisRealtime })),
    ).rejects.toThrow(/repair chain exhausted/)

    const stageResetPublished = publishSpy.mock.calls.some(([channel, payload]) => {
      if (typeof channel !== 'string' || typeof payload !== 'string') return false
      if (!channel.includes(`pipeline:campaign:${campaignId}`)) return false
      const parsed = JSON.parse(payload) as { type?: string; stage?: string }
      return parsed.type === 'stage-reset' && parsed.stage === 'locations_and_npcs'
    })
    expect(stageResetPublished).toBe(true)
  })

  it('persistence COMMIT failure → ROLLBACK + publishes stage-reset and rethrows', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(nestedFixture('Eredil')))

    // Wrap pool.connect to inject a client that fails on COMMIT.
    const realConnect = pool.connect.bind(pool)
    async function fakeConnect(): Promise<Awaited<ReturnType<typeof pool.connect>>> {
      const client = await realConnect()
      const originalQuery = client.query.bind(client)
      const patchedQuery = ((...args: unknown[]): unknown => {
        const sql = args[0]
        if (typeof sql === 'string' && sql.trim().toUpperCase() === 'COMMIT') {
          return Promise.reject(new Error('simulated COMMIT failure'))
        }
        return (originalQuery as (...a: unknown[]) => unknown)(...args)
      }) as typeof client.query
      ;(client as unknown as { query: typeof client.query }).query = patchedQuery
      return client as unknown as Awaited<ReturnType<typeof pool.connect>>
    }
    const connectSpy = vi.spyOn(pool, 'connect')
    // mockImplementationOnce wants a sync callable returning a Promise;
    // an async function literal trips the no-misused-promises rule, so
    // we wrap via a sync function that returns the promise from fakeConnect.
    connectSpy.mockImplementationOnce(((): Promise<unknown> => fakeConnect()) as never)

    const redisRealtime = new IoredisMock()
    const publishSpy = vi.spyOn(redisRealtime, 'publish')

    await expect(
      runLocationsAndNpcsStage(makeInput({ pool, worldId, userId, campaignId, redisRealtime })),
    ).rejects.toThrow(/simulated COMMIT failure/)

    const stageResetPublished = publishSpy.mock.calls.some(([channel, payload]) => {
      if (typeof channel !== 'string' || typeof payload !== 'string') return false
      if (!channel.includes(`pipeline:campaign:${campaignId}`)) return false
      const parsed = JSON.parse(payload) as { type?: string; stage?: string }
      return parsed.type === 'stage-reset' && parsed.stage === 'locations_and_npcs'
    })
    expect(stageResetPublished).toBe(true)

    // ROLLBACK fired — no stage-3 entity rows landed (the 2 stage-2 seeds remain).
    const counts = await pool.query<{ ent: string }>(
      `SELECT count(*)::text AS ent FROM entities WHERE world_id = $1`,
      [worldId],
    )
    expect(Number(counts.rows[0]?.ent)).toBe(2)

    connectSpy.mockRestore()
  })
})
