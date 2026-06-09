import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

// MYT-67 T6: `campaigns.countAcceptedMembers` — accepted-only member count for
// the solo gate (spec §4.5). `listMembers` does NOT filter `invite_accepted`,
// so this dedicated count is needed.
describe('campaigns.countAcceptedMembers (integration)', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('campacccount')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  it('counts only accepted members and rises when a pending invite is accepted', async () => {
    await cleanupTestScope(pool, scope)
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)

    const owner = await users.create(pool, {
      cognitoSub: scope.userSub(0),
      displayName: scope.displayName(0),
      username: scope.username(0),
    })
    const player = await users.create(pool, {
      cognitoSub: scope.userSub(1),
      displayName: scope.displayName(1),
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
      name: scope.campaignName(0),
    })

    // Accepted owner + one PENDING (invite_accepted=false) player.
    await campaigns.addMember({ campaignId: c.id, userId: owner.id, role: 'owner', inviteAccepted: true })
    await campaigns.addMember({
      campaignId: c.id,
      userId: player.id,
      role: 'player',
      inviteAccepted: false,
    })

    expect(await campaigns.countAcceptedMembers(c.id)).toBe(1)

    // Accept the pending invite → count rises to 2.
    await pool.query(
      `UPDATE campaign_members SET invite_accepted = true
        WHERE campaign_id = $1 AND user_id = $2`,
      [c.id, player.id],
    )

    expect(await campaigns.countAcceptedMembers(c.id)).toBe(2)
  })

  it('returns 0 for a campaign with no accepted members', async () => {
    const campaigns = createCampaignsRepo(pool)
    expect(
      await campaigns.countAcceptedMembers('019dccef-0000-7000-8000-000000000000'),
    ).toBe(0)
  })
})
