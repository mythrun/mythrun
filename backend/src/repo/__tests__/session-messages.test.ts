import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { createSessionsRepo } from '../sessions.js'
import { createRepo } from '../index.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

// session_messages.session_id is CASCADE-FK to sessions; user_id is nullable
// with NO FK. So the only seed required is a campaign + a session — no
// character integration. cleanupTestScope CASCADE-deletes campaigns → sessions
// → session_messages, then removes the scope's users.
const databaseUrl = process.env.DATABASE_URL ?? ''

describe('repo.sessionMessages (integration)', () => {
  let pool: Pool
  let scope: TestScope
  let userId: string
  let sessionId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('sessmsgs')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupTestScope(pool, scope)

    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const sessions = createSessionsRepo(pool)

    const owner = await users.create(pool, {
      cognitoSub: scope.userSub(0),
      username: scope.username(0),
      displayName: scope.displayName(0),
    })
    userId = owner.id

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
    const session = await sessions.create({ campaignId: campaign.id, sessionNumber: 1 })
    sessionId = session.id
  })

  it('append persists, listAfterSeq returns ordered rows > afterSeq, duplicate seq throws', async () => {
    const repo = createRepo(pool)

    const m1 = await repo.sessionMessages.append({
      sessionId,
      seq: 1,
      userId,
      messageType: 'player_message',
      content: 'hello',
    })
    expect(m1.seq).toBe(1)
    expect(m1.sessionId).toBe(sessionId)
    expect(m1.userId).toBe(userId)
    expect(m1.messageType).toBe('player_message')
    expect(m1.content).toBe('hello')
    expect(m1.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(m1.createdAt).toBeInstanceOf(Date)

    await repo.sessionMessages.append({
      sessionId,
      seq: 2,
      userId,
      messageType: 'player_message',
      content: 'world',
    })

    const after = await repo.sessionMessages.listAfterSeq(sessionId, 1)
    expect(after.map((r) => r.seq)).toEqual([2]) // ordered, > afterSeq only
    expect(after.map((r) => r.content)).toEqual(['world'])

    // UNIQUE(session_id, seq): a duplicate seq throws (caller re-INCRs; binder
    // does NOT retry).
    await expect(
      repo.sessionMessages.append({
        sessionId,
        seq: 2,
        userId,
        messageType: 'player_message',
        content: 'dup',
      }),
    ).rejects.toThrow()
  })

  it('append accepts a null userId (system/DM messages)', async () => {
    const repo = createRepo(pool)
    const m = await repo.sessionMessages.append({
      sessionId,
      seq: 1,
      userId: null,
      messageType: 'dm_message',
      content: 'The tavern falls silent.',
    })
    expect(m.userId).toBeNull()
    expect(m.messageType).toBe('dm_message')
  })

  it('listAfterSeq returns the full ordered history from seq 0', async () => {
    const repo = createRepo(pool)
    await repo.sessionMessages.append({
      sessionId,
      seq: 1,
      userId,
      messageType: 'player_message',
      content: 'one',
    })
    await repo.sessionMessages.append({
      sessionId,
      seq: 2,
      userId,
      messageType: 'player_message',
      content: 'two',
    })
    await repo.sessionMessages.append({
      sessionId,
      seq: 3,
      userId,
      messageType: 'player_message',
      content: 'three',
    })
    const all = await repo.sessionMessages.listAfterSeq(sessionId, 0)
    expect(all.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(all.map((r) => r.content)).toEqual(['one', 'two', 'three'])
  })

  it('composes inside repo.transaction (tx.sessionMessages.append)', async () => {
    const repo = createRepo(pool)
    const m = await repo.transaction((tx) =>
      tx.sessionMessages.append({
        sessionId,
        seq: 1,
        userId,
        messageType: 'player_message',
        content: 'in tx',
      }),
    )
    expect(m).toMatchObject({ sessionId, seq: 1, content: 'in tx' })
  })
})
