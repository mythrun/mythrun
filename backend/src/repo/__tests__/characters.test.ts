import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { createCharactersRepo } from '../characters.js'
import {
  CharacterAlreadyInCampaignError,
  UserAlreadyHasCharacterInCampaignError,
} from '../characters-errors.js'
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

const baseCharacterInput = {
  name: 'Aila Thornwood',
  level: 1,
  class: 'Ranger',
  species: 'Half-Elf',
  background: 'Outlander',
  str: 12,
  dex: 16,
  con: 13,
  int: 11,
  wis: 14,
  cha: 10,
  hitPoints: 11,
  maxHitPoints: 11,
  armorClass: 14,
  proficiencyBonus: 2,
}

describe('repo.characters', () => {
  let pool: Pool
  let userId: string
  let campaignId: string

  beforeAll(async () => {
    guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl)
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetData(pool)

    const users = createUsersRepo(pool)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const user = await users.create(client, {
        cognitoSub: 'g_player_a',
        username: 'aila',
        displayName: 'Aila',
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
    campaignId = campaign.id
  })

  describe('create', () => {
    it('returns a Character row matching the input', async () => {
      const characters = createCharactersRepo(pool)
      const client = await pool.connect()
      let created
      try {
        await client.query('BEGIN')
        created = await characters.create(client, { userId, ...baseCharacterInput })
        await client.query('COMMIT')
      } finally {
        client.release()
      }

      expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(created.userId).toBe(userId)
      expect(created.name).toBe('Aila Thornwood')
      expect(created.level).toBe(1)
      expect(created.class).toBe('Ranger')
      expect(created.hitPoints).toBe(11)
      expect(created.maxHitPoints).toBe(11)
      expect(created.armorClass).toBe(14)
      expect(created.proficiencyBonus).toBe(2)
      expect(created.entityId).toBeNull()
    })
  })

  describe('addToCampaign', () => {
    it('inserts a join row on first call', async () => {
      const characters = createCharactersRepo(pool)
      const client = await pool.connect()
      let charId: string
      try {
        await client.query('BEGIN')
        const created = await characters.create(client, { userId, ...baseCharacterInput })
        await client.query('COMMIT')
        charId = created.id
      } finally {
        client.release()
      }

      await characters.addToCampaign(campaignId, charId, userId)

      const rows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM campaign_characters
         WHERE campaign_id = $1 AND character_id = $2 AND user_id = $3`,
        [campaignId, charId, userId],
      )
      expect(rows.rows[0]?.count).toBe('1')
    })

    it('throws CharacterAlreadyInCampaignError on duplicate (campaign_id, character_id)', async () => {
      const characters = createCharactersRepo(pool)
      const client = await pool.connect()
      let charId: string
      try {
        await client.query('BEGIN')
        const created = await characters.create(client, { userId, ...baseCharacterInput })
        await client.query('COMMIT')
        charId = created.id
      } finally {
        client.release()
      }

      await characters.addToCampaign(campaignId, charId, userId)

      await expect(characters.addToCampaign(campaignId, charId, userId)).rejects.toBeInstanceOf(
        CharacterAlreadyInCampaignError,
      )
    })

    it('throws UserAlreadyHasCharacterInCampaignError when same user adds a different character', async () => {
      const characters = createCharactersRepo(pool)
      const client = await pool.connect()
      let charA: string
      let charB: string
      try {
        await client.query('BEGIN')
        const a = await characters.create(client, { userId, ...baseCharacterInput })
        const b = await characters.create(client, {
          userId,
          ...baseCharacterInput,
          name: 'Borin Stoneshield',
          class: 'Fighter',
        })
        await client.query('COMMIT')
        charA = a.id
        charB = b.id
      } finally {
        client.release()
      }

      await characters.addToCampaign(campaignId, charA, userId)

      await expect(characters.addToCampaign(campaignId, charB, userId)).rejects.toBeInstanceOf(
        UserAlreadyHasCharacterInCampaignError,
      )
    })
  })
})
