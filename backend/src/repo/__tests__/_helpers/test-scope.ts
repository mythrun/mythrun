// backend/src/repo/__tests__/_helpers/test-scope.ts
//
// Per-test scoped setup/teardown helper for integration tests (myth-5jdo).
// Replaces the blanket `DELETE FROM users WHERE cognito_sub != 'system:mythrun'`
// + sibling `DELETE FROM <table>` patterns that wipe entire tables between
// tests. With this helper each test owns a unique scope prefix; the cleanup
// only removes rows belonging to that scope.
//
// Why per-test scope:
//   - Two test files running in parallel against the shared local Postgres
//     can't race-collide on TRUNCATE if they only touch their own rows.
//   - Real bugs in test fixtures (e.g., a forgotten INSERT carrying over)
//     surface as test failures instead of being masked by the next
//     blanket-delete.
//   - The seeded dev users (migration 013, myth-40uh) survive across tests
//     since no test wipes them by scope.
//
// Usage (see entities.test.ts for the canonical conversion):
//
//   const scope = makeTestScope('entities')   // beforeAll
//   beforeEach(async () => {
//     await cleanupTestScope(pool, scope)     // remove this scope's rows
//                                              // from prior iteration
//     userId = uuidv7()
//     worldId = uuidv7()
//     await pool.query(
//       `INSERT INTO users (id, cognito_sub, display_name, username)
//        VALUES ($1, $2, $3, $4)`,
//       [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
//     )
//     ...
//   })
//   afterAll(async () => {
//     await cleanupTestScope(pool, scope)
//   })

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

export interface TestScope {
  /** Human label (matches the describe-block name in most cases). */
  readonly label: string
  /** Unique prefix used as the cognito_sub root, world/campaign name root, etc. */
  readonly id: string
  /** Returns `${id}-user-${n}` for the nth user in this scope. */
  readonly userSub: (n: number) => string
  /** Returns a username unique to this scope + index. Must satisfy the
   *  username CHECK (lowercase alphanum, length cap). */
  readonly username: (n: number) => string
  /** Returns a display name for the nth user. */
  readonly displayName: (n: number) => string
  /** Returns `${id}-world-${n}`. */
  readonly worldName: (n: number) => string
  /** Returns `${id}-campaign-${n}`. */
  readonly campaignName: (n: number) => string
}

export function makeTestScope(label: string): TestScope {
  // 8-char random suffix so two test files using the same label still
  // get distinct scopes when run in parallel (same DB, no collisions).
  // Lowercase + alphanum so the username variant (which has a stricter
  // CHECK constraint) doesn't need escaping.
  const rand = randomUUID().replace(/-/g, '').slice(0, 8).toLowerCase()
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]/g, '')
  const id = `tst-${safeLabel}-${rand}`
  return {
    label,
    id,
    userSub: (n) => `${id}-user-${String(n)}`,
    // Usernames have a length cap of ~30 chars per migration 005's regex.
    // Strip dashes from id (which has 2 already) so the username's joined
    // form fits in budget.
    username: (n) => `${id.replace(/-/g, '')}u${String(n)}`.slice(0, 28),
    displayName: (n) => `Test User ${String(n)} (${id})`,
    worldName: (n) => `${id}-world-${String(n)}`,
    campaignName: (n) => `${id}-campaign-${String(n)}`,
  }
}

/**
 * Delete every row this scope created across the schema. Order respects
 * FK constraints — credit_ledger.user_id is RESTRICT-FK, so it must go
 * before users. Campaigns/worlds CASCADE through their dependent rows.
 *
 * Idempotent — safe to call before each test AND in afterAll.
 */
export async function cleanupTestScope(
  client: Pool | PoolClient,
  scope: TestScope,
): Promise<void> {
  const idPrefix = `${scope.id}%`

  // credit_ledger is RESTRICT-FK to users — must delete first.
  await client.query(
    `DELETE FROM credit_ledger
       WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
    [idPrefix],
  )

  // Campaigns own campaign_members + invites via CASCADE.
  await client.query(`DELETE FROM campaigns WHERE name LIKE $1`, [idPrefix])

  // Worlds own entities + prose_kernels + facts + relationships +
  // entity_hierarchy + pipeline_runs + random_tables(+entries) via
  // CASCADE chains. Match on name LIKE prefix AND on created_by — the
  // latter catches worlds that pipeline stages renamed mid-test (e.g.
  // concept_intake sets worlds.name = the LLM-generated name, which no
  // longer matches the scope prefix).
  await client.query(`DELETE FROM worlds WHERE name LIKE $1`, [idPrefix])
  await client.query(
    `DELETE FROM worlds
       WHERE created_by IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
    [idPrefix],
  )

  // Sessions own session_messages + session_participants + session_preps +
  // session_usage via CASCADE; they're keyed on campaign_id which the
  // earlier campaign delete already cleaned. But standalone sessions (no
  // campaign) by name pattern, defensive:
  await client.query(
    `DELETE FROM sessions WHERE id::text LIKE $1 OR campaign_id::text LIKE $1`,
    [idPrefix],
  )

  // Users last, after the dependent rows have been removed.
  await client.query(`DELETE FROM users WHERE cognito_sub LIKE $1`, [idPrefix])
}
