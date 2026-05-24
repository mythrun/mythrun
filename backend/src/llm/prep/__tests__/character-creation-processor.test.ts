/* eslint-disable @typescript-eslint/no-deprecated -- design §4.1 mandates streamObject; test must mock the deprecated SDK function. */
// backend/src/llm/prep/__tests__/character-creation-processor.test.ts
//
// MYT-53 / myth-0eji T11: the BullMQ processor that wires the four stage
// handlers (T7-T10), the character-concepts repo (T2), the cost-cap
// aggregator (T5), and the atomicClaimStage primitive (T6) into a single
// per-player worker. One job per (campaign_id, user_id) — fan-out by the
// owner's POST /start-character-creation.
//
// Integration style: real Postgres + ioredis-mock-style publishEvent spy +
// mocked Vercel AI SDK. Seeds the prerequisite world + entities + campaign
// + character_concepts row, then invokes runCharacterCreationJob(deps, job)
// and asserts post-conditions.

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
import {
  runCharacterCreationJob,
  createCharacterCreationProcessor,
  type CharacterCreationJobPayload,
  type CharacterCreationDeps,
  type CreateCharacterCreationProcessorDeps,
} from '../character-creation-processor.js'
import { LlmStructuredOutputError } from '../../errors.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn(), streamObject: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)
const mockStreamObject = vi.mocked(ai.streamObject)

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
    { base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } },
    sink,
  )
}

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
  skills: [{ name: 'Insight', proficient: true, expertise: false }],
  features: [
    { name: 'Divine Domain: Life', description: 'extra healing for allies' },
  ],
  equipment: [{ name: 'Mace', quantity: 1 }],
  spells: [{ name: 'Cure Wounds', level: 1, prepared: true }],
}

// VALID_INTEGRATION (the stage-4 fixture) lived here under MYT-53. T3
// removed the per-player integration stage; the campaign-scoped fixture
// for MYT-54's character-integration-processor lives in that processor's
// own test file (added in T10).

interface SeedResult {
  readonly userId: string
  readonly worldId: string
  readonly campaignId: string
  readonly locationId: string
  readonly factionId: string
}

function makeJob(
  campaignId: string,
  userId: string,
): {
  data: CharacterCreationJobPayload
  updateProgress: () => Promise<void>
  name: string
} {
  return {
    data: { campaignId, userId },
    updateProgress: () => Promise.resolve(),
    name: 'character-creation',
  }
}

interface MakeDepsOverrides {
  readonly costCapUsd?: number
  readonly publishEvent?: CharacterCreationDeps['publishEvent']
}

// Default cap matches migration 016's seeded $5.00. Tests exercising the
// cap-exceeded path override via `costCapUsd: <tight value>`.
function makeDeps(pool: Pool, overrides: MakeDepsOverrides = {}): CharacterCreationDeps {
  return {
    pool,
    costCapUsd: overrides.costCapUsd ?? 5.0,
    publishEvent: overrides.publishEvent ?? (() => Promise.resolve()),
  }
}

function makeProcessorDeps(
  pool: Pool,
  overrides: MakeDepsOverrides = {},
): CreateCharacterCreationProcessorDeps {
  return {
    pool,
    costCapUsd: overrides.costCapUsd ?? 5.0,
    publishEvent: overrides.publishEvent ?? (() => Promise.resolve()),
  }
}

// myth-5jdo: characters.user_id is RESTRICT-FK to users — must delete
// scope-user characters BEFORE cleanupTestScope's user delete. The
// character-creation processor inserts characters rows via stage 3.
async function cleanupCharactersFor(p: Pool, scope: TestScope): Promise<void> {
  await p.query(
    `DELETE FROM characters
       WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
    [`${scope.id}%`],
  )
  await cleanupTestScope(p, scope)
}

describe('runCharacterCreationJob', () => {
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
    scope = makeTestScope('charcc')
    userCounter = 0
  })

  afterAll(async () => {
    // myth-5jdo: characters delete must precede scope user delete.
    await cleanupCharactersFor(pool, scope)
    await pool.end()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    // Cost-cap is injected via makeDeps()/makeProcessorDeps(); workers no
    // longer read the settings table at job time.
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
    // character_concepts row in 'processing' (post fan-out).
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

  function setupHappyPathMocks(): void {
    // Stage 2: character_concept (Sonnet generateText)
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_CONCEPT,
      finishReason: 'stop',
      usage: { inputTokens: 1500, outputTokens: 1200, totalTokens: 2700 },
    } as never)
    // Stage 3: character_sheet (Sonnet generateText)
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_SHEET,
      finishReason: 'stop',
      usage: { inputTokens: 2000, outputTokens: 2000, totalTokens: 4000 },
    } as never)
    // MYT-54 T3: stage 4 (character_integration) was lifted out of this
    // per-player pipeline into a campaign-scoped Opus pass — no third
    // mock is needed here for the per-player end-to-end run.
  }

  it('runs all per-player stages end-to-end and marks character_concepts.completed', async () => {
    const { userId, campaignId } = await seed()
    setupHappyPathMocks()

    const events: Record<string, unknown>[] = []
    // Drive through the factory wrapper rather than calling
    // runCharacterCreationJob directly — exercises the closure body that
    // BullMQ's Worker invokes in production (mirrors how the
    // world-gen-processor tests drive createWorldGenProcessor).
    const processor = createCharacterCreationProcessor(
      makeProcessorDeps(pool, {
        publishEvent: (cid, e) => {
          events.push({ campaignId: cid, ...e })
          return Promise.resolve()
        },
      }),
    )
    await processor(makeJob(campaignId, userId) as unknown as Parameters<typeof processor>[0])

    // MYT-54 T3: the per-player pipeline now has 3 stages — the prior
    // per-player 'character_integration' was lifted to a campaign-scoped
    // Opus pass (owned by MYT-54's character-integration-processor).
    const runs = await pool.query<{ stage: string; status: string }>(
      `SELECT stage, status FROM pipeline_runs
       WHERE campaign_id = $1 AND user_id = $2
       ORDER BY started_at`,
      [campaignId, userId],
    )
    expect(runs.rowCount).toBe(3)
    for (const r of runs.rows) {
      expect(r.status).toBe('completed')
    }
    const stages = runs.rows.map((r) => r.stage)
    expect(stages).toEqual([
      'location_selection',
      'character_concept',
      'character_sheet',
    ])

    // characters row exists for the user, linked via campaign_characters.
    const characters = await pool.query<{ name: string }>(
      `SELECT c.name FROM characters c
       JOIN campaign_characters cc ON cc.character_id = c.id
       WHERE cc.campaign_id = $1 AND cc.user_id = $2`,
      [campaignId, userId],
    )
    expect(characters.rowCount).toBe(1)
    expect(characters.rows[0]?.name).toBe('Bran of the Hollow')

    // MYT-54 T3: the PC `entities` row (entity_type='pc') is no longer
    // created by this per-player pipeline. It is now produced by the
    // campaign-scoped character-integration-processor (MYT-54), so the
    // legacy `entities`-row + characters.entity_id assertions belong in
    // that processor's test (added in T10).

    // character_concepts flipped to 'completed'.
    const concept = await pool.query<{ status: string }>(
      `SELECT status FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(concept.rows[0]?.status).toBe('completed')

    // Events: stage-started + stage-completed for each of the 3 per-player
    // stages. entity-added/edge-added events are now emitted by the
    // campaign-scoped character_integration processor (MYT-54), not by
    // this per-player path — they are NOT asserted here.
    const startedStages = events
      .filter((e) => e.type === 'stage-started')
      .map((e) => e.stage)
    expect(startedStages).toEqual([
      'location_selection',
      'character_concept',
      'character_sheet',
    ])
    const completedStages = events
      .filter((e) => e.type === 'stage-completed')
      .map((e) => e.stage)
    expect(completedStages).toEqual([
      'location_selection',
      'character_concept',
      'character_sheet',
    ])
  })

  it('isolates per-player failures: terminal LLM error fails one row without aborting the job', async () => {
    const { userId, campaignId } = await seed()
    // Stage 2 (character_concept) throws a TERMINAL error.
    mockGenerateText.mockRejectedValueOnce(
      new LlmStructuredOutputError('repair chain exhausted'),
    )

    const events: Record<string, unknown>[] = []
    // Terminal errors must NOT rethrow (no BullMQ retry).
    await expect(
      runCharacterCreationJob(
        makeDeps(pool, {
          publishEvent: (cid, e) => {
            events.push({ campaignId: cid, ...e })
            return Promise.resolve()
          },
        }),
        makeJob(campaignId, userId),
      ),
    ).resolves.toBeUndefined()

    // character_concepts row failed with error JSON populated.
    const concept = await pool.query<{ status: string; error: unknown }>(
      `SELECT status, error FROM character_concepts
       WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(concept.rows[0]?.status).toBe('failed')
    expect(concept.rows[0]?.error).not.toBeNull()

    // NO characters row was created.
    const characters = await pool.query<{ id: string }>(
      `SELECT c.id FROM characters c
       JOIN campaign_characters cc ON cc.character_id = c.id
       WHERE cc.campaign_id = $1 AND cc.user_id = $2`,
      [campaignId, userId],
    )
    expect(characters.rowCount).toBe(0)

    // stage-failed event published with willRetry: false.
    const stageFailed = events.find((e) => e.type === 'stage-failed')
    expect(stageFailed).toBeDefined()
    expect(stageFailed?.willRetry).toBe(false)
  })

  it('aborts the job when cost-cap is exceeded before the first stage', async () => {
    const { userId, campaignId } = await seed()
    // Pre-insert pipeline_runs rows summing to MORE than the cap of $5.00.
    // Two completed rows at $3.00 each = $6.00 > $5.00 cap.
    const otherUserId = uuidv7()
    const otherN = userCounter++
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [otherUserId, scope.userSub(otherN), scope.displayName(otherN), scope.username(otherN)],
    )
    await pool.query(
      `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at,
                                  completed_at, cost_usd, user_id)
       VALUES ($1, $2, 'character_concept', 'completed', now(), now(), 3.0, $3),
              ($4, $2, 'character_concept', 'completed', now(), now(), 3.0, $5)`,
      [uuidv7(), campaignId, userId, uuidv7(), otherUserId],
    )

    const events: Record<string, unknown>[] = []
    await runCharacterCreationJob(
      makeDeps(pool, {
        publishEvent: (cid, e) => {
          events.push({ campaignId: cid, ...e })
          return Promise.resolve()
        },
      }),
      makeJob(campaignId, userId),
    )

    // character_concepts.status='failed' with the cost-cap code in the
    // error JSON.
    const concept = await pool.query<{
      status: string
      error: { code?: string } | null
    }>(
      `SELECT status, error FROM character_concepts
       WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(concept.rows[0]?.status).toBe('failed')
    expect(concept.rows[0]?.error?.code).toBe('character_creation_cost_cap_exceeded')

    // NO new pipeline_runs rows were claimed (only the two pre-seeded rows
    // remain, neither for this stage-pair).
    const ourRuns = await pool.query<{ stage: string }>(
      `SELECT stage FROM pipeline_runs
       WHERE campaign_id = $1 AND user_id = $2 AND stage IN
         ('location_selection', 'character_sheet')`,
      [campaignId, userId],
    )
    expect(ourRuns.rowCount).toBe(0)

    // Neither the concept nor sheet LLM calls fired. (Stage 4 is now
    // campaign-scoped, owned by MYT-54's character-integration-processor.)
    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(mockStreamObject).not.toHaveBeenCalled()

    // No characters row.
    const characters = await pool.query<{ id: string }>(
      `SELECT c.id FROM characters c
       JOIN campaign_characters cc ON cc.character_id = c.id
       WHERE cc.campaign_id = $1 AND cc.user_id = $2`,
      [campaignId, userId],
    )
    expect(characters.rowCount).toBe(0)

    // stage-failed event for the cap.
    const capFailed = events.find(
      (e) =>
        e.type === 'stage-failed' &&
        e.reason === 'character_creation_cost_cap_exceeded',
    )
    expect(capFailed).toBeDefined()
  })

  it('idempotent re-entry: re-running picks up where it left off', async () => {
    const { userId, campaignId } = await seed()
    setupHappyPathMocks()

    await runCharacterCreationJob(
      makeDeps(pool),
      makeJob(campaignId, userId),
    )

    const firstCharacters = await pool.query<{ id: string }>(
      `SELECT c.id FROM characters c
       JOIN campaign_characters cc ON cc.character_id = c.id
       WHERE cc.campaign_id = $1 AND cc.user_id = $2`,
      [campaignId, userId],
    )
    expect(firstCharacters.rowCount).toBe(1)
    const firstCharacterId = firstCharacters.rows[0]?.id

    const firstRunsCount = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pipeline_runs
       WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(firstRunsCount.rows[0]?.n).toBe('3')

    // Second run with same payload. We do NOT mock any new LLM responses —
    // the atomicClaimStage should return 'completed' for each of the 4
    // stages, so no LLM call should fire.
    mockGenerateText.mockClear()
    mockStreamObject.mockClear()

    await runCharacterCreationJob(
      makeDeps(pool),
      makeJob(campaignId, userId),
    )

    // No new characters row — same characterId via the campaign_characters
    // join.
    const secondCharacters = await pool.query<{ id: string }>(
      `SELECT c.id FROM characters c
       JOIN campaign_characters cc ON cc.character_id = c.id
       WHERE cc.campaign_id = $1 AND cc.user_id = $2`,
      [campaignId, userId],
    )
    expect(secondCharacters.rowCount).toBe(1)
    expect(secondCharacters.rows[0]?.id).toBe(firstCharacterId)

    // Still exactly 3 pipeline_runs rows — MYT-54 T3 dropped the
    // per-player stage 4. atomicClaimStage's ON CONFLICT path didn't
    // INSERT new rows; the row count is invariant across re-entry.
    const secondRunsCount = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pipeline_runs
       WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(secondRunsCount.rows[0]?.n).toBe('3')

    // character_concepts still 'completed'.
    const concept = await pool.query<{ status: string }>(
      `SELECT status FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(concept.rows[0]?.status).toBe('completed')

    // No LLM calls fired on re-entry.
    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(mockStreamObject).not.toHaveBeenCalled()
  })

  it('handles a world with NULL optional fields (empty-string fallbacks on the world snapshot)', async () => {
    // The worlds table allows NULL on tone/themes/era/geography_summary/
    // political_summary/key_tensions. A degraded world (e.g., partial
    // world-gen) might have these as NULL. The processor's empty-string
    // fallbacks let stage 2/3 prompts still render.
    const { userId, campaignId, worldId } = await seed()
    await pool.query(
      `UPDATE worlds
          SET tone = NULL, themes = NULL, era = NULL,
              geography_summary = NULL, political_summary = NULL,
              key_tensions = NULL
        WHERE id = $1`,
      [worldId],
    )
    // Also null concept_text on the character_concepts row to exercise
    // that fallback in buildConceptArgs.
    await pool.query(
      `UPDATE character_concepts SET concept_text = NULL WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    setupHappyPathMocks()
    await runCharacterCreationJob(
      makeDeps(pool),
      makeJob(campaignId, userId),
    )
    // Just verify the job completed. The empty-string fallbacks rendered
    // into the prompts as empty placeholders; the LLM mocks returned valid
    // shapes so the persistence side completed.
    const concept = await pool.query<{ status: string }>(
      `SELECT status FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(concept.rows[0]?.status).toBe('completed')
  })

  it('throws on stage 3 re-entry without ctx.conceptOutput (mid-job worker crash recovery)', async () => {
    // Setup: pre-insert pipeline_runs for stage 2 as 'completed'. On
    // re-entry, atomicClaimStage skips stage 2; ctx.conceptOutput stays
    // null; stage 3's re-entry guard throws + marks failed.
    const { userId, campaignId } = await seed()
    await pool.query(
      `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, completed_at, user_id, cost_usd, input_tokens, output_tokens)
       VALUES ($1, $2, 'character_concept', 'completed', now(), now(), $3, 0.02, 100, 50)`,
      [uuidv7(), campaignId, userId],
    )
    const events: Record<string, unknown>[] = []
    // Non-terminal error → BullMQ retry path: markStageFailed + publish
    // event + rethrow. We catch the throw, then verify the side effects.
    await expect(
      runCharacterCreationJob(
        makeDeps(pool, {
          publishEvent: (cid, e) => {
            events.push({ campaignId: cid, ...e })
            return Promise.resolve()
          },
        }),
        makeJob(campaignId, userId),
      ),
    ).rejects.toThrow(/re-entry without ctx.conceptOutput/)
    const sheetRow = await pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM pipeline_runs
       WHERE campaign_id = $1 AND user_id = $2 AND stage = 'character_sheet'`,
      [campaignId, userId],
    )
    expect(sheetRow.rows[0]?.status).toBe('failed')
    expect(sheetRow.rows[0]?.error).toMatch(/re-entry without ctx.conceptOutput/)
    // The non-terminal rethrow path emits a stage-failed event with
    // willRetry:true (BullMQ would re-attempt).
    const stageFailed = events.find(
      (e) => e.type === 'stage-failed' && e.stage === 'character_sheet',
    )
    expect(stageFailed).toBeDefined()
    expect(stageFailed?.willRetry).toBe(true)
  })

  // MYT-54 T3 removed the per-player 'character_integration' stage. The
  // legacy "throws on stage 4 re-entry without ctx.characterId or
  // ctx.conceptOutput" test exercised a re-entry guard inside that stage's
  // dispatch branch; both the stage and the guard moved to MYT-54's
  // campaign-scoped character-integration-processor, so the equivalent
  // re-entry test belongs there (added in T10).
})
