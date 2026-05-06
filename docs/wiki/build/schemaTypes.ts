/**
 * Typed shape returned by the schema extractor and consumed by the renderer.
 * The renderer is a pure function of this object — no DB access, no I/O.
 */

export type ClusterName =
  | 'Identity & billing'
  | 'Worlds & entities'
  | 'Campaigns & play'
  | 'Pipeline & ops'
  | 'SRD reference'
  | 'Other'

export type DeleteRule = 'CASCADE' | 'SET NULL' | 'NO ACTION' | 'RESTRICT'

export interface ColumnMeta {
  name: string
  type: string
  nullable: boolean
  default: string | null
  fk: { foreignTable: string; foreignColumn: string; deleteRule: DeleteRule } | null
}

export interface IndexMeta {
  name: string
  columns: string[]
  unique: boolean
  predicate: string | null
  expression: string | null
  rawDef: string
}

export interface CheckMeta {
  name: string
  clause: string
}

export interface FkMeta {
  column: string
  foreignTable: string
  foreignColumn: string
  deleteRule: DeleteRule
}

export interface TableMeta {
  name: string
  cluster: ClusterName
  columns: ColumnMeta[]
  indexes: IndexMeta[]
  checks: CheckMeta[]
  fks: FkMeta[]
}

export interface SchemaMetadata {
  tables: TableMeta[]
}

/**
 * Static cluster assignment. Lifted from content/data/schema.html groupings.
 * Tables not in this map fall into 'Other' (defensive — should never fire).
 * `_migrations` is intentionally absent: framework metadata, not application
 * schema, and the user-facing reference hides it.
 */
export const TABLE_CLUSTERS: Readonly<Record<string, ClusterName>> = {
  // Identity & billing
  users: 'Identity & billing',
  credit_ledger: 'Identity & billing',
  subscription_tiers: 'Identity & billing',
  user_subscriptions: 'Identity & billing',
  session_packs: 'Identity & billing',
  purchases: 'Identity & billing',
  stripe_events: 'Identity & billing',
  billing_history: 'Identity & billing',
  // Worlds & entities
  worlds: 'Worlds & entities',
  entities: 'Worlds & entities',
  prose_kernels: 'Worlds & entities',
  facts: 'Worlds & entities',
  relationships: 'Worlds & entities',
  entity_hierarchy: 'Worlds & entities',
  random_tables: 'Worlds & entities',
  random_table_entries: 'Worlds & entities',
  stat_blocks: 'Worlds & entities',
  stat_block_actions: 'Worlds & entities',
  // Campaigns & play
  campaigns: 'Campaigns & play',
  campaign_members: 'Campaigns & play',
  campaign_invites: 'Campaigns & play',
  characters: 'Campaigns & play',
  character_skills: 'Campaigns & play',
  character_features: 'Campaigns & play',
  character_equipment: 'Campaigns & play',
  character_spells: 'Campaigns & play',
  sessions: 'Campaigns & play',
  session_messages: 'Campaigns & play',
  session_participants: 'Campaigns & play',
  world_snapshots: 'Campaigns & play',
  session_preps: 'Campaigns & play',
  session_usage: 'Campaigns & play',
  // Pipeline & ops
  pipeline_runs: 'Pipeline & ops',
  world_marketplace: 'Pipeline & ops',
  moderation_flags: 'Pipeline & ops',
  settings: 'Pipeline & ops',
  // SRD reference
  srd_monsters: 'SRD reference',
  srd_spells: 'SRD reference',
  srd_conditions: 'SRD reference',
}

/** Display order for clusters in the rendered page. */
export const CLUSTER_ORDER: readonly ClusterName[] = [
  'Identity & billing',
  'Worlds & entities',
  'Campaigns & play',
  'Pipeline & ops',
  'SRD reference',
  'Other',
]

/** Tables explicitly excluded from the reference page. */
export const HIDDEN_TABLES: ReadonlySet<string> = new Set(['_migrations'])
