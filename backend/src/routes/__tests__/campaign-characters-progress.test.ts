// backend/src/routes/__tests__/campaign-characters-progress.test.ts
//
// MYT-54 T12. Integration tests for the per-PC character-creation
// progress route:
//
//   GET /api/campaigns/:campaignId/character-creation-progress
//
// Visible to ALL campaign members (owner OR player). The frontend uses
// this to decide whether to surface "are you sure?" on the finalize
// button. Returns `concepts[]` (members with a character_concepts row,
// any status) and `missing[]` (members with no row). Status='integrated'
// (introduced by MYT-54 T1 in migration 018) is surfaced unchanged;
// `error` (JSONB) is present iff status='failed'.
//
// Pattern mirrors campaign-characters.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { requireOnboarded } from '../../auth/require-onboarded.js'
import { campaignCharactersPlugin } from '../campaign-characters.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

interface SeededUser {
  readonly userId: string
  readonly devSub: string
}

async function seedUser(pool: Pool, scope: TestScope, index: number): Promise<SeededUser> {
  const userId = uuidv7()
  const devSub = scope.userSub(index)
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, devSub, scope.displayName(index), scope.username(index)],
  )
  return { userId, devSub }
}

interface SeededCampaign {
  readonly userId: string
  readonly devSub: string
  readonly worldId: string
  readonly campaignId: string
}

async function seedCampaignOwnedBy(
  pool: Pool,
  scope: TestScope,
  owner: SeededUser,
  index: number,
): Promise<SeededCampaign> {
  const worldId = uuidv7()
  const campaignId = uuidv7()
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status)
     VALUES ($1, $2, $3, 'A long enough concept for the test', 'complete')`,
    [worldId, owner.userId, scope.worldName(index)],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, 'setup')`,
    [campaignId, worldId, owner.userId, scope.campaignName(index)],
  )
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaignId, owner.userId],
  )
  return { userId: owner.userId, devSub: owner.devSub, worldId, campaignId }
}

async function addMember(
  pool: Pool,
  campaignId: string,
  user: SeededUser,
  role: 'owner' | 'player' = 'player',
): Promise<void> {
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, $4, true)`,
    [uuidv7(), campaignId, user.userId, role],
  )
}

// Insert a character_concepts row directly with an explicit status. Used
// to drive each branch of the response (submitted / processing /
// completed / failed / integrated). `error` is settable for the failed
// case.
async function insertConcept(
  pool: Pool,
  campaignId: string,
  userId: string,
  status: 'submitted' | 'processing' | 'completed' | 'failed' | 'integrated' = 'submitted',
  errorJson: unknown = null,
): Promise<string> {
  const id = uuidv7()
  await pool.query(
    `INSERT INTO character_concepts (
       id, campaign_id, user_id, concept_text,
       situation_grounding_text, guided_choices, status, error
     )
     VALUES ($1, $2, $3, 'a road-weary cleric who lost their faith',
             'arrived seeking word of an old companion',
             '{}'::jsonb, $4, $5::jsonb)`,
    [id, campaignId, userId, status, errorJson === null ? null : JSON.stringify(errorJson)],
  )
  return id
}

async function buildTestApp(pool: Pool): Promise<FastifyInstance> {
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(bypassPlugin)
  await app.register(requireOnboarded, { pool })
  await app.register(campaignCharactersPlugin, {
    pool,
    characterCreationQueue: undefined,
  })
  await app.ready()
  return app
}

interface ProgressBody {
  campaignId: string
  totalMembers: number
  concepts: {
    userId: string
    displayName: string
    status: string
    submittedAt: string
    // MYT-90 D8 additive fields.
    confirmedAt: string | null
    characterId: string | null
    error?: unknown
  }[]
  missing: { userId: string; displayName: string }[]
}

// MYT-90 D8: mark a member's concept confirmed ("This is me").
async function confirmConcept(pool: Pool, campaignId: string, userId: string): Promise<void> {
  await pool.query(
    `UPDATE character_concepts SET confirmed_at = now()
      WHERE campaign_id = $1 AND user_id = $2`,
    [campaignId, userId],
  )
}

// MYT-90 D8: persist a `characters` row + `campaign_characters` join for a member,
// so the progress row's `characterId` resolves (mirrors campaign-characters.test.ts).
async function attachCharacter(
  pool: Pool,
  campaignId: string,
  userId: string,
  name: string,
): Promise<string> {
  const characterId = uuidv7()
  await pool.query(
    `INSERT INTO characters (
       id, user_id, name, level, class, species, background,
       str, dex, con, int, wis, cha,
       hit_points, max_hit_points, armor_class, proficiency_bonus
     ) VALUES ($1, $2, $3, 1, 'Cleric', 'Human', 'Sage',
               10, 10, 10, 10, 10, 10, 10, 10, 10, 2)`,
    [characterId, userId, name],
  )
  await pool.query(
    `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
     VALUES ($1, $2, $3, $4)`,
    [uuidv7(), campaignId, characterId, userId],
  )
  return characterId
}

describe('GET /api/campaigns/:campaignId/character-creation-progress (MYT-54 T12)', () => {
  let pool: Pool
  let app: FastifyInstance
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('cc-prog')
  })

  // The D8 test attaches `characters` rows (owned by scope users). Those survive
  // the campaign CASCADE (characters decoupled from campaigns in migration 009),
  // so cleanupTestScope's users-delete pass would hit characters_user_id_fkey.
  // Wipe the scope's characters first (mirrors campaign-characters.test.ts).
  async function wipeScopeCharacters(): Promise<void> {
    await pool.query(
      `DELETE FROM characters
         WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
      [`${scope.id}%`],
    )
  }

  afterAll(async () => {
    await wipeScopeCharacters()
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')
    await wipeScopeCharacters()
    await cleanupTestScope(pool, scope)
    app = await buildTestApp(pool)
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  it('200 — owner can fetch; reports concepts + missing across a 4-member campaign', async () => {
    const owner = await seedUser(pool, scope, 0)
    const p1 = await seedUser(pool, scope, 1)
    const p2 = await seedUser(pool, scope, 2)
    const p3 = await seedUser(pool, scope, 3)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    await addMember(pool, seed.campaignId, p1, 'player')
    await addMember(pool, seed.campaignId, p2, 'player')
    await addMember(pool, seed.campaignId, p3, 'player')

    // owner: completed; p1: processing; p2: no row (missing); p3: failed
    await insertConcept(pool, seed.campaignId, owner.userId, 'completed')
    await insertConcept(pool, seed.campaignId, p1.userId, 'processing')
    await insertConcept(pool, seed.campaignId, p3.userId, 'failed', {
      message: 'boom',
      stage: 'character_creation',
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/character-creation-progress`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<ProgressBody>()
    expect(body.campaignId).toBe(seed.campaignId)
    expect(body.totalMembers).toBe(4)
    expect(body.concepts).toHaveLength(3)
    expect(body.missing).toHaveLength(1)

    const byUserId = Object.fromEntries(body.concepts.map((c) => [c.userId, c]))
    expect(byUserId[owner.userId]?.status).toBe('completed')
    expect(byUserId[owner.userId]?.displayName).toBe(scope.displayName(0))
    // submittedAt is ISO-8601 (Z suffix).
    expect(byUserId[owner.userId]?.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/)
    expect(byUserId[p1.userId]?.status).toBe('processing')
    expect(byUserId[p3.userId]?.status).toBe('failed')
    expect(byUserId[p3.userId]?.error).toEqual({
      message: 'boom',
      stage: 'character_creation',
    })

    // p2 is in missing[], not concepts[].
    expect(body.missing[0]?.userId).toBe(p2.userId)
    expect(body.missing[0]?.displayName).toBe(scope.displayName(2))
  })

  it('200 — non-owner player member can also fetch the route', async () => {
    const owner = await seedUser(pool, scope, 0)
    const player = await seedUser(pool, scope, 1)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    await addMember(pool, seed.campaignId, player, 'player')
    await insertConcept(pool, seed.campaignId, owner.userId, 'submitted')

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/character-creation-progress`,
      headers: { 'x-mythrun-dev-sub': player.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<ProgressBody>()
    expect(body.totalMembers).toBe(2)
    expect(body.concepts).toHaveLength(1)
    expect(body.missing).toHaveLength(1)
    expect(body.missing[0]?.userId).toBe(player.userId)
  })

  it('200 — status=integrated is surfaced unchanged (MYT-54 T1 addition)', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    await insertConcept(pool, seed.campaignId, owner.userId, 'integrated')

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/character-creation-progress`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<ProgressBody>()
    expect(body.concepts).toHaveLength(1)
    expect(body.concepts[0]?.status).toBe('integrated')
  })

  it('200 — MYT-90 D8: surfaces confirmedAt + characterId per concept', async () => {
    const owner = await seedUser(pool, scope, 0)
    const p1 = await seedUser(pool, scope, 1)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    await addMember(pool, seed.campaignId, p1, 'player')

    // owner: completed + confirmed + a persisted character (→ both fields set).
    await insertConcept(pool, seed.campaignId, owner.userId, 'completed')
    const ownerCharId = await attachCharacter(pool, seed.campaignId, owner.userId, 'Brother Anselm')
    await confirmConcept(pool, seed.campaignId, owner.userId)
    // p1: processing, unconfirmed, no character yet (→ both fields null).
    await insertConcept(pool, seed.campaignId, p1.userId, 'processing')

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/character-creation-progress`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<ProgressBody>()
    const byUserId = Object.fromEntries(body.concepts.map((c) => [c.userId, c]))

    // Confirmed owner with a sheet: ISO confirmedAt + the real characterId.
    expect(byUserId[owner.userId]?.confirmedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/,
    )
    expect(byUserId[owner.userId]?.characterId).toBe(ownerCharId)

    // Unconfirmed, pre-sheet player: both null (present as keys, not omitted).
    expect(byUserId[p1.userId]?.confirmedAt).toBeNull()
    expect(byUserId[p1.userId]?.characterId).toBeNull()
    expect('confirmedAt' in (byUserId[p1.userId] ?? {})).toBe(true)
    expect('characterId' in (byUserId[p1.userId] ?? {})).toBe(true)
  })

  it("200 — `error` is OMITTED (not null) when status != 'failed'", async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    await insertConcept(pool, seed.campaignId, owner.userId, 'completed')

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/character-creation-progress`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<ProgressBody>()
    expect(body.concepts).toHaveLength(1)
    expect('error' in (body.concepts[0] ?? {})).toBe(false)
  })

  it("200 — `error` is PRESENT when status='failed'", async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    await insertConcept(pool, seed.campaignId, owner.userId, 'failed', {
      message: 'llm timeout',
      retryable: true,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/character-creation-progress`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<ProgressBody>()
    expect(body.concepts[0]?.error).toEqual({ message: 'llm timeout', retryable: true })
  })

  it('200 — empty concepts + missing == totalMembers when no rows', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/character-creation-progress`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<ProgressBody>()
    expect(body.totalMembers).toBe(1)
    expect(body.concepts).toEqual([])
    expect(body.missing).toHaveLength(1)
    expect(body.missing[0]?.userId).toBe(owner.userId)
  })

  // llm-outage-resilience §3.4 (Task 9): the progress derivation gains the
  // armed/overdue stamp arms. Stamp contract: pipeline 'character_creation',
  // entity_id = the character_concepts.id. While the stamp is resuming the
  // concept stays 'processing' (generating-never-failed-while-armed) with the
  // additive lastErrorClass; an overdue or exhausted stamp derives 'failed'
  // (the retryable surface) as a pure read — the row itself is untouched.
  async function seedStamp(
    conceptId: string,
    s: { attempt: number; consumedMs: number; nextResumeAt: Date | null },
  ): Promise<void> {
    await pool.query(
      `INSERT INTO llm_resume_stamps
         (pipeline, entity_id, resume_attempt, next_resume_at, park_consumed_ms, last_error_class)
       VALUES ('character_creation', $1, $2, $3, $4, 'rate-limit')`,
      [conceptId, s.attempt, s.nextResumeAt, s.consumedMs],
    )
  }

  it('200 — a PARKED (armed, resuming) processing concept stays processing and surfaces lastErrorClass', async () => {
    const owner = await seedUser(pool, scope, 0)
    const campaign = await seedCampaignOwnedBy(pool, scope, owner, 0)
    const conceptId = await insertConcept(pool, campaign.campaignId, owner.userId, 'processing')
    await seedStamp(conceptId, {
      attempt: 2,
      consumedMs: 150_000,
      nextResumeAt: new Date(Date.now() + 60_000),
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaign.campaignId}/character-creation-progress`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<ProgressBody>()
    const entry = body.concepts.find((c) => c.userId === owner.userId) as
      | (ProgressBody['concepts'][number] & { lastErrorClass?: string; resumeAttempt?: number })
      | undefined
    expect(entry?.status).toBe('processing')
    expect(entry?.lastErrorClass).toBe('rate-limit')
    expect(entry?.resumeAttempt).toBe(2)
  })

  it("200 — an OVERDUE park derives status 'failed' (retryable) without touching the row", async () => {
    const owner = await seedUser(pool, scope, 0)
    const campaign = await seedCampaignOwnedBy(pool, scope, owner, 0)
    const conceptId = await insertConcept(pool, campaign.campaignId, owner.userId, 'processing')
    await seedStamp(conceptId, {
      attempt: 1,
      consumedMs: 30_000,
      nextResumeAt: new Date(Date.now() - 6 * 60_000),
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaign.campaignId}/character-creation-progress`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<ProgressBody>()
    const entry = body.concepts.find((c) => c.userId === owner.userId) as
      | (ProgressBody['concepts'][number] & { lastErrorClass?: string })
      | undefined
    expect(entry?.status).toBe('failed')
    expect(entry?.lastErrorClass).toBe('rate-limit')

    // Pure read predicate — the DB row itself stays 'processing'.
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM character_concepts WHERE id = $1`,
      [conceptId],
    )
    expect(row.rows[0]?.status).toBe('processing')
  })

  it("200 — an EXHAUSTED park budget derives status 'failed' (retryable)", async () => {
    const owner = await seedUser(pool, scope, 0)
    const campaign = await seedCampaignOwnedBy(pool, scope, owner, 0)
    const conceptId = await insertConcept(pool, campaign.campaignId, owner.userId, 'processing')
    await seedStamp(conceptId, {
      attempt: 4,
      consumedMs: 6 * 60 * 60 * 1000,
      nextResumeAt: null,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaign.campaignId}/character-creation-progress`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<ProgressBody>()
    expect(body.concepts.find((c) => c.userId === owner.userId)?.status).toBe('failed')
  })

  it('200 — a processing concept WITHOUT a stamp carries no park fields (byte-identical shape)', async () => {
    const owner = await seedUser(pool, scope, 0)
    const campaign = await seedCampaignOwnedBy(pool, scope, owner, 0)
    await insertConcept(pool, campaign.campaignId, owner.userId, 'processing')

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaign.campaignId}/character-creation-progress`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<ProgressBody>()
    const entry = body.concepts.find((c) => c.userId === owner.userId)
    expect(entry?.status).toBe('processing')
    expect(entry !== undefined && 'lastErrorClass' in entry).toBe(false)
    expect(entry !== undefined && 'resumeAttempt' in entry).toBe(false)
  })

  it('403 not_campaign_member — stranger', async () => {
    const owner = await seedUser(pool, scope, 0)
    const stranger = await seedUser(pool, scope, 1)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/character-creation-progress`,
      headers: { 'x-mythrun-dev-sub': stranger.devSub },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json<{ code: string }>().code).toBe('not_campaign_member')
  })
})
