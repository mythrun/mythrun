import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { createCharacterConceptsRepo } from '../character-concepts.js'
import { resetData } from './_helpers/reset-data.js'

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

// Helper: bring up a user + world + campaign + campaign_members row so the
// composite FK (campaign_id, user_id) -> campaign_members(campaign_id, user_id)
// on character_concepts is satisfied. Mirrors the fixture pattern used by
// repo/__tests__/characters.test.ts.
async function makeMember(pool: Pool): Promise<{ campaignId: string; userId: string }> {
  const users = createUsersRepo(pool)
  const client = await pool.connect()
  let userId: string
  try {
    await client.query('BEGIN')
    const user = await users.create(client, {
      cognitoSub: `g_player_${uuidv7()}`,
      username: `player_${uuidv7().slice(0, 8)}`,
      displayName: 'Player',
    })
    await client.query('COMMIT')
    userId = user.id
  } finally {
    client.release()
  }

  const worlds = createWorldsRepo(pool)
  const world = await worlds.create({
    createdBy: userId,
    name: 'Test World',
    concept: 'A test world.',
  })

  const campaigns = createCampaignsRepo(pool)
  const campaign = await campaigns.create({
    worldId: world.id,
    createdBy: userId,
    name: 'Test Campaign',
  })

  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaign.id, userId],
  )

  return { campaignId: campaign.id, userId }
}

describe('character_concepts repo (integration)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 1 })
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetData(pool)
  })

  it('upserts a new submitted concept on first call', async () => {
    const repo = createCharacterConceptsRepo(pool)
    const { campaignId, userId } = await makeMember(pool)

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
    const { campaignId, userId } = await makeMember(pool)
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
    const { campaignId, userId } = await makeMember(pool)
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
    const { campaignId, userId } = await makeMember(pool)
    const got = await repo.getByCampaignAndUser(campaignId, userId)
    expect(got).toBeNull()
  })

  it('markProcessing transitions submitted -> processing; markCompleted to completed', async () => {
    const repo = createCharacterConceptsRepo(pool)
    const { campaignId, userId } = await makeMember(pool)
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
})
