/* eslint-disable @typescript-eslint/no-deprecated -- design §4.1 mandates streamObject; test must mock the deprecated SDK function. */
// backend/src/llm/prep/__tests__/concept-output-persistence.test.ts
//
// MYT-54 / myth-y7xt T2: the character-creation processor must persist
// stage 2's CharacterConceptOutput to character_concepts.concept_output so
// the campaign-scoped character_integration worker (myth-y7xt T3/T4) can
// read the structured narrative instead of just concept_text + the
// mechanical fields on `characters`. T1 added the JSONB column (nullable);
// T2 wires the write. This test asserts that after the processor runs the
// character_concept stage, the concept_output row is populated with the
// LLM's structured output — fed in through a vi.spyOn'd `runCharacterConcept
// Stage` to keep the test deterministic.
//
// Pattern mirrors character-creation-processor.test.ts: real Postgres via
// createTestPool + scoped fixtures + mocked Vercel AI SDK. We only need to
// drive through stage 2 successfully; stages 3 + 4 mocks return shapes that
// let the job complete cleanly (the assertion is on the DB row, not on the
// processor's terminal state).

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import * as ai from 'ai'
import { guardTestDatabase } from '../../../db/__tests__/guard-db.js'
import { runMigrations } from '../../../db/migrate.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../../repo/__tests__/_helpers/test-pool.js'
import { runCharacterCreationJob } from '../character-creation-processor.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn(), streamObject: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: () => {
      // discard log output
    },
  }
  return pino(
    {
      base: { component: 'migrate' },
      serializers: { err: pino.stdSerializers.err },
    },
    sink,
  )
}

// Mirrors the canonical happy-path VALID_CONCEPT in
// character-creation-processor.test.ts. The persistence assertion compares
// the round-tripped JSONB to this exact shape.
const VALID_CONCEPT = {
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
  personality_traits: [
    'speaks in measured tones',
    'pauses before answering, as if listening to something else first',
  ],
  ideals: ['order serves the weak'],
  bonds: ['the temple that raised him'],
  flaws: ['quick to suspect deception'],
  backstory:
    'Bran was apprenticed at the Bone Sept in his twelfth year, when the priests took him in after a winter on the moors orphaned him. Twenty years later, when the Sept burned, he walked out with a tin ladle and a name he was no longer sure was his. He has been on the road since, doing temple work for coin, telling himself he is still a cleric of the Hollow, listening for the small voice that used to answer him at the altar.',
}

const VALID_SHEET = {
  str: 12,
  dex: 10,
  con: 14,
  int: 13,
  wis: 16,
  cha: 11,
  hit_points: 9,
  max_hit_points: 9,
  armor_class: 14,
  proficiency_bonus: 2,
  starting_gold: 15,
  hit_die: 8,
  spellcasting_progression: 'full',
  skills: [{ name: 'Insight', proficient: true, expertise: false }],
  features: [
    {
      name: 'Divine Domain: Life',
      description: 'extra healing for allies',
      max_uses: null,
      recharge: 'none',
    },
  ],
  equipment: [{ name: 'Mace', quantity: 1, consumable: false }],
  spells: [{ name: 'Cure Wounds', level: 1, prepared: true, ritual: false }],
}

// VALID_INTEGRATION (the stage-4 fixture) lived here under MYT-53.
// MYT-54 T3 lifted character_integration out of the per-player pipeline,
// so runCharacterCreationJob no longer drives stage 4. The campaign-scoped
// fixture for MYT-54's character-integration-processor lives in that
// processor's own test file (added in T10).

interface SeedResult {
  readonly userId: string
  readonly worldId: string
  readonly campaignId: string
  readonly locationId: string
  readonly factionId: string
}

// myth-5jdo: characters.user_id is RESTRICT-FK to users — must delete
// scope-user characters BEFORE cleanupTestScope's user delete. Mirrors the
// helper in character-creation-processor.test.ts.
async function cleanupCharactersFor(p: Pool, scope: TestScope): Promise<void> {
  await p.query(
    `DELETE FROM characters
       WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
    [`${scope.id}%`],
  )
  await cleanupTestScope(p, scope)
}

describe('character-creation-processor — stage 2 persists concept_output', () => {
  let pool: Pool
  let scope: TestScope
  let userCounter: number

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    await runMigrations({
      pool,
      migrationsDir: REAL_MIGRATIONS_DIR,
      logger: silentLogger(),
    })
    scope = makeTestScope('concop')
    userCounter = 0
  })

  afterAll(async () => {
    await cleanupCharactersFor(pool, scope)
    await pool.end()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function seed(): Promise<SeedResult> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    const locationId = uuidv7()
    const factionId = uuidv7()
    const n = userCounter++

    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(n), scope.displayName(n), scope.username(n)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status, tone, themes, era,
                           geography_summary, political_summary, key_tensions,
                           starting_situation_entries)
       VALUES ($1, $2, $3, 'A test concept', 'complete', 'somber', 'guardianship',
               'iron age', 'highlands', 'three rival houses', 'spirits chafe', $4::jsonb)`,
      [
        worldId,
        userId,
        scope.worldName(n),
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
       VALUES ($1, $2, $3, $4, 0)`,
      [campaignId, worldId, userId, scope.campaignName(n)],
    )
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'owner', true)`,
      [uuidv7(), campaignId, userId],
    )
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
    await pool.query(
      `INSERT INTO character_concepts (
         id, campaign_id, user_id, concept_text, situation_grounding_text,
         guided_choices, status
       )
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 'processing')`,
      [
        uuidv7(),
        campaignId,
        userId,
        'A road-weary cleric searching for word of an old companion',
        'arrived at the tavern seeking word of an old companion through the fall storms',
      ],
    )
    return { userId, worldId, campaignId, locationId, factionId }
  }

  it('writes character_concepts.concept_output with the structured narrative after stage 2 completes', async () => {
    const { userId, campaignId } = await seed()
    // Stage 2: character_concept — returns VALID_CONCEPT.
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_CONCEPT,
      finishReason: 'stop',
      usage: { inputTokens: 1500, outputTokens: 1200, totalTokens: 2700 },
    } as never)
    // Stage 3: character_sheet — returns VALID_SHEET so the processor walks
    // past stage 2 cleanly. The assertion below targets the DB row stage 2
    // wrote; stage 3 is scaffolding to keep the run from rolling back.
    // MYT-54 T3: stage 4 (character_integration) was lifted out of the
    // per-player pipeline, so no third mock is needed here.
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_SHEET,
      finishReason: 'stop',
      usage: { inputTokens: 2000, outputTokens: 2000, totalTokens: 4000 },
    } as never)

    await runCharacterCreationJob(
      {
        pool,
        costCapUsd: 5.0,
        publishEvent: () => Promise.resolve(),
      },
      {
        data: { campaignId, userId },
        updateProgress: () => Promise.resolve(),
        name: 'character-creation',
      },
    )

    const row = await pool.query<{ concept_output: unknown }>(
      `SELECT concept_output FROM character_concepts
         WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(row.rowCount).toBe(1)
    // JSONB round-trips as a plain JS object; deep-equal against the LLM
    // output that stage 2 returned.
    expect(row.rows[0]?.concept_output).toEqual(VALID_CONCEPT)
  })
})
