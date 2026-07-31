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
import * as retrievalModule from '../../../world/retrieval/index.js'
import * as repoModule from '../../../repo/index.js'
import { logger } from '../../logger.js'
import {
  LlmStructuredOutputError,
  LlmRateLimitedError,
} from '../../errors.js'

// MYT-71 T11: the embed post-pass calls embedWorld through the retrieval barrel.
// Mock it at the module boundary so no test hits real Voyage — the post-pass is
// the unit under test, not the embed write-path (that has its own T9 tests).
vi.mock('../../../world/retrieval/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../world/retrieval/index.js')>()
  return { ...actual, embedWorld: vi.fn() }
})

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
    // The embed post-pass (MYT-71 T11) builds a Voyage embedder from this key,
    // but embedWorld is mocked at the module boundary so it is never invoked.
    voyageApiKey: 'pa-test-voyage-key',
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
    // Default the mocked embedWorld to a clean, no-op summary so the happy-path
    // post-pass logs successfully; individual tests override as needed.
    vi.mocked(retrievalModule.embedWorld).mockResolvedValue({
      embedded: 0,
      leftNull: 0,
      voyageErrors: 0,
    })
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

  it("llm-outage-resilience §3.2 (Task 9): STOPS with a retryable throw on an in-flight (running, not stuck) claim", async () => {
    const { campaignId, ownerUserId } = await seed()
    // A live (not-stuck) character_integration row — e.g. BullMQ's stall
    // handling re-drove a dead worker's job while another container genuinely
    // runs the stage. Falling through would double-run it; returning cleanly
    // (the old 'lost-race' lumping) would let a stall re-drive complete the
    // job with the stage unfinished.
    await pool.query(
      `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, user_id)
       VALUES ($1, $2, 'character_integration', 'running', now(), NULL)`,
      [uuidv7(), campaignId],
    )
    const handlerSpy = vi
      .spyOn(integrationStage, 'runCharacterIntegrationStage')
      .mockImplementation(() => {
        throw new Error('handler must not be called past an in-flight claim')
      })

    await expect(
      processCharacterIntegrationJob(makeDeps(pool), makeJob({ campaignId, ownerUserId })),
    ).rejects.toMatchObject({ code: 'stage_in_flight' })
    expect(handlerSpy).not.toHaveBeenCalled()
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

  // ── MYT-71 T11: embed post-pass ─────────────────────────────────────────
  // After a SUCCESSFUL integration, the processor embeds the world's NULL rows
  // (the new PC-backstory facts character-integration inserted ship NULL-
  // embedded) so the world stays searchable. The post-pass is TOTAL: a Voyage
  // error must NOT fail the already-committed + already-published integration.

  it('embed post-pass: after success, calls embedWorld(NULL-only) with the resolved worldId', async () => {
    const { campaignId, ownerUserId, worldId } = await seed()
    vi.spyOn(integrationStage, 'runCharacterIntegrationStage').mockResolvedValueOnce({
      llmCostUsd: 0.1,
      characterIds: ['e1'],
    })

    await processCharacterIntegrationJob(
      makeDeps(pool),
      makeJob({ campaignId, ownerUserId }),
    )

    // embedWorld called exactly once, against the campaign's real world_id.
    expect(retrievalModule.embedWorld).toHaveBeenCalledTimes(1)
    const call = vi.mocked(retrievalModule.embedWorld).mock.calls[0]
    expect(call?.[1]).toBe(worldId)
    // opts omitted → NULL-only embed (no force; the post-pass never re-embeds).
    expect(call?.[2]).toBeUndefined()
    // deps carry an embedder + the repo (the embedWorld EmbedDeps shape).
    const depsArg = call?.[0]
    expect(typeof depsArg?.embedder.embedDocuments).toBe('function')
    expect(typeof (depsArg?.repo as { transaction?: unknown }).transaction).toBe('function')

    // Stage still marked completed (the post-pass runs AFTER markStageCompleted).
    const runs = await pool.query<{ status: string }>(
      `SELECT status FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = 'character_integration'
          AND user_id IS NULL`,
      [campaignId],
    )
    expect(runs.rows[0]?.status).toBe('completed')
  })

  it('embed post-pass is TOTAL: an embedWorld throw does NOT fail the job and the stage stays completed', async () => {
    const { campaignId, ownerUserId } = await seed()
    vi.spyOn(integrationStage, 'runCharacterIntegrationStage').mockResolvedValueOnce({
      llmCostUsd: 0.1,
      characterIds: ['e1'],
    })
    vi.mocked(retrievalModule.embedWorld).mockRejectedValueOnce(
      new Error('voyage 503'),
    )

    // The job must resolve cleanly — the integration is already committed +
    // published; a Voyage failure here is non-fatal.
    await expect(
      processCharacterIntegrationJob(
        makeDeps(pool),
        makeJob({ campaignId, ownerUserId }),
      ),
    ).resolves.toBeUndefined()

    // The stage was marked completed BEFORE the post-pass ran, so the failing
    // embed must not have flipped it back to 'failed'.
    const runs = await pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = 'character_integration'
          AND user_id IS NULL`,
      [campaignId],
    )
    expect(runs.rows[0]?.status).toBe('completed')
    expect(runs.rows[0]?.error).toBeNull()
  })

  it('embed post-pass escalates a CONFIG-class summary to an ERROR log (misconfigured); job still completes', async () => {
    const { campaignId, ownerUserId, worldId } = await seed()
    vi.spyOn(integrationStage, 'runCharacterIntegrationStage').mockResolvedValueOnce({
      llmCostUsd: 0.1,
      characterIds: ['e1'],
    })
    // The post-pass embed reports a CONFIG-class Voyage failure (a misconfigured
    // key/model/dim that affects every world) — this must escalate LOUDLY at
    // ERROR, distinct from a transient degrade, while the job still completes.
    vi.mocked(retrievalModule.embedWorld).mockResolvedValueOnce({
      embedded: 0,
      leftNull: 25,
      voyageErrors: 1,
      configErrorKind: 'dim_mismatch',
    })
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger)

    await expect(
      processCharacterIntegrationJob(
        makeDeps(pool),
        makeJob({ campaignId, ownerUserId }),
      ),
    ).resolves.toBeUndefined()

    // Escalated at ERROR with the misconfigured event + the full summary.
    const misconfigCall = errorSpy.mock.calls.find(
      (c) => (c[0] as { event?: string }).event === 'character_integration.embed_misconfigured',
    )
    expect(misconfigCall).toBeDefined()
    expect(misconfigCall?.[0]).toMatchObject({
      event: 'character_integration.embed_misconfigured',
      campaignId,
      worldId,
      embedded: 0,
      leftNull: 25,
      voyageErrors: 1,
      configErrorKind: 'dim_mismatch',
    })

    // The job still completed (the post-pass escalation is non-fatal).
    const runs = await pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = 'character_integration'
          AND user_id IS NULL`,
      [campaignId],
    )
    expect(runs.rows[0]?.status).toBe('completed')
    expect(runs.rows[0]?.error).toBeNull()
  })

  it('embed post-pass logs a transient degrade at WARN (voyageErrors>0, no config); job still completes', async () => {
    const { campaignId, ownerUserId, worldId } = await seed()
    vi.spyOn(integrationStage, 'runCharacterIntegrationStage').mockResolvedValueOnce({
      llmCostUsd: 0.1,
      characterIds: ['e1'],
    })
    // A transient Voyage blip (no config error): rows left NULL, backfill will
    // recover. This must log at WARN with the degraded event — distinct from the
    // alarmable misconfigured ERROR.
    vi.mocked(retrievalModule.embedWorld).mockResolvedValueOnce({
      embedded: 5,
      leftNull: 3,
      voyageErrors: 1,
    })
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger)

    await expect(
      processCharacterIntegrationJob(
        makeDeps(pool),
        makeJob({ campaignId, ownerUserId }),
      ),
    ).resolves.toBeUndefined()

    const degradedCall = warnSpy.mock.calls.find(
      (c) => (c[0] as { event?: string }).event === 'character_integration.embed_degraded',
    )
    expect(degradedCall).toBeDefined()
    expect(degradedCall?.[0]).toMatchObject({
      event: 'character_integration.embed_degraded',
      campaignId,
      worldId,
      embedded: 5,
      leftNull: 3,
      voyageErrors: 1,
    })
    // No ERROR-level misconfigured escalation on a transient degrade.
    expect(
      errorSpy.mock.calls.find(
        (c) => (c[0] as { event?: string }).event === 'character_integration.embed_misconfigured',
      ),
    ).toBeUndefined()

    const runs = await pool.query<{ status: string }>(
      `SELECT status FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = 'character_integration'
          AND user_id IS NULL`,
      [campaignId],
    )
    expect(runs.rows[0]?.status).toBe('completed')
  })

  it('embed post-pass does NOT run on the terminal-failure path (embedWorld never called)', async () => {
    const { campaignId, ownerUserId } = await seed()
    vi.spyOn(integrationStage, 'runCharacterIntegrationStage').mockRejectedValueOnce(
      new LlmStructuredOutputError('schema repair chain exhausted'),
    )

    await expect(
      processCharacterIntegrationJob(
        makeDeps(pool),
        makeJob({ campaignId, ownerUserId }),
      ),
    ).resolves.toBeUndefined()

    // The post-pass lives inside the success block; a terminal failure short-
    // circuits before it, so embedWorld is never invoked.
    expect(retrievalModule.embedWorld).not.toHaveBeenCalled()
  })

  it('embed post-pass skips (no embedWorld) when getWorldId returns null', async () => {
    // pipeline_runs FKs campaign_id → campaigns, so a real campaign must exist
    // for the claim/mark writes. getWorldId only returns null for an absent
    // campaign — unreachable with a seeded row. Cover the `worldId === null`
    // arm by wrapping the real repo and overriding campaigns.getWorldId → null;
    // every other repo method stays real (real claim/mark against Postgres).
    const { campaignId, ownerUserId } = await seed()
    vi.spyOn(integrationStage, 'runCharacterIntegrationStage').mockResolvedValueOnce({
      llmCostUsd: 0.1,
      characterIds: ['e1'],
    })
    // Capture the original factory BEFORE spying so the wrapper can delegate.
    const realCreateRepo = repoModule.createRepo
    vi.spyOn(repoModule, 'createRepo').mockImplementation((pgPool) => {
      const real = realCreateRepo(pgPool)
      return {
        ...real,
        campaigns: { ...real.campaigns, getWorldId: () => Promise.resolve(null) },
      }
    })

    await processCharacterIntegrationJob(
      makeDeps(pool),
      makeJob({ campaignId, ownerUserId }),
    )

    expect(retrievalModule.embedWorld).not.toHaveBeenCalled()
  })
})
