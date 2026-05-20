import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool, PoolClient } from 'pg'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { createInvitesRepo } from '../invites.js'
import {
  InviteCapReachedError,
  InviteCreationError,
  InviteTimeoutError,
} from '../invites-errors.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

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

const baseUserInput = (scope: TestScope, idx: number) => ({
  cognitoSub: scope.userSub(idx),
  username: scope.username(idx),
  displayName: scope.displayName(idx),
})

describe('invites repo (integration)', () => {
  let pool: Pool
  let scope: TestScope
  // myth-5jdo: monotonically advancing index — each setup() call within a
  // single test reserves a unique user slot, so the multi-user tests
  // (e.g. campaign-full with 7 users) don't collide on scope.userSub(0).
  let userIdx = 0

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
    scope = makeTestScope('inv')
  })

  afterAll(async () => {
    // myth-5jdo: cleanup only this scope's rows; the seeded dev users
    // + system user + demo world remain intact for the next test file.
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    // myth-5jdo: scoped cleanup replaces resetData.
    await cleanupTestScope(pool, scope)
    userIdx = 0
  })

  async function setup() {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const invites = createInvitesRepo(pool)

    const ownerSlot = userIdx
    userIdx += 1
    const owner = await users.create(pool, baseUserInput(scope, ownerSlot))
    const w = await worlds.create({
      createdBy: owner.id,
      name: scope.worldName(ownerSlot),
      concept: 'concept',
    })
    const c = await campaigns.create({
      worldId: w.id,
      createdBy: owner.id,
      name: scope.campaignName(ownerSlot),
    })
    await campaigns.addMember({ campaignId: c.id, userId: owner.id, role: 'owner' })
    return { users, worlds, campaigns, invites, owner, world: w, campaign: c }
  }

  async function makeExtraUser(): Promise<{ id: string; username: string; displayName: string }> {
    const slot = userIdx
    userIdx += 1
    const users = createUsersRepo(pool)
    const u = await users.create(pool, baseUserInput(scope, slot))
    return { id: u.id, username: u.username, displayName: u.displayName }
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

    it('rethrows non-23505 INSERT errors via the outer catch + ROLLBACK', async () => {
      // Passing a createdBy that doesn't exist → FK violation 23503 on INSERT,
      // which is NOT the invite_code UNIQUE collision the retry loop handles.
      // The error falls through `throw err` in the retry loop, then through
      // the outer catch which fires ROLLBACK and rethrows.
      const { invites, campaign } = await setup()
      const phantomUserId = '019dccef-0000-7000-8000-000000bbbbbb'
      await expect(
        invites.create({ campaignId: campaign.id, createdBy: phantomUserId }),
      ).rejects.toThrow()
    })

    it('rollback failure during outer catch is swallowed; original error rethrown', async () => {
      const fakePool = {
        connect: (): Promise<PoolClient> => {
          const fake = {
            query: (sqlOrConfig: unknown): Promise<{ rows: unknown[]; rowCount: number }> => {
              const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : ''
              if (sql.startsWith('BEGIN')) return Promise.resolve({ rows: [], rowCount: 0 })
              if (sql.includes('FROM campaigns WHERE id')) {
                // Force a generic error in body to enter the catch.
                return Promise.reject(new Error('campaign-select exploded'))
              }
              if (sql.startsWith('ROLLBACK')) {
                return Promise.reject(new Error('rollback exploded'))
              }
              return Promise.resolve({ rows: [], rowCount: 0 })
            },
            release: () => {
              /* no-op */
            },
          }
          return Promise.resolve(fake as unknown as PoolClient)
        },
      } as unknown as Pool
      const invitesRepo = createInvitesRepo(fakePool)
      await expect(
        invitesRepo.create({
          campaignId: '019dccef-0000-7000-8000-000000000001',
          createdBy: '019dccef-0000-7000-8000-000000000002',
        }),
      ).rejects.toThrow(/campaign-select exploded/)
    })

    it('throws InviteCreationError when every INSERT collides on invite_code (fake pool)', async () => {
      // Drive the retry loop to exhaustion: fake pool whose INSERT always
      // rejects with 23505 + campaign_invites_invite_code_key. Loop exits
      // after INVITE_CODE_RETRIES iterations and throws InviteCreationError.
      let inserts = 0
      const fakePool = {
        connect: (): Promise<PoolClient> => {
          const fake = {
            query: (sqlOrConfig: unknown): Promise<{ rows: unknown[]; rowCount: number }> => {
              const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : ''
              if (sql.startsWith('BEGIN')) {
                return Promise.resolve({ rows: [], rowCount: 0 })
              }
              if (sql.includes('FROM campaigns WHERE id')) {
                // Campaign lock check.
                return Promise.resolve({ rows: [{ id: 'whatever' }], rowCount: 1 })
              }
              if (sql.includes('count(*)')) {
                // Cap-check returns under cap.
                return Promise.resolve({ rows: [{ count: '0' }], rowCount: 1 })
              }
              if (sql.startsWith('INSERT INTO campaign_invites')) {
                inserts += 1
                return Promise.reject(
                  Object.assign(new Error('unique violation'), {
                    code: '23505',
                    constraint: 'campaign_invites_invite_code_key',
                  }),
                )
              }
              if (sql.startsWith('ROLLBACK') || sql.startsWith('COMMIT')) {
                return Promise.resolve({ rows: [], rowCount: 0 })
              }
              return Promise.resolve({ rows: [], rowCount: 0 })
            },
            release: () => {
              /* no-op */
            },
          }
          return Promise.resolve(fake as unknown as PoolClient)
        },
      } as unknown as Pool
      const invitesRepo = createInvitesRepo(fakePool)
      await expect(
        invitesRepo.create({
          campaignId: '019dccef-0000-7000-8000-000000000001',
          createdBy: '019dccef-0000-7000-8000-000000000002',
        }),
      ).rejects.toBeInstanceOf(InviteCreationError)
      expect(inserts).toBe(3) // INVITE_CODE_RETRIES
    })
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
      const { invites, campaign, owner } = await setup()
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      const preview = await invites.getCodePreview(inv.inviteCode)
      expect(preview?.campaignName).toBe(campaign.name)
      expect(preview?.ownerUsername).toBe(owner.username)
      expect(preview?.ownerDisplayName).toBe(owner.displayName)
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

  describe('listForCampaign', () => {
    it('returns all non-expired invites ordered ASC by created_at; first row has primary=true', async () => {
      const { invites, campaign, owner } = await setup()
      const a = await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      await new Promise((r) => setTimeout(r, 5))
      const b = await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      const list = await invites.listForCampaign(campaign.id)
      expect(list.map((i) => i.id)).toEqual([a.id, b.id])
      expect(list[0]?.primary).toBe(true)
      expect(list[1]?.primary).toBe(false)
    })

    it('returns empty when the campaign has no active invites', async () => {
      const { invites, campaign } = await setup()
      const list = await invites.listForCampaign(campaign.id)
      expect(list).toEqual([])
    })

    it('excludes expired invites', async () => {
      const { invites, campaign, owner } = await setup()
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      await invites.revoke(inv.inviteCode, campaign.id) // sets expires_at = now()
      const list = await invites.listForCampaign(campaign.id)
      expect(list).toEqual([])
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
      const { invites, campaign, owner } = await setup()
      const player = await makeExtraUser()
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })

      const result = await invites.acceptInvite({ code: inv.inviteCode, userId: player.id })
      expect(result).toEqual({ campaignId: campaign.id, alreadyMember: false })

      const updatedInv = await invites.getByCode(inv.inviteCode)
      expect(updatedInv?.uses).toBe(1)
    })

    it('already-member: returns alreadyMember=true, uses NOT incremented', async () => {
      const { invites, campaigns, campaign, owner } = await setup()
      const player = await makeExtraUser()
      await campaigns.addMember({ campaignId: campaign.id, userId: player.id, role: 'player' })
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })

      const result = await invites.acceptInvite({ code: inv.inviteCode, userId: player.id })
      expect(result).toEqual({ campaignId: campaign.id, alreadyMember: true })

      const updatedInv = await invites.getByCode(inv.inviteCode)
      expect(updatedInv?.uses).toBe(0)
    })

    it('membership trumps revoke: already-member of revoked invite returns alreadyMember=true', async () => {
      const { invites, campaigns, campaign, owner } = await setup()
      const player = await makeExtraUser()
      await campaigns.addMember({ campaignId: campaign.id, userId: player.id, role: 'player' })
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      await invites.revoke(inv.inviteCode, campaign.id)

      const result = await invites.acceptInvite({ code: inv.inviteCode, userId: player.id })
      expect(result).toEqual({ campaignId: campaign.id, alreadyMember: true })
    })

    it('non-member + revoked → revoked: true', async () => {
      const { invites, campaign, owner } = await setup()
      const player = await makeExtraUser()
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      await invites.revoke(inv.inviteCode, campaign.id)

      const result = await invites.acceptInvite({ code: inv.inviteCode, userId: player.id })
      expect(result).toEqual({ revoked: true })
    })

    it('unknown code → notFound: true', async () => {
      const { invites } = await setup()
      const player = await makeExtraUser()
      const result = await invites.acceptInvite({ code: 'NOTACODE0000', userId: player.id })
      expect(result).toEqual({ notFound: true })
    })

    it('campaign full (6 members) → campaignFull: true', async () => {
      const { invites, campaigns, campaign, owner } = await setup()
      for (let i = 0; i < 5; i++) {
        const p = await makeExtraUser()
        await campaigns.addMember({ campaignId: campaign.id, userId: p.id, role: 'player' })
      }
      const newPlayer = await makeExtraUser()
      const inv = await invites.create({ campaignId: campaign.id, createdBy: owner.id })
      const result = await invites.acceptInvite({ code: inv.inviteCode, userId: newPlayer.id })
      expect(result).toEqual({ campaignFull: true, activeMembers: 6 })
    })

    it('campaign deleted mid-accept (FK 23503 on INSERT) → campaignGone: true', async () => {
      // Drive the FK-violation branch by faking the INSERT to reject 23503.
      const fakePool = {
        connect: (): Promise<PoolClient> => {
          const inviteRow = {
            id: '019dccef-0000-7000-8000-000000000005',
            campaign_id: '019dccef-0000-7000-8000-000000000099',
            created_by: '019dccef-0000-7000-8000-000000000001',
            invite_code: 'CODECODECODE',
            max_uses: null,
            uses: 0,
            expires_at: null,
            created_at: new Date(),
          }
          const fake = {
            query: (sqlOrConfig: unknown): Promise<{ rows: unknown[]; rowCount: number }> => {
              const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : ''
              if (sql.startsWith('BEGIN')) return Promise.resolve({ rows: [], rowCount: 0 })
              if (sql.startsWith('SELECT * FROM campaign_invites')) {
                return Promise.resolve({ rows: [inviteRow], rowCount: 1 })
              }
              if (sql.startsWith('SELECT id FROM campaign_members')) {
                // Not a member.
                return Promise.resolve({ rows: [], rowCount: 0 })
              }
              if (sql.startsWith('SELECT count(*)::text AS count FROM campaign_members')) {
                return Promise.resolve({ rows: [{ count: '0' }], rowCount: 1 })
              }
              if (sql.startsWith('INSERT INTO campaign_members')) {
                return Promise.reject(
                  Object.assign(new Error('fk violation'), { code: '23503' }),
                )
              }
              if (sql.startsWith('ROLLBACK') || sql.startsWith('COMMIT')) {
                return Promise.resolve({ rows: [], rowCount: 0 })
              }
              return Promise.resolve({ rows: [], rowCount: 0 })
            },
            release: () => {
              /* no-op */
            },
          }
          return Promise.resolve(fake as unknown as PoolClient)
        },
      } as unknown as Pool
      const invitesRepo = createInvitesRepo(fakePool)
      const result = await invitesRepo.acceptInvite({
        code: 'CODECODECODE',
        userId: '019dccef-0000-7000-8000-000000000001',
      })
      expect(result).toEqual({ campaignGone: true })
    })

    it('non-23503 INSERT error rethrows verbatim (e.g. generic DB error)', async () => {
      const fakePool = {
        connect: (): Promise<PoolClient> => {
          const inviteRow = {
            id: '019dccef-0000-7000-8000-000000000007',
            campaign_id: '019dccef-0000-7000-8000-000000000099',
            created_by: '019dccef-0000-7000-8000-000000000001',
            invite_code: 'GENERICCODE!',
            max_uses: null,
            uses: 0,
            expires_at: null,
            created_at: new Date(),
          }
          const fake = {
            query: (sqlOrConfig: unknown): Promise<{ rows: unknown[]; rowCount: number }> => {
              const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : ''
              if (sql.startsWith('BEGIN')) return Promise.resolve({ rows: [], rowCount: 0 })
              if (sql.startsWith('SELECT * FROM campaign_invites')) {
                return Promise.resolve({ rows: [inviteRow], rowCount: 1 })
              }
              if (sql.startsWith('SELECT id FROM campaign_members')) {
                return Promise.resolve({ rows: [], rowCount: 0 })
              }
              if (sql.startsWith('SELECT count(*)::text AS count FROM campaign_members')) {
                return Promise.resolve({ rows: [{ count: '0' }], rowCount: 1 })
              }
              if (sql.startsWith('INSERT INTO campaign_members')) {
                // Non-23503, non-23505: a generic DB error.
                return Promise.reject(new Error('generic insert error'))
              }
              if (sql.startsWith('ROLLBACK') || sql.startsWith('COMMIT')) {
                return Promise.resolve({ rows: [], rowCount: 0 })
              }
              return Promise.resolve({ rows: [], rowCount: 0 })
            },
            release: () => {
              /* no-op */
            },
          }
          return Promise.resolve(fake as unknown as PoolClient)
        },
      } as unknown as Pool
      const invitesRepo = createInvitesRepo(fakePool)
      await expect(
        invitesRepo.acceptInvite({
          code: 'GENERICCODE!',
          userId: '019dccef-0000-7000-8000-000000000001',
        }),
      ).rejects.toThrow(/generic insert error/)
    })

    it('ON CONFLICT no-op (rowCount=0) on INSERT membership → alreadyMember: true', async () => {
      // A concurrent insert via a different invite code landed the membership
      // row. Our INSERT...ON CONFLICT DO NOTHING returns 0 rows; we COMMIT
      // and report alreadyMember=true without incrementing uses.
      const fakePool = {
        connect: (): Promise<PoolClient> => {
          const inviteRow = {
            id: '019dccef-0000-7000-8000-000000000006',
            campaign_id: '019dccef-0000-7000-8000-000000000099',
            created_by: '019dccef-0000-7000-8000-000000000001',
            invite_code: 'OTHEROTHEROT',
            max_uses: null,
            uses: 0,
            expires_at: null,
            created_at: new Date(),
          }
          const fake = {
            query: (sqlOrConfig: unknown): Promise<{ rows: unknown[]; rowCount: number }> => {
              const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : ''
              if (sql.startsWith('BEGIN')) return Promise.resolve({ rows: [], rowCount: 0 })
              if (sql.startsWith('SELECT * FROM campaign_invites')) {
                return Promise.resolve({ rows: [inviteRow], rowCount: 1 })
              }
              if (sql.startsWith('SELECT id FROM campaign_members')) {
                return Promise.resolve({ rows: [], rowCount: 0 })
              }
              if (sql.startsWith('SELECT count(*)::text AS count FROM campaign_members')) {
                return Promise.resolve({ rows: [{ count: '0' }], rowCount: 1 })
              }
              if (sql.startsWith('INSERT INTO campaign_members')) {
                // ON CONFLICT DO NOTHING with the row already present.
                return Promise.resolve({ rows: [], rowCount: 0 })
              }
              if (sql.startsWith('ROLLBACK') || sql.startsWith('COMMIT')) {
                return Promise.resolve({ rows: [], rowCount: 0 })
              }
              return Promise.resolve({ rows: [], rowCount: 0 })
            },
            release: () => {
              /* no-op */
            },
          }
          return Promise.resolve(fake as unknown as PoolClient)
        },
      } as unknown as Pool
      const invitesRepo = createInvitesRepo(fakePool)
      const result = await invitesRepo.acceptInvite({
        code: 'OTHEROTHEROT',
        userId: '019dccef-0000-7000-8000-000000000001',
      })
      expect(result).toEqual({
        campaignId: '019dccef-0000-7000-8000-000000000099',
        alreadyMember: true,
      })
    })

    it('lock_timeout (55P03) maps to InviteTimeoutError(cause=lock) via fake pool', async () => {
      const fakePool = {
        connect: (): Promise<PoolClient> => {
          const fake = {
            query: (sqlOrConfig: unknown): Promise<{ rows: unknown[]; rowCount: number }> => {
              const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : ''
              if (sql.startsWith('BEGIN')) return Promise.resolve({ rows: [], rowCount: 0 })
              if (sql.startsWith('SELECT * FROM campaign_invites')) {
                return Promise.reject(
                  Object.assign(new Error('lock timeout'), { code: '55P03' }),
                )
              }
              if (sql.startsWith('ROLLBACK')) return Promise.resolve({ rows: [], rowCount: 0 })
              return Promise.resolve({ rows: [], rowCount: 0 })
            },
            release: () => {
              /* no-op */
            },
          }
          return Promise.resolve(fake as unknown as PoolClient)
        },
      } as unknown as Pool
      const invitesRepo = createInvitesRepo(fakePool)
      let caught: unknown
      try {
        await invitesRepo.acceptInvite({
          code: 'LOCKLOCKLOCK',
          userId: '019dccef-0000-7000-8000-000000000001',
        })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(InviteTimeoutError)
      if (caught instanceof InviteTimeoutError) {
        expect(caught.cause).toBe('lock')
        expect(caught.sqlstate).toBe('55P03')
      }
    })

    it('statement_timeout (57014) maps to InviteTimeoutError(cause=statement)', async () => {
      const fakePool = {
        connect: (): Promise<PoolClient> => {
          const fake = {
            query: (sqlOrConfig: unknown): Promise<{ rows: unknown[]; rowCount: number }> => {
              const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : ''
              if (sql.startsWith('BEGIN')) return Promise.resolve({ rows: [], rowCount: 0 })
              if (sql.startsWith('SELECT * FROM campaign_invites')) {
                return Promise.reject(
                  Object.assign(new Error('statement timeout'), { code: '57014' }),
                )
              }
              if (sql.startsWith('ROLLBACK')) return Promise.resolve({ rows: [], rowCount: 0 })
              return Promise.resolve({ rows: [], rowCount: 0 })
            },
            release: () => {
              /* no-op */
            },
          }
          return Promise.resolve(fake as unknown as PoolClient)
        },
      } as unknown as Pool
      const invitesRepo = createInvitesRepo(fakePool)
      let caught: unknown
      try {
        await invitesRepo.acceptInvite({
          code: 'STMTSTMTSTMT',
          userId: '019dccef-0000-7000-8000-000000000001',
        })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(InviteTimeoutError)
      if (caught instanceof InviteTimeoutError) {
        expect(caught.cause).toBe('statement')
        expect(caught.sqlstate).toBe('57014')
      }
    })

    it('ROLLBACK failure during catch is swallowed; original error rethrown', async () => {
      const fakePool = {
        connect: (): Promise<PoolClient> => {
          const fake = {
            query: (sqlOrConfig: unknown): Promise<{ rows: unknown[]; rowCount: number }> => {
              const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : ''
              if (sql.startsWith('BEGIN')) return Promise.resolve({ rows: [], rowCount: 0 })
              if (sql.startsWith('SELECT * FROM campaign_invites')) {
                return Promise.reject(new Error('select-invite exploded'))
              }
              if (sql.startsWith('ROLLBACK')) {
                return Promise.reject(new Error('rollback exploded'))
              }
              return Promise.resolve({ rows: [], rowCount: 0 })
            },
            release: () => {
              /* no-op */
            },
          }
          return Promise.resolve(fake as unknown as PoolClient)
        },
      } as unknown as Pool
      const invitesRepo = createInvitesRepo(fakePool)
      await expect(
        invitesRepo.acceptInvite({
          code: 'RBFAILRBFAIL',
          userId: '019dccef-0000-7000-8000-000000000001',
        }),
      ).rejects.toThrow(/select-invite exploded/)
    })
  })
})

const RACE_ITERATIONS = 50

describe('invites repo — concurrency (separate pool)', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    // myth-5jdo: createTestPool hardcodes max:4 — perfect for race tests.
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('invrace')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    // myth-5jdo: scoped cleanup replaces resetData.
    await cleanupTestScope(pool, scope)
  })

  it('two parallel acceptInvite for same code by SAME user → exactly one membership row, one uses increment', async () => {
    const users = createUsersRepo(pool)
    const worldsRepo = createWorldsRepo(pool)
    const campaignsRepo = createCampaignsRepo(pool)
    const invitesRepo = createInvitesRepo(pool)

    for (let i = 0; i < RACE_ITERATIONS; i++) {
      // myth-5jdo: cleanupTestScope is the per-iteration reset for race
      // tests — it deletes only the scope's rows from the prior loop so
      // we can re-create (owner_i, player_i) without colliding on the
      // unique constraints (cognito_sub, username, invite_code).
      await cleanupTestScope(pool, scope)
      const owner = await users.create(pool, {
        cognitoSub: scope.userSub(2 * i),
        username: scope.username(2 * i),
        displayName: scope.displayName(2 * i),
      })
      const player = await users.create(pool, {
        cognitoSub: scope.userSub(2 * i + 1),
        username: scope.username(2 * i + 1),
        displayName: scope.displayName(2 * i + 1),
      })
      const w = await worldsRepo.create({
        createdBy: owner.id,
        name: scope.worldName(i),
        concept: 'c',
      })
      const c = await campaignsRepo.create({
        worldId: w.id,
        createdBy: owner.id,
        name: scope.campaignName(i),
      })
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

    const owner = await users.create(pool, {
      cognitoSub: scope.userSub(0),
      username: scope.username(0),
      displayName: scope.displayName(0),
    })
    const player = await users.create(pool, {
      cognitoSub: scope.userSub(1),
      username: scope.username(1),
      displayName: scope.displayName(1),
    })
    const w = await worldsRepo.create({
      createdBy: owner.id,
      name: scope.worldName(0),
      concept: 'c',
    })
    const c = await campaignsRepo.create({
      worldId: w.id,
      createdBy: owner.id,
      name: scope.campaignName(0),
    })
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
