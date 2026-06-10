import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { createSessionsRepo } from '../sessions.js'
import { createSessionMessagesRepo } from '../session-messages.js'
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

  it('maxSeq returns 0 when no messages exist, then the durable MAX(seq)', async () => {
    // MYT-65 Task 10: the suspend checkpoint reads this DURABLE max (distinct
    // from the live Redis :seq counter). Empty → 0; after appends → MAX(seq).
    const repo = createRepo(pool)
    expect(await repo.sessionMessages.maxSeq(sessionId)).toBe(0)

    await repo.sessionMessages.append({
      sessionId,
      seq: 1,
      userId,
      messageType: 'player_message',
      content: 'one',
    })
    await repo.sessionMessages.append({
      sessionId,
      seq: 5,
      userId,
      messageType: 'player_message',
      content: 'five',
    })
    // MAX, not COUNT — a gap (seq 1 then 5) still reports 5.
    expect(await repo.sessionMessages.maxSeq(sessionId)).toBe(5)
  })

  it('maxSeq defensively returns 0 when the query yields no row (fake pool)', async () => {
    // `COALESCE(MAX(seq),0)::text` always returns exactly one row in real PG, so
    // the `result.rows[0]?.max ?? 0` fallback arm is unreachable via integration.
    // A fake pool returning zero rows exercises that defensive branch — mirrors
    // the create/addMember fake-pool tests above + sessions.maxSessionNumber's
    // identical idiom.
    const fakePool = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    } as unknown as Pool
    const repo = createSessionMessagesRepo(fakePool)
    expect(await repo.maxSeq('019dccef-0000-7000-8000-000000000000')).toBe(0)
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

  // ─── MYT-68 §3.7 PG-direct transcript ──────────────────────────────────────

  it('appendDmTurn inserts rows with ordinals 0..n-1 + the given seqs', async () => {
    const repo = createRepo(pool)
    const turnId = '019dccef-1111-7000-8000-000000000001'
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId,
      rows: [
        { kind: 'dm_text', content: 'The lock looks old.' },
        { kind: 'skill_check', content: JSON.stringify({ toolCallId: 'c1', input: {}, output: {} }) },
        { kind: 'dm_text', content: 'You slip past.' },
      ],
      seqs: [10, 11, 12],
    })

    const res = await pool.query<{
      seq: number
      message_type: string
      content: string
      turn_ordinal: number
      turn_id: string
      user_id: string | null
    }>(
      `SELECT seq, message_type, content, turn_ordinal, turn_id, user_id
         FROM session_messages WHERE turn_id = $1 ORDER BY turn_ordinal ASC`,
      [turnId],
    )
    expect(res.rows.map((r) => r.turn_ordinal)).toEqual([0, 1, 2])
    expect(res.rows.map((r) => r.seq)).toEqual([10, 11, 12])
    expect(res.rows.map((r) => r.message_type)).toEqual(['dm_text', 'skill_check', 'dm_text'])
    expect(res.rows.map((r) => r.content)).toEqual([
      'The lock looks old.',
      JSON.stringify({ toolCallId: 'c1', input: {}, output: {} }),
      'You slip past.',
    ])
    // DM rows carry no author.
    expect(res.rows.every((r) => r.user_id === null)).toBe(true)
  })

  it('appendDmTurn is idempotent on (turn_id, turn_ordinal) — a re-run inserts nothing', async () => {
    const repo = createRepo(pool)
    const turnId = '019dccef-1111-7000-8000-000000000002'
    const input = {
      sessionId,
      turnId,
      rows: [
        { kind: 'dm_text', content: 'one' },
        { kind: 'dm_text', content: 'two' },
      ],
      seqs: [20, 21],
    }
    expect(await repo.sessionMessages.turnRowsExist(turnId)).toBe(false)
    await repo.sessionMessages.appendDmTurn(input)
    expect(await repo.sessionMessages.turnRowsExist(turnId)).toBe(true)

    const count = async () =>
      Number(
        (
          await pool.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM session_messages WHERE turn_id = $1`,
            [turnId],
          )
        ).rows[0]?.n ?? '0',
      )
    expect(await count()).toBe(2)

    // A BullMQ re-run re-appends the SAME turn — ON CONFLICT DO NOTHING, row
    // count unchanged. Fresh seqs would otherwise UNIQUE-collide; the conflict
    // arbiter is (turn_id, turn_ordinal), so the first commit wins.
    await repo.sessionMessages.appendDmTurn({ ...input, seqs: [22, 23] })
    expect(await count()).toBe(2)
  })

  it('appendDmTurn throws on a rows/seqs length mismatch', async () => {
    const repo = createRepo(pool)
    await expect(
      repo.sessionMessages.appendDmTurn({
        sessionId,
        turnId: '019dccef-1111-7000-8000-000000000003',
        rows: [{ kind: 'dm_text', content: 'a' }],
        seqs: [30, 31],
      }),
    ).rejects.toThrow()
  })

  it('appendDmTurn is a no-op on empty rows', async () => {
    const repo = createRepo(pool)
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId: '019dccef-1111-7000-8000-000000000004',
      rows: [],
      seqs: [],
    })
    expect(await repo.sessionMessages.maxSeq(sessionId)).toBe(0)
  })

  it('listFtContextRows returns player rows up to the watermark + ALL DM rows, seq ASC', async () => {
    const repo = createRepo(pool)
    const turnId = '019dccef-2222-7000-8000-000000000001'

    // player seq 1, 2
    await repo.sessionMessages.append({ sessionId, seq: 1, userId, messageType: 'player_message', content: 'p1' })
    await repo.sessionMessages.append({ sessionId, seq: 2, userId, messageType: 'player_message', content: 'p2' })
    // DM rows seq 3, 4 (turn tA)
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId,
      rows: [
        { kind: 'dm_text', content: 'dm3' },
        { kind: 'dm_text', content: 'dm4' },
      ],
      seqs: [3, 4],
    })
    // player seq 5 (the watermark)
    await repo.sessionMessages.append({ sessionId, seq: 5, userId, messageType: 'player_message', content: 'p5' })
    // player seq 6 ABOVE the watermark — must be excluded
    await repo.sessionMessages.append({ sessionId, seq: 6, userId, messageType: 'player_message', content: 'p6' })
    // a DM row at seq 7 (raced past the next-batch player seqs) — must be included
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId: '019dccef-2222-7000-8000-000000000002',
      rows: [{ kind: 'dm_text', content: 'dm7' }],
      seqs: [7],
    })

    const rows = await repo.sessionMessages.listFtContextRows(sessionId, 5)
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 7])
    expect(rows.map((r) => r.content)).toEqual(['p1', 'p2', 'dm3', 'dm4', 'p5', 'dm7'])
    // player seq 6 (> watermark) excluded; dm7 (> watermark) included.
    expect(rows.some((r) => r.content === 'p6')).toBe(false)
  })

  it('listFtContextRows includes the six MYT-70 ledger message_types (§8)', async () => {
    // Without the IN-list extension the rebuilt FT history silently omits every
    // ledger tool call/result — the FT loses its own mutation record mid-session.
    const repo = createRepo(pool)
    const ledgerKinds = [
      'cast_spell',
      'spend_resource',
      'acquire_resource',
      'adjust_hp',
      'update_condition',
      'take_rest',
    ] as const

    // player watermark row at seq 1
    await repo.sessionMessages.append({ sessionId, seq: 1, userId, messageType: 'player_message', content: 'p1' })
    // one DM turn carrying all six ledger rows, seqs 2..7
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId: '019dccef-3333-7000-8000-000000000001',
      rows: ledgerKinds.map((kind) => ({
        kind,
        content: JSON.stringify({ toolCallId: `c-${kind}`, input: {}, output: { ok: true } }),
      })),
      seqs: [2, 3, 4, 5, 6, 7],
    })

    const rows = await repo.sessionMessages.listFtContextRows(sessionId, 1)
    expect(rows.map((r) => r.messageType)).toEqual(['player_message', ...ledgerKinds])
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('listFtContextRows isolates by session — another session never bleeds in', async () => {
    const repo = createRepo(pool)
    const sessions = createSessionsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const worlds = createWorldsRepo(pool)
    const world = await worlds.create({ createdBy: userId, name: scope.worldName(1), concept: 'Other world.' })
    const campaign = await campaigns.create({ worldId: world.id, createdBy: userId, name: scope.campaignName(1) })
    const other = await sessions.create({ campaignId: campaign.id, sessionNumber: 1 })

    await repo.sessionMessages.append({ sessionId, seq: 1, userId, messageType: 'player_message', content: 'mine' })
    await repo.sessionMessages.append({ sessionId: other.id, seq: 1, userId, messageType: 'player_message', content: 'theirs' })

    const rows = await repo.sessionMessages.listFtContextRows(sessionId, 10)
    expect(rows.map((r) => r.content)).toEqual(['mine'])
  })
})
