import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('campaigns repo (integration)', () => {
  let pool: Pool
  let scope: TestScope
  let baseUserInput: { cognitoSub: string; displayName: string; username: string }

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('camp')
    baseUserInput = {
      cognitoSub: scope.userSub(0),
      displayName: scope.displayName(0),
      username: scope.username(0),
    }
  })

  afterAll(async () => {
    // myth-5jdo: cleanup only this scope's rows; the seeded dev users
    // + system user + demo world remain intact for the next test file.
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  describe('member methods', () => {
    it('addMember inserts a new row with default invite_accepted=true', async () => {
      await cleanupTestScope(pool, scope)
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const campaigns = createCampaignsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const world = await worlds.create({
        createdBy: owner.id,
        name: scope.worldName(0),
        concept: 'c',
      })
      const c = await campaigns.create({
        worldId: world.id,
        createdBy: owner.id,
        name: scope.campaignName(1),
      })
      const m = await campaigns.addMember({ campaignId: c.id, userId: owner.id, role: 'owner' })
      expect(m.role).toBe('owner')
      expect(m.inviteAccepted).toBe(true)
      expect(m.campaignId).toBe(c.id)
      expect(m.userId).toBe(owner.id)
    })

    it('addMember is idempotent: collision returns the existing row', async () => {
      await cleanupTestScope(pool, scope)
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const campaigns = createCampaignsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const world = await worlds.create({
        createdBy: owner.id,
        name: scope.worldName(0),
        concept: 'c',
      })
      const c = await campaigns.create({
        worldId: world.id,
        createdBy: owner.id,
        name: scope.campaignName(2),
      })
      const first = await campaigns.addMember({ campaignId: c.id, userId: owner.id, role: 'owner' })
      const second = await campaigns.addMember({
        campaignId: c.id,
        userId: owner.id,
        role: 'owner',
      })
      expect(second.id).toBe(first.id)
    })

    it('getMembership returns the row for an existing member', async () => {
      await cleanupTestScope(pool, scope)
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const campaigns = createCampaignsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const world = await worlds.create({
        createdBy: owner.id,
        name: scope.worldName(0),
        concept: 'c',
      })
      const c = await campaigns.create({
        worldId: world.id,
        createdBy: owner.id,
        name: scope.campaignName(3),
      })
      await campaigns.addMember({ campaignId: c.id, userId: owner.id, role: 'owner' })
      const m = await campaigns.getMembership(c.id, owner.id)
      expect(m?.role).toBe('owner')
    })

    it('getMembership returns null for a non-member', async () => {
      await cleanupTestScope(pool, scope)
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const campaigns = createCampaignsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const world = await worlds.create({
        createdBy: owner.id,
        name: scope.worldName(0),
        concept: 'c',
      })
      const c = await campaigns.create({
        worldId: world.id,
        createdBy: owner.id,
        name: scope.campaignName(4),
      })
      const m = await campaigns.getMembership(c.id, '019dccef-0000-7000-8000-000000000000')
      expect(m).toBeNull()
    })

    it('getOwner returns the owner row', async () => {
      await cleanupTestScope(pool, scope)
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const campaigns = createCampaignsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const player = await users.create(pool, {
        ...baseUserInput,
        cognitoSub: scope.userSub(1),
        username: scope.username(1),
      })
      const world = await worlds.create({
        createdBy: owner.id,
        name: scope.worldName(0),
        concept: 'c',
      })
      const c = await campaigns.create({
        worldId: world.id,
        createdBy: owner.id,
        name: scope.campaignName(5),
      })
      await campaigns.addMember({ campaignId: c.id, userId: owner.id, role: 'owner' })
      await campaigns.addMember({ campaignId: c.id, userId: player.id, role: 'player' })
      const o = await campaigns.getOwner(c.id)
      expect(o?.userId).toBe(owner.id)
      expect(o?.role).toBe('owner')
    })

    it('listMembers returns members joined with username + displayName, ordered by joinedAt ASC', async () => {
      await cleanupTestScope(pool, scope)
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const campaigns = createCampaignsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const playerDisplay = `Player ${scope.id}`
      const player = await users.create(pool, {
        ...baseUserInput,
        cognitoSub: scope.userSub(1),
        username: scope.username(1),
        displayName: playerDisplay,
      })
      const world = await worlds.create({
        createdBy: owner.id,
        name: scope.worldName(0),
        concept: 'c',
      })
      const c = await campaigns.create({
        worldId: world.id,
        createdBy: owner.id,
        name: scope.campaignName(6),
      })
      await campaigns.addMember({ campaignId: c.id, userId: owner.id, role: 'owner' })
      await new Promise((r) => setTimeout(r, 5))
      await campaigns.addMember({ campaignId: c.id, userId: player.id, role: 'player' })
      const list = await campaigns.listMembers(c.id)
      expect(list.map((m) => m.userId)).toEqual([owner.id, player.id])
      expect(list[0]?.username).toBe(baseUserInput.username)
      expect(list[1]?.displayName).toBe(playerDisplay)
      expect(list[1]?.characterId).toBeNull()
    })

    it('listMembers excludes suspended users', async () => {
      await cleanupTestScope(pool, scope)
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const campaigns = createCampaignsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const player = await users.create(pool, {
        ...baseUserInput,
        cognitoSub: scope.userSub(1),
        username: scope.username(1),
      })
      const world = await worlds.create({
        createdBy: owner.id,
        name: scope.worldName(0),
        concept: 'c',
      })
      const c = await campaigns.create({
        worldId: world.id,
        createdBy: owner.id,
        name: scope.campaignName(7),
      })
      await campaigns.addMember({ campaignId: c.id, userId: owner.id, role: 'owner' })
      await campaigns.addMember({ campaignId: c.id, userId: player.id, role: 'player' })
      await pool.query('UPDATE users SET suspended_at = now() WHERE id = $1', [player.id])
      const list = await campaigns.listMembers(c.id)
      expect(list.map((m) => m.userId)).toEqual([owner.id])
    })
  })

  describe('setNameFromUntitled (stage 1 name propagation)', () => {
    // concept-intake (stage 1) sets the campaign owning a world to the
    // LLM-synthesized name, but ONLY while it still carries the create-time
    // 'Untitled' placeholder — a user's PATCH rename must not be clobbered.
    async function seedCampaign(name: string): Promise<{ worldId: string; campaignId: string }> {
      await cleanupTestScope(pool, scope)
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const campaigns = createCampaignsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const world = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
      const c = await campaigns.create({ worldId: world.id, createdBy: owner.id, name })
      return { worldId: world.id, campaignId: c.id }
    }

    it('renames the campaign when it still carries the Untitled placeholder', async () => {
      const { worldId, campaignId } = await seedCampaign('Untitled')
      const campaigns = createCampaignsRepo(pool)
      await campaigns.setNameFromUntitled(worldId, 'Aelmoor')
      const row = await pool.query<{ name: string }>(
        `SELECT name FROM campaigns WHERE id = $1`, [campaignId],
      )
      expect(row.rows[0]?.name).toBe('Aelmoor')
    })

    it('does NOT clobber a campaign that was already renamed away from Untitled', async () => {
      const { worldId, campaignId } = await seedCampaign(scope.campaignName(0))
      const campaigns = createCampaignsRepo(pool)
      await campaigns.setNameFromUntitled(worldId, 'Aelmoor')
      const row = await pool.query<{ name: string }>(
        `SELECT name FROM campaigns WHERE id = $1`, [campaignId],
      )
      expect(row.rows[0]?.name).toBe(scope.campaignName(0))
    })
  })

  // myth-gp2c Cluster C: character-integration campaign methods.
})
