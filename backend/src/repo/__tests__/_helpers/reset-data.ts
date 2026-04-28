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
  'users',
  'credit_ledger',
  'purchases',
  'user_subscriptions',
  'subscription_tiers',
  'session_packs',
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
