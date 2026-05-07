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
import { createInvitesRepo } from '../invites.js'
import {
  InviteCapReachedError,
  InviteTimeoutError,
} from '../invites-errors.js'
import { resetData } from './_helpers/reset-data.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: (): void => {
      // discard log output
    },
  }
  return pino({ base: { component: 'migrate' } }, sink)
}

const baseUserInput = (suffix: string) => ({
  cognitoSub: `sub-${suffix}`,
  username: `user${suffix}`,
  displayName: `User ${suffix}`,
})

describe('invites repo (integration)', () => {
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

  async function setup(userSuffix = 'owner') {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const invites = createInvitesRepo(pool)

    const owner = await users.create(pool, baseUserInput(userSuffix))
    const w = await worlds.create({ createdBy: owner.id, name: 'World', concept: 'concept' })
    const c = await campaigns.create({ worldId: w.id, createdBy: owner.id, name: 'Campaign' })
    await campaigns.addMember({ campaignId: c.id, userId: owner.id, role: 'owner' })
    return { users, worlds, campaigns, invites, owner, world: w, campaign: c }
  }

  describe('create', () => {
    it('creates an invite with a 12-char base62 code', async () => {
      const { invites, campaign, owner } = await setup()
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      expect(inv.inviteCode).toMatch(/^[A-Za-z0-9]{12}$/)
      expect(inv.campaignId).toBe(campaign.id)
      expect(inv.uses).toBe(0)
      expect(inv.primary).toBe(true)
    })

    it('throws InviteCapReachedError on the 26th invite', async () => {
      const { invites, campaign, owner } = await setup()
      for (let i = 0; i < 25; i++) {
        await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      }
      await expect(
        invites.create({ campaignId: campaign.id, createdBy: owner.id }),
      ).rejects.toBeInstanceOf(InviteCapReachedError)
    }, 10_000)
  })

  describe('getByCode', () => {
    it('returns the invite by code', async () => {
      const { invites, campaign, owner } = await setup()
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      const found = await invites.getByCode(inv.inviteCode)
      expect(found?.id).toBe(inv.id)
    })

    it('returns null on unknown code', async () => {
      const { invites } = await setup()
      const found = await invites.getByCode('NOTACODE0000')
      expect(found).toBeNull()
    })
  })

  describe('getCodePreview', () => {
    it('returns campaign name + owner identity', async () => {
      const { invites, campaign, owner } = await setup('alicia')
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      const preview = await invites.getCodePreview(inv.inviteCode)
      expect(preview?.campaignName).toBe('Campaign')
      expect(preview?.ownerUsername).toBe('useralicia')
      expect(preview?.ownerDisplayName).toBe('User alicia')
      expect(preview?.valid).toBe(true)
    })

    it('returns valid=false on revoked', async () => {
      const { invites, campaign, owner } = await setup()
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      await invites.revoke(inv.inviteCode, campaign.id)
      const preview = await invites.getCodePreview(inv.inviteCode)
      expect(preview?.valid).toBe(false)
    })

    it('returns null when owner is suspended', async () => {
      const { invites, campaign, owner } = await setup()
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      await pool.query('UPDATE users SET suspended_at = now() WHERE id = $1', [owner.id])
      const preview = await invites.getCodePreview(inv.inviteCode)
      expect(preview).toBeNull()
    })
  })

  describe('revoke', () => {
    it('sets expires_at when invite belongs to campaign', async () => {
      const { invites, campaign, owner } = await setup()
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      const result = await invites.revoke(inv.inviteCode, campaign.id)
      expect(result).toEqual({ revoked: true })
      const found = await invites.getByCode(inv.inviteCode)
      expect(found?.expiresAt).toBeInstanceOf(Date)
    })

    it('returns notFoundOrWrongCampaign on unknown code', async () => {
      const { invites, campaign } = await setup()
      const result = await invites.revoke('NOTREAL00000', campaign.id)
      expect(result).toEqual({ notFoundOrWrongCampaign: true })
    })
  })

  describe('acceptInvite', () => {
    it('happy path: adds member, returns alreadyMember=false, increments uses', async () => {
      const { invites, campaign, owner, users } = await setup()
      const player = await users.create(pool, baseUserInput('player'))
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })

      const result = await invites.acceptInvite({ code: inv.inviteCode, userId: player.id })
      expect(result).toEqual({ campaignId: campaign.id, alreadyMember: false })

      const updatedInv = await invites.getByCode(inv.inviteCode)
      expect(updatedInv?.uses).toBe(1)
    })

    it('already-member: returns alreadyMember=true, uses NOT incremented', async () => {
      const { invites, campaigns, campaign, owner, users } = await setup()
      const player = await users.create(pool, baseUserInput('player'))
      await campaigns.addMember({ campaignId: campaign.id, userId: player.id, role: 'player' })
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })

      const result = await invites.acceptInvite({ code: inv.inviteCode, userId: player.id })
      expect(result).toEqual({ campaignId: campaign.id, alreadyMember: true })

      const updatedInv = await invites.getByCode(inv.inviteCode)
      expect(updatedInv?.uses).toBe(0)
    })

    it('membership trumps revoke: already-member of revoked invite returns alreadyMember=true', async () => {
      const { invites, campaigns, campaign, owner, users } = await setup()
      const player = await users.create(pool, baseUserInput('player'))
      await campaigns.addMember({ campaignId: campaign.id, userId: player.id, role: 'player' })
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      await invites.revoke(inv.inviteCode, campaign.id)

      const result = await invites.acceptInvite({ code: inv.inviteCode, userId: player.id })
      expect(result).toEqual({ campaignId: campaign.id, alreadyMember: true })
    })

    it('non-member + revoked → revoked: true', async () => {
      const { invites, campaign, owner, users } = await setup()
      const player = await users.create(pool, baseUserInput('player'))
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      await invites.revoke(inv.inviteCode, campaign.id)

      const result = await invites.acceptInvite({ code: inv.inviteCode, userId: player.id })
      expect(result).toEqual({ revoked: true })
    })

    it('unknown code → notFound: true', async () => {
      const { invites, users } = await setup()
      const player = await users.create(pool, baseUserInput('player'))
      const result = await invites.acceptInvite({ code: 'NOTACODE0000', userId: player.id })
      expect(result).toEqual({ notFound: true })
    })

    it('campaign full (6 members) → campaignFull: true', async () => {
      const { invites, campaigns, campaign, owner, users } = await setup()
      for (let i = 0; i < 5; i++) {
        const p = await users.create(pool, baseUserInput(`p${String(i)}`))
        await campaigns.addMember({ campaignId: campaign.id, userId: p.id, role: 'player' })
      }
      const newPlayer = await users.create(pool, baseUserInput('seventh'))
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      const result = await invites.acceptInvite({ code: inv.inviteCode, userId: newPlayer.id })
      expect(result).toEqual({ campaignFull: true, activeMembers: 6 })
    })
  })
})

const RACE_ITERATIONS = 50

describe('invites repo — concurrency (separate pool)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 4 })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetData(pool)
  })

  it('two parallel acceptInvite for same code by SAME user → exactly one membership row, one uses increment', async () => {
    const users = createUsersRepo(pool)
    const worldsRepo = createWorldsRepo(pool)
    const campaignsRepo = createCampaignsRepo(pool)
    const invitesRepo = createInvitesRepo(pool)

    for (let i = 0; i < RACE_ITERATIONS; i++) {
      await resetData(pool)
      const owner = await users.create(pool, {
        cognitoSub: `sub-race-o-${String(i)}`,
        username: `raceo${String(i)}`,
        displayName: 'Owner',
      })
      const player = await users.create(pool, {
        cognitoSub: `sub-race-p-${String(i)}`,
        username: `racep${String(i)}`,
        displayName: 'Player',
      })
      const w = await worldsRepo.create({ createdBy: owner.id, name: 'W', concept: 'c' })
      const c = await campaignsRepo.create({ worldId: w.id, createdBy: owner.id, name: 'C' })
      await campaignsRepo.addMember({ campaignId: c.id, userId: owner.id, role: 'owner' })
      const inv = await invitesRepo.create({ campaignId: c.id, createdBy: owner.id })

      const [r1, r2] = await Promise.all([
        invitesRepo.acceptInvite({ code: inv.inviteCode, userId: player.id }),
        invitesRepo.acceptInvite({ code: inv.inviteCode, userId: player.id }),
      ])

      const inserts = [r1, r2].filter((r) => 'alreadyMember' in r && !r.alreadyMember)
      const replays = [r1, r2].filter((r) => 'alreadyMember' in r && r.alreadyMember)
      expect(inserts.length).toBe(1)
      expect(replays.length).toBe(1)

      const memberCount = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
        [c.id, player.id],
      )
      expect(Number(memberCount.rows[0]?.count)).toBe(1)

      const updatedInv = await invitesRepo.getByCode(inv.inviteCode)
      expect(updatedInv?.uses).toBe(1)
    }
  }, 60_000)

  it('lock_timeout fires InviteTimeoutError with sqlstate=55P03', async () => {
    const users = createUsersRepo(pool)
    const worldsRepo = createWorldsRepo(pool)
    const campaignsRepo = createCampaignsRepo(pool)
    const fastInvites = createInvitesRepo(pool, { lockTimeoutMs: 200 })
    const invitesRepo = createInvitesRepo(pool)

    const owner = await users.create(pool, { cognitoSub: 'sub-lock-o', username: 'locko', displayName: 'O' })
    const player = await users.create(pool, { cognitoSub: 'sub-lock-p', username: 'lockp', displayName: 'P' })
    const w = await worldsRepo.create({ createdBy: owner.id, name: 'W', concept: 'c' })
    const c = await campaignsRepo.create({ worldId: w.id, createdBy: owner.id, name: 'C' })
    await campaignsRepo.addMember({ campaignId: c.id, userId: owner.id, role: 'owner' })
    const inv = await invitesRepo.create({ campaignId: c.id, createdBy: owner.id })

    const holder = await pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT * FROM campaign_invites WHERE id = $1 FOR NO KEY UPDATE', [inv.id])

      let caught: unknown
      try {
        await fastInvites.acceptInvite({ code: inv.inviteCode, userId: player.id })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(InviteTimeoutError)
      if (caught instanceof InviteTimeoutError) {
        expect(caught.cause).toBe('lock')
        expect(caught.sqlstate).toBe('55P03')
      }
    } finally {
      await holder.query('ROLLBACK').catch(() => {
        // ignore — connection may already be in a failed state
      })
      holder.release()
    }
  }, 10_000)
})
