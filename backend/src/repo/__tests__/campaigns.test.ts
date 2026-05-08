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

const baseUserInput = {
  cognitoSub: 'g_owner',
  displayName: 'Owner',
  username: 'owner',
}

async function addCampaignMember(
  pool: Pool,
  campaignId: string,
  userId: string,
  role: 'owner' | 'player',
  inviteAccepted: boolean,
): Promise<void> {
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, $4, $5)`,
    [uuidv7(), campaignId, userId, role, inviteAccepted],
  )
}

describe('campaigns repo (integration)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 1 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetData(pool)
  })

  it('create returns a populated campaign with default status=setup', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })
    const c = await campaigns.create({
      worldId: world.id,
      createdBy: owner.id,
      name: 'My Campaign',
    })
    expect(c.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(c.worldId).toBe(world.id)
    expect(c.createdBy).toBe(owner.id)
    expect(c.status).toBe('setup')
    expect(c.language).toBe('en')
  })

  it('getById returns null for unknown campaign', async () => {
    const campaigns = createCampaignsRepo(pool)
    expect(await campaigns.getById('019dccef-0000-7000-8000-000000000000')).toBeNull()
  })

  it('listByUser returns campaigns where user is an accepted member', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)

    const owner = await users.create(pool, baseUserInput)
    const player = await users.create(pool, {
      ...baseUserInput,
      cognitoSub: 'g_p',
      username: 'player',
    })
    const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })

    const c1 = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'C1' })
    const c2 = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'C2' })

    await addCampaignMember(pool, c1.id, player.id, 'player', true)
    await addCampaignMember(pool, c2.id, player.id, 'player', false)

    const list = await campaigns.listByUser(player.id)
    expect(list.map((c) => c.id)).toEqual([c1.id])
  })

  it('listByUser returns DESC by createdAt', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })
    const a = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'A' })
    await new Promise((r) => setTimeout(r, 5))
    const b = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'B' })
    await addCampaignMember(pool, a.id, owner.id, 'owner', true)
    await addCampaignMember(pool, b.id, owner.id, 'owner', true)
    const list = await campaigns.listByUser(owner.id)
    expect(list.map((c) => c.id)).toEqual([b.id, a.id])
  })

  it('update mutates supplied fields and bumps updatedAt', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })
    const c = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'A' })
    await new Promise((r) => setTimeout(r, 5))
    const updated = await campaigns.update(c.id, { name: 'A renamed', status: 'active' })
    expect(updated.name).toBe('A renamed')
    expect(updated.status).toBe('active')
    expect(updated.updatedAt.getTime()).toBeGreaterThan(c.updatedAt.getTime())
  })

  describe('member methods', () => {
    it('addMember inserts a new row with default invite_accepted=true', async () => {
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const campaigns = createCampaignsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })
      const c = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'M1' })
      const m = await campaigns.addMember({ campaignId: c.id, userId: owner.id, role: 'owner' })
      expect(m.role).toBe('owner')
      expect(m.inviteAccepted).toBe(true)
      expect(m.campaignId).toBe(c.id)
      expect(m.userId).toBe(owner.id)
    })

    it('addMember is idempotent: collision returns the existing row', async () => {
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const campaigns = createCampaignsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })
      const c = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'M2' })
      const first = await campaigns.addMember({ campaignId: c.id, userId: owner.id, role: 'owner' })
      const second = await campaigns.addMember({
        campaignId: c.id,
        userId: owner.id,
        role: 'owner',
      })
      expect(second.id).toBe(first.id)
    })

    it('getMembership returns the row for an existing member', async () => {
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const campaigns = createCampaignsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })
      const c = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'M3' })
      await campaigns.addMember({ campaignId: c.id, userId: owner.id, role: 'owner' })
      const m = await campaigns.getMembership(c.id, owner.id)
      expect(m?.role).toBe('owner')
    })

    it('getMembership returns null for a non-member', async () => {
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const campaigns = createCampaignsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })
      const c = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'M4' })
      const m = await campaigns.getMembership(c.id, '019dccef-0000-7000-8000-000000000000')
      expect(m).toBeNull()
    })

    it('getOwner returns the owner row', async () => {
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const campaigns = createCampaignsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const player = await users.create(pool, {
        ...baseUserInput,
        cognitoSub: 'g_p',
        username: 'player',
      })
      const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })
      const c = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'M5' })
      await campaigns.addMember({ campaignId: c.id, userId: owner.id, role: 'owner' })
      await campaigns.addMember({ campaignId: c.id, userId: player.id, role: 'player' })
      const o = await campaigns.getOwner(c.id)
      expect(o?.userId).toBe(owner.id)
      expect(o?.role).toBe('owner')
    })

    it('listMembers returns members joined with username + displayName, ordered by joinedAt ASC', async () => {
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const campaigns = createCampaignsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const player = await users.create(pool, {
        ...baseUserInput,
        cognitoSub: 'g_p',
        username: 'player',
        displayName: 'Player',
      })
      const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })
      const c = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'M6' })
      await campaigns.addMember({ campaignId: c.id, userId: owner.id, role: 'owner' })
      await new Promise((r) => setTimeout(r, 5))
      await campaigns.addMember({ campaignId: c.id, userId: player.id, role: 'player' })
      const list = await campaigns.listMembers(c.id)
      expect(list.map((m) => m.userId)).toEqual([owner.id, player.id])
      expect(list[0]?.username).toBe('owner')
      expect(list[1]?.displayName).toBe('Player')
      expect(list[1]?.characterId).toBeNull()
    })

    it('listMembers excludes suspended users', async () => {
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const campaigns = createCampaignsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const player = await users.create(pool, {
        ...baseUserInput,
        cognitoSub: 'g_p',
        username: 'player',
      })
      const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })
      const c = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'M7' })
      await campaigns.addMember({ campaignId: c.id, userId: owner.id, role: 'owner' })
      await campaigns.addMember({ campaignId: c.id, userId: player.id, role: 'player' })
      await pool.query('UPDATE users SET suspended_at = now() WHERE id = $1', [player.id])
      const list = await campaigns.listMembers(c.id)
      expect(list.map((m) => m.userId)).toEqual([owner.id])
    })
  })
})
