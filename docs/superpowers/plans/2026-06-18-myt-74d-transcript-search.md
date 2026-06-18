# MYT-74d — Transcript Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give players a relevance-ranked, highlighted full-text lookback over their campaign's player-facing transcript (`GET /api/campaigns/:campaignId/transcript/search`).

**Architecture:** Postgres FTS — a generated `tsvector` column on `session_messages` + a **partial** GIN index over the prose-bearing message types (`dm_text`, `player_message`); a composable repo read (`transcriptSearchNs.searchTranscript`) using `websearch_to_tsquery` + `ts_rank` + `ts_headline`; a member-readable Fastify route that resolves speaker attribution and shapes the wire result. No LLM, no embeddings — mechanical retrieval (ZFC's computation exception).

**Tech Stack:** Node 24 + TypeScript strict, Postgres (FTS), Fastify, Zod, Vitest. Repo = composable binders (`fooNs(c: ClientLike)`); tests = scoped fixtures against `mythrun_test`.

**Spec:** `docs/superpowers/specs/2026-06-17-myt-74d-transcript-search-design.md`

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `backend/migrations/029_session_messages_fts.sql` | Generated `content_tsv` column + partial GIN index | T1 |
| `backend/src/db/__tests__/migration-029.test.ts` | Migration shape + generated-column population assertions | T1 |
| `backend/src/db/__tests__/migrate-schema.test.ts` | **Modify** — pin 029 in the migration list + index name | T1 |
| `backend/src/repo/transcript-search.ts` | `transcriptSearchNs` + `searchTranscript` + `SEARCHABLE_MESSAGE_TYPES` + `TranscriptHit` | T2 |
| `backend/src/repo/index.ts` | **Modify** — register `transcriptSearch` in `bindTx` | T2 |
| `backend/src/repo/__tests__/transcript-search.test.ts` | Repo read: ranking, paging, isolation, prose-only, EXPLAIN | T2 |
| `backend/src/session/attribution.ts` | `DEPARTED_AUTHOR_NAME`, `DM_SPEAKER_NAME`, `resolveSpeaker` | T3 |
| `backend/src/routes/ws-session.ts` | **Modify** — import `DEPARTED_AUTHOR_NAME` (drop local const) | T3 |
| `backend/src/session/__tests__/attribution.test.ts` | `resolveSpeaker` three-way | T3 |
| `backend/src/routes/campaigns.ts` | **Modify** — query schema + route handler | T4 |
| `backend/src/contract/backend-routes.ts` | **Modify** — route-drift list | T4 |
| `backend/dev-tool/verify-registry.ts` | **Modify** — `EXEMPT_ROUTES` | T4 |
| ~~`backend/dev-tool/coverage.json`~~ | **Do NOT touch** — pipeline-only manifest (`dev-tool:check` validates vs `PIPELINE_ROUTES`); a non-pipeline route here fails the gate | — |
| `backend/src/routes/__tests__/transcript-search-route.test.ts` | Route: auth, shape, attribution, 400/403, paging | T4 |

**Dependencies:** T2 depends on T1 (the `content_tsv` column must exist for repo tests). T4 depends on T2 + T3. T3 is independent. **Order: T1 → T2 → T3 → T4.**

**Commands:** all run from `backend/`. After T1's migration lands, run `pnpm db:migrate:test` before any repo/route test (tests hit `mythrun_test`). Lint via `pnpm lint` (`eslint src` — per-file lint skips type-aware rules). The dev-tool TS (`coverage.json`/`verify-registry.ts`) is checked by the dev-tool-verifier, not `pnpm typecheck`.

---

## Task 1: Migration 029 — generated tsvector + partial GIN index

**Files:**
- Create: `backend/migrations/029_session_messages_fts.sql`
- Create: `backend/src/db/__tests__/migration-029.test.ts`
- Modify: `backend/src/db/__tests__/migrate-schema.test.ts` (migration list + `EXPECTED_IDX_NAMES`)

- [ ] **Step 1: Write the failing migration test**

Create `backend/src/db/__tests__/migration-029.test.ts` (models `migration-028.test.ts` — runs against the already-migrated `mythrun_test`, asserts live shape):

```ts
// MYT-74d T1: migration 029 adds session_messages.content_tsv (a generated
// tsvector) + a PARTIAL GIN index over the prose-bearing message types
// (dm_text, player_message). Runs against the already-migrated mythrun_test DB.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from './guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

async function seedSession(pool: Pool, scope: TestScope): Promise<string> {
  const userId = uuidv7()
  const worldId = uuidv7()
  const campaignId = uuidv7()
  const sessionId = uuidv7()
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
  )
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
    [worldId, userId, scope.worldName(0)],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name) VALUES ($1, $2, $3, $4)`,
    [campaignId, worldId, userId, scope.campaignName(0)],
  )
  await pool.query(
    `INSERT INTO sessions (id, campaign_id, session_number, status) VALUES ($1, $2, 1, 'active')`,
    [sessionId, campaignId],
  )
  return sessionId
}

describe('migration 029 — session_messages.content_tsv FTS', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('migration029')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  it('adds session_messages.content_tsv (tsvector, generated)', async () => {
    const { rows } = await pool.query<{
      column_name: string
      data_type: string
      is_generated: string
    }>(
      `SELECT column_name, data_type, is_generated
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'session_messages'
          AND column_name = 'content_tsv'`,
    )
    expect(rows).toEqual([
      { column_name: 'content_tsv', data_type: 'tsvector', is_generated: 'ALWAYS' },
    ])
  })

  it('creates a partial GIN index over the prose-bearing types', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_session_messages_content_tsv'`,
    )
    expect(rows).toHaveLength(1)
    const def = rows[0]?.indexdef ?? ''
    expect(def).toContain('USING gin')
    expect(def).toContain('content_tsv')
    // Partial predicate restricts to the two prose-bearing types.
    expect(def).toContain("message_type")
    expect(def).toContain("'dm_text'")
    expect(def).toContain("'player_message'")
  })

  it('auto-populates content_tsv and matches a term via websearch_to_tsquery', async () => {
    const sessionId = await seedSession(pool, scope)
    await pool.query(
      `INSERT INTO session_messages (id, session_id, seq, message_type, content)
       VALUES ($1, $2, 0, 'dm_text', 'The harbourmaster guards the ledger.')`,
      [uuidv7(), sessionId],
    )
    const { rows } = await pool.query<{ match: boolean }>(
      `SELECT (content_tsv @@ websearch_to_tsquery('english', 'harbourmaster')) AS match
         FROM session_messages WHERE session_id = $1`,
      [sessionId],
    )
    expect(rows).toEqual([{ match: true }])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/db/__tests__/migration-029.test.ts`
Expected: FAIL — `content_tsv` column / `idx_session_messages_content_tsv` index do not exist.

- [ ] **Step 3: Write the migration**

Create `backend/migrations/029_session_messages_fts.sql`:

```sql
-- 029_session_messages_fts.sql — MYT-74d
-- Full-text search over the player-facing transcript. A generated tsvector
-- column (auto-maintained on insert; the transcript is append-only) + a PARTIAL
-- GIN index over only the prose-bearing message types — mechanical JSON rows
-- (skill_check/dice_roll/world_fact_lookup/ledger) store JSON.stringify blobs,
-- not prose, and are excluded from search (D7). The partial predicate MUST stay
-- in lockstep with SEARCHABLE_MESSAGE_TYPES in repo/transcript-search.ts (an
-- EXPLAIN test pins the coupling). No CONCURRENTLY: the migration runner wraps
-- each file in a transaction. Lands pre-launch against an empty/near-empty
-- table, so the column add (full rewrite) + GIN build are effectively free.
ALTER TABLE session_messages
  ADD COLUMN content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX idx_session_messages_content_tsv
  ON session_messages USING GIN (content_tsv)
  WHERE message_type IN ('dm_text', 'player_message');
```

- [ ] **Step 4: Pin the migration in `migrate-schema.test.ts`**

In `backend/src/db/__tests__/migrate-schema.test.ts`, add `029` to the migration list (after `'028_session_messages_trigger_kind.sql',`):

```ts
      '028_session_messages_trigger_kind.sql',
      '029_session_messages_fts.sql',
    ])
```

And insert the index name into `EXPECTED_IDX_NAMES` in **sorted** position (between `'idx_relationships_target'` and `'idx_session_messages_session_seq'` — `content` sorts before `session`):

```ts
  'idx_relationships_target',
  'idx_session_messages_content_tsv',
  'idx_session_messages_session_seq',
```

- [ ] **Step 5: Apply the migration to the test DB**

Run: `pnpm db:migrate:test`
Expected: `029_session_messages_fts.sql` applied.

- [ ] **Step 6: Run both tests to verify they pass**

Run: `pnpm vitest run src/db/__tests__/migration-029.test.ts src/db/__tests__/migrate-schema.test.ts`
Expected: PASS (migration shape correct; pinned lists match the live schema).

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/029_session_messages_fts.sql \
  backend/src/db/__tests__/migration-029.test.ts \
  backend/src/db/__tests__/migrate-schema.test.ts
git commit -m "feat(MYT-74d): migration 029 — session_messages FTS tsvector + partial GIN index"
```

---

## Task 2: Repo `searchTranscript` + namespace registration

**Files:**
- Create: `backend/src/repo/transcript-search.ts`
- Modify: `backend/src/repo/index.ts` (register `transcriptSearch` in `bindTx`)
- Create: `backend/src/repo/__tests__/transcript-search.test.ts`

- [ ] **Step 1: Write the failing repo test**

Create `backend/src/repo/__tests__/transcript-search.test.ts`. The helper seeds the FK chain + transcript rows; tests cover campaign-wide ranking, the `sessionId` filter, snippet highlighting, total-order pagination, prose-only corpus, cross-campaign isolation, and the EXPLAIN partial-index guard:

```ts
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

// users -> worlds -> campaigns -> N sessions. Returns ids for row inserts.
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
    scope = makeTestScope('transcript-search')
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
    await insertRow(pool, c.sessions[0]!, 0, 'dm_text', 'The harbourmaster eyes the ledger.', null)
    await insertRow(pool, c.sessions[1]!, 0, 'player_message', 'I ask the harbourmaster about taxes.', c.userId)
    await insertRow(pool, c.sessions[1]!, 1, 'dm_text', 'A gull cries overhead.', null) // no match

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
    await insertRow(pool, c.sessions[0]!, 0, 'dm_text', 'A ledger sits on the desk.', null)
    await insertRow(pool, c.sessions[1]!, 0, 'dm_text', 'Another ledger entry.', null)
    const repo = transcriptSearchNs(pool)
    const hits = await repo.searchTranscript({
      campaignId: c.campaignId, query: 'ledger', sessionId: c.sessions[0], limit: 20, offset: 0,
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.sessionId).toBe(c.sessions[0])
  })

  it('excludes mechanical JSON rows (prose-only corpus)', async () => {
    const c = await seedCampaign(pool, scope, 0, 1)
    // A skill_check row whose JSON content literally contains the term.
    await insertRow(pool, c.sessions[0]!, 0, 'skill_check',
      JSON.stringify({ toolCallId: 'x', input: { skill: 'ledger' }, output: 'ok' }), null)
    await insertRow(pool, c.sessions[0]!, 1, 'dm_text', 'You read the ledger.', null)
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
    await insertRow(pool, a.sessions[0]!, 0, 'dm_text', 'The shared beacon glows.', null)
    await insertRow(pool, b.sessions[0]!, 0, 'dm_text', 'The shared beacon flickers.', null)
    const repo = transcriptSearchNs(pool)
    const hitsA = await repo.searchTranscript({
      campaignId: a.campaignId, query: 'beacon', limit: 20, offset: 0,
    })
    expect(hitsA).toHaveLength(1)
    expect(hitsA[0]?.sessionId).toBe(a.sessions[0])
    // A sessionId from campaign B passed with campaignId A → no rows.
    const cross = await repo.searchTranscript({
      campaignId: a.campaignId, query: 'beacon', sessionId: b.sessions[0], limit: 20, offset: 0,
    })
    expect(cross).toEqual([])
  })

  it('paginates with a total order — no skips or duplicates across tied rows', async () => {
    const c = await seedCampaign(pool, scope, 0, 1)
    // Four rows that tie on rank (same single-term content) — pagination must
    // still be deterministic via the (session_id, seq) tiebreaker.
    for (let i = 0; i < 4; i++) {
      await insertRow(pool, c.sessions[0]!, i, 'dm_text', 'beacon', null)
    }
    const repo = transcriptSearchNs(pool)
    const seen = new Set<number>()
    for (let offset = 0; offset < 4; offset++) {
      const page = await repo.searchTranscript({
        campaignId: c.campaignId, query: 'beacon', limit: 1, offset,
      })
      expect(page).toHaveLength(1)
      seen.add(page[0]!.seq)
    }
    expect(seen).toEqual(new Set([0, 1, 2, 3]))
  })

  it('returns [] for a no-match query', async () => {
    const c = await seedCampaign(pool, scope, 0, 1)
    await insertRow(pool, c.sessions[0]!, 0, 'dm_text', 'A quiet harbour.', null)
    const repo = transcriptSearchNs(pool)
    expect(await repo.searchTranscript({
      campaignId: c.campaignId, query: 'dragon', limit: 20, offset: 0,
    })).toEqual([])
  })

  it('never surfaces a [[DM CORRECTION marker (public-by-construction invariant)', async () => {
    // A correction-triggered DM row persists the FT's player-facing RETCON
    // PROSE, not the [[DM CORRECTION:]] input direction (which never reaches
    // persisted content). This pins that invariant: a regression that ever
    // persisted the marker would surface it here.
    const c = await seedCampaign(pool, scope, 0, 1)
    await insertRow(pool, c.sessions[0]!, 0, 'dm_text',
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
    await insertRow(pool, c.sessions[0]!, 0, 'dm_text', 'A beacon on the cliff.', null)
    const { rows } = await pool.query<{ plan: string }>(
      `EXPLAIN (FORMAT TEXT)
       SELECT 1 FROM session_messages sm
         JOIN sessions s ON s.id = sm.session_id
         CROSS JOIN LATERAL websearch_to_tsquery('english', $2) AS q(tsq)
        WHERE s.campaign_id = $1
          AND sm.message_type IN ('dm_text', 'player_message')
          AND sm.content_tsv @@ q.tsq`,
      [c.campaignId, 'beacon'],
    )
    const plan = rows.map((r) => r.plan).join('\n')
    expect(plan).toContain('idx_session_messages_content_tsv')
  })
})
```

> Note: the EXPLAIN test seeds only one tiny row, so the planner could pick a seq scan on a near-empty table. If the assertion is flaky on an empty table, seed ~30 throwaway `dm_text` rows first (or `SET LOCAL enable_seqscan = off` inside the test transaction) so the index path is chosen — keep whichever the implementer confirms is stable. The intent: pin that the query's `message_type IN (...)` literal matches the partial-index predicate.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/repo/__tests__/transcript-search.test.ts`
Expected: FAIL — `../transcript-search.js` does not exist.

- [ ] **Step 3: Implement the repo namespace**

Create `backend/src/repo/transcript-search.ts`:

```ts
import { type Pool } from 'pg'
import type { ClientLike } from './_types.js'

/**
 * The prose-bearing message types — the searchable corpus (MYT-74d, D7).
 * Mechanical types (skill_check/dice_roll/world_fact_lookup/ledger) store
 * JSON.stringify blobs, not prose, so they are excluded from search.
 *
 * This list MUST stay in lockstep with the partial-index predicate in
 * migration 029 (`WHERE message_type IN ('dm_text', 'player_message')`) — the
 * SQL below inlines the same literal so the planner uses the partial index
 * (a parameterised `= ANY($n)` would NOT match the literal predicate). The
 * EXPLAIN repo test pins this coupling.
 */
export const SEARCHABLE_MESSAGE_TYPES = ['dm_text', 'player_message'] as const

export interface TranscriptHit {
  readonly sessionId: string
  readonly sessionNumber: number
  readonly seq: number
  readonly messageType: string
  readonly userId: string | null // resolved to a speaker by the route
  readonly content: string
  readonly snippet: string // ts_headline highlight
  readonly createdAt: Date
}

export interface SearchTranscriptArgs {
  readonly campaignId: string
  readonly query: string // the player's raw query
  readonly sessionId?: string // optional narrow to one session
  readonly limit: number
  readonly offset: number
}

interface TranscriptHitDbRow {
  session_id: string
  session_number: number
  seq: number
  message_type: string
  user_id: string | null
  content: string
  snippet: string
  created_at: Date
}

// Composable binder — see sessionMessagesNs for the pattern. A single read,
// so it binds cleanly on both the pool and tx surfaces.
export function transcriptSearchNs(c: ClientLike) {
  return {
    // FTS over the prose-bearing transcript. ts_headline runs in the OUTER
    // query over the rank-filtered-and-paginated page (never the full match
    // set). The ORDER BY is a TOTAL order (a single appendDmTurn shares one
    // created_at, and terse rows tie on rank) via the (session_id, seq)
    // tiebreaker, so LIMIT/OFFSET pagination can't skip or duplicate. The
    // message_type literal matches migration 029's partial-index predicate.
    searchTranscript: async (args: SearchTranscriptArgs): Promise<readonly TranscriptHit[]> => {
      const result = await c.query<TranscriptHitDbRow>(
        `SELECT sub.session_id, sub.session_number, sub.seq, sub.message_type,
                sub.user_id, sub.content,
                ts_headline('english', sub.content, sub.tsq,
                  'StartSel=<mark>,StopSel=</mark>,MaxFragments=2,MaxWords=18,MinWords=5') AS snippet,
                sub.created_at
           FROM (
             SELECT sm.session_id, s.session_number, sm.seq, sm.message_type,
                    sm.user_id, sm.content, sm.created_at, q.tsq,
                    ts_rank(sm.content_tsv, q.tsq) AS rank
               FROM session_messages sm
               JOIN sessions s ON s.id = sm.session_id
               CROSS JOIN LATERAL websearch_to_tsquery('english', $2) AS q(tsq)
              WHERE s.campaign_id = $1
                AND ($3::uuid IS NULL OR sm.session_id = $3)
                AND sm.message_type IN ('dm_text', 'player_message')
                AND sm.content_tsv @@ q.tsq
              ORDER BY rank DESC, sm.created_at DESC, sm.session_id, sm.seq DESC
              LIMIT $4 OFFSET $5
           ) sub
          ORDER BY sub.rank DESC, sub.created_at DESC, sub.session_id, sub.seq DESC`,
        [args.campaignId, args.query, args.sessionId ?? null, args.limit, args.offset],
      )
      return result.rows.map((r) => ({
        sessionId: r.session_id,
        sessionNumber: r.session_number,
        seq: r.seq,
        messageType: r.message_type,
        userId: r.user_id,
        content: r.content,
        snippet: r.snippet,
        createdAt: r.created_at,
      }))
    },
  }
}

/** Back-compat factory — pool-bound surface. */
export const createTranscriptSearchRepo = (pool: Pool) => transcriptSearchNs(pool)
```

- [ ] **Step 4: Register the namespace in `bindTx`**

In `backend/src/repo/index.ts`, add the import and the `bindTx` entry:

```ts
import { sessionMessagesNs } from './session-messages.js'
import { transcriptSearchNs } from './transcript-search.js'
```

```ts
    sessionMessages: sessionMessagesNs(c),
    transcriptSearch: transcriptSearchNs(c),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/repo/__tests__/transcript-search.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add backend/src/repo/transcript-search.ts backend/src/repo/index.ts \
  backend/src/repo/__tests__/transcript-search.test.ts
git commit -m "feat(MYT-74d): searchTranscript repo read (FTS, prose-only, total-order paging)"
```

---

## Task 3: Speaker-attribution helper + ws-session refactor

**Files:**
- Create: `backend/src/session/attribution.ts`
- Modify: `backend/src/routes/ws-session.ts` (import `DEPARTED_AUTHOR_NAME`, drop the local const at line 187)
- Create: `backend/src/session/__tests__/attribution.test.ts`

- [ ] **Step 1: Write the failing attribution test**

Create `backend/src/session/__tests__/attribution.test.ts`:

```ts
// MYT-74d T3: speaker attribution — one source of truth for "who said it",
// shared by the WS replay path and transcript search.
import { describe, expect, it } from 'vitest'
import { resolveSpeaker, DEPARTED_AUTHOR_NAME, DM_SPEAKER_NAME } from '../attribution.js'

describe('resolveSpeaker', () => {
  const map = new Map<string, string>([['u-1', 'Bram Ironhide']])

  it('null user_id (DM-authored) → DM', () => {
    expect(resolveSpeaker(null, map)).toBe(DM_SPEAKER_NAME)
    expect(DM_SPEAKER_NAME).toBe('DM')
  })

  it('a user present in the map → the character name', () => {
    expect(resolveSpeaker('u-1', map)).toBe('Bram Ironhide')
  })

  it('a non-null user absent from the map (departed player) → Former player, not DM', () => {
    expect(resolveSpeaker('u-gone', map)).toBe(DEPARTED_AUTHOR_NAME)
    expect(DEPARTED_AUTHOR_NAME).toBe('Former player')
    expect(resolveSpeaker('u-gone', map)).not.toBe(DM_SPEAKER_NAME)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/session/__tests__/attribution.test.ts`
Expected: FAIL — `../attribution.js` does not exist.

- [ ] **Step 3: Implement the attribution helper**

Create `backend/src/session/attribution.ts`:

```ts
/**
 * Player-facing speaker attribution for session_messages rows. One source of
 * truth for "who said it", shared by the WS replay path (routes/ws-session.ts)
 * and transcript search (MYT-74d).
 */

/** A message authored by the DM tier (FT-rendered dm_text rows carry a null
 *  user_id). */
export const DM_SPEAKER_NAME = 'DM'

/** A message authored by a user who has since left the campaign (absent from
 *  the active character map). NOT "DM" — collapsing a departed player's line
 *  into the DM is a "who said it" mis-attribution. */
export const DEPARTED_AUTHOR_NAME = 'Former player'

/**
 * Resolve a session_messages.user_id to a player-facing speaker:
 *  - null            → "DM"
 *  - present in map  → the speaking character's name
 *  - non-null/absent → DEPARTED_AUTHOR_NAME (departed player)
 */
export function resolveSpeaker(
  userId: string | null,
  characterByUser: ReadonlyMap<string, string>,
): string {
  if (userId === null) return DM_SPEAKER_NAME
  return characterByUser.get(userId) ?? DEPARTED_AUTHOR_NAME
}
```

- [ ] **Step 4: Refactor `ws-session.ts` to import the constant**

In `backend/src/routes/ws-session.ts`, delete the local declaration:

```ts
const DEPARTED_AUTHOR_NAME = 'Former player'
```

and add to the imports (top of file, with the other `../session/...` imports):

```ts
import { DEPARTED_AUTHOR_NAME } from '../session/attribution.js'
```

(ws-session keeps its own two-field replay-frame logic — only the constant is shared.)

- [ ] **Step 5: Run the attribution + ws-session tests to verify they pass**

Run: `pnpm vitest run src/session/__tests__/attribution.test.ts src/routes/__tests__/ws-session.integration.test.ts`
Expected: PASS (the constant swap is behavior-preserving; the replay tests still pass). If the ws-session test file name differs, run `pnpm vitest run src/session/__tests__/attribution.test.ts` plus the ws-session suite the repo actually has (`ls src/routes/__tests__ | grep ws-session`).

- [ ] **Step 6: Commit**

```bash
git add backend/src/session/attribution.ts \
  backend/src/session/__tests__/attribution.test.ts \
  backend/src/routes/ws-session.ts
git commit -m "feat(MYT-74d): shared speaker-attribution helper (DM/name/Former player)"
```

---

## Task 4: Route `GET /transcript/search` + contract manifests

**Files:**
- Modify: `backend/src/routes/campaigns.ts` (query schema near the other schemas; route handler after the `/wiki` route ~line 718)
- Modify: `backend/src/contract/backend-routes.ts` (after the `/wiki` entry, line 50)
- Modify: `backend/dev-tool/verify-registry.ts` (`EXEMPT_ROUTES`, after the `/wiki` entry, line 162)
- Modify: `backend/dev-tool/coverage.json` (`exempt.routes`, after the `/wiki` entry)
- Create: `backend/src/routes/__tests__/transcript-search-route.test.ts`

- [ ] **Step 1: Write the failing route test**

Create `backend/src/routes/__tests__/transcript-search-route.test.ts` (models `campaigns-wiki.test.ts`'s harness — bypass auth via `x-mythrun-dev-sub`):

```ts
// MYT-74d T4: integration tests for GET /api/campaigns/:campaignId/transcript/search.
// Member-readable FTS lookback over the prose-bearing transcript. Real Postgres;
// bypass auth in NODE_ENV=test.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import IoredisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { requireOnboarded } from '../../auth/require-onboarded.js'
import { campaignsRoutes, type WorldGenQueueLike } from '../campaigns.js'
import type { PipelineSubscriber } from '../../sse/pipeline-subscriber.js'
import type { ConnectionCounter } from '../../sse/connection-counter.js'
import {
  cleanupTestScope, makeTestScope, type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const REDIS_KEY_PREFIX = `test:transcript-search-${String(Date.now())}:`

function noopSubscriber(): PipelineSubscriber {
  return { attach: () => () => {}, close: () => Promise.resolve() } as unknown as PipelineSubscriber
}
function noopCounter(): ConnectionCounter {
  return {
    increment: () => {}, decrement: () => {}, startPeriodicLog: () => () => {},
  } as unknown as ConnectionCounter
}
function noopQueue(): WorldGenQueueLike {
  return {
    add: () => Promise.resolve({ id: 'stub' }),
    getJobCounts: () => Promise.resolve({ waiting: 0, active: 0, delayed: 0 }),
    getJob: () => Promise.resolve(null),
  }
}

interface SeededUser { userId: string; devSub: string }
async function seedUser(pool: Pool, scope: TestScope, i: number): Promise<SeededUser> {
  const userId = uuidv7()
  const devSub = scope.userSub(i)
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, devSub, scope.displayName(i), scope.username(i)],
  )
  return { userId, devSub }
}

// Seed a campaign owned by `owner`, with one session. Returns ids.
async function seedCampaign(pool: Pool, scope: TestScope, owner: SeededUser, i: number) {
  const worldId = uuidv7()
  const campaignId = uuidv7()
  const sessionId = uuidv7()
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
    [worldId, owner.userId, scope.worldName(i)],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES ($1, $2, $3, $4, 'setup')`,
    [campaignId, worldId, owner.userId, scope.campaignName(i)],
  )
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaignId, owner.userId],
  )
  await pool.query(
    `INSERT INTO sessions (id, campaign_id, session_number, status) VALUES ($1, $2, 1, 'ended')`,
    [sessionId, campaignId],
  )
  return { worldId, campaignId, sessionId }
}

// A characters row + campaign_characters join so listForCampaign resolves
// user_id → character name. All NOT NULL stat columns get arbitrary values.
async function seedCharacter(
  pool: Pool, campaignId: string, userId: string, name: string,
): Promise<void> {
  const characterId = uuidv7()
  await pool.query(
    `INSERT INTO characters (id, user_id, name, level, class, species, background,
        str, dex, con, int, wis, cha, hit_points, max_hit_points, armor_class, proficiency_bonus)
     VALUES ($1, $2, $3, 1, 'Fighter', 'Human', 'Soldier',
        10, 10, 10, 10, 10, 10, 10, 10, 10, 2)`,
    [characterId, userId, name],
  )
  await pool.query(
    `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
     VALUES ($1, $2, $3, $4)`,
    [uuidv7(), campaignId, characterId, userId],
  )
}

async function insertRow(
  pool: Pool, sessionId: string, seq: number, messageType: string, content: string, userId: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO session_messages (id, session_id, seq, user_id, message_type, content)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uuidv7(), sessionId, seq, userId, messageType, content],
  )
}

async function buildApp(pool: Pool, redis: Redis): Promise<FastifyInstance> {
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(bypassPlugin)
  await app.register(requireOnboarded, { pool })
  await app.register(campaignsRoutes, {
    pool, subscriber: noopSubscriber(), counter: noopCounter(),
    redis, redisKeyPrefix: REDIS_KEY_PREFIX, worldGenQueue: noopQueue(),
  })
  await app.ready()
  return app
}

describe('GET /api/campaigns/:campaignId/transcript/search (MYT-74d)', () => {
  let pool: Pool
  let redis: Redis
  let app: FastifyInstance
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('transcript-route')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')
    redis = new IoredisMock()
    await cleanupTestScope(pool, scope)
    app = await buildApp(pool, redis)
  })
  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  it('200 ranked hits with speaker attribution for a member', async () => {
    const owner = await seedUser(pool, scope, 0)
    const c = await seedCampaign(pool, scope, owner, 0)
    await seedCharacter(pool, c.campaignId, owner.userId, 'Bram Ironhide')
    await insertRow(pool, c.sessionId, 0, 'dm_text', 'The harbourmaster guards the ledger.', null)
    await insertRow(pool, c.sessionId, 1, 'player_message', 'I confront the harbourmaster.', owner.userId)

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${c.campaignId}/transcript/search?q=harbourmaster`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      hits: { messageType: string; speaker: string; snippet: string; sessionNumber: number; seq: number }[]
      query: string
    }>()
    expect(body.query).toBe('harbourmaster')
    expect(body.hits).toHaveLength(2)
    const dm = body.hits.find((h) => h.messageType === 'dm_text')
    const player = body.hits.find((h) => h.messageType === 'player_message')
    expect(dm?.speaker).toBe('DM')
    expect(player?.speaker).toBe('Bram Ironhide')
    expect(body.hits.every((h) => h.snippet.includes('<mark>'))).toBe(true)
  })

  it('attributes a departed author to "Former player", not DM', async () => {
    const owner = await seedUser(pool, scope, 0)
    const departed = await seedUser(pool, scope, 1)
    const c = await seedCampaign(pool, scope, owner, 0)
    // A player_message authored by `departed`, who is NOT in campaign_characters.
    await insertRow(pool, c.sessionId, 0, 'player_message', 'I distrust the harbourmaster.', departed.userId)

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${c.campaignId}/transcript/search?q=harbourmaster`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ hits: { speaker: string }[] }>()
    expect(body.hits[0]?.speaker).toBe('Former player')
  })

  it('400 invalid_query for an empty q', async () => {
    const owner = await seedUser(pool, scope, 0)
    const c = await seedCampaign(pool, scope, owner, 0)
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${c.campaignId}/transcript/search?q=%20`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ code: string }>().code).toBe('invalid_query')
  })

  it('403 not_campaign_member for a non-member', async () => {
    const owner = await seedUser(pool, scope, 0)
    const stranger = await seedUser(pool, scope, 2)
    const c = await seedCampaign(pool, scope, owner, 0)
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${c.campaignId}/transcript/search?q=anything`,
      headers: { 'x-mythrun-dev-sub': stranger.devSub },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_member' })
  })

  it('200 { hits: [] } for a fresh campaign with no sessions', async () => {
    const owner = await seedUser(pool, scope, 0)
    // No seedCampaign session rows: make a campaign with zero sessions.
    const worldId = uuidv7(); const campaignId = uuidv7()
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, owner.userId, scope.worldName(5)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES ($1, $2, $3, $4, 'setup')`,
      [campaignId, worldId, owner.userId, scope.campaignName(5)],
    )
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'owner', true)`,
      [uuidv7(), campaignId, owner.userId],
    )
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/transcript/search?q=anything`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ hits: unknown[] }>().hits).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/routes/__tests__/transcript-search-route.test.ts`
Expected: FAIL — the route 404s (not registered).

- [ ] **Step 3: Add the query schema + route to `campaigns.ts`**

Near the other Zod schemas (e.g. after `CreateCampaignBodySchema`, ~line 150), add:

```ts
const TranscriptSearchQuerySchema = z.object({
  q: z.string().trim().min(1),
  sessionId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(50).default(20),
  offset: z.coerce.number().int().min(0).max(500).default(0),
})

interface TranscriptSearchQuerystring {
  q?: string
  sessionId?: string
  limit?: string
  offset?: string
}
```

Import the attribution helper at the top of `campaigns.ts`:

```ts
import { resolveSpeaker } from '../session/attribution.js'
```

Register the route after the `/wiki` route (~line 718), **without** `config.pipelineRoute` (D5):

```ts
  // -------------------------------------------------------------------------
  // GET /api/campaigns/:campaignId/transcript/search (MYT-74d)
  //
  // Player-facing in-session lookback: FTS over the prose-bearing transcript
  // (dm_text + player_message), campaign-scoped, session-filterable. Public by
  // construction (the FT never narrates secrets); the only structural guard is
  // the campaign_id join (inside searchTranscript) + requireCampaignMember.
  // NOT a pipelineRoute — session-runtime data, no stage gate.
  // -------------------------------------------------------------------------

  app.get<{ Params: Params; Querystring: TranscriptSearchQuerystring }>(
    '/api/campaigns/:campaignId/transcript/search',
    {
      config: {
        // Member-read, per-user (UI-fanned). 30/min — heavier than the 60/min
        // status/wiki polls (an O(matches) rank-sort + per-row ts_headline).
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => {
            try {
              return requireDbUser(req).id
            } catch {
              return req.ip
            }
          },
        },
      },
      preHandler: requireCampaignMember(repo),
    },
    async (request, reply) => {
      const parsed = TranscriptSearchQuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_query', issues: parsed.error.issues })
      }
      const { q, sessionId, limit, offset } = parsed.data
      const campaignId = request.params.campaignId

      const characters = await repo.characters.listForCampaign(campaignId)
      const characterByUser = new Map(characters.map((ch) => [ch.userId, ch.name]))

      const hits = await repo.transcriptSearch.searchTranscript({
        campaignId,
        query: q,
        sessionId,
        limit,
        offset,
      })

      const shaped = hits.map((h) => ({
        sessionId: h.sessionId,
        sessionNumber: h.sessionNumber,
        seq: h.seq,
        messageType: h.messageType,
        speaker: resolveSpeaker(h.userId, characterByUser),
        content: h.content,
        snippet: h.snippet,
        createdAt: h.createdAt,
      }))

      return reply.send({ hits: shaped, query: q, limit, offset })
    },
  )
```

> Under `exactOptionalPropertyTypes`, `searchTranscript({ …, sessionId, … })` with `sessionId: string | undefined` is fine because `SearchTranscriptArgs.sessionId?` is optional; the repo coalesces `?? null` at the bind site. If the strict optional check complains, spread conditionally: `...(sessionId ? { sessionId } : {})`.

- [ ] **Step 4: Add the route to the three contract manifests**

`backend/src/contract/backend-routes.ts` — after the `/wiki` line (50):

```ts
  { method: 'GET', path: '/api/campaigns/:campaignId/wiki' }, // MYT-74c
  { method: 'GET', path: '/api/campaigns/:campaignId/transcript/search' }, // MYT-74d
```

`backend/dev-tool/verify-registry.ts` — in `EXEMPT_ROUTES`, after the `/wiki` entry (162):

```ts
  { method: 'GET', path: '/api/campaigns/:campaignId/wiki' },

  // GET /api/campaigns/:campaignId/transcript/search (MYT-74d): player-facing
  // FTS lookback over the transcript. Member-readable; no dev-tool inspector
  // surface (the player UI owns the search box, a Frontend ticket).
  { method: 'GET', path: '/api/campaigns/:campaignId/transcript/search' },
```

`backend/dev-tool/coverage.json` — **DO NOT TOUCH.** (Correction, found at dev-tool-verify time.) `coverage.json` `exempt.routes` is **pipeline-only**: `dev-tool:check` validates it against `PIPELINE_ROUTES`, so adding a non-pipeline route here is always a `dev-tool:check` failure. The `/wiki` route lives here only because it IS a pipelineRoute; `/transcript/search` is not, so its sole dev-tool exempt home is `verify-registry.ts` `EXEMPT_ROUTES` above. The non-pipeline contract ripple is therefore just **two** files: `backend-routes.ts` + `verify-registry.ts`.

- [ ] **Step 5: Run the route + contract tests to verify they pass**

Run: `pnpm vitest run src/routes/__tests__/transcript-search-route.test.ts src/contract/__tests__/backend-routes.test.ts`
Expected: PASS (route behavior + the route-drift list now includes the new route). Also run the dev-tool registry test: `pnpm vitest run dev-tool/verify-registry.test.ts` (or the path `ls dev-tool` shows) — the route-exhaustion invariant passes with the `EXEMPT_ROUTES` entry.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/campaigns.ts backend/src/contract/backend-routes.ts \
  backend/dev-tool/verify-registry.ts backend/dev-tool/coverage.json \
  backend/src/routes/__tests__/transcript-search-route.test.ts
git commit -m "feat(MYT-74d): transcript-search route + contract manifests"
```

---

## Task 5: Full verification & close-out

**Not a code task — the controller's gate before push.** Run from `backend/`:

- [ ] **Step 1: Typecheck** — `pnpm typecheck` → clean.
- [ ] **Step 2: Lint (type-aware)** — `pnpm lint` (`eslint src`; per-file lint skips type-aware rules). Sweep any `require-await` / `no-unsafe-*` the implementers left.
- [ ] **Step 3: Scoped coverage** on the new files (fast, points to uncovered arms):
  ```bash
  pnpm vitest run src/repo/__tests__/transcript-search.test.ts \
    src/session/__tests__/attribution.test.ts \
    src/routes/__tests__/transcript-search-route.test.ts \
    src/db/__tests__/migration-029.test.ts \
    --coverage \
    --coverage.include='src/repo/transcript-search.ts' \
    --coverage.include='src/session/attribution.ts'
  ```
  Fill any uncovered branch (the 100% gate is enforced pre-push).
- [ ] **Step 4: Full backend suite** — `pnpm test` (catches the migrate-schema pin, contract drift, ws-session refactor).
- [ ] **Step 5: Wiki sync** — dispatch the `docs/wiki/AUTHORING.md` subagent for MYT-74d (runtime/session-runtime page gains the transcript-search read surface). Sync the wiki **LAST**, after the dev-tool-verifier (which may drift `runtime/dev-tool.html`).
- [ ] **Step 6: dev-tool-verifier** — this task touches `dev-tool/verify-registry.ts` + `dev-tool/coverage.json`, so the pre-push hook requires the verifier's marker. Dispatch the dev-tool-verifier subagent (general-purpose, Opus) with an explicit `E2E: required` line (a new route was registered + `verify-registry.ts` edited). Only the subagent writes `tmp/.dev-tool-verifier-ok` — never the controller.
- [ ] **Step 7: Single push** — once all gates are green, `git push origin main` (code + wiki in one push).
- [ ] **Step 8: Linear** — MYT-74d is the final piece of MYT-74; flip MYT-74 to Done (confirm with the user first, since this closes the epic).

---

## Self-Review (against the spec)

**Spec coverage:** §1 migration → T1. §2 repo (`searchTranscript`, the outer-query/total-order/CROSS JOIN LATERAL SQL, prose-only filter, `?? null` bind) → T2. §2 attribution (three-way) → T3 (helper) + T4 (route wiring). §3 route (Zod `q`/`sessionId`/`limit`/`offset` caps, `invalid_query`, per-user `wiki`-precedent rate limit, no stage gate, contract ripple) → T4. §3a perf characteristics → embodied in the SQL (T2). §4 enforced ignorance (campaign scoping + prose-only + correction-row) → T2 tests (isolation, prose-only) + the public-by-construction corpus. §5 testing → distributed across T1–T4 (migration shape, pinned arrays, ranking, sessionId, snippet, total-order paging, prose-only, cross-campaign isolation + foreign-sessionId, EXPLAIN, attribution three-way, route 200/400/403/empty). **Gap check:** the spec's §5 "correction-row invariant" defense test is a repo-level assertion — fold it into T2 (seed a `dm_text` row with content that has no `[[DM CORRECTION` marker and assert the returned content/snippet contains none; the marker never persists, so it's a positive invariant). Add it as an extra `it()` in the T2 test file.

**Placeholder scan:** none — every step has concrete code/SQL/commands.

**Type consistency:** `TranscriptHit` / `SearchTranscriptArgs` / `SEARCHABLE_MESSAGE_TYPES` (T2) match their use in the route (T4). `resolveSpeaker` / `DEPARTED_AUTHOR_NAME` / `DM_SPEAKER_NAME` (T3) match the route import + the attribution test. `repo.transcriptSearch.searchTranscript` (registered in `bindTx`, T2) matches the route call (T4). Route shape `{ hits, query, limit, offset }` consistent between handler and tests.
