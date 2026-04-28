import { Pool } from 'pg'
import { applyMigrations } from './applyMigrations.ts'
import {
  CLUSTER_ORDER,
  HIDDEN_TABLES,
  TABLE_CLUSTERS,
  type CheckMeta,
  type ClusterName,
  type ColumnMeta,
  type DeleteRule,
  type FkMeta,
  type IndexMeta,
  type SchemaMetadata,
  type TableMeta,
} from './schemaTypes.ts'

interface RawColumnRow {
  table_name: string
  column_name: string
  data_type: string
  udt_name: string
  is_nullable: 'YES' | 'NO'
  column_default: string | null
  ordinal_position: number
  character_maximum_length: number | null
  numeric_precision: number | null
  numeric_scale: number | null
}

interface RawIndexRow {
  tablename: string
  indexname: string
  indexdef: string
}

interface RawCheckRow {
  table_name: string
  conname: string
  clause: string
}

interface RawFkRow {
  table_name: string
  column_name: string
  foreign_table_name: string
  foreign_column_name: string
  delete_rule: string
}

export interface ExtractOptions {
  readonly databaseUrl: string
  readonly migrationsDir: string
}

/**
 * Applies the migrations to a throwaway schema, introspects it, returns a
 * typed metadata object, drops the schema, closes the pool. The schema name
 * is suffixed with the process pid and a random nonce, so concurrent runs
 * against the same DB get isolated namespaces.
 */
export async function extractSchema(opts: ExtractOptions): Promise<SchemaMetadata> {
  const schemaName = `wiki_schema_introspect_${String(process.pid)}_${Math.random().toString(36).slice(2, 8)}`
  const pool = new Pool({ connectionString: opts.databaseUrl, max: 1 })
  const client = await pool.connect()
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    await client.query(`CREATE SCHEMA ${schemaName}`)
    await client.query(`SET search_path TO ${schemaName}, public`)

    await applyMigrations(client, opts.migrationsDir)

    const tablesQ = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
      [schemaName],
    )

    const columnsQ = await client.query<RawColumnRow>(
      `SELECT
         table_name, column_name, data_type, udt_name, is_nullable, column_default,
         ordinal_position, character_maximum_length, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [schemaName],
    )

    const indexesQ = await client.query<RawIndexRow>(
      `SELECT tablename, indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = $1 AND indexname LIKE 'idx_%'
        ORDER BY tablename, indexname`,
      [schemaName],
    )

    const checksQ = await client.query<RawCheckRow>(
      `SELECT t.relname AS table_name, c.conname, pg_get_constraintdef(c.oid) AS clause
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype = 'c' AND n.nspname = $1
        ORDER BY t.relname, c.conname`,
      [schemaName],
    )

    const fksQ = await client.query<RawFkRow>(
      `SELECT
         tc.table_name,
         kcu.column_name,
         ccu.table_name AS foreign_table_name,
         ccu.column_name AS foreign_column_name,
         rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu USING (constraint_name)
       JOIN information_schema.constraint_column_usage ccu USING (constraint_name)
       JOIN information_schema.referential_constraints rc USING (constraint_name)
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
       ORDER BY tc.table_name, kcu.column_name`,
      [schemaName],
    )

    const tables = buildSchemaMetadata(
      tablesQ.rows,
      columnsQ.rows,
      indexesQ.rows,
      checksQ.rows,
      fksQ.rows,
    )

    return { tables }
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {
      // Swallow cleanup errors so the original failure surfaces.
    })
    client.release()
    await pool.end()
  }
}

function clusterFor(tableName: string): ClusterName {
  const c = TABLE_CLUSTERS[tableName]
  return c ?? 'Other'
}

function formatType(col: RawColumnRow): string {
  // information_schema.data_type collapses many types to broad labels
  // ("USER-DEFINED" for enums, "ARRAY" for any array). udt_name is the
  // underlying type name (uuid, jsonb, etc.). Prefer udt_name for the
  // common cases where data_type is unhelpful. For arrays, udt_name is
  // the element type prefixed with `_` (e.g. `_text`); strip the underscore
  // and append `[]` for the conventional rendering.
  if (col.data_type === 'ARRAY') return col.udt_name.replace(/^_/, '') + '[]'
  if (col.data_type === 'USER-DEFINED') return col.udt_name
  if (col.data_type === 'character varying') {
    return col.character_maximum_length === null
      ? 'varchar'
      : `varchar(${String(col.character_maximum_length)})`
  }
  if (col.data_type === 'numeric' && col.numeric_precision !== null) {
    const scale = col.numeric_scale ?? 0
    return `numeric(${String(col.numeric_precision)},${String(scale)})`
  }
  if (col.data_type === 'timestamp with time zone') return 'timestamptz'
  if (col.data_type === 'timestamp without time zone') return 'timestamp'
  return col.data_type
}

const COLUMN_LIST_RE = /\(([^)]+)\)(?:\s+WHERE\s+\((.+)\))?/i
const PREDICATE_RE = /\bWHERE\s+\((.+)\)\s*$/i

function parseIndexDef(rawDef: string): { columns: string[]; predicate: string | null; expression: string | null } {
  // pg's indexdef looks like:
  //   CREATE [UNIQUE] INDEX <name> ON <schema>.<table> USING btree (col1, col2) [WHERE (...)]
  // For simple column lists, the parens after USING-something contain comma-separated
  // identifiers. For expression-based indexes (COALESCE(...)), the parens contain
  // expressions we can't cleanly tokenize — fall back to rendering the raw def.
  const match = COLUMN_LIST_RE.exec(rawDef)
  if (match === null) return { columns: [], predicate: null, expression: rawDef }
  const inner = match[1] ?? ''
  // Crude expression detection: a comma-separated list of bare identifiers
  // (lowercase letters, digits, underscores) is "simple"; anything else
  // (parentheses, casts, function calls) is treated as an expression and we
  // fall back to the raw def.
  const parts = inner.split(',').map((s) => s.trim())
  const isSimple = parts.every((p) => /^[a-z_][a-z0-9_]*$/.test(p))
  const predicateMatch = PREDICATE_RE.exec(rawDef)
  const predicate = predicateMatch?.[1] ?? null
  if (!isSimple) {
    return { columns: [], predicate, expression: rawDef }
  }
  return { columns: parts, predicate, expression: null }
}

function buildSchemaMetadata(
  tableRows: { table_name: string }[],
  columnRows: RawColumnRow[],
  indexRows: RawIndexRow[],
  checkRows: RawCheckRow[],
  fkRows: RawFkRow[],
): TableMeta[] {
  const fkByTableCol = new Map<string, FkMeta>()
  for (const row of fkRows) {
    const rule = row.delete_rule.toUpperCase() as DeleteRule
    fkByTableCol.set(`${row.table_name}.${row.column_name}`, {
      column: row.column_name,
      foreignTable: row.foreign_table_name,
      foreignColumn: row.foreign_column_name,
      deleteRule: rule,
    })
  }

  const columnsByTable = new Map<string, ColumnMeta[]>()
  for (const row of columnRows) {
    const cols = columnsByTable.get(row.table_name) ?? []
    cols.push({
      name: row.column_name,
      type: formatType(row),
      nullable: row.is_nullable === 'YES',
      default: row.column_default,
      fk: fkByTableCol.get(`${row.table_name}.${row.column_name}`) ?? null,
    })
    columnsByTable.set(row.table_name, cols)
  }

  const indexesByTable = new Map<string, IndexMeta[]>()
  for (const row of indexRows) {
    const parsed = parseIndexDef(row.indexdef)
    const list = indexesByTable.get(row.tablename) ?? []
    list.push({
      name: row.indexname,
      columns: parsed.columns,
      unique: /CREATE UNIQUE/i.test(row.indexdef),
      predicate: parsed.predicate,
      expression: parsed.expression,
      rawDef: row.indexdef,
    })
    indexesByTable.set(row.tablename, list)
  }

  const checksByTable = new Map<string, CheckMeta[]>()
  for (const row of checkRows) {
    const list = checksByTable.get(row.table_name) ?? []
    list.push({ name: row.conname, clause: row.clause })
    checksByTable.set(row.table_name, list)
  }

  const fksByTable = new Map<string, FkMeta[]>()
  for (const row of fkRows) {
    const list = fksByTable.get(row.table_name) ?? []
    const rule = row.delete_rule.toUpperCase() as DeleteRule
    list.push({
      column: row.column_name,
      foreignTable: row.foreign_table_name,
      foreignColumn: row.foreign_column_name,
      deleteRule: rule,
    })
    fksByTable.set(row.table_name, list)
  }

  const tables: TableMeta[] = []
  for (const tr of tableRows) {
    if (HIDDEN_TABLES.has(tr.table_name)) continue
    tables.push({
      name: tr.table_name,
      cluster: clusterFor(tr.table_name),
      columns: columnsByTable.get(tr.table_name) ?? [],
      indexes: indexesByTable.get(tr.table_name) ?? [],
      checks: checksByTable.get(tr.table_name) ?? [],
      fks: fksByTable.get(tr.table_name) ?? [],
    })
  }
  return tables
}

/** Used by buildPipeline.ts to ensure clusters are emitted in display order. */
export const ORDERED_CLUSTERS = CLUSTER_ORDER
