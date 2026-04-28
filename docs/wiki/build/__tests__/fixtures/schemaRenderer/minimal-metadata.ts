import type { SchemaMetadata } from '../../../schemaTypes.ts'

/**
 * Minimal fixture: one table per cluster covering the rendering edge cases.
 * - users: simple columns + one CHECK + one FK (auth_provider)
 * - facts: partial-unique index, multi-column index, multiple CHECKs, FK with CASCADE
 * - sessions: partial-unique index with a WHERE predicate
 * - pipeline_runs: expression-based unique index (no clean column list)
 * - srd_monsters: empty (no indexes, no CHECKs, no FKs) — proves empty sections collapse
 */
export const minimalMetadata: SchemaMetadata = {
  tables: [
    {
      name: 'users',
      cluster: 'Identity & billing',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, default: null, fk: null },
        { name: 'email', type: 'text', nullable: false, default: null, fk: null },
        { name: 'auth_provider', type: 'text', nullable: false, default: null, fk: null },
      ],
      indexes: [],
      checks: [
        {
          name: 'users_auth_provider_check',
          clause: "CHECK ((auth_provider = ANY (ARRAY['google'::text, 'discord'::text])))",
        },
      ],
      fks: [],
    },
    {
      name: 'facts',
      cluster: 'Worlds & entities',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, default: null, fk: null },
        {
          name: 'entity_id',
          type: 'uuid',
          nullable: false,
          default: null,
          fk: { foreignTable: 'entities', foreignColumn: 'id', deleteRule: 'CASCADE' },
        },
        { name: 'access_level', type: 'text', nullable: false, default: null, fk: null },
      ],
      indexes: [
        {
          name: 'idx_facts_entity',
          columns: ['entity_id'],
          unique: false,
          predicate: null,
          expression: null,
          rawDef: 'CREATE INDEX idx_facts_entity ON wiki_schema_introspect.facts USING btree (entity_id)',
        },
      ],
      checks: [
        {
          name: 'facts_access_level_check',
          clause:
            "CHECK ((access_level = ANY (ARRAY['public'::text, 'private'::text, 'secret'::text])))",
        },
      ],
      fks: [
        {
          column: 'entity_id',
          foreignTable: 'entities',
          foreignColumn: 'id',
          deleteRule: 'CASCADE',
        },
      ],
    },
    {
      name: 'sessions',
      cluster: 'Campaigns & play',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, default: null, fk: null },
        {
          name: 'campaign_id',
          type: 'uuid',
          nullable: false,
          default: null,
          fk: { foreignTable: 'campaigns', foreignColumn: 'id', deleteRule: 'CASCADE' },
        },
        { name: 'status', type: 'text', nullable: false, default: null, fk: null },
      ],
      indexes: [
        {
          name: 'idx_sessions_one_active',
          columns: ['campaign_id'],
          unique: true,
          predicate: "status = 'active'::text",
          expression: null,
          rawDef:
            "CREATE UNIQUE INDEX idx_sessions_one_active ON wiki_schema_introspect.sessions USING btree (campaign_id) WHERE (status = 'active'::text)",
        },
      ],
      checks: [],
      fks: [
        {
          column: 'campaign_id',
          foreignTable: 'campaigns',
          foreignColumn: 'id',
          deleteRule: 'CASCADE',
        },
      ],
    },
    {
      name: 'pipeline_runs',
      cluster: 'Pipeline & ops',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, default: null, fk: null },
        {
          name: 'world_id',
          type: 'uuid',
          nullable: true,
          default: null,
          fk: { foreignTable: 'worlds', foreignColumn: 'id', deleteRule: 'CASCADE' },
        },
        { name: 'stage', type: 'text', nullable: false, default: null, fk: null },
      ],
      indexes: [
        {
          name: 'idx_pipeline_runs_unique',
          columns: [],
          unique: true,
          predicate: null,
          expression:
            "CREATE UNIQUE INDEX idx_pipeline_runs_unique ON wiki_schema_introspect.pipeline_runs USING btree (COALESCE(world_id, campaign_id), stage, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid))",
          rawDef:
            "CREATE UNIQUE INDEX idx_pipeline_runs_unique ON wiki_schema_introspect.pipeline_runs USING btree (COALESCE(world_id, campaign_id), stage, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid))",
        },
      ],
      checks: [],
      fks: [
        {
          column: 'world_id',
          foreignTable: 'worlds',
          foreignColumn: 'id',
          deleteRule: 'CASCADE',
        },
      ],
    },
    {
      name: 'srd_monsters',
      cluster: 'SRD reference',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, default: null, fk: null },
        { name: 'name', type: 'text', nullable: false, default: null, fk: null },
      ],
      indexes: [],
      checks: [],
      fks: [],
    },
  ],
}
