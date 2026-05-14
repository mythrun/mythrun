// backend/src/llm/prep/stages/__tests__/world-and-factions.test.ts
//
// Stage 2 (world_and_factions) integration test. Real Postgres + mocked
// Vercel SDK streamObject. Asserts the persistence contract (entities +
// prose_kernels + facts + worlds.world_overview) and the repair-chain
// fallthrough behavior (Zod-fail → Haiku → Sonnet → stage-reset).
//
// Pattern crib: src/llm/prep/__tests__/structured-output-repair.test.ts
// for the ai-module mock pattern; src/llm/prep/stages/__tests__/concept-intake.test.ts
// for the stage-handler shape.

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
import { runWorldAndFactionsStage } from '../world-and-factions.js'

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
interface NamedBlock {
  name: string
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
      prose: `Description of region ${String(i)}. `.repeat(3),
      facts: [
        {
          topic: 'history',
          content: 'Founded long ago by elven settlers.',
          access_level: 'public' as const,
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
      prose: `Description of faction ${String(i)}. `.repeat(3),
      facts: [
        {
          topic: 'goal',
          content: 'Reclaim the lost sword of the founders.',
          access_level: 'public' as const,
        },
        {
          topic: 'enemy',
          content: 'Rivals with the Iron Coast factions.',
          access_level: 'public' as const,
        },
      ],
    })),
  }
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

type StageInput = Parameters<typeof runWorldAndFactionsStage>[0]

function makeInput(opts: {
  pool: Pool
  worldId: string
  userId: string
  campaignId: string
  redisRealtime?: InstanceType<typeof IoredisMock>
}): StageInput {
  return {
    pool: opts.pool,
    world: { id: opts.worldId, createdBy: opts.userId, name: 'W', concept: 'C' },
    campaignId: opts.campaignId,
    job: fakeJob(),
    redisRealtime: opts.redisRealtime ?? new IoredisMock(),
    keyPrefix: 'test:',
  }
}

describe('runWorldAndFactionsStage', () => {
  let pool: Pool
  let userId: string
  let campaignId: string
  let worldId: string

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
    await pool.query('DELETE FROM facts')
    await pool.query('DELETE FROM prose_kernels')
    await pool.query('DELETE FROM entities')
    await pool.query('DELETE FROM campaigns')
    await pool.query('DELETE FROM worlds')
    await pool.query("DELETE FROM users WHERE cognito_sub != 'system:mythrun'")
    userId = uuidv7()
    worldId = uuidv7()
    campaignId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, `bypass:wf-${userId.slice(-6)}`, 'WF', `wf${userId.slice(-6)}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, 'W', 'C', 'generating')`,
      [worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES ($1, $2, $3, 'Smoke', 'setup')`,
      [campaignId, worldId, userId],
    )
  })

  it('persists regions + factions + prose + facts + world_overview', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(fixtureTree()))

    const result = await runWorldAndFactionsStage(
      makeInput({ pool, worldId, userId, campaignId }),
    )
    expect(result.costUsd).toBeGreaterThan(0)
    expect(result.inputTokens).toBe(5000)
    expect(result.outputTokens).toBe(6000)

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

  it('stamps facts.narrative_status = undelivered and source = prep', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(fixtureTree()))

    await runWorldAndFactionsStage(makeInput({ pool, worldId, userId, campaignId }))

    const rows = await pool.query<{ narrative_status: string; source: string }>(
      `SELECT DISTINCT narrative_status, source FROM facts WHERE entity_id IN (SELECT id FROM entities WHERE world_id = $1)`,
      [worldId],
    )
    expect(rows.rows).toEqual([{ narrative_status: 'undelivered', source: 'prep' }])
  })

  it('does NOT write to relationships table (stage 4 owns edges)', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(fixtureTree()))

    await runWorldAndFactionsStage(makeInput({ pool, worldId, userId, campaignId }))
    const c = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM relationships`,
    )
    expect(c.rows[0]?.count).toBe('0')
  })

  it('Zod-fail at stream end → Haiku repair succeeds → persists repaired tree', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(brokenTree()))

    // Haiku repair returns a valid tree.
    mockGenerateText.mockResolvedValueOnce({
      output: fixtureTree(),
      usage: { inputTokens: 800, outputTokens: 700, totalTokens: 1500 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const result = await runWorldAndFactionsStage(
      makeInput({ pool, worldId, userId, campaignId }),
    )
    // costUsd accumulates Opus stream + Haiku repair.
    expect(result.costUsd).toBeGreaterThan(0)
    expect(mockGenerateText).toHaveBeenCalledTimes(1) // only Haiku; no Sonnet escalation

    const counts = await pool.query<{ ent: string }>(
      `SELECT count(*)::text AS ent FROM entities WHERE world_id = $1`,
      [worldId],
    )
    expect(Number(counts.rows[0]?.ent)).toBe(6)
  })

  it('Zod-fail → Haiku-fail → Sonnet-success → persists Sonnet-repaired tree', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(brokenTree()))

    // Haiku fails; Sonnet returns a valid tree.
    mockGenerateText.mockResolvedValueOnce({
      output: brokenTree(),
      usage: { inputTokens: 800, outputTokens: 700, totalTokens: 1500 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)
    mockGenerateText.mockResolvedValueOnce({
      output: fixtureTree(),
      usage: { inputTokens: 1000, outputTokens: 900, totalTokens: 1900 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const result = await runWorldAndFactionsStage(
      makeInput({ pool, worldId, userId, campaignId }),
    )
    expect(result.costUsd).toBeGreaterThan(0)
    expect(mockGenerateText).toHaveBeenCalledTimes(2) // Haiku + Sonnet

    const counts = await pool.query<{ ent: string }>(
      `SELECT count(*)::text AS ent FROM entities WHERE world_id = $1`,
      [worldId],
    )
    expect(Number(counts.rows[0]?.ent)).toBe(6)
  })

  it('Zod-fail → Haiku-fail → Sonnet-fail → publishes stage-reset and throws', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(brokenTree()))

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
      runWorldAndFactionsStage(
        makeInput({ pool, worldId, userId, campaignId, redisRealtime }),
      ),
    ).rejects.toThrow(/repair chain exhausted/)

    expect(mockGenerateText).toHaveBeenCalledTimes(2) // Haiku + Sonnet

    const stageResetPublished = publishSpy.mock.calls.some(([channel, payload]) => {
      if (typeof channel !== 'string' || typeof payload !== 'string') return false
      if (!channel.includes(`pipeline:campaign:${campaignId}`)) return false
      const parsed = JSON.parse(payload) as { type?: string; stage?: string }
      return parsed.type === 'stage-reset' && parsed.stage === 'world_and_factions'
    })
    expect(stageResetPublished).toBe(true)

    // Persistence aborted — no rows landed.
    const counts = await pool.query<{ ent: string }>(
      `SELECT count(*)::text AS ent FROM entities WHERE world_id = $1`,
      [worldId],
    )
    expect(Number(counts.rows[0]?.ent)).toBe(0)
  })

  it('persistence COMMIT failure → ROLLBACK + publishes stage-reset and rethrows', async () => {
    mockStreamObject.mockReturnValueOnce(makeStream(fixtureTree()))

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
    // The mockImplementationOnce signature wants a sync callable returning a
    // Promise; async function literals trip the no-misused-promises rule, so
    // we wrap via a sync function that returns the promise from fakeConnect.
    connectSpy.mockImplementationOnce(((): Promise<unknown> => fakeConnect()) as never)

    const redisRealtime = new IoredisMock()
    const publishSpy = vi.spyOn(redisRealtime, 'publish')

    await expect(
      runWorldAndFactionsStage(
        makeInput({ pool, worldId, userId, campaignId, redisRealtime }),
      ),
    ).rejects.toThrow(/simulated COMMIT failure/)

    const stageResetPublished = publishSpy.mock.calls.some(([channel, payload]) => {
      if (typeof channel !== 'string' || typeof payload !== 'string') return false
      if (!channel.includes(`pipeline:campaign:${campaignId}`)) return false
      const parsed = JSON.parse(payload) as { type?: string; stage?: string }
      return parsed.type === 'stage-reset' && parsed.stage === 'world_and_factions'
    })
    expect(stageResetPublished).toBe(true)

    // ROLLBACK fired — no rows landed.
    const counts = await pool.query<{ ent: string }>(
      `SELECT count(*)::text AS ent FROM entities WHERE world_id = $1`,
      [worldId],
    )
    expect(Number(counts.rows[0]?.ent)).toBe(0)

    connectSpy.mockRestore()
  })
})
