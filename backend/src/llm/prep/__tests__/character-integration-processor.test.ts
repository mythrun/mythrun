// backend/src/llm/prep/__tests__/character-integration-processor.test.ts
//
// MYT-54 T11: BullMQ processor wrapper around T10's
// `runCharacterIntegrationStage` handler. The processor owns pipeline_runs
// bookkeeping (claim → run → mark) + the terminal-error classification that
// decides whether BullMQ should retry.
//
// Test style: real Postgres + a vi.spyOn on the handler module's
// `runCharacterIntegrationStage` export. The handler itself is unit-tested
// in stages/__tests__/character-integration.test.ts; this file pins the
// processor's lifecycle invariants without re-driving the full Opus pass.
//
// Seed shape is intentionally minimal: campaigns + worlds + a campaign-
// scoped pipeline_runs claim. No party / character_concepts seeding is
// needed because we stub the handler before it runs.

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
import type { Job } from 'bullmq'
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
  createCharacterIntegrationProcessor,
  processCharacterIntegrationJob,
  type CharacterIntegrationJobPayload,
  type CharacterIntegrationProcessorDeps,
} from '../character-integration-processor.js'
import * as integrationStage from '../stages/character-integration.js'
import {
  LlmStructuredOutputError,
  LlmRateLimitedError,
} from '../../errors.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: () => {
      // discard
    },
  }
  return pino(
    { base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } },
    sink,
  )
}

interface SeedResult {
  readonly campaignId: string
  readonly ownerUserId: string
  readonly worldId: string
}

function makeJob(
  payload: CharacterIntegrationJobPayload,
): Job<CharacterIntegrationJobPayload> {
  // The processor only reads `job.data`; the cast keeps the call shape
  // honest without instantiating a full BullMQ Job (which would require a
  // live queue connection).
  return { data: payload } as unknown as Job<CharacterIntegrationJobPayload>
}

interface MakeDepsOverrides {
  readonly publishEvent?: CharacterIntegrationProcessorDeps['publishEvent']
}

function makeDeps(
  pool: Pool,
  overrides: MakeDepsOverrides = {},
): CharacterIntegrationProcessorDeps {
  return {
    pool,
    publishEvent: overrides.publishEvent ?? (() => Promise.resolve()),
  }
}

describe('processCharacterIntegrationJob (MYT-54 T11)', () => {
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
    scope = makeTestScope('charintproc')
    userCounter = 0
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.restoreAllMocks()
    await cleanupTestScope(pool, scope)
  })

  // Minimal seed: owner user + world + campaign. character_concepts /
  // characters / campaign_members are not needed because we stub the
  // handler — the processor's claim/mark/publish path does not query them.
  async function seed(): Promise<SeedResult> {
    const ownerUserId = uuidv7()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    const n = userCounter++

    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [ownerUserId, scope.userSub(n), scope.displayName(n), scope.username(n)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status)
       VALUES ($1, $2, $3, 'A test concept', 'complete')`,
      [worldId, ownerUserId, scope.worldName(n)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, status)
       VALUES ($1, $2, $3, $4, 'setup')`,
      [campaignId, worldId, ownerUserId, scope.campaignName(n)],
    )

    return { campaignId, ownerUserId, worldId }
  }

  it('happy path: runs handler, marks pipeline_runs completed, publishes stage-completed', async () => {
    const { campaignId, ownerUserId } = await seed()
    const handlerSpy = vi
      .spyOn(integrationStage, 'runCharacterIntegrationStage')
      .mockResolvedValueOnce({
        llmCostUsd: 0.42,
        characterIds: ['e1', 'e2'],
      })

    const events: Record<string, unknown>[] = []
    const processor = createCharacterIntegrationProcessor(
      makeDeps(pool, {
        publishEvent: (cid, e) => {
          events.push({ campaignId: cid, ...e })
          return Promise.resolve()
        },
      }),
    )
    await processor(makeJob({ campaignId, ownerUserId }))

    expect(handlerSpy).toHaveBeenCalledTimes(1)
    // myth-gp2c Cluster C: the processor now builds a repo (createRepo(pool))
    // and passes it — the handler takes a Repo, not the raw pool. Assert the
    // repo shape (carries `.transaction`) + the unchanged args.
    const [repoArg, argsArg] = handlerSpy.mock.calls[0] ?? []
    expect(typeof (repoArg as { transaction?: unknown }).transaction).toBe('function')
    expect(argsArg).toEqual({ campaignId, ownerUserId })

    const runs = await pool.query<{ status: string; cost_usd: string }>(
      `SELECT status, cost_usd FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = 'character_integration'
          AND user_id IS NULL`,
      [campaignId],
    )
    expect(runs.rowCount).toBe(1)
    expect(runs.rows[0]?.status).toBe('completed')
    // cost_usd is NUMERIC(10,6) → pg returns a string; compare numerically.
    expect(Number(runs.rows[0]?.cost_usd)).toBeCloseTo(0.42, 6)

    const completed = events.find((e) => e.type === 'stage-completed')
    expect(completed).toBeDefined()
    expect(completed?.stage).toBe('character_integration')
    expect(completed?.costUsd).toBe(0.42)
  })

  it('idempotent re-entry: returns without invoking handler when pipeline_runs is already completed', async () => {
    const { campaignId, ownerUserId } = await seed()

    // Pre-seed the pipeline_runs row at 'completed' (simulates a prior
    // successful run that BullMQ then retried due to a downstream timeout).
    await pool.query(
      `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, completed_at, cost_usd, user_id)
       VALUES ($1, $2, 'character_integration', 'completed', now(), now(), 0.5, NULL)`,
      [uuidv7(), campaignId],
    )

    const handlerSpy = vi
      .spyOn(integrationStage, 'runCharacterIntegrationStage')
      .mockImplementation(() => {
        throw new Error('handler must not be called on idempotent re-entry')
      })
    const events: Record<string, unknown>[] = []

    await processCharacterIntegrationJob(
      makeDeps(pool, {
        publishEvent: (cid, e) => {
          events.push({ campaignId: cid, ...e })
          return Promise.resolve()
        },
      }),
      makeJob({ campaignId, ownerUserId }),
    )

    expect(handlerSpy).not.toHaveBeenCalled()
    expect(events).toHaveLength(0)
    // Row state unchanged — still completed, still $0.50.
    const runs = await pool.query<{ status: string; cost_usd: string }>(
      `SELECT status, cost_usd FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = 'character_integration'
          AND user_id IS NULL`,
      [campaignId],
    )
    expect(runs.rows[0]?.status).toBe('completed')
    expect(Number(runs.rows[0]?.cost_usd)).toBeCloseTo(0.5, 6)
  })

  it('non-terminal failure: marks row failed, publishes stage-failed{terminal:false}, RETHROWS for BullMQ retry', async () => {
    const { campaignId, ownerUserId } = await seed()
    vi.spyOn(integrationStage, 'runCharacterIntegrationStage').mockRejectedValueOnce(
      new LlmRateLimitedError('upstream 429'),
    )
    const events: Record<string, unknown>[] = []

    await expect(
      processCharacterIntegrationJob(
        makeDeps(pool, {
          publishEvent: (cid, e) => {
            events.push({ campaignId: cid, ...e })
            return Promise.resolve()
          },
        }),
        makeJob({ campaignId, ownerUserId }),
      ),
    ).rejects.toBeInstanceOf(LlmRateLimitedError)

    const runs = await pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = 'character_integration'
          AND user_id IS NULL`,
      [campaignId],
    )
    expect(runs.rows[0]?.status).toBe('failed')
    expect(runs.rows[0]?.error).toBe('upstream 429')

    const failed = events.find((e) => e.type === 'stage-failed')
    expect(failed).toBeDefined()
    expect(failed?.stage).toBe('character_integration')
    expect(failed?.message).toBe('upstream 429')
    expect(failed?.terminal).toBe(false)
  })

  it('terminal failure: marks row failed, publishes stage-failed{terminal:true}, does NOT rethrow', async () => {
    const { campaignId, ownerUserId } = await seed()
    vi.spyOn(integrationStage, 'runCharacterIntegrationStage').mockRejectedValueOnce(
      new LlmStructuredOutputError('schema repair chain exhausted'),
    )
    const events: Record<string, unknown>[] = []

    // Terminal errors must NOT rethrow (no BullMQ retry).
    await expect(
      processCharacterIntegrationJob(
        makeDeps(pool, {
          publishEvent: (cid, e) => {
            events.push({ campaignId: cid, ...e })
            return Promise.resolve()
          },
        }),
        makeJob({ campaignId, ownerUserId }),
      ),
    ).resolves.toBeUndefined()

    const runs = await pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = 'character_integration'
          AND user_id IS NULL`,
      [campaignId],
    )
    expect(runs.rows[0]?.status).toBe('failed')
    expect(runs.rows[0]?.error).toBe('schema repair chain exhausted')

    const failed = events.find((e) => e.type === 'stage-failed')
    expect(failed).toBeDefined()
    expect(failed?.terminal).toBe(true)
    expect(failed?.message).toBe('schema repair chain exhausted')
  })
})
