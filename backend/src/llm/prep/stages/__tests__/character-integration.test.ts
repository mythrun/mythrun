/* eslint-disable @typescript-eslint/no-deprecated -- design §4.1 mandates streamObject; test must mock the deprecated SDK function. */
// backend/src/llm/prep/stages/__tests__/character-integration.test.ts
//
// MYT-53 / myth-pytq T10: stage 4 of the character-creation worker. Opus
// streamObject producing the PC entity + PC↔world relationships + PC-tagged
// facts. Owns the SINGLE INSERT into `entities` (entity_type='pc'), updates
// `characters.entity_id`, and persists relationships + facts in one
// transaction. Idempotent re-run: if `characters.entity_id` is already set,
// reuse the entity row and DELETE-then-re-INSERT relationships/facts.
//
// The Zod schema does NOT line up 1:1 with the DB columns (see
// character-integration.ts header for the mapping table):
//   pc_entity.short_description -> persisted as a fact with topic='introduction'
//     (entities has no short_description column).
//   relationships table uses source_entity_id / target_entity_id (NOT
//     source_id / target_id).
//   facts has NO `tags` column — handler uses tags[0] as `topic`
//     (default 'backstory').
//   facts.narrative_status defaults to 'undelivered'.
//   facts.access_level for new PC-tagged facts defaults to 'known'.
//
// Mock target: `'ai'` (the Vercel SDK) — matches the proven pattern used by
// every peer stage test in this directory. Real Postgres seed pattern lifted
// from character-sheet.test.ts.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import * as ai from 'ai'
import { guardTestDatabase } from '../../../../db/__tests__/guard-db.js'
import { runMigrations } from '../../../../db/migrate.js'
import { createPgPool } from '../../../../db/postgres.js'
import { uuidv7 } from '../../../../repo/uuidv7.js'
import { resetData } from '../../../../repo/__tests__/_helpers/reset-data.js'
import { runCharacterIntegrationStage } from '../character-integration.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, streamObject: vi.fn() }
})

const mockStreamObject = vi.mocked(ai.streamObject)

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: () => {
      // discard log output
    },
  }
  return pino(
    { base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } },
    sink,
  )
}

const NARRATIVE = {
  name: 'Bran of the Hollow',
  race: 'human',
  class: 'cleric',
  background: 'acolyte',
  level: 1,
  alignment: 'lawful neutral',
  age: 27,
  gender: 'man',
  physical_description:
    'A tall man, weather-worn from years on the road, with a shaved scalp and a faded sept-mark on the back of his left hand.',
  personality_traits: ['measured', 'patient'],
  ideals: ['order serves the weak'],
  bonds: ['the temple that raised him'],
  flaws: ['quick to suspect deception'],
  backstory:
    'Bran was apprenticed at the Bone Sept in his twelfth year, when the priests took him in after a winter on the moors orphaned him. Twenty years later, when the Sept burned, he walked out with a tin ladle and a name he was no longer sure was his. He has been on the road since, doing temple work for coin, telling himself he is still a cleric of the Hollow, listening for the small voice that used to answer him at the altar.',
}

interface SeedResult {
  readonly userId: string
  readonly worldId: string
  readonly campaignId: string
  readonly characterId: string
  readonly locationId: string
  readonly factionId: string
}

function streamObjectMockReturn(payload: unknown): ReturnType<typeof ai.streamObject> {
  return {
    object: Promise.resolve(payload),
    usage: Promise.resolve({ inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 }),
  } as unknown as ReturnType<typeof ai.streamObject>
}

const INTEGRATION = {
  pc_entity: {
    name: 'Bran of the Hollow',
    short_description:
      'A road-weary cleric tying his fate to the Hollow and the silence of the old gods through the long autumn rains.',
  },
  relationships: [
    {
      target_entity_name: 'Bone Sept',
      relationship_type: 'apprenticed_at',
      description:
        'Trained at the Bone Sept in youth, learned the old liturgies before the burning twenty years ago.',
    },
  ],
  facts: [
    {
      content: 'Bran was apprenticed at the Bone Sept in his youth.',
      tags: ['backstory'],
    },
  ],
}

describe('runCharacterIntegrationStage', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await runMigrations({
      pool,
      migrationsDir: REAL_MIGRATIONS_DIR,
      logger: silentLogger(),
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetData(pool)
    vi.clearAllMocks()
  })

  async function seed(): Promise<SeedResult> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    const characterId = uuidv7()
    const locationId = uuidv7()
    const factionId = uuidv7()
    const suffix = userId.slice(0, 8)

    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [userId, `g_char_integ_${suffix}`, 'Char Integ User', `charinteg_${suffix}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status, starting_situation_entries)
       VALUES ($1, $2, 'Char Integ World', 'C', 'complete', $3::jsonb)`,
      [
        worldId,
        userId,
        JSON.stringify([
          {
            index: 0,
            locationEntityId: locationId,
            prose: 'You arrive at The Tavern as the storm breaks.',
          },
        ]),
      ],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, starting_situation_index)
       VALUES ($1, $2, $3, 'Char Integ Campaign', 0)`,
      [campaignId, worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'owner', true)`,
      [uuidv7(), campaignId, userId],
    )
    // World entities: location ('The Tavern') + faction ('Bone Sept').
    await pool.query(
      `INSERT INTO entities (id, world_id, entity_type, name, access_level)
       VALUES ($1, $2, 'location', 'The Tavern', 'known')`,
      [locationId, worldId],
    )
    await pool.query(
      `INSERT INTO entities (id, world_id, entity_type, name, access_level)
       VALUES ($1, $2, 'faction', 'Bone Sept', 'known')`,
      [factionId, worldId],
    )
    // Characters row WITHOUT entity_id set — that's stage 4's job.
    await pool.query(
      `INSERT INTO characters (
         id, user_id, name, level, class, species, background,
         str, dex, con, int, wis, cha,
         hit_points, max_hit_points, armor_class, proficiency_bonus
       )
       VALUES ($1, $2, 'Bran of the Hollow', 1, 'cleric', 'human', 'acolyte',
               12, 10, 14, 13, 16, 11, 9, 9, 14, 2)`,
      [characterId, userId],
    )
    await pool.query(
      `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
       VALUES ($1, $2, $3, $4)`,
      [uuidv7(), campaignId, characterId, userId],
    )

    return { userId, worldId, campaignId, characterId, locationId, factionId }
  }

  it('creates a pc entity, links characters.entity_id, persists relationships and facts including the deferred location fact', async () => {
    const { userId, worldId, campaignId, characterId, factionId } = await seed()

    mockStreamObject.mockReturnValueOnce(streamObjectMockReturn(INTEGRATION))

    const events: Record<string, unknown>[] = []
    const result = await runCharacterIntegrationStage(pool, {
      campaignId,
      userId,
      worldId,
      characterId,
      narrative: NARRATIVE,
      situationGroundingText:
        'arrived seeking word of an old companion through the fall storms.',
      publishEvent: (e) => {
        events.push(e)
        return Promise.resolve()
      },
    })

    expect(result.entityId).toBeDefined()
    expect(result.inputTokens).toBe(2000)
    expect(result.outputTokens).toBe(1000)
    // Opus pricing: 15.0 input / 75.0 output per Mtok.
    expect(result.costUsd).toBeCloseTo(
      (2000 / 1_000_000) * 15.0 + (1000 / 1_000_000) * 75.0,
      6,
    )

    const ent = await pool.query(
      `SELECT entity_type, name, access_level, world_id FROM entities WHERE id = $1`,
      [result.entityId],
    )
    expect(ent.rows[0]).toMatchObject({
      entity_type: 'pc',
      name: 'Bran of the Hollow',
      access_level: 'known',
      world_id: worldId,
    })

    const ch = await pool.query<{ entity_id: string | null }>(
      `SELECT entity_id FROM characters WHERE id = $1`,
      [characterId],
    )
    expect(ch.rows[0]?.entity_id).toBe(result.entityId)

    const rels = await pool.query<{
      target_entity_id: string
      relationship_type: string
    }>(
      `SELECT target_entity_id, relationship_type FROM relationships WHERE source_entity_id = $1`,
      [result.entityId],
    )
    expect(rels.rowCount).toBe(1)
    expect(rels.rows[0]).toMatchObject({
      target_entity_id: factionId,
      relationship_type: 'apprenticed_at',
    })

    const facts = await pool.query<{
      topic: string
      content: string
      narrative_status: string
      access_level: string
    }>(
      `SELECT topic, content, narrative_status, access_level FROM facts WHERE entity_id = $1 ORDER BY topic`,
      [result.entityId],
    )
    // At minimum: backstory (from LLM) + introduction (short_description) +
    // starting_location (deferred). Allow >=2 if the handler folds
    // short_description elsewhere.
    expect(facts.rowCount).toBeGreaterThanOrEqual(2)
    const startsAt = facts.rows.find((f) => f.topic === 'starting_location')
    expect(startsAt).toBeDefined()
    expect(startsAt?.content).toMatch(/starts at|The Tavern/i)
    // All persisted facts default to known / undelivered.
    for (const f of facts.rows) {
      expect(f.access_level).toBe('known')
      expect(f.narrative_status).toBe('undelivered')
    }

    // SSE events: at least one entity-added (for the PC) + one edge-added
    // (for the PC → faction relationship).
    expect(events.some((e) => e.type === 'entity-added')).toBe(true)
    expect(events.some((e) => e.type === 'edge-added')).toBe(true)
  })

  it('idempotent re-run: existing characters.entity_id reused, edges/facts DELETEd + re-INSERTed', async () => {
    const { userId, worldId, campaignId, characterId, factionId } = await seed()

    // First run.
    mockStreamObject.mockReturnValueOnce(streamObjectMockReturn(INTEGRATION))
    const first = await runCharacterIntegrationStage(pool, {
      campaignId,
      userId,
      worldId,
      characterId,
      narrative: NARRATIVE,
      situationGroundingText: 'arrived at the tavern.',
      publishEvent: () => Promise.resolve(),
    })

    const firstFactCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM facts WHERE entity_id = $1`,
      [first.entityId],
    )
    const firstRelCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM relationships WHERE source_entity_id = $1`,
      [first.entityId],
    )

    // Second run with a different INTEGRATION payload (different fact content,
    // same single relationship target).
    const INTEGRATION_V2 = {
      pc_entity: {
        name: 'Bran of the Hollow',
        short_description:
          'A road-weary cleric who has begun listening for the silence of the old gods, in the second telling of his arrival.',
      },
      relationships: [
        {
          target_entity_name: 'Bone Sept',
          relationship_type: 'apprenticed_at',
          description:
            'Was raised at the Bone Sept and bears its faded sept-mark on the back of his left hand.',
        },
      ],
      facts: [
        {
          content: 'Bran carries a sept-mark from his apprentice years.',
          tags: ['backstory'],
        },
      ],
    }
    mockStreamObject.mockReturnValueOnce(streamObjectMockReturn(INTEGRATION_V2))
    const second = await runCharacterIntegrationStage(pool, {
      campaignId,
      userId,
      worldId,
      characterId,
      narrative: NARRATIVE,
      situationGroundingText: 'arrived at the tavern.',
      publishEvent: () => Promise.resolve(),
    })

    expect(second.entityId).toBe(first.entityId)

    // characters.entity_id is still the same.
    const ch = await pool.query<{ entity_id: string | null }>(
      `SELECT entity_id FROM characters WHERE id = $1`,
      [characterId],
    )
    expect(ch.rows[0]?.entity_id).toBe(first.entityId)

    // Exactly one relationship row — the previous one was DELETEd, the new
    // one inserted. Same count as first run, not doubled.
    const rels = await pool.query<{
      target_entity_id: string
      description: string
    }>(
      `SELECT target_entity_id, description FROM relationships WHERE source_entity_id = $1`,
      [first.entityId],
    )
    expect(rels.rowCount).toBe(Number(firstRelCount.rows[0]?.count ?? '0'))
    expect(rels.rows[0]?.target_entity_id).toBe(factionId)
    expect(rels.rows[0]?.description).toMatch(/sept-mark/)

    // Facts: same count as first run. The new backstory content replaces the
    // old one — verify by content match.
    const factsAfter = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM facts WHERE entity_id = $1`,
      [first.entityId],
    )
    expect(factsAfter.rows[0]?.count).toBe(firstFactCount.rows[0]?.count)
    const matchingFacts = await pool.query<{ content: string }>(
      `SELECT content FROM facts WHERE entity_id = $1 AND content LIKE '%sept-mark%'`,
      [first.entityId],
    )
    expect(matchingFacts.rowCount).toBe(1)
  })
})
