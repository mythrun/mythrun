import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

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

  it('create returns a populated campaign with default status=setup', async () => {
    await cleanupTestScope(pool, scope)
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const world = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    const c = await campaigns.create({
      worldId: world.id,
      createdBy: owner.id,
      name: scope.campaignName(0),
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

  it('getById returns the campaign when present', async () => {
    await cleanupTestScope(pool, scope)
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const world = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    const c = await campaigns.create({
      worldId: world.id,
      createdBy: owner.id,
      name: scope.campaignName(0),
    })
    const found = await campaigns.getById(c.id)
    expect(found?.id).toBe(c.id)
  })

  it('loadWorldGenContext returns the campaign + world prep columns (JOIN)', async () => {
    await cleanupTestScope(pool, scope)
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const world = await worlds.create({
      createdBy: owner.id, name: scope.worldName(0), concept: 'a concept',
      tone: 'misted', themes: 'guardianship', era: 'lantern-age', keyTensions: 'spirits chafe',
      geographySummary: 'drowned coast', politicalSummary: 'fractured guilds',
    })
    const c = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: scope.campaignName(0) })

    const ctx = await campaigns.loadWorldGenContext(c.id)
    expect(ctx).not.toBeNull()
    expect(ctx?.campaign_id).toBe(c.id)
    expect(ctx?.world_id).toBe(world.id)
    expect(ctx?.created_by).toBe(owner.id)
    expect(ctx?.concept).toBe('a concept')
    expect(ctx?.tone).toBe('misted')
    expect(ctx?.themes).toBe('guardianship')
    expect(ctx?.era).toBe('lantern-age')
    expect(ctx?.key_tensions).toBe('spirits chafe')
    expect(ctx?.geography_summary).toBe('drowned coast')
    expect(ctx?.political_summary).toBe('fractured guilds')
    expect(ctx?.dev_bypass_access_filter).toBe(false)
  })

  it('loadWorldGenContext returns null for an unknown campaign', async () => {
    const campaigns = createCampaignsRepo(pool)
    expect(await campaigns.loadWorldGenContext('019dccef-0000-7000-8000-000000000000')).toBeNull()
  })

  it('update with empty patch is a no-op (covers all-undefined ?? null branches)', async () => {
    await cleanupTestScope(pool, scope)
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const world = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    const cname = scope.campaignName(0)
    const c = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: cname })
    const updated = await campaigns.update(c.id, {})
    expect(updated.name).toBe(cname)
    expect(updated.status).toBe('setup')
  })

  it('listByUser returns campaigns where user is an accepted member', async () => {
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
    const world = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })

    const c1 = await campaigns.create({
      worldId: world.id,
      createdBy: owner.id,
      name: scope.campaignName(1),
    })
    const c2 = await campaigns.create({
      worldId: world.id,
      createdBy: owner.id,
      name: scope.campaignName(2),
    })

    await addCampaignMember(pool, c1.id, player.id, 'player', true)
    await addCampaignMember(pool, c2.id, player.id, 'player', false)

    const list = await campaigns.listByUser(player.id)
    expect(list.map((c) => c.id)).toEqual([c1.id])
  })

  it('listByUser returns DESC by createdAt', async () => {
    await cleanupTestScope(pool, scope)
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const world = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    const a = await campaigns.create({
      worldId: world.id,
      createdBy: owner.id,
      name: scope.campaignName(1),
    })
    await new Promise((r) => setTimeout(r, 5))
    const b = await campaigns.create({
      worldId: world.id,
      createdBy: owner.id,
      name: scope.campaignName(2),
    })
    await addCampaignMember(pool, a.id, owner.id, 'owner', true)
    await addCampaignMember(pool, b.id, owner.id, 'owner', true)
    const list = await campaigns.listByUser(owner.id)
    expect(list.map((c) => c.id)).toEqual([b.id, a.id])
  })

  it('update mutates supplied fields and bumps updatedAt', async () => {
    await cleanupTestScope(pool, scope)
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const world = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    const c = await campaigns.create({
      worldId: world.id,
      createdBy: owner.id,
      name: scope.campaignName(1),
    })
    await new Promise((r) => setTimeout(r, 5))
    const renamed = `${scope.campaignName(1)}-renamed`
    const updated = await campaigns.update(c.id, { name: renamed, status: 'active' })
    expect(updated.name).toBe(renamed)
    expect(updated.status).toBe('active')
    expect(updated.updatedAt.getTime()).toBeGreaterThan(c.updatedAt.getTime())
  })

  it('update accepts all defined patch fields (covers each COALESCE branch)', async () => {
    await cleanupTestScope(pool, scope)
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const world = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    const c = await campaigns.create({
      worldId: world.id,
      createdBy: owner.id,
      name: scope.campaignName(1),
    })
    const renamed = scope.campaignName(2)
    const updated = await campaigns.update(c.id, {
      name: renamed,
      status: 'archived',
      language: 'en',
    })
    expect(updated.name).toBe(renamed)
    expect(updated.status).toBe('archived')
    expect(updated.language).toBe('en')
  })

  it('update throws when the campaign does not exist', async () => {
    const campaigns = createCampaignsRepo(pool)
    await expect(
      campaigns.update('019dccef-0000-7000-8000-000000000000', { name: 'X' }),
    ).rejects.toThrow(/no campaign with id/)
  })

  it('create defensively throws when INSERT returns no row (fake pool)', async () => {
    const fakePool = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    } as unknown as Pool
    const campaigns = createCampaignsRepo(fakePool)
    await expect(
      campaigns.create({
        worldId: '019dccef-0000-7000-8000-000000000001',
        createdBy: '019dccef-0000-7000-8000-000000000002',
        name: 'X',
      }),
    ).rejects.toThrow(/INSERT returned no row/)
  })

  it('addMember defensively throws when ON CONFLICT then SELECT returns no row (fake pool)', async () => {
    // Real PG always finds the row after ON CONFLICT DO NOTHING because the
    // conflict means a row exists. This defensive branch fires only if the
    // schema invariant has drifted.
    let call = 0
    const fakePool = {
      query: () => {
        call += 1
        // First call: INSERT...ON CONFLICT DO NOTHING returns 0 rows (conflict).
        // Second call: follow-up SELECT also returns 0 rows (impossible normally).
        return Promise.resolve({ rows: [], rowCount: 0 })
      },
    } as unknown as Pool
    const campaigns = createCampaignsRepo(fakePool)
    await expect(
      campaigns.addMember({
        campaignId: '019dccef-0000-7000-8000-000000000001',
        userId: '019dccef-0000-7000-8000-000000000002',
        role: 'player',
      }),
    ).rejects.toThrow(/ON CONFLICT then SELECT returned no row/)
    expect(call).toBe(2)
  })

  it('getOwner returns null when the campaign has no owner row', async () => {
    await cleanupTestScope(pool, scope)
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const world = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    const c = await campaigns.create({
      worldId: world.id,
      createdBy: owner.id,
      name: scope.campaignName(1),
    })
    // No addMember call → no owner row.
    const o = await campaigns.getOwner(c.id)
    expect(o).toBeNull()
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
})
