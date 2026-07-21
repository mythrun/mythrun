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
  handleCharacterCreationJobFailure,
  type CharacterCreationJobPayload,
  type CharacterCreationDeps,
  type CreateCharacterCreationProcessorDeps,
} from '../character-creation-processor.js'
import { LlmStructuredOutputError, LlmRateLimitedError } from '../../errors.js'

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

// A coherent LEVEL-1 sheet under MYT-90 A5's strengthened validateCoherence:
// con 14 → CON mod +2, hit_die 8 → HP band [10, 11] (hit_die + conMod floor);
// proficiency_bonus 2 (levels 1–4); a level-1 spell on a full caster (slot cap 1).
const VALID_SHEET = {
  str: 12,
  dex: 10,
  con: 14,
  int: 13,
  wis: 16,
  cha: 11,
  hit_points: 10,
  max_hit_points: 10,
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

// A coherent LEVEL-5 sheet for the starting_level=5 case: proficiency_bonus 3
// (level 5), and max_hit_points 38 inside the L5 band [22, 55] for hit_die 8 /
// CON mod +2. A level-1 spell stays within the full-caster L5 slot cap (3).
const VALID_SHEET_L5 = {
  ...VALID_SHEET,
  hit_points: 38,
  max_hit_points: 38,
  proficiency_bonus: 3,
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
  readonly stageTimeoutMs?: number
}

// Default cap matches migration 016's seeded $5.00. Tests exercising the
// cap-exceeded path override via `costCapUsd: <tight value>`.
function makeDeps(pool: Pool, overrides: MakeDepsOverrides = {}): CharacterCreationDeps {
  return {
    pool,
    costCapUsd: overrides.costCapUsd ?? 5.0,
    publishEvent: overrides.publishEvent ?? (() => Promise.resolve()),
    ...(overrides.stageTimeoutMs !== undefined
      ? { stageTimeoutMs: overrides.stageTimeoutMs }
      : {}),
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
    // starting_level is set here (not left NULL) to model the A3 submit gate,
    // which REQUIRES a party-wide level before any character job is enqueued.
    // Level 1 mirrors the historical default; the level-injection test below
    // overrides it to 5. The fail-loud test nulls it back out on purpose.
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, starting_situation_index, starting_level)
       VALUES ($1, $2, $3, $4, 0, 1)`,
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

    // MYT-90 A8: on completion the processor emits a typed, per-user
    // `character_creation_complete` event (carrying userId) — the FE loading
    // beat filters it to swap to the character reveal. This REPLACES the old
    // untyped `{ type: 'phase', phase: 'character_creation_complete' }` emit,
    // which the PipelineEvent contract never modelled and which carried the
    // completion signal in an unfiltered-by-user `phase` field.
    const completion = events.filter((e) => e.type === 'character_creation_complete')
    expect(completion).toHaveLength(1)
    expect(completion[0]).toMatchObject({
      type: 'character_creation_complete',
      userId,
    })
    // The legacy untyped phase emit is gone: no event carries the completion
    // signal in a `phase` field anymore.
    expect(events.some((e) => e.phase === 'character_creation_complete')).toBe(false)
  })

  it('injects campaign.starting_level into the persisted character AND the sheet prompt (ZFC: deterministic level, not the LLM echo)', async () => {
    const { userId, campaignId } = await seed()
    // Owner picked a party-wide starting level of 5 (migration 033). The seed
    // above sets starting_level = 1; override it to 5 for this case.
    await pool.query(`UPDATE campaigns SET starting_level = 5 WHERE id = $1`, [campaignId])
    // The concept mock (VALID_CONCEPT) deliberately echoes level 1 — the
    // processor must OVERRIDE it from campaign.starting_level, never trust
    // the LLM's echoed level. The sheet mock must be LEVEL-5-coherent
    // (proficiency_bonus 3, HP in the L5 band) because the sheet stage
    // validates against the overridden narrative.level (5), not the echo.
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_CONCEPT,
      finishReason: 'stop',
      usage: { inputTokens: 1500, outputTokens: 1200, totalTokens: 2700 },
    } as never)
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_SHEET_L5,
      finishReason: 'stop',
      usage: { inputTokens: 2000, outputTokens: 2000, totalTokens: 4000 },
    } as never)

    await runCharacterCreationJob(makeDeps(pool), makeJob(campaignId, userId))

    // Invariant: persisted character.level == campaign.starting_level.
    const character = await pool.query<{ level: number }>(
      `SELECT c.level FROM characters c
         JOIN campaign_characters cc ON cc.character_id = c.id
        WHERE cc.campaign_id = $1 AND cc.user_id = $2`,
      [campaignId, userId],
    )
    expect(character.rows[0]?.level).toBe(5)

    // The override happens BEFORE setConceptOutput, so the persisted concept
    // narrative (read by MYT-54's campaign-scoped integration) carries the
    // overridden level 5, not the echoed 1.
    const concept = await pool.query<{ concept_output: { level: number } | null }>(
      `SELECT concept_output FROM character_concepts
        WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(concept.rows[0]?.concept_output?.level).toBe(5)

    // The sheet-stage prompt (the 2nd generateText call — location_selection
    // makes no LLM call, concept is call[0], sheet is call[1]) rendered
    // {{level}} = 5.
    const sheetPrompt = mockGenerateText.mock.calls[1]?.[0]?.prompt as string | undefined
    expect(sheetPrompt).toContain('level-5')
  })

  it('fails loud when campaign.starting_level is null (A3 submit-gate invariant)', async () => {
    // The A3 submit gate guarantees starting_level is non-null before any
    // character job is enqueued, so a null here is a broken invariant — not a
    // degraded-but-playable path. Silently substituting level 1 would violate
    // `persisted character.level == campaign.starting_level`, so the processor
    // must throw instead. Null out the level the seed set to model the bug.
    const { userId, campaignId } = await seed()
    await pool.query(`UPDATE campaigns SET starting_level = NULL WHERE id = $1`, [campaignId])
    // No LLM mocks: the null-check throws before any stage runs.
    await expect(
      runCharacterCreationJob(makeDeps(pool), makeJob(campaignId, userId)),
    ).rejects.toThrow(/has no starting_level/)

    // The job aborted before stage 3 — no character was persisted (a silent
    // level-1 character is exactly the failure mode this guard prevents).
    const characters = await pool.query<{ id: string }>(
      `SELECT c.id FROM characters c
       JOIN campaign_characters cc ON cc.character_id = c.id
       WHERE cc.campaign_id = $1 AND cc.user_id = $2`,
      [campaignId, userId],
    )
    expect(characters.rowCount).toBe(0)
    // No LLM calls fired — the throw preempts the stage loop.
    expect(mockGenerateText).not.toHaveBeenCalled()
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

    // stage-failed event published with willRetry: false. MYT-102 A4: the
    // failure identifier rides `errorCode` (the PipelineEvent contract field —
    // what world-gen and the dev-tool live-events panel already use), NOT the
    // drifted `reason` the processor used to emit.
    const stageFailed = events.find((e) => e.type === 'stage-failed')
    expect(stageFailed).toBeDefined()
    expect(stageFailed?.willRetry).toBe(false)
    expect(stageFailed?.errorCode).toBe('llm_structured_output_failed')
    expect(stageFailed?.reason).toBeUndefined()
  })

  it('a TRANSIENT (non-terminal) stage error publishes willRetry:true and RETHROWS (BullMQ attempts:2)', async () => {
    // A rate-limit / overload is non-terminal: the stage marks the pipeline_runs
    // row failed, publishes stage-failed with willRetry:true, and RETHROWS so
    // BullMQ's attempts:2 policy fires. Distinct from the terminal path, it does
    // NOT flip the concept row to 'failed' (a retry may still succeed), so the
    // player stays on the loading beat rather than seeing a premature failure.
    const { userId, campaignId } = await seed()
    // Stage 2 (character_concept) throws a TRANSIENT error (terminal:false).
    mockGenerateText.mockRejectedValueOnce(new LlmRateLimitedError('upstream rate limited: 429'))

    const events: Record<string, unknown>[] = []
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
    ).rejects.toThrow(/rate limited/)

    // The pipeline_runs row for the failed stage is marked failed…
    const run = await pool.query<{ status: string }>(
      `SELECT status FROM pipeline_runs
        WHERE campaign_id = $1 AND user_id = $2 AND stage = 'character_concept'`,
      [campaignId, userId],
    )
    expect(run.rows[0]?.status).toBe('failed')

    // …but the CONCEPT stays 'processing' (non-terminal — a BullMQ retry may yet
    // succeed; only exhaustion, handled by the 'failed' listener, flips it).
    const concept = await pool.query<{ status: string }>(
      `SELECT status FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(concept.rows[0]?.status).toBe('processing')

    // stage-failed event with willRetry:true + the sanitized errorCode.
    const stageFailed = events.find((e) => e.type === 'stage-failed')
    expect(stageFailed).toBeDefined()
    expect(stageFailed?.willRetry).toBe(true)
    expect(stageFailed?.errorCode).toBe('llm_rate_limited')
    expect(stageFailed?.reason).toBeUndefined()
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

    // stage-failed event for the cap — identifier on `errorCode` (contract
    // field), not the drifted `reason` (MYT-102 A4).
    const capFailed = events.find(
      (e) =>
        e.type === 'stage-failed' &&
        e.errorCode === 'character_creation_cost_cap_exceeded',
    )
    expect(capFailed).toBeDefined()
    expect(capFailed?.reason).toBeUndefined()
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

  it('stage-3 re-entry without ctx.conceptOutput is TERMINAL: flips the concept to failed, no futile retry (playtest 2026-07-18)', async () => {
    // Setup: pre-insert pipeline_runs for stage 2 as 'completed'. On
    // re-entry, atomicClaimStage skips stage 2; ctx.conceptOutput stays
    // null; stage 3's re-entry guard fires. The output is UNRECOVERABLE —
    // "player must resubmit" is definitionally terminal, so it must NOT be
    // retried futilely: it flips the CONCEPT to 'failed' (so the player sees
    // the failed state + can resubmit) and returns cleanly (no rethrow).
    // Regression: this path shipped mis-classified as non-terminal — it
    // rethrew, BullMQ retried the unrecoverable job, and the concept stayed
    // 'processing' FOREVER (a character stuck on the loading beat with no
    // recovery; found live in a 3-player playtest).
    const { userId, campaignId } = await seed()
    await pool.query(
      `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, completed_at, user_id, cost_usd, input_tokens, output_tokens)
       VALUES ($1, $2, 'character_concept', 'completed', now(), now(), $3, 0.02, 100, 50)`,
      [uuidv7(), campaignId, userId],
    )
    const events: Record<string, unknown>[] = []
    // Terminal → returns cleanly (BullMQ sees success; no retry of the
    // unrecoverable job).
    await runCharacterCreationJob(
      makeDeps(pool, {
        publishEvent: (cid, e) => {
          events.push({ campaignId: cid, ...e })
          return Promise.resolve()
        },
      }),
      makeJob(campaignId, userId),
    )
    const sheetRow = await pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM pipeline_runs
       WHERE campaign_id = $1 AND user_id = $2 AND stage = 'character_sheet'`,
      [campaignId, userId],
    )
    expect(sheetRow.rows[0]?.status).toBe('failed')
    expect(sheetRow.rows[0]?.error).toMatch(/re-entry without ctx.conceptOutput/)
    // THE FIX: the CONCEPT flips to 'failed' so the player can resubmit
    // (previously it stayed 'processing' forever).
    const concept = await pool.query<{ status: string }>(
      `SELECT status FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(concept.rows[0]?.status).toBe('failed')
    // Terminal stage-failed: willRetry:false (the job is not re-attempted).
    const stageFailed = events.find(
      (e) => e.type === 'stage-failed' && e.stage === 'character_sheet',
    )
    expect(stageFailed).toBeDefined()
    expect(stageFailed?.willRetry).toBe(false)
    expect(stageFailed?.errorCode).toBe('stage_failed')
  })

  // MYT-54 T3 removed the per-player 'character_integration' stage. The
  // legacy "throws on stage 4 re-entry without ctx.characterId or
  // ctx.conceptOutput" test exercised a re-entry guard inside that stage's
  // dispatch branch; both the stage and the guard moved to MYT-54's
  // campaign-scoped character-integration-processor, so the equivalent
  // re-entry test belongs there (added in T10).

  // -------------------------------------------------------------------------
  // myth-3u4a0: per-stage watchdog (was MYT-102 A1, non-terminal). Staging
  // evidence: a job completed two Sonnet calls then awaited SOMETHING forever —
  // worker task alive, BullMQ lock renewing, zero further logs. The watchdog
  // bounds every stage execution with a wall-clock timeout. myth-3u4a0 makes the
  // trip TERMINAL (`{ terminal: true }`, code 'job_timeout'): the concept flips
  // to 'failed' at once so the player resubmits, rather than waiting out a futile
  // BullMQ retry of a hang. `withJobTimeout` is the shared timeout primitive.
  // -------------------------------------------------------------------------

  it('watchdog: a never-resolving stage fails TERMINAL (concept → failed, no futile retry) instead of hanging', async () => {
    const { userId, campaignId } = await seed()
    // Stage 2's Sonnet call never settles — models the staging hang.
    mockGenerateText.mockReturnValueOnce(new Promise(() => undefined) as never)

    const events: Record<string, unknown>[] = []
    // Terminal → runCharacterCreationJob RESOLVES (returns cleanly after the
    // inline markFailed); it does NOT rethrow, so BullMQ sees no retry.
    await runCharacterCreationJob(
      makeDeps(pool, {
        stageTimeoutMs: 50,
        publishEvent: (cid, e) => {
          events.push({ campaignId: cid, ...e })
          return Promise.resolve()
        },
      }),
      makeJob(campaignId, userId),
    )

    // The hung stage's pipeline_runs row is marked failed, and the failure is
    // TERMINAL: stage-failed carries willRetry:false + the job_timeout code.
    const run = await pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM pipeline_runs
        WHERE campaign_id = $1 AND user_id = $2 AND stage = 'character_concept'`,
      [campaignId, userId],
    )
    expect(run.rows[0]?.status).toBe('failed')
    expect(run.rows[0]?.error).toMatch(/character-creation stage 'character_concept' exceeded 50ms/)

    const stageFailed = events.find(
      (e) => e.type === 'stage-failed' && e.stage === 'character_concept',
    )
    expect(stageFailed).toBeDefined()
    expect(stageFailed?.willRetry).toBe(false)
    expect(stageFailed?.errorCode).toBe('job_timeout')

    // THE FIX: the concept flips to 'failed' so the player sees the failure and
    // can resubmit — previously it stayed 'processing' waiting out a retry.
    const concept = await pool.query<{ status: string }>(
      `SELECT status FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(concept.rows[0]?.status).toBe('failed')
  })

  // -------------------------------------------------------------------------
  // myth-3u4a0: whole-JOB backstop at the processor factory. The per-stage
  // watchdog covers `runStage`; this outer cap bounds the orchestration-loop
  // awaits it does not — so a wedge anywhere in the job can't renew the lock
  // forever. It throws the same terminal `{ terminal: true }` shape.
  // -------------------------------------------------------------------------

  it('whole-job watchdog: the factory bounds a job that hangs on its FIRST orchestration await', async () => {
    // A pool whose every query hangs — models a wedged DB/Redis await that is
    // NOT inside a stage watchdog (the exact gap the whole-job cap closes). The
    // job stalls on its first orchestration await (the cost-cap read) forever;
    // the factory's whole-job watchdog is the only thing that can end it.
    const hangingPool = { query: () => new Promise(() => undefined) } as unknown as Pool
    const processor = createCharacterCreationProcessor({
      pool: hangingPool,
      costCapUsd: 5,
      publishEvent: () => Promise.resolve(),
      jobTotalTimeoutMs: 30,
    })

    await expect(
      processor(makeJob('camp-hang', 'user-hang') as never),
    ).rejects.toMatchObject({ terminal: true, code: 'job_timeout' })
  })
})

// ---------------------------------------------------------------------------
// MYT-102 A2: exhausted-transient surfacing. A transient stage failure
// rethrows so BullMQ retries (attempts:2) — but when the LAST attempt fails,
// nothing used to flip the concept off 'processing', stranding the player
// forever. The worker's 'failed' listener calls
// handleCharacterCreationJobFailure, which (only on exhaustion) marks the
// concept failed + publishes a terminal stage-failed.
// ---------------------------------------------------------------------------

describe('handleCharacterCreationJobFailure', () => {
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
    scope = makeTestScope('charccfail')
    userCounter = 0
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  async function seedConcept(): Promise<{ userId: string; campaignId: string }> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    const n = userCounter++
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(n), scope.displayName(n), scope.username(n)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status)
       VALUES ($1, $2, $3, 'A test concept', 'complete')`,
      [worldId, userId, scope.worldName(n)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, starting_level)
       VALUES ($1, $2, $3, $4, 1)`,
      [campaignId, worldId, userId, scope.campaignName(n)],
    )
    // character_concepts FKs (campaign_id, user_id) → campaign_members.
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'owner', true)`,
      [uuidv7(), campaignId, userId],
    )
    await pool.query(
      `INSERT INTO character_concepts (
         id, campaign_id, user_id, concept_text, situation_grounding_text,
         guided_choices, status
       )
       VALUES ($1, $2, $3, 'A road-weary cleric searching for an old companion',
               'arrived at the tavern as the storm broke', '{}'::jsonb, 'processing')`,
      [uuidv7(), campaignId, userId],
    )
    return { userId, campaignId }
  }

  interface FailedJobOverrides {
    readonly name?: string
    readonly attemptsMade?: number
    readonly attempts?: number
    readonly data?: unknown
    readonly progress?: unknown
  }

  function failedJob(
    campaignId: string,
    userId: string,
    over: FailedJobOverrides = {},
  ): {
    name: string
    data: unknown
    attemptsMade: number
    opts: { attempts?: number }
    progress: unknown
  } {
    return {
      name: over.name ?? 'character-creation',
      data: over.data ?? { campaignId, userId },
      attemptsMade: over.attemptsMade ?? 2,
      opts: { attempts: over.attempts ?? 2 },
      // `in` (not ??) so an explicit `progress: null` override survives.
      progress: 'progress' in over ? over.progress : { stage: 'character_concept', userId },
    }
  }

  function makeFailureDeps(): {
    deps: Parameters<typeof handleCharacterCreationJobFailure>[0]
    events: Record<string, unknown>[]
    errorLog: ReturnType<typeof vi.fn>
  } {
    const events: Record<string, unknown>[] = []
    const errorLog = vi.fn()
    return {
      deps: {
        pool,
        publishEvent: (cid: string, e: Record<string, unknown>) => {
          events.push({ campaignId: cid, ...e })
          return Promise.resolve()
        },
        logger: { error: errorLog },
      },
      events,
      errorLog,
    }
  }

  it('marks the concept failed + publishes terminal stage-failed when attempts are exhausted', async () => {
    const { userId, campaignId } = await seedConcept()
    const { deps, events, errorLog } = makeFailureDeps()

    await handleCharacterCreationJobFailure(
      deps,
      failedJob(campaignId, userId),
      new LlmRateLimitedError('upstream rate limited: 429'),
    )

    const concept = await pool.query<{ status: string; error: { code?: string } | null }>(
      `SELECT status, error FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(concept.rows[0]?.status).toBe('failed')
    expect(concept.rows[0]?.error?.code).toBe('llm_rate_limited')

    // Terminal stage-failed on the pipeline channel, errorCode field (contract).
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      campaignId,
      type: 'stage-failed',
      stage: 'character_concept',
      userId,
      willRetry: false,
      errorCode: 'llm_rate_limited',
    })

    // Loud log so the exhaustion is grep-able from worker logs.
    expect(errorLog).toHaveBeenCalledTimes(1)
  })

  it('no-ops while BullMQ retries remain (attemptsMade < attempts)', async () => {
    const { userId, campaignId } = await seedConcept()
    const { deps, events } = makeFailureDeps()

    await handleCharacterCreationJobFailure(
      deps,
      failedJob(campaignId, userId, { attemptsMade: 1, attempts: 2 }),
      new LlmRateLimitedError('upstream rate limited: 429'),
    )

    const concept = await pool.query<{ status: string }>(
      `SELECT status FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(concept.rows[0]?.status).toBe('processing')
    expect(events).toHaveLength(0)
  })

  it('ignores character-integration jobs and undefined jobs', async () => {
    const { userId, campaignId } = await seedConcept()
    const { deps, events } = makeFailureDeps()

    await handleCharacterCreationJobFailure(
      deps,
      failedJob(campaignId, userId, { name: 'character-integration' }),
      new Error('integration exhausted'),
    )
    await handleCharacterCreationJobFailure(deps, undefined, new Error('no job'))

    const concept = await pool.query<{ status: string }>(
      `SELECT status FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(concept.rows[0]?.status).toBe('processing')
    expect(events).toHaveLength(0)
  })

  it('is idempotent when the concept row is already failed', async () => {
    const { userId, campaignId } = await seedConcept()
    await pool.query(
      `UPDATE character_concepts SET status = 'failed', error = '{"code":"prior"}'::jsonb
        WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    const { deps, events } = makeFailureDeps()

    await handleCharacterCreationJobFailure(
      deps,
      failedJob(campaignId, userId),
      new LlmRateLimitedError('upstream rate limited: 429'),
    )

    const concept = await pool.query<{ status: string }>(
      `SELECT status FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(concept.rows[0]?.status).toBe('failed')
    // Still publishes (SSE consumers may have missed the first) — the row
    // write is the idempotent part.
    expect(events).toHaveLength(1)
  })

  it('never unwinds a completed concept (stale failed event after a successful re-run)', async () => {
    const { userId, campaignId } = await seedConcept()
    await pool.query(
      `UPDATE character_concepts SET status = 'completed', error = NULL
        WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    const { deps, events } = makeFailureDeps()

    await handleCharacterCreationJobFailure(
      deps,
      failedJob(campaignId, userId),
      new LlmRateLimitedError('upstream rate limited: 429'),
    )

    const concept = await pool.query<{ status: string }>(
      `SELECT status FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(concept.rows[0]?.status).toBe('completed')
    expect(events).toHaveLength(0)
  })

  it('falls back to a job-level stage label when progress carries no stage', async () => {
    const { userId, campaignId } = await seedConcept()
    const { deps, events } = makeFailureDeps()

    // BullMQ default progress is 0 (never updated) — e.g. a job that failed
    // before the first stage claim. A null progress (defensive) falls back the
    // same way.
    await handleCharacterCreationJobFailure(
      deps,
      failedJob(campaignId, userId, { progress: 0 }),
      new LlmRateLimitedError('upstream rate limited: 429'),
    )
    await handleCharacterCreationJobFailure(
      deps,
      failedJob(campaignId, userId, { progress: null }),
      new LlmRateLimitedError('upstream rate limited: 429'),
    )

    expect(events).toHaveLength(2)
    expect(events[0]?.stage).toBe('character_creation')
    expect(events[1]?.stage).toBe('character_creation')
  })

  it('skips silently when no concept row exists for the payload ids', async () => {
    const { deps, events, errorLog } = makeFailureDeps()

    await handleCharacterCreationJobFailure(
      deps,
      failedJob(uuidv7(), uuidv7()),
      new LlmRateLimitedError('upstream rate limited: 429'),
    )

    expect(events).toHaveLength(0)
    expect(errorLog).not.toHaveBeenCalled()
  })

  it('applies BullMQ’s default attempts:1 when opts carries no attempts', async () => {
    const { userId, campaignId } = await seedConcept()
    const { deps, events } = makeFailureDeps()

    await handleCharacterCreationJobFailure(
      deps,
      {
        name: 'character-creation',
        data: { campaignId, userId },
        attemptsMade: 1,
        opts: {},
        progress: { stage: 'character_concept', userId },
      },
      new LlmRateLimitedError('upstream rate limited: 429'),
    )

    // attempts defaults to 1 → attemptsMade:1 is exhaustion.
    expect(events).toHaveLength(1)
    const concept = await pool.query<{ status: string }>(
      `SELECT status FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(concept.rows[0]?.status).toBe('failed')
  })

  it('never throws on a malformed payload — logs and returns', async () => {
    const { deps, events, errorLog } = makeFailureDeps()

    // Non-string campaignId (data null) and non-string userId each hit the
    // bad-payload log-and-return.
    await expect(
      handleCharacterCreationJobFailure(
        deps,
        failedJob('x', 'y', { data: null }),
        new Error('boom'),
      ),
    ).resolves.toBeUndefined()
    await expect(
      handleCharacterCreationJobFailure(
        deps,
        failedJob('x', 'y', { data: { campaignId: uuidv7(), userId: 42 } }),
        new Error('boom'),
      ),
    ).resolves.toBeUndefined()

    expect(events).toHaveLength(0)
    expect(errorLog).toHaveBeenCalledTimes(2)
  })

  it('never throws when a dep fails mid-surfacing — catches and logs', async () => {
    const { userId, campaignId } = await seedConcept()
    const errorLog = vi.fn()
    const deps = {
      pool,
      publishEvent: () => Promise.reject(new Error('redis down')),
      logger: { error: errorLog },
    }

    await expect(
      handleCharacterCreationJobFailure(
        deps,
        failedJob(campaignId, userId),
        new LlmRateLimitedError('upstream rate limited: 429'),
      ),
    ).resolves.toBeUndefined()

    // The markFailed write landed before the publish blew up; the handler
    // logged the surfacing failure instead of throwing into the emitter.
    const concept = await pool.query<{ status: string }>(
      `SELECT status FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(concept.rows[0]?.status).toBe('failed')
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'character_creation.job_failed_handler_error' }),
      expect.any(String),
    )
  })
})
