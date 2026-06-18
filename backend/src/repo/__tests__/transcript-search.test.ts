// MYT-74d T2: searchTranscript — campaign-scoped FTS over the prose-bearing
// transcript. Real Postgres (scoped fixtures); the corpus is dm_text +
// player_message only (mechanical JSON rows excluded by the partial index).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { transcriptSearchNs } from '../transcript-search.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

interface SeededCampaign {
  campaignId: string
  userId: string
  sessions: string[] // session ids by index
}

// noUncheckedIndexedAccess widens `arr[i]` to `T | undefined`; the repo lint
// config forbids `!` (no-non-null-assertion) in tests too. This guarded
// accessor narrows to `T` for seeded elements we know exist, throwing loudly
// if a fixture index is wrong (a real test-setup bug, not a silent undefined).
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i]
  if (v === undefined) throw new Error(`fixture index ${String(i)} is out of range`)
  return v
}

async function seedCampaign(
  pool: Pool,
  scope: TestScope,
  index: number,
  sessionCount: number,
): Promise<SeededCampaign> {
  const userId = uuidv7()
  const worldId = uuidv7()
  const campaignId = uuidv7()
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, scope.userSub(index), scope.displayName(index), scope.username(index)],
  )
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
    [worldId, userId, scope.worldName(index)],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name) VALUES ($1, $2, $3, $4)`,
    [campaignId, worldId, userId, scope.campaignName(index)],
  )
  const sessions: string[] = []
  for (let n = 0; n < sessionCount; n++) {
    const sessionId = uuidv7()
    await pool.query(
      `INSERT INTO sessions (id, campaign_id, session_number, status) VALUES ($1, $2, $3, 'ended')`,
      [sessionId, campaignId, n + 1],
    )
    sessions.push(sessionId)
  }
  return { campaignId, userId, sessions }
}

async function insertRow(
  pool: Pool,
  sessionId: string,
  seq: number,
  messageType: string,
  content: string,
  userId: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO session_messages (id, session_id, seq, user_id, message_type, content)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uuidv7(), sessionId, seq, userId, messageType, content],
  )
}

describe('transcriptSearch.searchTranscript', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    // Short label: the username helper strips dashes then truncates at 28
    // chars, so a long label would collapse user-0 and user-1 to the same
    // username (the cross-campaign test seeds two users) and trip
    // users_username_lower_key. "tsearch" keeps the per-user index digit.
    scope = makeTestScope('tsearch')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  it('returns campaign-wide matches across sessions, ranked, with <mark> snippets', async () => {
    const c = await seedCampaign(pool, scope, 0, 2)
    await insertRow(pool, at(c.sessions, 0), 0, 'dm_text', 'The harbourmaster eyes the ledger.', null)
    await insertRow(pool, at(c.sessions, 1), 0, 'player_message', 'I ask the harbourmaster about taxes.', c.userId)
    await insertRow(pool, at(c.sessions, 1), 1, 'dm_text', 'A gull cries overhead.', null) // no match

    const repo = transcriptSearchNs(pool)
    const hits = await repo.searchTranscript({
      campaignId: c.campaignId, query: 'harbourmaster', limit: 20, offset: 0,
    })
    expect(hits).toHaveLength(2)
    expect(hits.every((h) => h.snippet.includes('<mark>'))).toBe(true)
    expect(new Set(hits.map((h) => h.sessionNumber))).toEqual(new Set([1, 2]))
  })

  it('narrows to one session via sessionId', async () => {
    const c = await seedCampaign(pool, scope, 0, 2)
    await insertRow(pool, at(c.sessions, 0), 0, 'dm_text', 'A ledger sits on the desk.', null)
    await insertRow(pool, at(c.sessions, 1), 0, 'dm_text', 'Another ledger entry.', null)
    const repo = transcriptSearchNs(pool)
    const hits = await repo.searchTranscript({
      campaignId: c.campaignId, query: 'ledger', sessionId: at(c.sessions, 0), limit: 20, offset: 0,
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.sessionId).toBe(at(c.sessions, 0))
  })

  it('excludes mechanical JSON rows (prose-only corpus)', async () => {
    const c = await seedCampaign(pool, scope, 0, 1)
    await insertRow(pool, at(c.sessions, 0), 0, 'skill_check',
      JSON.stringify({ toolCallId: 'x', input: { skill: 'ledger' }, output: 'ok' }), null)
    await insertRow(pool, at(c.sessions, 0), 1, 'dm_text', 'You read the ledger.', null)
    const repo = transcriptSearchNs(pool)
    const hits = await repo.searchTranscript({
      campaignId: c.campaignId, query: 'ledger', limit: 20, offset: 0,
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.messageType).toBe('dm_text')
    expect(hits.every((h) => !h.content.startsWith('{'))).toBe(true)
  })

  it('isolates by campaign (no cross-campaign bleed) and rejects a foreign sessionId', async () => {
    const a = await seedCampaign(pool, scope, 0, 1)
    const b = await seedCampaign(pool, scope, 1, 1)
    await insertRow(pool, at(a.sessions, 0), 0, 'dm_text', 'The shared beacon glows.', null)
    await insertRow(pool, at(b.sessions, 0), 0, 'dm_text', 'The shared beacon flickers.', null)
    const repo = transcriptSearchNs(pool)
    const hitsA = await repo.searchTranscript({
      campaignId: a.campaignId, query: 'beacon', limit: 20, offset: 0,
    })
    expect(hitsA).toHaveLength(1)
    expect(hitsA[0]?.sessionId).toBe(at(a.sessions, 0))
    const cross = await repo.searchTranscript({
      campaignId: a.campaignId, query: 'beacon', sessionId: at(b.sessions, 0), limit: 20, offset: 0,
    })
    expect(cross).toEqual([])
  })

  it('paginates with a total order — no skips or duplicates across tied rows', async () => {
    const c = await seedCampaign(pool, scope, 0, 1)
    for (let i = 0; i < 4; i++) {
      await insertRow(pool, at(c.sessions, 0), i, 'dm_text', 'beacon', null)
    }
    const repo = transcriptSearchNs(pool)
    const seen = new Set<number>()
    for (let offset = 0; offset < 4; offset++) {
      const page = await repo.searchTranscript({
        campaignId: c.campaignId, query: 'beacon', limit: 1, offset,
      })
      expect(page).toHaveLength(1)
      seen.add(at(page, 0).seq)
    }
    expect(seen).toEqual(new Set([0, 1, 2, 3]))
  })

  it('returns [] for a no-match query', async () => {
    const c = await seedCampaign(pool, scope, 0, 1)
    await insertRow(pool, at(c.sessions, 0), 0, 'dm_text', 'A quiet harbour.', null)
    const repo = transcriptSearchNs(pool)
    expect(await repo.searchTranscript({
      campaignId: c.campaignId, query: 'dragon', limit: 20, offset: 0,
    })).toEqual([])
  })

  it('never surfaces a [[DM CORRECTION marker (public-by-construction invariant)', async () => {
    const c = await seedCampaign(pool, scope, 0, 1)
    await insertRow(pool, at(c.sessions, 0), 0, 'dm_text',
      'On reflection, the ledger was always in the harbourmaster’s desk.', null)
    const repo = transcriptSearchNs(pool)
    const hits = await repo.searchTranscript({
      campaignId: c.campaignId, query: 'ledger', limit: 20, offset: 0,
    })
    expect(hits).toHaveLength(1)
    expect(hits.every((h) => !h.content.includes('[[DM CORRECTION'))).toBe(true)
    expect(hits.every((h) => !h.snippet.includes('[[DM CORRECTION'))).toBe(true)
  })

  it('uses the partial GIN index (EXPLAIN)', async () => {
    const c = await seedCampaign(pool, scope, 0, 1)
    for (let i = 0; i < 40; i++) {
      await insertRow(pool, at(c.sessions, 0), i, 'dm_text', `A beacon on cliff number ${String(i)}.`, null)
    }
    // What this test pins: the repo's LITERAL `message_type IN ('dm_text',
    // 'player_message')` matches migration 029's PARTIAL-index predicate, so a
    // `content_tsv @@ <tsq>` lookup over that predicate is served by
    // idx_session_messages_content_tsv. A parameterised `= ANY($n)` would NOT
    // match the literal partial predicate, leaving the index unusable — that
    // regression is exactly what this EXPLAIN guards.
    //
    // We EXPLAIN the predicate as its own entry point (no campaign/session
    // anchor). With the join present the planner correctly takes the cheaper
    // session-keyed btree path on this tiny single-session table and applies
    // the tsv predicate as a post-filter — a correct plan that never touches
    // the GIN index, so it would prove nothing about the partial-predicate
    // coupling. Campaign scoping / cross-campaign isolation is asserted
    // behaviourally by the other tests; this one isolates the index coupling.
    // SET LOCAL is tx-scoped, so it must share the connection with the EXPLAIN
    // (explicit client + BEGIN/ROLLBACK). EXPLAIN's column is "QUERY PLAN".
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL enable_seqscan = off')
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (FORMAT TEXT)
         SELECT 1 FROM session_messages sm
          WHERE sm.message_type IN ('dm_text', 'player_message')
            AND sm.content_tsv @@ websearch_to_tsquery('english', $1)`,
        ['beacon'],
      )
      await client.query('ROLLBACK')
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n')
      expect(plan).toContain('idx_session_messages_content_tsv')
    } finally {
      client.release()
    }
  })
})
