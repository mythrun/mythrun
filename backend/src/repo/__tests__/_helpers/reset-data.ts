import type { Pool } from 'pg'

/**
 * TRUNCATE all application tables to reset between tests.
 *
 * Faster than DROP SCHEMA + re-applying migrations (~5ms vs ~150ms).
 * Schema stays intact across tests; only data is reset. CASCADE handles
 * FK relationships so the order of tables in the list doesn't matter.
 *
 * As future tickets add namespaces and tables, extend this list. Keep
 * `_migrations` OUT — that's the runner's bookkeeping; truncating it
 * would force a re-application on the next runMigrations call.
 */
const TABLES = [
  // Identity / billing
  // Order within the section is for readability; FK ordering is handled by
  // `TRUNCATE ... CASCADE` (see resetData below). credit_ledger has RESTRICT
  // FKs to purchases and billing_history; CASCADE forces those dependents
  // to truncate together regardless of position.
  'billing_history',
  'user_subscriptions',
  'purchases',
  'users',
  'credit_ledger',
  'stripe_events',

  // Worlds + entities
  'worlds',
  'entities',
  'prose_kernels',
  'facts',
  'relationships',
  'entity_hierarchy',
  'random_tables',
  'random_table_entries',

  // Campaigns + characters
  'campaigns',
  'campaign_members',
  'campaign_invites',
  'characters',
  'character_skills',
  'character_features',
  'character_equipment',
  'character_spells',

  // Sessions + ops
  'sessions',
  'session_messages',
  'session_participants',
  'session_preps',
  'session_usage',
  'pipeline_runs',
  'world_snapshots',
  'stat_blocks',
  'stat_block_actions',

  // SRD + misc
  'srd_monsters',
  'srd_spells',
  'srd_conditions',
  'world_marketplace',
  'moderation_flags',
  'settings',
] as const

export async function resetData(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`)
}

/**
 * Fast reset for tests that only touch users + credit_ledger.
 *
 * TRUNCATE has a fixed per-call overhead (~270-400ms here, dominated by
 * acquiring ACCESS EXCLUSIVE locks on every table in the list). For
 * race-style tests that run 50-100 iterations of {reset + create + race},
 * that overhead alone can blow the per-test timeout (e.g., 100 × 400ms =
 * 40s already, before any actual test work). DELETE statements skip the
 * lock-each-table fixed cost and run in a few ms each. Order matches the
 * FK delete_rule — credit_ledger.user_id is RESTRICT, so it must go first.
 *
 * Use this ONLY when the test's surface is provably users+credits. Tests
 * that touch worlds/campaigns/invites/sessions must use the full
 * resetData() above.
 */
export async function resetCreditsData(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM credit_ledger')
  await pool.query('DELETE FROM users')
}
