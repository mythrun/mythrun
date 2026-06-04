import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../postgres.js'
import { runMigrations } from '../migrate.js'
import { guardTestDatabase } from './guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { seedTestDatabase } from '../../__tests__/_helpers/seed-test-database.js'

// myth-exac T01: demo-world UUID seeded by migration 008. Used by the
// migration-014 describe block to insert a sample entity + fact under a
// known-good world without needing additional fixture setup.
const DEMO_WORLD_ID = '019700e0-0000-7000-8000-000000000002'

const databaseUrl = process.env.DATABASE_URL ?? ''

const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

const EXPECTED_TABLES = [
  '_migrations',
  'billing_history',
  'campaign_characters',
  'campaign_invites',
  'campaign_members',
  'campaigns',
  'character_concepts',
  'character_equipment',
  'character_features',
  'character_skills',
  'character_spells',
  'characters',
  'credit_ledger',
  'entities',
  'entity_hierarchy',
  'facts',
  'moderation_flags',
  'pipeline_runs',
  'prose_kernels',
  'purchases',
  'random_table_entries',
  'random_tables',
  'relationships',
  'session_messages',
  'session_participants',
  'session_preps',
  'session_usage',
  'sessions',
  'settings',
  'srd_conditions',
  'srd_monsters',
  'srd_spells',
  'stat_block_actions',
  'stat_blocks',
  'stripe_events',
  'user_subscriptions',
  'users',
  'world_marketplace',
  'world_snapshots',
  'worlds',
] as const

const EXPECTED_IDX_NAMES = [
  'idx_billing_history_invoice_pi',
  'idx_billing_history_user_occurred',
  'idx_campaign_characters_character',
  'idx_campaign_characters_user',
  'idx_campaign_members_campaign',
  'idx_campaign_members_user',
  'idx_campaigns_created_by',
  'idx_character_concepts_campaign_status',
  'idx_characters_user',
  'idx_credit_ledger_source_billing_history',
  'idx_credit_ledger_source_purchase',
  'idx_credit_ledger_user_type',
  'idx_entities_world',
  'idx_entities_world_access',
  'idx_entities_world_type',
  'idx_facts_entity',
  'idx_facts_entity_access_status',
  'idx_pipeline_runs_campaign',
  'idx_pipeline_runs_unique',
  'idx_pipeline_runs_world',
  'idx_purchases_user',
  'idx_random_tables_world',
  'idx_relationships_source',
  'idx_relationships_target',
  'idx_session_messages_session_seq',
  'idx_session_messages_session_seq_unique',
  'idx_session_preps_campaign',
  'idx_session_usage_one_per_session',
  'idx_sessions_campaign',
  'idx_sessions_one_active',
  'idx_user_subscriptions_user',
  'idx_world_snapshots_campaign',
  'idx_worlds_one_demo',
] as const

const EXPECTED_CHECK_CONSTRAINTS: readonly {
  readonly table_name: string
  readonly check_clause: string
}[] = [
  {
    table_name: 'billing_history',
    check_clause: `CHECK ((((kind = 'purchase'::text) AND (source_id_stripe ~~ 'pi_%'::text)) OR ((kind = 'invoice'::text) AND (source_id_stripe ~~ 'in_%'::text)) OR ((kind = 'refund'::text) AND (source_id_stripe ~~ 're_%'::text))))`,
  },
  {
    table_name: 'billing_history',
    check_clause: `CHECK ((kind = ANY (ARRAY['purchase'::text, 'invoice'::text, 'refund'::text])))`,
  },
  {
    table_name: 'billing_history',
    check_clause: `CHECK ((status = ANY (ARRAY['completed'::text, 'refunded'::text])))`,
  },
  {
    table_name: 'campaign_members',
    check_clause: `CHECK ((role = ANY (ARRAY['owner'::text, 'player'::text])))`,
  },
  {
    table_name: 'campaigns',
    check_clause: `CHECK (((pre_integration_notes IS NULL) OR (length(pre_integration_notes) <= 4000)))`,
  },
  {
    table_name: 'campaigns',
    check_clause: `CHECK (((starting_situation_index IS NULL) OR ((starting_situation_index >= 0) AND (starting_situation_index <= 2))))`,
  },
  {
    table_name: 'campaigns',
    check_clause: `CHECK ((status = ANY (ARRAY['setup'::text, 'active'::text, 'archived'::text, 'failed'::text])))`,
  },
  {
    table_name: 'character_concepts',
    check_clause: `CHECK (((concept_output IS NULL) OR (jsonb_typeof(concept_output) = 'object'::text)))`,
  },
  {
    table_name: 'character_concepts',
    check_clause: `CHECK (((concept_text IS NULL) OR ((length(concept_text) >= 20) AND (length(concept_text) <= 4000))))`,
  },
  {
    table_name: 'character_concepts',
    check_clause: `CHECK (((length(situation_grounding_text) >= 20) AND (length(situation_grounding_text) <= 2000)))`,
  },
  {
    table_name: 'character_concepts',
    check_clause: `CHECK ((status = ANY (ARRAY['submitted'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'integrated'::text])))`,
  },
  {
    table_name: 'character_skills',
    check_clause: `CHECK ((proficiency_level = ANY (ARRAY['none'::text, 'proficient'::text, 'expertise'::text])))`,
  },
  {
    table_name: 'credit_ledger',
    check_clause: `CHECK ((credit_type = ANY (ARRAY['session'::text, 'world_gen'::text])))`,
  },
  {
    table_name: 'credit_ledger',
    check_clause: `CHECK (((source_type <> 'debit'::text) OR (source_id IS NOT NULL)))`,
  },
  {
    table_name: 'credit_ledger',
    check_clause: `CHECK (((source_type <> 'debit'::text) OR (expires_at IS NULL)))`,
  },
  {
    table_name: 'credit_ledger',
    check_clause: `CHECK (((source_type = 'debit'::text) = (amount < 0)))`,
  },
  {
    table_name: 'credit_ledger',
    check_clause: `CHECK (\nCASE source_type\n    WHEN 'debit'::text THEN ((source_purchase_id IS NULL) AND (source_billing_history_id IS NULL))\n    WHEN 'trial'::text THEN ((source_purchase_id IS NULL) AND (source_billing_history_id IS NULL))\n    WHEN 'gift'::text THEN ((source_purchase_id IS NULL) AND (source_billing_history_id IS NULL))\n    WHEN 'refund'::text THEN ((source_purchase_id IS NULL) AND (source_billing_history_id IS NOT NULL))\n    WHEN 'purchase'::text THEN ((source_purchase_id IS NOT NULL) AND (source_billing_history_id IS NULL))\n    WHEN 'subscription'::text THEN ((source_purchase_id IS NULL) AND (source_billing_history_id IS NOT NULL))\n    WHEN 'cost_cap_refund'::text THEN ((source_purchase_id IS NULL) AND (source_billing_history_id IS NULL))\n    WHEN 'admin'::text THEN ((source_purchase_id IS NULL) AND (source_billing_history_id IS NULL))\n    ELSE false\nEND)`,
  },
  {
    table_name: 'credit_ledger',
    check_clause: `CHECK ((source_type = ANY (ARRAY['purchase'::text, 'subscription'::text, 'gift'::text, 'trial'::text, 'refund'::text, 'debit'::text, 'cost_cap_refund'::text, 'admin'::text])))`,
  },
  {
    table_name: 'entities',
    check_clause: `CHECK ((access_level = ANY (ARRAY['known'::text, 'discoverable'::text, 'secret'::text])))`,
  },
  {
    table_name: 'entities',
    check_clause: `CHECK ((entity_type = ANY (ARRAY['npc'::text, 'location'::text, 'faction'::text, 'item'::text, 'pc'::text])))`,
  },
  {
    table_name: 'facts',
    check_clause: `CHECK ((access_level = ANY (ARRAY['known'::text, 'discoverable'::text, 'secret'::text])))`,
  },
  {
    table_name: 'facts',
    check_clause: `CHECK ((narrative_status = ANY (ARRAY['undelivered'::text, 'delivered'::text, 'developed'::text, 'resolved'::text])))`,
  },
  {
    table_name: 'moderation_flags',
    check_clause: `CHECK ((severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text])))`,
  },
  {
    table_name: 'moderation_flags',
    check_clause: `CHECK ((status = ANY (ARRAY['pending'::text, 'reviewed'::text, 'actioned'::text, 'dismissed'::text])))`,
  },
  {
    table_name: 'moderation_flags',
    check_clause: `CHECK ((target_type = ANY (ARRAY['world'::text, 'session_message'::text, 'user'::text])))`,
  },
  {
    table_name: 'pipeline_runs',
    check_clause: `CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text])))`,
  },
  { table_name: 'purchases', check_clause: `CHECK ((quantity > 0))` },
  {
    table_name: 'purchases',
    check_clause: `CHECK ((status = ANY (ARRAY['completed'::text, 'refunded'::text])))`,
  },
  {
    table_name: 'sessions',
    check_clause: `CHECK ((status = ANY (ARRAY['active'::text, 'ended'::text, 'crashed'::text])))`,
  },
  {
    table_name: 'stat_block_actions',
    check_clause: `CHECK ((action_type = ANY (ARRAY['action'::text, 'reaction'::text, 'bonus_action'::text, 'legendary'::text])))`,
  },
  {
    table_name: 'user_subscriptions',
    check_clause: `CHECK ((current_period_end > current_period_start))`,
  },
  {
    table_name: 'user_subscriptions',
    check_clause: `CHECK ((status = ANY (ARRAY['active'::text, 'past_due'::text, 'canceled'::text, 'unpaid'::text, 'incomplete'::text, 'incomplete_expired'::text, 'trialing'::text, 'paused'::text])))`,
  },
  {
    table_name: 'worlds',
    check_clause: `CHECK (((jsonb_typeof(entity_consolidation_pending) = 'object'::text) AND (jsonb_typeof((entity_consolidation_pending -> 'declarations'::text)) = 'array'::text) AND (jsonb_typeof((entity_consolidation_pending -> 'relationships'::text)) = 'array'::text)))`,
  },
  {
    table_name: 'worlds',
    check_clause: `CHECK ((moderation_status = ANY (ARRAY['unreviewed'::text, 'approved'::text, 'flagged'::text, 'removed'::text])))`,
  },
  {
    table_name: 'worlds',
    check_clause: `CHECK ((jsonb_typeof(starting_situation_entries) = 'array'::text))`,
  },
  {
    table_name: 'worlds',
    check_clause: `CHECK ((status = ANY (ARRAY['generating'::text, 'complete'::text, 'failed'::text])))`,
  },
  {
    table_name: 'worlds',
    check_clause: `CHECK (((jsonb_typeof(vocabulary_registry) = 'object'::text) AND (jsonb_typeof((vocabulary_registry -> 'entries'::text)) = 'array'::text) AND (jsonb_typeof((vocabulary_registry -> 'adjacent_franchises'::text)) = 'array'::text)))`,
  },
]

const EXPECTED_FK_DELETE_RULES: readonly {
  readonly table_name: string
  readonly column_name: string
  readonly foreign_table_name: string
  readonly delete_rule: string
}[] = [
  {
    table_name: 'billing_history',
    column_name: 'user_id',
    foreign_table_name: 'users',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'campaign_characters',
    column_name: 'campaign_id',
    foreign_table_name: 'campaigns',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'campaign_characters',
    column_name: 'character_id',
    foreign_table_name: 'characters',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'campaign_characters',
    column_name: 'user_id',
    foreign_table_name: 'users',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'campaign_invites',
    column_name: 'campaign_id',
    foreign_table_name: 'campaigns',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'campaign_invites',
    column_name: 'created_by',
    foreign_table_name: 'users',
    delete_rule: 'NO ACTION',
  },
  {
    table_name: 'campaign_members',
    column_name: 'campaign_id',
    foreign_table_name: 'campaigns',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'campaign_members',
    column_name: 'user_id',
    foreign_table_name: 'users',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'campaigns',
    column_name: 'created_by',
    foreign_table_name: 'users',
    delete_rule: 'NO ACTION',
  },
  {
    table_name: 'campaigns',
    column_name: 'source_world_id',
    foreign_table_name: 'worlds',
    delete_rule: 'SET NULL',
  },
  {
    table_name: 'campaigns',
    column_name: 'world_id',
    foreign_table_name: 'worlds',
    delete_rule: 'CASCADE',
  },
  // character_concepts: composite FK to (campaign_id, user_id) on
  // campaign_members ON DELETE CASCADE, plus separate FKs to campaigns
  // and users — Postgres projects each constraint per-column in
  // information_schema.key_column_usage, so campaign_id appears under
  // two distinct constraints (the composite + the direct campaign FK)
  // and similarly for user_id (the composite + the direct user FK).
  // The migration's INFORMATION_SCHEMA join (delete_rule from
  // referential_constraints, table_name from key_column_usage) yields
  // these six rows in (column_name, foreign_table_name) order.
  {
    table_name: 'character_concepts',
    column_name: 'campaign_id',
    foreign_table_name: 'campaign_members',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'character_concepts',
    column_name: 'campaign_id',
    foreign_table_name: 'campaign_members',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'character_concepts',
    column_name: 'campaign_id',
    foreign_table_name: 'campaigns',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'character_concepts',
    column_name: 'user_id',
    foreign_table_name: 'campaign_members',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'character_concepts',
    column_name: 'user_id',
    foreign_table_name: 'campaign_members',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'character_concepts',
    column_name: 'user_id',
    foreign_table_name: 'users',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'character_equipment',
    column_name: 'character_id',
    foreign_table_name: 'characters',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'character_features',
    column_name: 'character_id',
    foreign_table_name: 'characters',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'character_skills',
    column_name: 'character_id',
    foreign_table_name: 'characters',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'character_spells',
    column_name: 'character_id',
    foreign_table_name: 'characters',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'characters',
    column_name: 'entity_id',
    foreign_table_name: 'entities',
    delete_rule: 'SET NULL',
  },
  {
    table_name: 'characters',
    column_name: 'user_id',
    foreign_table_name: 'users',
    delete_rule: 'NO ACTION',
  },
  {
    table_name: 'credit_ledger',
    column_name: 'source_billing_history_id',
    foreign_table_name: 'billing_history',
    delete_rule: 'RESTRICT',
  },
  {
    table_name: 'credit_ledger',
    column_name: 'source_purchase_id',
    foreign_table_name: 'purchases',
    delete_rule: 'RESTRICT',
  },
  {
    table_name: 'credit_ledger',
    column_name: 'user_id',
    foreign_table_name: 'users',
    delete_rule: 'RESTRICT',
  },
  {
    table_name: 'entities',
    column_name: 'stat_block_id',
    foreign_table_name: 'stat_blocks',
    delete_rule: 'SET NULL',
  },
  {
    table_name: 'entities',
    column_name: 'world_id',
    foreign_table_name: 'worlds',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'entity_hierarchy',
    column_name: 'child_entity_id',
    foreign_table_name: 'entities',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'entity_hierarchy',
    column_name: 'parent_entity_id',
    foreign_table_name: 'entities',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'facts',
    column_name: 'entity_id',
    foreign_table_name: 'entities',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'moderation_flags',
    column_name: 'reporter_id',
    foreign_table_name: 'users',
    delete_rule: 'NO ACTION',
  },
  {
    table_name: 'pipeline_runs',
    column_name: 'campaign_id',
    foreign_table_name: 'campaigns',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'pipeline_runs',
    column_name: 'user_id',
    foreign_table_name: 'users',
    delete_rule: 'NO ACTION',
  },
  {
    table_name: 'pipeline_runs',
    column_name: 'world_id',
    foreign_table_name: 'worlds',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'prose_kernels',
    column_name: 'entity_id',
    foreign_table_name: 'entities',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'purchases',
    column_name: 'user_id',
    foreign_table_name: 'users',
    delete_rule: 'NO ACTION',
  },
  {
    table_name: 'random_table_entries',
    column_name: 'table_id',
    foreign_table_name: 'random_tables',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'random_tables',
    column_name: 'world_id',
    foreign_table_name: 'worlds',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'relationships',
    column_name: 'source_entity_id',
    foreign_table_name: 'entities',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'relationships',
    column_name: 'target_entity_id',
    foreign_table_name: 'entities',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'session_messages',
    column_name: 'session_id',
    foreign_table_name: 'sessions',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'session_participants',
    column_name: 'character_id',
    foreign_table_name: 'characters',
    delete_rule: 'NO ACTION',
  },
  {
    table_name: 'session_participants',
    column_name: 'session_id',
    foreign_table_name: 'sessions',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'session_participants',
    column_name: 'user_id',
    foreign_table_name: 'users',
    delete_rule: 'NO ACTION',
  },
  {
    table_name: 'session_preps',
    column_name: 'campaign_id',
    foreign_table_name: 'campaigns',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'session_preps',
    column_name: 'snapshot_id',
    foreign_table_name: 'world_snapshots',
    delete_rule: 'SET NULL',
  },
  {
    table_name: 'session_usage',
    column_name: 'campaign_id',
    foreign_table_name: 'campaigns',
    delete_rule: 'NO ACTION',
  },
  {
    table_name: 'session_usage',
    column_name: 'session_id',
    foreign_table_name: 'sessions',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'session_usage',
    column_name: 'user_id',
    foreign_table_name: 'users',
    delete_rule: 'NO ACTION',
  },
  {
    table_name: 'sessions',
    column_name: 'campaign_id',
    foreign_table_name: 'campaigns',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'stat_block_actions',
    column_name: 'stat_block_id',
    foreign_table_name: 'stat_blocks',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'user_subscriptions',
    column_name: 'user_id',
    foreign_table_name: 'users',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'world_marketplace',
    column_name: 'world_id',
    foreign_table_name: 'worlds',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'world_snapshots',
    column_name: 'campaign_id',
    foreign_table_name: 'campaigns',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'worlds',
    column_name: 'created_by',
    foreign_table_name: 'users',
    delete_rule: 'NO ACTION',
  },
  {
    table_name: 'worlds',
    column_name: 'source_world_id',
    foreign_table_name: 'worlds',
    delete_rule: 'SET NULL',
  },
]

function makeSilentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: () => {
      // discard log output
    },
  }
  return pino(
    { base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } },
    sink,
  )
}

// This file's schema-parity tests intentionally drop + re-run the real
// migrations to pin the cumulative schema contract. The DROP SCHEMA below
// is the test's subject, not obsolete per-file setup — exempt it from the
// test-only lint ban that exists to catch the per-file-beforeAll pattern.
async function resetSchema(pool: Pool): Promise<void> {
  await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
  // eslint-disable-next-line no-restricted-syntax
  await pool.query('DROP SCHEMA public CASCADE')
  await pool.query('CREATE SCHEMA public')
  await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
  await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
}

describe('schema-parity (integration)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 1 })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetSchema(pool)
  })

  it('applies all migrations and pins the schema contract', async () => {
    const applied = await runMigrations({
      pool,
      migrationsDir: REAL_MIGRATIONS_DIR,
      logger: makeSilentLogger(),
    })

    expect(applied.map((m) => m.version)).toEqual([
      '001_initial_schema.sql',
      '002_indexes.sql',
      '003_srd_reference_data.sql',
      '004_credit_ledger_invariants.sql',
      '005_drop_profile_columns_users.sql',
      '006_drop_billing_config_tables.sql',
      '007_recreate_billing_tables.sql',
      '008_billing_metering.sql',
      '009_character_portability.sql',
      '010_settings_world_gen_cost_cap.sql',
      '011_credit_ledger_cost_cap_refund.sql',
      '012_credit_ledger_admin_source.sql',
      '013_seed_dev_users.sql',
      '014_access_tier_rework.sql',
      '015_vocabulary_registry.sql',
      '016_character_concepts.sql',
      '017_entity_consolidation.sql',
      '018_character_integration.sql',
      '019_starting_situation_titles.sql',
      '020_relationships_synth_key.sql',
      '021_campaigns_failed_status.sql',
      '022_session_preps_unique.sql',
      '023_session_messages_unique_seq.sql',
    ])

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
    )
    expect(tables.rows.map((r) => r.table_name)).toEqual([...EXPECTED_TABLES])

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND indexname LIKE 'idx_%'
         ORDER BY indexname`,
    )
    expect(indexes.rows.map((r) => r.indexname)).toEqual([...EXPECTED_IDX_NAMES])

    const partial = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'idx_sessions_one_active'`,
    )
    expect(partial.rows[0]?.indexdef).toContain(`WHERE (status = 'active'::text)`)

    const checks = await pool.query<{ table_name: string; check_clause: string }>(
      `SELECT t.relname AS table_name, pg_get_constraintdef(c.oid) AS check_clause
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype = 'c' AND n.nspname = 'public'
        ORDER BY t.relname, c.conname`,
    )
    expect(checks.rows).toEqual(EXPECTED_CHECK_CONSTRAINTS)

    const fks = await pool.query<{
      table_name: string
      column_name: string
      foreign_table_name: string
      delete_rule: string
    }>(
      `SELECT tc.table_name, kcu.column_name,
              ccu.table_name AS foreign_table_name, rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu USING (constraint_name)
         JOIN information_schema.constraint_column_usage ccu USING (constraint_name)
         JOIN information_schema.referential_constraints rc USING (constraint_name)
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
        ORDER BY tc.table_name, kcu.column_name, ccu.table_name`,
    )
    expect(fks.rows).toEqual(EXPECTED_FK_DELETE_RULES)

    // Migration 005: minimal-claims users — email/avatar_url/auth_provider dropped,
    // case-sensitive UNIQUE on users.username replaced with UNIQUE LOWER(username).
    const userColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users'
         ORDER BY column_name`,
    )
    const userColumnNames = userColumns.rows.map((r) => r.column_name)
    expect(userColumnNames).not.toContain('email')
    expect(userColumnNames).not.toContain('avatar_url')
    expect(userColumnNames).not.toContain('auth_provider')
    expect(userColumnNames).toContain('display_name')
    expect(userColumnNames).toContain('username')

    const userIndexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'users'
         ORDER BY indexname`,
    )
    const userIndexNames = userIndexes.rows.map((r) => r.indexname)
    expect(userIndexNames).toContain('users_username_lower_key')
    expect(userIndexNames).not.toContain('users_username_key')

    // Migration 006: legacy billing-config tables are gone. Migration 007
    // recreates `purchases` and `user_subscriptions` with the new lookup_key
    // shape, so only `subscription_tiers` and `session_packs` stay dropped.
    const droppedTables = ['subscription_tiers', 'session_packs']
    const tableExists = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [droppedTables],
    )
    expect(tableExists.rows).toEqual([])

    // Idempotency — second run is a no-op.
    const second = await runMigrations({
      pool,
      migrationsDir: REAL_MIGRATIONS_DIR,
      logger: makeSilentLogger(),
    })
    expect(second).toEqual([])
  })
})

// myth-exac T01: targeted assertions for migration 014's three schema
// surfaces — the facts CHECK rewrite, the entities access_level column,
// and the worlds.dev_bypass_access_filter flag — plus the supporting
// idx_entities_world_access index. Lives in a fresh describe so the
// schema-parity test above stays self-contained.
describe('migration 014 — access tier rework', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 1 })
    await resetSchema(pool)
    await runMigrations({
      pool,
      migrationsDir: REAL_MIGRATIONS_DIR,
      logger: makeSilentLogger(),
    })
  })

  afterAll(async () => {
    // Restore globalSetup's seed rows (system user + demo world + dev
    // users + settings) so subsequent test files see the same baseline
    // they assume. Schema is already in the fully-migrated state from
    // this describe's beforeAll; only the seed needs replaying.
    await seedTestDatabase(pool)
    await pool.end()
  })

  it('rewrites facts.access_level CHECK to (known, discoverable, secret)', async () => {
    const entityId = uuidv7()
    await pool.query(
      `INSERT INTO entities (id, world_id, entity_type, name, access_level)
       VALUES ($1, $2, 'location', 'X', 'known')`,
      [entityId, DEMO_WORLD_ID],
    )
    // New vocabulary — should succeed.
    await expect(
      pool.query(
        `INSERT INTO facts (id, entity_id, topic, access_level, content, narrative_status)
         VALUES ($1, $2, 't', 'discoverable', 'c', 'undelivered')`,
        [uuidv7(), entityId],
      ),
    ).resolves.toBeDefined()
    // Old vocabulary — should fail under the rewritten CHECK.
    await expect(
      pool.query(
        `INSERT INTO facts (id, entity_id, topic, access_level, content, narrative_status)
         VALUES ($1, $2, 't', 'public', 'c', 'undelivered')`,
        [uuidv7(), entityId],
      ),
    ).rejects.toThrow(/facts_access_level_check/)
  })

  it('adds entities.access_level NOT NULL DEFAULT known with CHECK', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name='entities' AND column_name='access_level'`,
    )
    expect(rows).toEqual([
      {
        column_name: 'access_level',
        data_type: 'text',
        is_nullable: 'NO',
        column_default: "'known'::text",
      },
    ])
  })

  it('adds worlds.dev_bypass_access_filter NOT NULL DEFAULT false', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name='worlds' AND column_name='dev_bypass_access_filter'`,
    )
    expect(rows).toEqual([
      {
        column_name: 'dev_bypass_access_filter',
        data_type: 'boolean',
        is_nullable: 'NO',
        column_default: 'false',
      },
    ])
  })

  it('creates idx_entities_world_access index', async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename='entities' AND indexname='idx_entities_world_access'`,
    )
    expect(rows).toHaveLength(1)
  })
})

// MYT-61 T1: migration 022 promotes session_preps to one record per
// (campaign, session_number) via a named UNIQUE table constraint — the
// precondition for the prep worker's INSERT ... ON CONFLICT resume. Lives
// in its own describe so the schema-parity test above stays self-contained.
describe('migration 022 — session_preps uniqueness', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 1 })
    await resetSchema(pool)
    await runMigrations({
      pool,
      migrationsDir: REAL_MIGRATIONS_DIR,
      logger: makeSilentLogger(),
    })
  })

  afterAll(async () => {
    // Restore globalSetup's seed rows so subsequent test files see the same
    // baseline they assume — same teardown shape as the migration-014 block.
    await seedTestDatabase(pool)
    await pool.end()
  })

  it('has a UNIQUE constraint on (campaign_id, session_number)', async () => {
    const { rows } = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'session_preps' AND c.contype = 'u'`,
    )
    expect(rows.some((r) => r.def.includes('UNIQUE (campaign_id, session_number)'))).toBe(true)
  })
})
