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
  await reseedSystemRows(pool)
}

/**
 * Re-insert MYT-43's seeded system rows (system user + demo world) after
 * a destructive reset. Migration 008 seeds these so production has them
 * post-migrate; the test reset path needs to re-create them so the
 * post-reset state matches the post-migrate state.
 *
 * UUIDs match migration 008 verbatim — the system-user UUID is referenced
 * by the demo world's created_by FK; the demo-world UUID is the
 * forkable-by-trial-flow target. Tests that look up either by ID rely on
 * these literal values.
 */
const SYSTEM_USER_ID = '019700e0-0000-7000-8000-000000000001'
const DEMO_WORLD_ID = '019700e0-0000-7000-8000-000000000002'

async function reseedSystemRows(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used, suspended_at)
     VALUES ($1, 'system:mythrun', 'Mythrun System', 'system', true, '1970-01-01 00:00:00+00'::timestamptz)`,
    [SYSTEM_USER_ID],
  )
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status, language, is_public, is_demo)
     VALUES ($1, $2, 'Demo Adventure', 'Trial-mode demo world. Narrative content authored separately.', 'complete', 'en', false, true)`,
    [DEMO_WORLD_ID, SYSTEM_USER_ID],
  )
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
  // Preserve the MYT-43 system user — the demo world's created_by FK
  // references it. Deleting it would fail FK RESTRICT against worlds.
  await pool.query("DELETE FROM users WHERE cognito_sub != 'system:mythrun'")
}
