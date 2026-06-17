// backend/src/repo/__tests__/session-messages-analysis.test.ts
//
// MYT-74b §5 / T8 — the trigger_kind thread + the post-session analysis read.
//
// Two surfaces are exercised against real Postgres (migration 028 added the
// nullable session_messages.trigger_kind column + its closed-set CHECK):
//
//   1. appendDmTurn's optional shared `triggerKind` — written onto EVERY row of
//      the turn (shared, like turn_id), NULL when omitted. The containment
//      verifier filters voice-excerpt selection on this column, so a
//      correction/farewell turn must be structurally identifiable.
//   2. listForAnalysis(sessionId, limit) — the LAST `limit` rows in seq-ASC
//      order, projecting trigger_kind. Bounds the Opus call's input on the
//      largest sessions; the late tail is where voice/affect lives.
//
// Seed chain mirrors session-messages.test.ts: session_id is a CASCADE-FK to
// sessions, user_id is nullable with NO FK — so a campaign + a session is the
// whole seed. cleanupTestScope CASCADE-deletes campaigns → sessions →
// session_messages, then removes the scope's users.

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

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('repo.sessionMessages — trigger_kind + listForAnalysis (integration)', () => {
  let pool: Pool
  let scope: TestScope
  let userId: string
  let sessionId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('sessmsgs-analysis')
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

  it('appendDmTurn with triggerKind writes that kind on EVERY row of the turn', async () => {
    const repo = createRepo(pool)
    const turnId = '019dccef-aaaa-7000-8000-000000000001'
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId,
      rows: [
        { kind: 'dm_text', content: 'You step back toward the door.' },
        { kind: 'dm_text', content: 'The lantern gutters. Until next time.' },
      ],
      seqs: [10, 11],
      triggerKind: 'farewell',
    })

    const res = await pool.query<{ trigger_kind: string | null; turn_ordinal: number }>(
      `SELECT trigger_kind, turn_ordinal FROM session_messages
        WHERE turn_id = $1 ORDER BY turn_ordinal ASC`,
      [turnId],
    )
    // Both rows carry the SAME shared trigger_kind (like turn_id).
    expect(res.rows.map((r) => r.turn_ordinal)).toEqual([0, 1])
    expect(res.rows.map((r) => r.trigger_kind)).toEqual(['farewell', 'farewell'])
  })

  it('appendDmTurn with NO triggerKind writes NULL on every row (the omit → NULL contract)', async () => {
    const repo = createRepo(pool)
    const turnId = '019dccef-aaaa-7000-8000-000000000002'
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId,
      rows: [
        { kind: 'dm_text', content: 'one' },
        { kind: 'dm_text', content: 'two' },
      ],
      seqs: [20, 21],
    })

    const res = await pool.query<{ trigger_kind: string | null }>(
      `SELECT trigger_kind FROM session_messages WHERE turn_id = $1 ORDER BY turn_ordinal ASC`,
      [turnId],
    )
    expect(res.rows.map((r) => r.trigger_kind)).toEqual([null, null])
  })

  it('listForAnalysis returns {seq, messageType, content, triggerKind} in seq-ASC order', async () => {
    const repo = createRepo(pool)

    // A player row (NULL trigger via the single-row append path) then a DM turn
    // tagged 'auto'.
    await repo.sessionMessages.append({
      sessionId,
      seq: 1,
      userId,
      messageType: 'player_message',
      content: 'I greet the smith.',
    })
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId: '019dccef-aaaa-7000-8000-000000000003',
      rows: [
        { kind: 'dm_text', content: 'The smith looks up from the anvil.' },
        { kind: 'dm_text', content: '"Long road behind you?" she asks.' },
      ],
      seqs: [2, 3],
      triggerKind: 'auto',
    })

    const rows = await repo.sessionMessages.listForAnalysis(sessionId, 100)
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(rows.map((r) => r.messageType)).toEqual(['player_message', 'dm_text', 'dm_text'])
    expect(rows.map((r) => r.content)).toEqual([
      'I greet the smith.',
      'The smith looks up from the anvil.',
      '"Long road behind you?" she asks.',
    ])
    // The single-row player append leaves trigger_kind NULL; the DM turn carries 'auto'.
    expect(rows.map((r) => r.triggerKind)).toEqual([null, 'auto', 'auto'])
  })

  it('listForAnalysis keeps only the LAST N rows (oldest dropped) and returns them ascending', async () => {
    const repo = createRepo(pool)
    // Insert 8 rows; request the last 3. The newest-3 window is {6,7,8}, returned
    // seq-ASC. The LIMIT runs over a seq-DESC subquery, so the inner ORDER picks
    // the tail; the outer ORDER restores ascending.
    const total = 8
    const want = 3
    for (let seq = 1; seq <= total; seq++) {
      await repo.sessionMessages.append({
        sessionId,
        seq,
        userId,
        messageType: 'player_message',
        content: `m${String(seq)}`,
      })
    }

    const rows = await repo.sessionMessages.listForAnalysis(sessionId, want)
    expect(rows.map((r) => r.seq)).toEqual([6, 7, 8])
    expect(rows.map((r) => r.content)).toEqual(['m6', 'm7', 'm8'])
    // The oldest rows (1..5) were dropped by the LIMIT.
    expect(rows.some((r) => r.seq <= 5)).toBe(false)
  })

  it('listForAnalysis isolates by session — another session never bleeds in', async () => {
    const repo = createRepo(pool)
    const sessions = createSessionsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const worlds = createWorldsRepo(pool)
    const world = await worlds.create({ createdBy: userId, name: scope.worldName(1), concept: 'Other world.' })
    const campaign = await campaigns.create({ worldId: world.id, createdBy: userId, name: scope.campaignName(1) })
    const other = await sessions.create({ campaignId: campaign.id, sessionNumber: 1 })

    await repo.sessionMessages.append({ sessionId, seq: 1, userId, messageType: 'player_message', content: 'mine' })
    await repo.sessionMessages.append({ sessionId: other.id, seq: 1, userId, messageType: 'player_message', content: 'theirs' })

    const rows = await repo.sessionMessages.listForAnalysis(sessionId, 100)
    expect(rows.map((r) => r.content)).toEqual(['mine'])
  })
})
