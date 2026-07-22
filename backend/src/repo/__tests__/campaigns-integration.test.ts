import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createUsersRepo } from '../users.js'
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

  describe('character-integration (Cluster C)', () => {
    async function seedSetupCampaign(
      situationEntries: { index: number; locationEntityId: string; prose: string }[],
      chosenIndex: number | null,
    ): Promise<{ campaignId: string; worldId: string }> {
      await cleanupTestScope(pool, scope)
      const users = createUsersRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      // Raw world INSERT: worlds.create defaults status='generating' and has no
      // starting_situation_entries param; this seed needs status='complete' +
      // pre-populated situation entries for loadIntegrationMeta's JOIN.
      const worldId = uuidv7()
      await pool.query(
        `INSERT INTO worlds (id, created_by, name, concept, status, starting_situation_entries)
         VALUES ($1, $2, $3, 'c', 'complete', $4::jsonb)`,
        [worldId, owner.id, scope.worldName(0), JSON.stringify(situationEntries)],
      )
      const campaignId = uuidv7()
      await pool.query(
        `INSERT INTO campaigns (id, world_id, created_by, name, status, starting_situation_index)
         VALUES ($1, $2, $3, $4, 'setup', $5)`,
        [campaignId, worldId, owner.id, scope.campaignName(0), chosenIndex],
      )
      return { campaignId, worldId }
    }

    it('setActive flips the campaign to active', async () => {
      const { campaignId } = await seedSetupCampaign([], null)
      const campaigns = createCampaignsRepo(pool)
      await campaigns.setActive(campaignId)
      const row = await pool.query<{ status: string }>(
        `SELECT status FROM campaigns WHERE id = $1`, [campaignId],
      )
      expect(row.rows[0]?.status).toBe('active')
    })

    it('loadIntegrationMeta returns notes + world_id + situation entries (JOIN); null for unknown', async () => {
      const entries = [{ index: 0, locationEntityId: uuidv7(), prose: 'At the tavern.' }]
      const { campaignId, worldId } = await seedSetupCampaign(entries, 0)
      const campaigns = createCampaignsRepo(pool)
      const meta = await campaigns.loadIntegrationMeta(campaignId)
      expect(meta).not.toBeNull()
      expect(meta?.world_id).toBe(worldId)
      expect(meta?.starting_situation_index).toBe(0)
      expect(meta?.starting_situation_entries).toEqual(entries)
      expect(meta?.pre_integration_notes).toBeNull()

      expect(
        await campaigns.loadIntegrationMeta('019dccef-0000-7000-8000-000000000000'),
      ).toBeNull()
    })

    it('setPreIntegrationNotesIfSetup writes notes + returns true only while status=setup', async () => {
      const { campaignId } = await seedSetupCampaign([], null)
      const campaigns = createCampaignsRepo(pool)

      const flipped = await campaigns.setPreIntegrationNotesIfSetup(campaignId, 'owner notes')
      expect(flipped).toBe(true)
      const row = await pool.query<{ pre_integration_notes: string | null }>(
        `SELECT pre_integration_notes FROM campaigns WHERE id = $1`, [campaignId],
      )
      expect(row.rows[0]?.pre_integration_notes).toBe('owner notes')

      // Once the campaign leaves 'setup', the conditional UPDATE returns false.
      await campaigns.setActive(campaignId)
      const second = await campaigns.setPreIntegrationNotesIfSetup(campaignId, 'late notes')
      expect(second).toBe(false)
    })
  })

  // data-layer unification: methods absorbed from inline reads/writes in
  // campaign-characters.ts / campaigns.ts / the character-creation processors.
  describe('route/processor read+write methods', () => {
    async function seedOwnerWorldCampaign(opts?: {
      worldStatus?: string
      situationIndex?: number | null
      startingLevel?: number | null
    }): Promise<{ ownerId: string; worldId: string; campaignId: string }> {
      await cleanupTestScope(pool, scope)
      const owner = await createUsersRepo(pool).create(pool, baseUserInput)
      const worldId = uuidv7()
      await pool.query(
        `INSERT INTO worlds (id, created_by, name, concept, status)
         VALUES ($1, $2, $3, 'c', $4)`,
        [worldId, owner.id, scope.worldName(0), opts?.worldStatus ?? 'complete'],
      )
      const campaignId = uuidv7()
      await pool.query(
        `INSERT INTO campaigns (id, world_id, created_by, name, status, starting_situation_index, starting_level)
         VALUES ($1, $2, $3, $4, 'setup', $5, $6)`,
        [
          campaignId,
          worldId,
          owner.id,
          scope.campaignName(0),
          opts?.situationIndex ?? null,
          opts?.startingLevel ?? null,
        ],
      )
      return { ownerId: owner.id, worldId, campaignId }
    }

    it('getWorldId returns the world_id; null for unknown', async () => {
      const { worldId, campaignId } = await seedOwnerWorldCampaign()
      const campaigns = createCampaignsRepo(pool)
      expect(await campaigns.getWorldId(campaignId)).toBe(worldId)
      expect(await campaigns.getWorldId('019dccef-0000-7000-8000-000000000000')).toBeNull()
    })

    it('getWorldAndSituationIndex returns the pair; null for unknown', async () => {
      const { worldId, campaignId } = await seedOwnerWorldCampaign({ situationIndex: 2 })
      const campaigns = createCampaignsRepo(pool)
      expect(await campaigns.getWorldAndSituationIndex(campaignId)).toEqual({
        world_id: worldId,
        starting_situation_index: 2,
        starting_level: null,
      })
      expect(
        await campaigns.getWorldAndSituationIndex('019dccef-0000-7000-8000-000000000000'),
      ).toBeNull()
    })

    it('getWorldAndSituationIndex surfaces starting_level (set → number, unset → null)', async () => {
      const { worldId, campaignId } = await seedOwnerWorldCampaign({
        situationIndex: 1,
        startingLevel: 3,
      })
      const campaigns = createCampaignsRepo(pool)
      expect(await campaigns.getWorldAndSituationIndex(campaignId)).toEqual({
        world_id: worldId,
        starting_situation_index: 1,
        starting_level: 3,
      })

      const { worldId: worldId2, campaignId: noLevel } = await seedOwnerWorldCampaign({
        situationIndex: null,
        startingLevel: null,
      })
      expect(await campaigns.getWorldAndSituationIndex(noLevel)).toEqual({
        world_id: worldId2,
        starting_situation_index: null,
        starting_level: null,
      })
    })

    it('getStartingSituationIndex returns the index; null when unset or unknown', async () => {
      const { campaignId } = await seedOwnerWorldCampaign({ situationIndex: 1 })
      const campaigns = createCampaignsRepo(pool)
      expect(await campaigns.getStartingSituationIndex(campaignId)).toBe(1)

      const { campaignId: noIdx } = await seedOwnerWorldCampaign({ situationIndex: null })
      expect(await campaigns.getStartingSituationIndex(noIdx)).toBeNull()
      expect(
        await campaigns.getStartingSituationIndex('019dccef-0000-7000-8000-000000000000'),
      ).toBeNull()
    })

    it('setStartingSituationIndex writes the chosen index', async () => {
      const { campaignId } = await seedOwnerWorldCampaign({ situationIndex: null })
      const campaigns = createCampaignsRepo(pool)
      await campaigns.setStartingSituationIndex(campaignId, 2)
      expect(await campaigns.getStartingSituationIndex(campaignId)).toBe(2)
    })

    it('archive flips setup→archived (true), no-op on already-archived (false)', async () => {
      const { campaignId } = await seedOwnerWorldCampaign()
      const campaigns = createCampaignsRepo(pool)
      expect(await campaigns.archive(campaignId)).toBe(true)
      const row = await pool.query<{ status: string }>(
        `SELECT status FROM campaigns WHERE id = $1`, [campaignId],
      )
      expect(row.rows[0]?.status).toBe('archived')
      // Second archive matches no setup/active row.
      expect(await campaigns.archive(campaignId)).toBe(false)
    })

    it('renameById updates name + returns true; false for unknown', async () => {
      const { campaignId } = await seedOwnerWorldCampaign()
      const campaigns = createCampaignsRepo(pool)
      expect(await campaigns.renameById(campaignId, 'A New Name')).toBe(true)
      const row = await pool.query<{ name: string }>(
        `SELECT name FROM campaigns WHERE id = $1`, [campaignId],
      )
      expect(row.rows[0]?.name).toBe('A New Name')
      expect(
        await campaigns.renameById('019dccef-0000-7000-8000-000000000000', 'X'),
      ).toBe(false)
    })

    it('setFailed flips the campaign to failed', async () => {
      const { campaignId } = await seedOwnerWorldCampaign()
      const campaigns = createCampaignsRepo(pool)
      await campaigns.setFailed(campaignId)
      const row = await pool.query<{ status: string }>(
        `SELECT status FROM campaigns WHERE id = $1`, [campaignId],
      )
      expect(row.rows[0]?.status).toBe('failed')
    })

    it('findInFlightGenerationForUser true when a generating world is owned, false otherwise', async () => {
      const campaigns = createCampaignsRepo(pool)
      const { ownerId } = await seedOwnerWorldCampaign({ worldStatus: 'generating' })
      expect(await campaigns.findInFlightGenerationForUser(ownerId)).toBe(true)

      const { ownerId: owner2 } = await seedOwnerWorldCampaign({ worldStatus: 'complete' })
      expect(await campaigns.findInFlightGenerationForUser(owner2)).toBe(false)
    })

    it('getPartyRoster joins members → concept status + persisted PC id', async () => {
      const { ownerId, campaignId } = await seedOwnerWorldCampaign()
      const campaigns = createCampaignsRepo(pool)
      await pool.query(
        `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
         VALUES ($1, $2, $3, 'owner', true)`,
        [uuidv7(), campaignId, ownerId],
      )
      // Member with no concept yet → concept_status null, character_id null.
      const roster = await campaigns.getPartyRoster(campaignId)
      expect(roster).toEqual([
        {
          user_id: ownerId,
          display_name: baseUserInput.displayName,
          concept_status: null,
          character_id: null,
        },
      ])
    })

    it('listMembersBasic returns display-only roster ordered by joined_at', async () => {
      const { ownerId, campaignId } = await seedOwnerWorldCampaign()
      const campaigns = createCampaignsRepo(pool)
      await pool.query(
        `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
         VALUES ($1, $2, $3, 'owner', true)`,
        [uuidv7(), campaignId, ownerId],
      )
      expect(await campaigns.listMembersBasic(campaignId)).toEqual([
        { user_id: ownerId, display_name: baseUserInput.displayName },
      ])
    })
  })
})
