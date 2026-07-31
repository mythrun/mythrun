// backend/src/llm/prep/__tests__/prep-queue-events.test.ts
//
// llm-outage-resilience §3.2 (Task 9) — the broker-side terminal-failure
// recovery for the three prep queues (MYT-67 session-turn precedent).
//
// The prep queues keep `removeOnFail: {count: 0}`, so a broker `failed`
// event is BOTH terminal (BullMQ emits it only from moveToFinished /
// the maxStalledCount exhaustion — retryable attempts go through
// retryJob/moveToDelayed and emit no `failed`) AND job-gone by
// construction. The handlers therefore operate from the event's jobId
// alone — parsed at FIXED UUID WIDTHS, never split('-'), never getJob —
// cross-checked against llm_resume_stamps: a stamp (armed OR in-flight)
// with a terminally-gone job is a stranded run no wake will ever
// re-drive, so the handler marks the entity failed via that pipeline's
// existing terminal path and clears the stamp.
//
// Handler tests run against real Postgres (constructed state); the
// builder test mocks bullmq to capture the QueueEvents wiring, mirroring
// session-turn-queue-events.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { guardTestDatabase } from '../../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../../repo/__tests__/_helpers/test-pool.js'
import { createRepo } from '../../../repo/index.js'
import type { PipelineEvent } from '../../../contract/pipeline-events.js'
import {
  buildPrepQueueEvents,
  handleCharacterCreationTerminalFailure,
  handleSessionPrepTerminalFailure,
  handleWorldGenTerminalFailure,
  type PrepTerminalRecoveryDeps,
} from '../prep-queue-events.js'

// The builder test captures QueueEvents registrations without a broker.
const captured: {
  instances: { queueName: string; handlers: Map<string, (args: unknown) => unknown> }[]
  queueEventsClosed: number
} = { instances: [], queueEventsClosed: 0 }

vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>()
  return {
    ...actual,
    QueueEvents: vi.fn().mockImplementation((queueName: string) => {
      const handlers = new Map<string, (args: unknown) => unknown>()
      captured.instances.push({ queueName, handlers })
      return {
        on: (event: string, handler: (args: unknown) => unknown) => {
          handlers.set(event, handler)
        },
        close: () => {
          captured.queueEventsClosed += 1
          return Promise.resolve()
        },
      }
    }),
  }
})

const databaseUrl = process.env.DATABASE_URL ?? ''

function recordingLogger(): {
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe('prep-queue-events (llm-outage-resilience §3.2, Task 9)', () => {
  let pool: Pool
  let scope: TestScope
  let userCounter: number

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('prep-qe')
    userCounter = 0
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    captured.instances.length = 0
    captured.queueEventsClosed = 0
    await cleanupTestScope(pool, scope)
  })

  interface Seeded {
    readonly userId: string
    readonly worldId: string
    readonly campaignId: string
  }

  async function seed(): Promise<Seeded> {
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
       VALUES ($1, $2, $3, 'a concept for testing', 'generating')`,
      [worldId, userId, scope.worldName(n)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name)
       VALUES ($1, $2, $3, $4)`,
      [campaignId, worldId, userId, scope.campaignName(n)],
    )
    return { userId, worldId, campaignId }
  }

  async function seedStamp(
    pipeline: 'world_gen' | 'session_prep' | 'character_creation',
    entityId: string,
    nextResumeAt: Date | null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO llm_resume_stamps
         (pipeline, entity_id, resume_attempt, next_resume_at, park_consumed_ms, last_error_class)
       VALUES ($1, $2, 1, $3, 30000, 'connectivity')`,
      [pipeline, entityId, nextResumeAt],
    )
  }

  async function stampExists(pipeline: string, entityId: string): Promise<boolean> {
    const { rows } = await pool.query(
      `SELECT 1 FROM llm_resume_stamps WHERE pipeline = $1 AND entity_id = $2`,
      [pipeline, entityId],
    )
    return rows.length > 0
  }

  function makeDeps(events: { campaignId: string; event: PipelineEvent }[]): {
    deps: PrepTerminalRecoveryDeps
    logger: ReturnType<typeof recordingLogger>
  } {
    const logger = recordingLogger()
    return {
      deps: {
        repo: createRepo(pool),
        publishEvent: (campaignId, event) => {
          events.push({ campaignId, event })
          return Promise.resolve()
        },
        logger,
      },
      logger,
    }
  }

  // -- world-gen -------------------------------------------------------------

  it('world-gen: an ARMED stamp + terminal failed event marks the world failed, publishes the phase, clears the stamp', async () => {
    const { worldId, campaignId } = await seed()
    await seedStamp('world_gen', campaignId, new Date(Date.now() + 60_000))
    const events: { campaignId: string; event: PipelineEvent }[] = []
    const { deps } = makeDeps(events)

    await handleWorldGenTerminalFailure(deps, campaignId, 'job stalled more than allowable limit')

    const world = await pool.query<{ status: string }>(
      `SELECT status FROM worlds WHERE id = $1`,
      [worldId],
    )
    expect(world.rows[0]?.status).toBe('failed')
    expect(events).toContainEqual({
      campaignId,
      event: { type: 'phase', phase: 'world_gen_failed' },
    })
    expect(await stampExists('world_gen', campaignId)).toBe(false)
  })

  it('world-gen: an IN-FLIGHT stamp (claim cleared nextResumeAt, then stall-death) also recovers', async () => {
    // The overdue predicate can never fire for an in-flight stamp
    // (nextResumeAt NULL) — this broker path is the ONLY net for a
    // post-claim stall-terminal, so the handler must act on stamp
    // presence, not armed-ness.
    const { worldId, campaignId } = await seed()
    await seedStamp('world_gen', campaignId, null)
    const events: { campaignId: string; event: PipelineEvent }[] = []
    const { deps } = makeDeps(events)

    await handleWorldGenTerminalFailure(deps, campaignId, 'stalled')

    const world = await pool.query<{ status: string }>(
      `SELECT status FROM worlds WHERE id = $1`,
      [worldId],
    )
    expect(world.rows[0]?.status).toBe('failed')
    expect(await stampExists('world_gen', campaignId)).toBe(false)
  })

  it('world-gen: a non-UUID-width jobId is a no-op (fixed-width identity, never split)', async () => {
    const events: { campaignId: string; event: PipelineEvent }[] = []
    const { deps } = makeDeps(events)
    await handleWorldGenTerminalFailure(deps, 'not-a-campaign-id', 'stalled')
    expect(events).toHaveLength(0)
  })

  it('world-gen: NO stamp → no-op (existing surfacing paths own unparked failures)', async () => {
    const { worldId, campaignId } = await seed()
    const events: { campaignId: string; event: PipelineEvent }[] = []
    const { deps } = makeDeps(events)

    await handleWorldGenTerminalFailure(deps, campaignId, 'attempts exhausted')

    const world = await pool.query<{ status: string }>(
      `SELECT status FROM worlds WHERE id = $1`,
      [worldId],
    )
    expect(world.rows[0]?.status).toBe('generating')
    expect(events).toHaveLength(0)
  })

  it('world-gen: a stamped id whose campaign row vanished clears the orphan stamp and warns', async () => {
    const orphanCampaignId = uuidv7()
    await seedStamp('world_gen', orphanCampaignId, new Date())
    const events: { campaignId: string; event: PipelineEvent }[] = []
    const { deps, logger } = makeDeps(events)

    await handleWorldGenTerminalFailure(deps, orphanCampaignId, 'stalled')

    expect(await stampExists('world_gen', orphanCampaignId)).toBe(false)
    expect(events).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalled()
  })

  // -- session-prep ----------------------------------------------------------

  it('session-prep: stamp + terminal failed event marks the stage row failed, publishes prep-failed terminal, clears the stamp', async () => {
    const { campaignId } = await seed()
    await seedStamp('session_prep', campaignId, new Date(Date.now() + 60_000))
    // The stage row a dead attempt left 'running' (the wake had claimed it).
    await pool.query(
      `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, user_id)
       VALUES ($1, $2, 'session-prep:2', 'running', now(), NULL)`,
      [uuidv7(), campaignId],
    )
    const events: { campaignId: string; event: PipelineEvent }[] = []
    const { deps } = makeDeps(events)

    await handleSessionPrepTerminalFailure(deps, `sp-${campaignId}-2`, 'stalled')

    const run = await pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = 'session-prep:2' AND user_id IS NULL`,
      [campaignId],
    )
    expect(run.rows[0]?.status).toBe('failed')
    expect(run.rows[0]?.error).toContain('stalled')
    expect(events).toContainEqual({
      campaignId,
      event: { type: 'prep-failed', sessionNumber: 2, terminal: true },
    })
    expect(await stampExists('session_prep', campaignId)).toBe(false)
  })

  it('session-prep: a malformed jobId (uuids embed hyphens — never split) is a no-op', async () => {
    const events: { campaignId: string; event: PipelineEvent }[] = []
    const { deps } = makeDeps(events)
    await handleSessionPrepTerminalFailure(deps, 'sp-not-a-uuid-3', 'stalled')
    await handleSessionPrepTerminalFailure(deps, 'unrelated-job-id', 'stalled')
    expect(events).toHaveLength(0)
  })

  it('session-prep: no stamp → no-op (a plain terminal failure already published its own prep-failed)', async () => {
    const { campaignId } = await seed()
    const events: { campaignId: string; event: PipelineEvent }[] = []
    const { deps } = makeDeps(events)
    await handleSessionPrepTerminalFailure(deps, `sp-${campaignId}-1`, 'stalled')
    expect(events).toHaveLength(0)
  })

  // -- character-creation ----------------------------------------------------

  async function seedConcept(campaignId: string, userId: string, status: string): Promise<string> {
    const id = uuidv7()
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
       VALUES ($1, $2, $3, 'a road-weary cleric searching for an old companion',
               'arrived at the tavern seeking word through the fall storms',
               '{}'::jsonb, $4)`,
      [id, campaignId, userId, status],
    )
    return id
  }

  it('character-creation: stamp on the concept + terminal failed event marks the concept failed, publishes, clears', async () => {
    const { campaignId, userId } = await seed()
    const conceptId = await seedConcept(campaignId, userId, 'processing')
    await seedStamp('character_creation', conceptId, null)
    const events: { campaignId: string; event: PipelineEvent }[] = []
    const { deps } = makeDeps(events)

    await handleCharacterCreationTerminalFailure(deps, `cc-${campaignId}-${userId}`, 'stalled')

    const concept = await pool.query<{ status: string; error: unknown }>(
      `SELECT status, error FROM character_concepts WHERE id = $1`,
      [conceptId],
    )
    expect(concept.rows[0]?.status).toBe('failed')
    expect(concept.rows[0]?.error).not.toBeNull()
    const stageFailed = events.find((e) => e.event.type === 'stage-failed')
    expect(stageFailed?.event).toMatchObject({
      type: 'stage-failed',
      userId,
      willRetry: false,
    })
    expect(await stampExists('character_creation', conceptId)).toBe(false)
  })

  it('character-creation: a COMPLETED concept is never unwound — the stale stamp is cleared, row untouched', async () => {
    const { campaignId, userId } = await seed()
    const conceptId = await seedConcept(campaignId, userId, 'completed')
    await seedStamp('character_creation', conceptId, new Date())
    const events: { campaignId: string; event: PipelineEvent }[] = []
    const { deps } = makeDeps(events)

    await handleCharacterCreationTerminalFailure(deps, `cc-${campaignId}-${userId}`, 'stalled')

    const concept = await pool.query<{ status: string }>(
      `SELECT status FROM character_concepts WHERE id = $1`,
      [conceptId],
    )
    expect(concept.rows[0]?.status).toBe('completed')
    expect(events).toHaveLength(0)
    expect(await stampExists('character_creation', conceptId)).toBe(false)
  })

  it('character-creation: a non-cc jobId on the campaign-setup queue (integration job) is a no-op', async () => {
    const events: { campaignId: string; event: PipelineEvent }[] = []
    const { deps } = makeDeps(events)
    await handleCharacterCreationTerminalFailure(deps, 'character-integration-abc', 'stalled')
    expect(events).toHaveLength(0)
  })

  it('character-creation: a cc jobId whose concept row vanished is a no-op', async () => {
    const events: { campaignId: string; event: PipelineEvent }[] = []
    const { deps } = makeDeps(events)
    await handleCharacterCreationTerminalFailure(deps, `cc-${uuidv7()}-${uuidv7()}`, 'stalled')
    expect(events).toHaveLength(0)
  })

  it('character-creation: no stamp → no-op (the exhausted-transient listener owns plain failures)', async () => {
    const { campaignId, userId } = await seed()
    const conceptId = await seedConcept(campaignId, userId, 'processing')
    const events: { campaignId: string; event: PipelineEvent }[] = []
    const { deps } = makeDeps(events)
    await handleCharacterCreationTerminalFailure(deps, `cc-${campaignId}-${userId}`, 'stalled')
    const concept = await pool.query<{ status: string }>(
      `SELECT status FROM character_concepts WHERE id = $1`,
      [conceptId],
    )
    expect(concept.rows[0]?.status).toBe('processing')
    expect(events).toHaveLength(0)
  })

  // -- builder wiring --------------------------------------------------------

  it('buildPrepQueueEvents subscribes one QueueEvents per prep queue and close() tears all down', async () => {
    const quit = vi.fn().mockResolvedValue(undefined)
    const duplicate = vi.fn().mockImplementation(() => ({ quit }))
    const fakeRedis = { duplicate } as unknown as Redis
    const logger = recordingLogger()

    const handle = buildPrepQueueEvents({
      redisBatch: fakeRedis,
      pool,
      publishEvent: () => Promise.resolve(),
      logger,
    })

    expect(captured.instances.map((i) => i.queueName).sort()).toEqual(
      ['campaign-setup', 'session-prep', 'world-gen'].sort(),
    )
    // One dedicated blocking connection per subscriber.
    expect(duplicate).toHaveBeenCalledTimes(3)
    for (const instance of captured.instances) {
      expect(instance.handlers.has('failed')).toBe(true)
    }

    await handle.close()
    expect(captured.queueEventsClosed).toBe(3)
    expect(quit).toHaveBeenCalledTimes(3)
  })

  it('a wired failed handler recovers a stamped world through the REAL recovery path', async () => {
    const { worldId, campaignId } = await seed()
    await seedStamp('world_gen', campaignId, new Date())
    const duplicate = vi.fn().mockImplementation(() => ({ quit: vi.fn() }))
    const fakeRedis = { duplicate } as unknown as Redis
    const logger = recordingLogger()

    buildPrepQueueEvents({
      redisBatch: fakeRedis,
      pool,
      publishEvent: () => Promise.resolve(),
      logger,
    })

    const worldGenInstance = captured.instances.find((i) => i.queueName === 'world-gen')
    const failedHandler = worldGenInstance?.handlers.get('failed')
    expect(failedHandler).toBeDefined()
    failedHandler?.({ jobId: campaignId, failedReason: 'stalled' })
    // The wiring fires a floating (guarded) promise; poll the DB outcome.
    await vi.waitFor(async () => {
      const world = await pool.query<{ status: string }>(
        `SELECT status FROM worlds WHERE id = $1`,
        [worldId],
      )
      expect(world.rows[0]?.status).toBe('failed')
    })
  })

  it('a handler failure is contained (logged) — never thrown into the broker emitter', async () => {
    const boomPool = {
      query: () => Promise.reject(new Error('pg down')),
    } as unknown as Pool
    const duplicate = vi.fn().mockImplementation(() => ({ quit: vi.fn() }))
    const fakeRedis = { duplicate } as unknown as Redis
    const logger = recordingLogger()

    buildPrepQueueEvents({
      redisBatch: fakeRedis,
      pool: boomPool,
      publishEvent: () => Promise.resolve(),
      logger,
    })

    const worldGenInstance = captured.instances.find((i) => i.queueName === 'world-gen')
    worldGenInstance?.handlers.get('failed')?.({ jobId: uuidv7(), failedReason: 'stalled' })
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalled()
    })
  })
})
