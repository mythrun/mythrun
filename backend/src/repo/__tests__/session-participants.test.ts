import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { createCharactersRepo } from '../characters.js'
import { createSessionsRepo } from '../sessions.js'
import { createSessionParticipantsRepo } from '../session-participants.js'
import { createRepo } from '../index.js'
import { NoCharacterForParticipantError } from '../session-participants-errors.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

// session_participants.character_id is RESTRICT-FK to characters and
// session_id CASCADE-FK to sessions. We delete this scope's characters
// explicitly (characters.user_id is RESTRICT-FK to users, so characters must
// go before cleanupTestScope's users delete) — but participant rows pin those
// characters via the RESTRICT-FK, so the participant rows must go first. The
// shared cleanupTestScope then CASCADE-deletes campaigns → sessions (and any
// remaining participant rows) before removing users.
async function cleanupParticipantsScope(p: Pool, scope: TestScope): Promise<void> {
  await p.query(
    `DELETE FROM session_participants
       WHERE character_id IN (
         SELECT id FROM characters
          WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)
       )`,
    [`${scope.id}%`],
  )
  await p.query(
    `DELETE FROM characters
       WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
    [`${scope.id}%`],
  )
  await cleanupTestScope(p, scope)
}

const databaseUrl = process.env.DATABASE_URL ?? ''

const sheetInput = {
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
  // MYT-70 ledger-init fields (empty sub-tables → no per-entry fields).
  startingGold: 0,
  hitDie: 8,
  hitDiceRemaining: 1,
  spellcastingProgression: 'none',
  slotRows: [],
  skills: [],
  features: [],
  equipment: [],
  spells: [],
} as const

describe('repo.sessionParticipants (integration)', () => {
  let pool: Pool
  let scope: TestScope
  let userId: string
  let strangerId: string
  let campaignId: string
  let sessionId: string
  let seededCharacterId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('sessparts')
  })

  afterAll(async () => {
    await cleanupParticipantsScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupParticipantsScope(pool, scope)

    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const characters = createCharactersRepo(pool)
    const sessions = createSessionsRepo(pool)

    // Owner (has a character) + a stranger (member-less, no character).
    const owner = await users.create(pool, {
      cognitoSub: scope.userSub(0),
      username: scope.username(0),
      displayName: scope.displayName(0),
    })
    userId = owner.id

    const stranger = await users.create(pool, {
      cognitoSub: scope.userSub(1),
      username: scope.username(1),
      displayName: scope.displayName(1),
    })
    strangerId = stranger.id

    const world = await worlds.create({
      createdBy: userId,
      name: scope.worldName(0),
      concept: 'A test world.',
    })
    const campaign = await campaigns.create({
      worldId: world.id,
      createdBy: userId,
      name: scope.campaignName(0),
    })
    campaignId = campaign.id

    // Integrate a character for the owner (campaign + user → character_id).
    seededCharacterId = await characters.replaceSubTables({ campaignId, userId, ...sheetInput })

    const session = await sessions.create({ campaignId, sessionNumber: 1 })
    sessionId = session.id
  })

  it('join resolves the joiner character, list/leave round-trip', async () => {
    const repo = createRepo(pool)

    const p = await repo.sessionParticipants.join({ sessionId, campaignId, userId })
    expect(p.characterId).toBe(seededCharacterId) // resolved, not passed in
    expect(p.sessionId).toBe(sessionId)
    expect(p.userId).toBe(userId)
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(p.joinedAt).toBeInstanceOf(Date)

    const list = await repo.sessionParticipants.list(sessionId)
    expect(list.map((x) => x.userId)).toContain(userId)
    expect(list).toHaveLength(1)

    await repo.sessionParticipants.leave(sessionId, userId)
    expect((await repo.sessionParticipants.list(sessionId)).length).toBe(0)
  })

  it('join is idempotent — re-joining returns the existing row', async () => {
    const repo = createRepo(pool)
    const first = await repo.sessionParticipants.join({ sessionId, campaignId, userId })
    const second = await repo.sessionParticipants.join({ sessionId, campaignId, userId })
    expect(second.id).toBe(first.id)
    expect(second.characterId).toBe(seededCharacterId)
    expect((await repo.sessionParticipants.list(sessionId)).length).toBe(1)
  })

  it('join throws NoCharacterForParticipantError for a user with no character in the campaign', async () => {
    const repo = createRepo(pool)
    await expect(
      repo.sessionParticipants.join({ sessionId, campaignId, userId: strangerId }),
    ).rejects.toThrow(/no character/i)
    await expect(
      repo.sessionParticipants.join({ sessionId, campaignId, userId: strangerId }),
    ).rejects.toBeInstanceOf(NoCharacterForParticipantError)
  })

  it('leave is a no-op when the user is not a participant', async () => {
    const repo = createRepo(pool)
    await expect(repo.sessionParticipants.leave(sessionId, userId)).resolves.toBeUndefined()
  })

  it('composes inside repo.transaction (tx.sessionParticipants.join)', async () => {
    const repo = createRepo(pool)
    const p = await repo.transaction((tx) =>
      tx.sessionParticipants.join({ sessionId, campaignId, userId }),
    )
    expect(p).toMatchObject({ sessionId, userId, characterId: seededCharacterId })
  })

  it('join defensively throws when the INSERT returns no row (fake pool)', async () => {
    // `ON CONFLICT ... RETURNING *` always returns exactly one row in real PG, so
    // the `if (!row) throw` arm is unreachable via integration. A fake pool whose
    // character lookup resolves a row but whose INSERT yields zero rows exercises
    // that defensive branch — and exercising it through the back-compat factory
    // covers `createSessionParticipantsRepo`, mirroring the createSessionMessages
    // fake-pool test + the createSessionsRepo pattern.
    let call = 0
    const fakePool = {
      query: () => {
        call += 1
        // 1st query: characters.findUserCharacterForCampaign → resolve a row
        // (only `.id` is read downstream). 2nd query: the INSERT → no row.
        return call === 1
          ? Promise.resolve({ rows: [{ id: 'char-1' }], rowCount: 1 })
          : Promise.resolve({ rows: [], rowCount: 0 })
      },
    } as unknown as Pool
    const repo = createSessionParticipantsRepo(fakePool)
    await expect(
      repo.join({
        sessionId: '019dccef-0000-7000-8000-000000000000',
        campaignId: '019dccef-0000-7000-8000-000000000001',
        userId: '019dccef-0000-7000-8000-000000000002',
      }),
    ).rejects.toThrow(/INSERT returned no row/)
  })
})
