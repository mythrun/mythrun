import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { createCharacterConceptsRepo } from '../character-concepts.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

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

// myth-5jdo: monotonic per-call counter so each makeMember() invocation
// produces a distinct user (and therefore a distinct campaign member).
// Tests in this file create one member per it() block; the counter advances
// across iterations so we don't collide on (cognito_sub) within a single
// scope's beforeEach window.
let memberCounter = 0

// Helper: bring up a user + world + campaign + campaign_members row so the
// composite FK (campaign_id, user_id) -> campaign_members(campaign_id, user_id)
// on character_concepts is satisfied.
async function makeMember(
  pool: Pool,
  scope: TestScope,
): Promise<{ campaignId: string; userId: string }> {
  const idx = memberCounter
  memberCounter += 1
  const users = createUsersRepo(pool)
  const client = await pool.connect()
  let userId: string
  try {
    await client.query('BEGIN')
    const user = await users.create(client, {
      cognitoSub: scope.userSub(idx),
      username: scope.username(idx),
      displayName: scope.displayName(idx),
    })
    await client.query('COMMIT')
    userId = user.id
  } finally {
    client.release()
  }

  const worlds = createWorldsRepo(pool)
  const world = await worlds.create({
    createdBy: userId,
    name: scope.worldName(idx),
    concept: 'A test world.',
  })

  const campaigns = createCampaignsRepo(pool)
  const campaign = await campaigns.create({
    worldId: world.id,
    createdBy: userId,
    name: scope.campaignName(idx),
  })

  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaign.id, userId],
  )

  return { campaignId: campaign.id, userId }
}

// myth-gp2c Cluster C: loadCompletedParty's test seeds a characters row, and
// characters.user_id is a RESTRICT-FK to users — it must be deleted BEFORE
// cleanupTestScope's user delete (mirrors characters.test.ts's cleanup order).
async function cleanupConceptsScope(p: Pool, scope: TestScope): Promise<void> {
  await p.query(
    `DELETE FROM characters
       WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
    [`${scope.id}%`],
  )
  await cleanupTestScope(p, scope)
}

describe('character_concepts repo (integration)', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
    scope = makeTestScope('ccon')
  })

  afterAll(async () => {
    // myth-5jdo: cleanup only this scope's rows; the seeded dev users
    // + system user + demo world remain intact for the next test file.
    await cleanupConceptsScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    // myth-5jdo: scoped cleanup replaces resetData. Reset the counter so
    // the next iteration starts from index 0 against a freshly-cleaned scope.
    await cleanupConceptsScope(pool, scope)
    memberCounter = 0
  })

  it('upserts a new submitted concept on first call', async () => {
    const repo = createCharacterConceptsRepo(pool)
    const { campaignId, userId } = await makeMember(pool, scope)

    const row = await repo.upsert({
      campaignId,
      userId,
      conceptText: 'a road-weary cleric who lost their faith',
      situationGroundingText: 'arrived seeking word of an old companion',
      guidedChoices: {},
    })

    expect(row.status).toBe('submitted')
    expect(row.conceptText).toMatch(/cleric/)
  })

  it('replaces the row and resets to submitted on re-upsert from failed', async () => {
    const repo = createCharacterConceptsRepo(pool)
    const { campaignId, userId } = await makeMember(pool, scope)
    await repo.upsert({
      campaignId,
      userId,
      conceptText: 'first try at a half-elf rogue',
      situationGroundingText: 'arrived chasing a stolen heirloom',
      guidedChoices: {},
    })
    await repo.markFailed(campaignId, userId, { code: 'stage_failed', message: 'mocked' })

    const replaced = await repo.upsert({
      campaignId,
      userId,
      conceptText: 'second try with more detail and intent',
      situationGroundingText: 'second situation arrival at the inn',
      guidedChoices: {},
    })

    expect(replaced.status).toBe('submitted')
    expect(replaced.conceptText).toMatch(/second try/)
    expect(replaced.error).toBeNull()
  })

  it('listSubmittedByCampaign returns only submitted rows for the campaign', async () => {
    const repo = createCharacterConceptsRepo(pool)
    const { campaignId, userId } = await makeMember(pool, scope)
    await repo.upsert({
      campaignId,
      userId,
      conceptText: 'a cleric still searching for the right god',
      situationGroundingText: 'arrived to follow up on an old letter',
      guidedChoices: {},
    })
    const rows = await repo.listSubmittedByCampaign(campaignId)
    expect(rows.map((r) => r.userId)).toEqual([userId])

    await repo.markProcessing(campaignId, userId)
    const after = await repo.listSubmittedByCampaign(campaignId)
    expect(after).toEqual([])
  })

  it('getByCampaignAndUser returns null when no row', async () => {
    const repo = createCharacterConceptsRepo(pool)
    const { campaignId, userId } = await makeMember(pool, scope)
    const got = await repo.getByCampaignAndUser(campaignId, userId)
    expect(got).toBeNull()
  })

  it('markProcessing transitions submitted -> processing; markCompleted to completed', async () => {
    const repo = createCharacterConceptsRepo(pool)
    const { campaignId, userId } = await makeMember(pool, scope)
    await repo.upsert({
      campaignId,
      userId,
      conceptText: 'a cleric still searching for the right god',
      situationGroundingText: 'arrived to follow up on an old letter',
      guidedChoices: {},
    })
    await repo.markProcessing(campaignId, userId)
    let row = await repo.getByCampaignAndUser(campaignId, userId)
    expect(row?.status).toBe('processing')
    await repo.markCompleted(campaignId, userId)
    row = await repo.getByCampaignAndUser(campaignId, userId)
    expect(row?.status).toBe('completed')
  })

  // myth-gp2c Cluster C: flipSubmittedToProcessing dropped its explicit-client
  // first-param — it composes inside POST /characters' repo.transaction.
  it('flipSubmittedToProcessing advances submitted -> processing and returns ids', async () => {
    const repo = createCharacterConceptsRepo(pool)
    const { campaignId, userId } = await makeMember(pool, scope)
    const upserted = await repo.upsert({
      campaignId,
      userId,
      conceptText: 'a cleric who needs to be flipped to processing',
      situationGroundingText: 'arrived to follow up on an old letter',
      guidedChoices: {},
    })

    const flipped = await repo.flipSubmittedToProcessing(campaignId, userId)
    expect(flipped).toEqual({ conceptId: upserted.id, userId })

    const row = await repo.getByCampaignAndUser(campaignId, userId)
    expect(row?.status).toBe('processing')

    // Second flip finds no 'submitted' row → null.
    const again = await repo.flipSubmittedToProcessing(campaignId, userId)
    expect(again).toBeNull()
  })

  it('countCompleted counts only completed concepts for the campaign', async () => {
    const repo = createCharacterConceptsRepo(pool)
    const { campaignId, userId } = await makeMember(pool, scope)
    expect(await repo.countCompleted(campaignId)).toBe(0)
    await repo.upsert({
      campaignId,
      userId,
      conceptText: 'a cleric whose concept will be marked completed',
      situationGroundingText: 'arrived to follow up on an old letter',
      guidedChoices: {},
    })
    expect(await repo.countCompleted(campaignId)).toBe(0)
    await repo.markCompleted(campaignId, userId)
    expect(await repo.countCompleted(campaignId)).toBe(1)
  })

  it('markIntegrated flips a concept to the integrated terminal state', async () => {
    const repo = createCharacterConceptsRepo(pool)
    const { campaignId, userId } = await makeMember(pool, scope)
    await repo.upsert({
      campaignId,
      userId,
      conceptText: 'a cleric whose concept will be integrated into the world',
      situationGroundingText: 'arrived to follow up on an old letter',
      guidedChoices: {},
    })
    await repo.markCompleted(campaignId, userId)
    await repo.markIntegrated(campaignId, userId)
    const row = await repo.getByCampaignAndUser(campaignId, userId)
    expect(row?.status).toBe('integrated')
  })

  // myth-gp2c Cluster C: the character-integration party loader (concept ⋈
  // member ⋈ user ⋈ campaign_characters ⋈ characters), filtered to 'completed'.
  it('loadCompletedParty returns completed members joined to their characters row', async () => {
    const repo = createCharacterConceptsRepo(pool)
    const { campaignId, userId } = await makeMember(pool, scope)

    // A 'submitted' (not completed) concept must NOT appear.
    await repo.upsert({
      campaignId,
      userId,
      conceptText: 'a cleric whose concept is still only submitted here',
      situationGroundingText: 'arrived to follow up on an old letter',
      guidedChoices: {},
    })
    expect(await repo.loadCompletedParty(campaignId)).toEqual([])

    // Flip to completed + persist a characters row + join.
    await repo.markCompleted(campaignId, userId)
    const characterId = uuidv7()
    await pool.query(
      `INSERT INTO characters (
         id, user_id, name, level, class, species, background,
         str, dex, con, int, wis, cha,
         hit_points, max_hit_points, armor_class, proficiency_bonus
       )
       VALUES ($1, $2, 'Partygoer', 1, 'cleric', 'human', 'acolyte',
               12, 10, 14, 13, 16, 11, 9, 9, 14, 2)`,
      [characterId, userId],
    )
    await pool.query(
      `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
       VALUES ($1, $2, $3, $4)`,
      [uuidv7(), campaignId, characterId, userId],
    )

    const party = await repo.loadCompletedParty(campaignId)
    expect(party).toHaveLength(1)
    expect(party[0]).toMatchObject({
      user_id: userId,
      character_id: characterId,
      character_name: 'Partygoer',
      character_class: 'cleric',
      character_species: 'human',
    })
  })

  // data-layer unification: methods absorbed from inline reads/writes in
  // campaign-characters.ts and character-creation-processor.ts.
  describe('route/processor read+write methods', () => {
    it('countLocked counts only processing/completed concepts', async () => {
      const repo = createCharacterConceptsRepo(pool)
      const { campaignId, userId } = await makeMember(pool, scope)
      // submitted → not counted.
      await repo.upsert({
        campaignId,
        userId,
        conceptText: 'x'.repeat(30),
        situationGroundingText: 'grounding text long enough',
        guidedChoices: {},
      })
      expect(await repo.countLocked(campaignId)).toBe(0)
      // flip to processing → counted.
      await repo.markProcessing(campaignId, userId)
      expect(await repo.countLocked(campaignId)).toBe(1)
      // flip to completed → still counted.
      await repo.markCompleted(campaignId, userId)
      expect(await repo.countLocked(campaignId)).toBe(1)
    })

    it('listForCampaign returns every concept row (user_id/status/submitted_at/error)', async () => {
      const repo = createCharacterConceptsRepo(pool)
      const { campaignId, userId } = await makeMember(pool, scope)
      await repo.upsert({
        campaignId,
        userId,
        conceptText: 'a'.repeat(30),
        situationGroundingText: 'grounding text long enough',
        guidedChoices: {},
      })
      const rows = await repo.listForCampaign(campaignId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.user_id).toBe(userId)
      expect(rows[0]?.status).toBe('submitted')
      expect(rows[0]?.submitted_at).toBeInstanceOf(Date)
      expect(rows[0]?.error).toBeNull()
    })

    it('getConceptInputs returns concept_text + guided_choices; null for unknown', async () => {
      const repo = createCharacterConceptsRepo(pool)
      const { campaignId, userId } = await makeMember(pool, scope)
      await repo.upsert({
        campaignId,
        userId,
        conceptText: 'a brave knight'.padEnd(30, '.'),
        situationGroundingText: 'grounding text long enough',
        guidedChoices: { foo: 'bar' },
      })
      const inputs = await repo.getConceptInputs(campaignId, userId)
      expect(inputs?.concept_text).toBe('a brave knight'.padEnd(30, '.'))
      expect(inputs?.guided_choices).toEqual({ foo: 'bar' })

      expect(
        await repo.getConceptInputs(campaignId, '019dccef-0000-7000-8000-000000000000'),
      ).toBeNull()
    })

    it('setConceptOutput persists the structured narrative JSONB', async () => {
      const repo = createCharacterConceptsRepo(pool)
      const { campaignId, userId } = await makeMember(pool, scope)
      await repo.upsert({
        campaignId,
        userId,
        conceptText: 'b'.repeat(30),
        situationGroundingText: 'grounding text long enough',
        guidedChoices: {},
      })
      await repo.setConceptOutput(campaignId, userId, JSON.stringify({ summary: 'done' }))
      const row = await pool.query<{ concept_output: unknown }>(
        `SELECT concept_output FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId],
      )
      expect(row.rows[0]?.concept_output).toEqual({ summary: 'done' })
    })
  })

  // myth-3u4a0: a creation job that hangs strands the concept at 'processing'
  // with no live worker (lock renewing forever). resetConcept lets the player
  // recover a STALE 'processing' row while keeping a FRESH one (an active
  // worker's) locked.
  describe('resetConcept stale-processing recovery', () => {
    async function seedProcessing(): Promise<{ campaignId: string; userId: string }> {
      const repo = createCharacterConceptsRepo(pool)
      const { campaignId, userId } = await makeMember(pool, scope)
      await repo.upsert({
        campaignId,
        userId,
        conceptText: 'a road-weary cleric whose creation job will hang here',
        situationGroundingText: 'arrived seeking word of an old companion',
        guidedChoices: {},
      })
      await repo.markProcessing(campaignId, userId)
      return { campaignId, userId }
    }

    it('resets a STALE processing concept (no update within the threshold) → submitted', async () => {
      const repo = createCharacterConceptsRepo(pool)
      const { campaignId, userId } = await seedProcessing()
      // Age the row well past a 10-minute threshold — models the hung job.
      await pool.query(
        `UPDATE character_concepts SET updated_at = now() - interval '1 hour'
          WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId],
      )
      const didReset = await repo.resetConcept(campaignId, userId, 10 * 60_000)
      expect(didReset).toBe(true)
      const row = await repo.getByCampaignAndUser(campaignId, userId)
      expect(row?.status).toBe('submitted')
      expect(row?.error).toBeNull()
    })

    it('REFUSES a FRESH processing concept (an active worker owns it) → still processing', async () => {
      const repo = createCharacterConceptsRepo(pool)
      const { campaignId, userId } = await seedProcessing()
      // updated_at is now() from markProcessing — well inside the threshold.
      const didReset = await repo.resetConcept(campaignId, userId, 10 * 60_000)
      expect(didReset).toBe(false)
      const row = await repo.getByCampaignAndUser(campaignId, userId)
      expect(row?.status).toBe('processing')
    })

    it('still resets a completed concept regardless of staleness (unchanged path)', async () => {
      const repo = createCharacterConceptsRepo(pool)
      const { campaignId, userId } = await seedProcessing()
      await repo.markCompleted(campaignId, userId) // fresh updated_at, terminal state
      const didReset = await repo.resetConcept(campaignId, userId, 10 * 60_000)
      expect(didReset).toBe(true)
      expect((await repo.getByCampaignAndUser(campaignId, userId))?.status).toBe('submitted')
    })
  })
})
