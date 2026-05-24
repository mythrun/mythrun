// backend/src/__tests__/e2e/character-integration-smoke.test.ts
//
// MYT-54 T18: end-to-end integration smoke test.
//
// Exercises the full character-integration flow:
//   1. Owner POST /api/campaigns/:campaignId/finalize-character-creation
//      → route writes `pre_integration_notes`, enqueues a
//        `ci-${campaignId}` job, returns 202 + jobId.
//   2. Processor (`processCharacterIntegrationJob`) is invoked directly with
//      the route's payload (BullMQ is bypassed — the plan's intent is to
//      verify the DB state after the full flow, not BullMQ wiring; BullMQ
//      mechanics are covered by `worker.test.ts`).
//   3. The handler (`runCharacterIntegrationStage`) calls the Anthropic SDK
//      via `ai.generateText`, which we mock with a deterministic 3-PC
//      payload (one PC↔PC sibling edge from PC0→PC1, mirrored by the worker).
//   4. Final DB state is asserted: campaigns.status='active',
//      3 entities with entity_type='pc', character_concepts.status='integrated'
//      for every party member, pipeline_runs row 'completed' with non-zero
//      cost_usd, prose_kernels written for every PC entity, ≥ 2 relationships
//      (PC0→PC1 + worker-mirrored PC1→PC0).
//
// The dev-tool-verifier's separate real-LLM smoke (per
// `backend/dev-tool/AUTHORING.md`) covers the actual Anthropic wire.
//
// Test isolation:
//   - Real Postgres via `createTestPool`.
//   - Scoped fixtures via `makeTestScope` — only this scope's rows are
//     cleaned up.
//   - The `ai` module is mocked at the file level (vi.mock), matching the
//     pattern in stages/__tests__/character-integration.test.ts.
//
// Why a single happy-path test:
//   - Per-failure modes (cost cap, schema repair, unknown target drop,
//     PC↔PC mirror) are unit-tested in
//     stages/__tests__/character-integration.test.ts; processor lifecycle
//     in __tests__/character-integration-processor.test.ts; route guards
//     in routes/__tests__/campaign-characters-finalize.test.ts. T18 is the
//     glue test that verifies route → processor → handler → DB end-to-end.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import * as ai from 'ai'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { requireOnboarded } from '../../auth/require-onboarded.js'
import {
  campaignCharactersPlugin,
  type CharacterCreationJobData,
  type CharacterCreationQueueLike,
} from '../../routes/campaign-characters.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'
import { processCharacterIntegrationJob } from '../../llm/prep/character-integration-processor.js'

// Mock the `ai` SDK module so generateText (which generateObject delegates
// to under the hood) returns a deterministic payload. Matches the proven
// pattern in stages/__tests__/character-integration.test.ts.
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)
const databaseUrl = process.env.DATABASE_URL ?? ''

// The Vercel AI SDK's generateText returns a wide shape; tests only need
// `output`, `finishReason`, and `usage`. Cast at the call site — matches
// peer test convention.
function generateTextMockReturn(payload: unknown): never {
  return {
    output: payload,
    finishReason: 'stop',
    usage: { inputTokens: 5000, outputTokens: 2000, totalTokens: 7000 },
  } as never
}

interface QueueSpy {
  readonly queue: CharacterCreationQueueLike
  readonly add: ReturnType<typeof vi.fn>
}

function createQueueSpy(): QueueSpy {
  const add = vi.fn().mockResolvedValue({ id: 'stub-job' })
  const queue: CharacterCreationQueueLike = {
    add: (
      name: 'character-creation' | 'character-integration',
      data: CharacterCreationJobData,
      opts?: { jobId?: string },
    ): Promise<unknown> => add(name, data, opts) as Promise<unknown>,
  }
  return { queue, add }
}

async function buildTestApp(
  pool: Pool,
  queue: CharacterCreationQueueLike,
): Promise<FastifyInstance> {
  // bypassPlugin probes the ECS metadata endpoint and requires it to FAIL —
  // replace fetch with a guaranteed-reject stub.
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))

  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(bypassPlugin)
  await app.register(requireOnboarded, { pool })
  await app.register(campaignCharactersPlugin, {
    pool,
    characterCreationQueue: queue,
  })
  await app.ready()
  return app
}

interface SeedResult {
  readonly campaignId: string
  readonly worldId: string
  readonly ownerUserId: string
  readonly ownerDevSub: string
  readonly userIds: readonly string[]
  readonly locationId: string
  readonly factionId: string
}

// Narrative shape stored in `character_concepts.concept_output` JSONB —
// the handler reads `backstory` and `personality_traits` from this blob
// when rendering the party block in the prompt. Other fields are ignored
// at integration time (they were consumed by the character-concept stage).
function makeNarrative(name: string): Record<string, unknown> {
  return {
    name,
    race: 'human',
    class: 'cleric',
    background: 'acolyte',
    level: 1,
    alignment: 'lawful neutral',
    age: 27,
    gender: 'man',
    physical_description:
      `A weather-worn ${name.toLowerCase()} with the bearing of someone who has walked too many roads alone.`,
    personality_traits: ['speaks in measured tones', 'pauses before answering'],
    ideals: ['order serves the weak'],
    bonds: ['the temple that raised them'],
    flaws: ['quick to suspect deception'],
    backstory:
      'Apprenticed at the Bone Sept in their twelfth year, when the priests took them in after a winter on the moors orphaned them. Twenty years later, when the Sept burned, they walked out with a tin ladle and a name they were no longer sure was theirs.',
  }
}

// Seed: a world (status='complete', starting_situation_entries populated +
// vocabulary_registry), a campaign (status='setup', starting_situation_index=0,
// linked to the world), N campaign_members (1 owner + N-1 players), N
// character_concepts (status='completed', concept_output JSONB populated),
// N characters rows + N campaign_characters joins. Plus two world entities
// (location + faction) the LLM can reference if it wants to.
//
// `partySize` includes the owner; the owner is always seeded as members[0]
// with role='owner', the rest as 'player'. Owner is required to exist on
// users + campaign_members because the finalize route uses
// requireCampaignMember(repo, 'owner') as a preHandler.
async function seedReadyToFinalize(
  pool: Pool,
  scope: TestScope,
  partySize: number,
  userCounterStart: number,
): Promise<SeedResult> {
  const worldId = uuidv7()
  const campaignId = uuidv7()
  const locationId = uuidv7()
  const factionId = uuidv7()
  const userIds: string[] = []
  let userCounter = userCounterStart

  // First member = owner.
  const ownerUserId = uuidv7()
  const ownerDevSub = scope.userSub(userCounter)
  userIds.push(ownerUserId)
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username)
     VALUES ($1, $2, $3, $4)`,
    [ownerUserId, ownerDevSub, scope.displayName(userCounter), scope.username(userCounter)],
  )
  userCounter += 1

  for (let i = 1; i < partySize; i += 1) {
    const uid = uuidv7()
    userIds.push(uid)
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [uid, scope.userSub(userCounter), scope.displayName(userCounter), scope.username(userCounter)],
    )
    userCounter += 1
  }

  await pool.query(
    `INSERT INTO worlds (
       id, created_by, name, concept, status,
       starting_situation_entries, vocabulary_registry
     )
     VALUES ($1, $2, $3, 'A test world concept long enough for the column.', 'complete', $4::jsonb, $5::jsonb)`,
    [
      worldId,
      ownerUserId,
      scope.worldName(userCounter),
      JSON.stringify([
        {
          index: 0,
          locationEntityId: locationId,
          prose: 'The party gathers at The Tavern as the autumn storm breaks.',
        },
      ]),
      JSON.stringify({ entries: [], adjacent_franchises: [] }),
    ],
  )
  await pool.query(
    `INSERT INTO campaigns (
       id, world_id, created_by, name, status, starting_situation_index
     )
     VALUES ($1, $2, $3, $4, 'setup', 0)`,
    [campaignId, worldId, ownerUserId, scope.campaignName(userCounter)],
  )

  for (const [i, uid] of userIds.entries()) {
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, $4, true)`,
      [uuidv7(), campaignId, uid, i === 0 ? 'owner' : 'player'],
    )
  }

  // Two world entities the LLM could reference in relationships / newFacts.
  // The starting-situation prose names "The Tavern", so the location entity
  // matches that anchor.
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

  // One completed character_concepts + one characters + one
  // campaign_characters per party member. The characters row has the full
  // mechanical sheet (str/dex/.../armor_class) — those CHECK-constrained
  // columns are NOT NULL on the characters table per migration 016.
  for (const [i, uid] of userIds.entries()) {
    const characterId = uuidv7()
    await pool.query(
      `INSERT INTO character_concepts (
         id, campaign_id, user_id, concept_text, situation_grounding_text,
         status, concept_output
       )
       VALUES ($1, $2, $3, $4, $5, 'completed', $6::jsonb)`,
      [
        uuidv7(),
        campaignId,
        uid,
        `A cleric concept for player ${String(i)} drawn from the bone sept tradition.`,
        `Arrived at The Tavern through the autumn storms for player ${String(i)}.`,
        JSON.stringify(makeNarrative(`Player${String(i)}`)),
      ],
    )
    await pool.query(
      `INSERT INTO characters (
         id, user_id, name, level, class, species, background,
         str, dex, con, int, wis, cha,
         hit_points, max_hit_points, armor_class, proficiency_bonus
       )
       VALUES ($1, $2, $3, 1, 'cleric', 'human', 'acolyte',
               12, 10, 14, 13, 16, 11, 9, 9, 14, 2)`,
      [characterId, uid, `Player${String(i)}`],
    )
    await pool.query(
      `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
       VALUES ($1, $2, $3, $4)`,
      [uuidv7(), campaignId, characterId, uid],
    )
  }

  return { campaignId, worldId, ownerUserId, ownerDevSub, userIds, locationId, factionId }
}

// Characters has user_id RESTRICT-FK to users → must clean characters
// scoped to this scope's users BEFORE cleanupTestScope deletes the users.
async function cleanupCharactersFor(p: Pool, scope: TestScope): Promise<void> {
  await p.query(
    `DELETE FROM characters
       WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
    [`${scope.id}%`],
  )
  await cleanupTestScope(p, scope)
}

describe('MYT-54 T18: character-integration E2E smoke', () => {
  let pool: Pool
  let scope: TestScope
  let app: FastifyInstance
  let queueSpy: QueueSpy
  let userCounter: number

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('ci-e2e')
    userCounter = 0
  })

  afterAll(async () => {
    await cleanupCharactersFor(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')
    await cleanupCharactersFor(pool, scope)
    queueSpy = createQueueSpy()
    app = await buildTestApp(pool, queueSpy.queue)
  })

  it('full flow: 3 players + finalize → campaigns.status=active + 3 PC entities + PC↔PC mirror', async () => {
    const seed = await seedReadyToFinalize(pool, scope, 3, userCounter)
    userCounter += 4 // 3 users + 1 buffer for the worldName/campaignName indexer

    const [ownerUid, p1Uid, p2Uid] = seed.userIds
    if (ownerUid === undefined || p1Uid === undefined || p2Uid === undefined) {
      throw new Error('seed produced fewer than 3 users')
    }

    // Stage the deterministic LLM response BEFORE the processor calls it.
    // Owner (PC0) emits a PC↔PC sibling edge to PC1; the worker mirrors it
    // on PC1's side automatically (one of the canonical T10 invariants).
    mockGenerateText.mockResolvedValueOnce(
      generateTextMockReturn({
        characters: seed.userIds.map((uid, i) => ({
          userId: uid,
          displayName: `Player${String(i)}`,
          entity: {
            name: `PC ${String(i)}`,
            proseKernel:
              `Player${String(i)} is a cleric who came down from the northern hills to serve at the temple that raised them, carrying a sept-mark on their hand.`,
          },
          facts: [
            {
              content: `Player${String(i)} was raised at the Bone Sept and bears its faded mark.`,
              tags: ['origin'],
              aboutEntityId: null,
            },
          ],
          relationships:
            i === 0
              ? [
                  {
                    targetKind: 'pc' as const,
                    targetUserId: p1Uid,
                    type: 'sibling_of',
                    description:
                      'They are siblings, raised together at the Bone Sept before the burning.',
                  },
                ]
              : [],
        })),
      }),
    )

    // Step 1: Route — POST /finalize-character-creation. Asserts the 202
    // shape + jobId determinism + queue.add call shape.
    const finalizeRes = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${seed.campaignId}/finalize-character-creation`,
      headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': seed.ownerDevSub },
      payload: { pre_integration_notes: 'PC0 and PC1 are siblings.' },
    })
    expect(finalizeRes.statusCode).toBe(202)
    expect(finalizeRes.json()).toEqual({
      campaignId: seed.campaignId,
      jobId: `ci-${seed.campaignId}`,
    })
    expect(queueSpy.add).toHaveBeenCalledTimes(1)
    const [jobName, jobData, jobOpts] = queueSpy.add.mock.calls[0] as [
      string,
      { campaignId: string; ownerUserId: string },
      { jobId: string },
    ]
    expect(jobName).toBe('character-integration')
    expect(jobData).toEqual({ campaignId: seed.campaignId, ownerUserId: seed.ownerUserId })
    expect(jobOpts.jobId).toBe(`ci-${seed.campaignId}`)

    // The route wrote pre_integration_notes inside the same transaction as
    // the queue dispatch. Verified here so a later regression that splits
    // the txn surfaces immediately.
    const { rows: notesRows } = await pool.query<{ pre_integration_notes: string | null }>(
      `SELECT pre_integration_notes FROM campaigns WHERE id = $1`,
      [seed.campaignId],
    )
    expect(notesRows[0]?.pre_integration_notes).toBe('PC0 and PC1 are siblings.')

    // Step 2: Processor — invoke directly with the route's payload. Bypasses
    // BullMQ entirely (BullMQ wiring is covered by worker.test.ts). The
    // processor owns pipeline_runs claim/complete/fail bookkeeping; the
    // handler owns the LLM call + DB writes.
    const events: Record<string, unknown>[] = []
    await processCharacterIntegrationJob(
      {
        pool,
        publishEvent: (cid, e) => {
          events.push({ campaignId: cid, ...e })
          return Promise.resolve()
        },
      },
      // processCharacterIntegrationJob signature only reads `job.data` —
      // pass a minimal `Pick<Job, 'data'>` literal, no full BullMQ Job
      // construction needed (which would require a live queue connection).
      { data: { campaignId: seed.campaignId, ownerUserId: seed.ownerUserId } },
    )

    // Step 3: Assertions on final DB state.

    // 3a. campaigns.status flipped to 'active'.
    const { rows: campRows } = await pool.query<{
      status: string
      pre_integration_notes: string | null
    }>(
      `SELECT status, pre_integration_notes FROM campaigns WHERE id = $1`,
      [seed.campaignId],
    )
    expect(campRows[0]?.status).toBe('active')
    expect(campRows[0]?.pre_integration_notes).toBe('PC0 and PC1 are siblings.')

    // 3b. Exactly 3 entities with entity_type='pc' in this world.
    const { rows: pcEntities } = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM entities WHERE world_id = $1 AND entity_type = 'pc' ORDER BY name`,
      [seed.worldId],
    )
    expect(pcEntities).toHaveLength(3)

    // 3c. character_concepts all flipped to 'integrated'.
    const { rows: conceptRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM character_concepts
        WHERE campaign_id = $1 AND status = 'integrated'`,
      [seed.campaignId],
    )
    expect(Number(conceptRows[0]?.count)).toBe(3)

    // 3d. ≥ 2 relationships (PC0→PC1 + worker-mirrored PC1→PC0). The exact
    // count depends on whether the LLM mock emits world-entity targets too;
    // the canonical mirror invariant requires at least 2.
    const { rows: relRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM relationships
        WHERE source_entity_id IN (
          SELECT id FROM entities WHERE world_id = $1 AND entity_type = 'pc'
        )`,
      [seed.worldId],
    )
    expect(Number(relRows[0]?.count)).toBeGreaterThanOrEqual(2)

    // 3e. characters.entity_id populated for every PC via campaign_characters
    // join (characters.campaign_id was dropped in migration 009).
    const { rows: chRows } = await pool.query<{ entity_id: string | null }>(
      `SELECT ch.entity_id
         FROM characters ch
         JOIN campaign_characters cc ON cc.character_id = ch.id
        WHERE cc.campaign_id = $1`,
      [seed.campaignId],
    )
    expect(chRows).toHaveLength(3)
    for (const r of chRows) {
      expect(r.entity_id).not.toBeNull()
    }

    // 3f. prose_kernels written for every PC entity.
    const { rows: pkRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM prose_kernels
        WHERE entity_id IN (
          SELECT id FROM entities WHERE world_id = $1 AND entity_type = 'pc'
        )`,
      [seed.worldId],
    )
    expect(Number(pkRows[0]?.count)).toBe(3)

    // 3g. pipeline_runs row marked 'completed' with non-zero cost_usd.
    const { rows: runRows } = await pool.query<{ status: string; cost_usd: string }>(
      `SELECT status, cost_usd FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = 'character_integration' AND user_id IS NULL`,
      [seed.campaignId],
    )
    expect(runRows).toHaveLength(1)
    expect(runRows[0]?.status).toBe('completed')
    expect(Number(runRows[0]?.cost_usd)).toBeGreaterThan(0)

    // 3h. Processor published a stage-completed event with the cost.
    const completed = events.find((e) => e.type === 'stage-completed')
    expect(completed).toBeDefined()
    expect(completed?.stage).toBe('character_integration')
    expect(Number(completed?.costUsd)).toBeGreaterThan(0)
  })
})
