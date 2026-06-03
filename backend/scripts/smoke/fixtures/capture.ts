import type { Pool } from 'pg'
import { Pool as PgPool } from 'pg'
import { writeFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { FixtureFile, FixtureManifest, FixtureRootIds, FixtureTableData } from './types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', 'migrations')

/** Latest migration filename — stamped into the fixture as a drift breadcrumb. */
function latestMigration(): string {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort().at(-1) ?? 'unknown'
}

/** Run each manifest table's root-scoped filter and collect RAW pg rows (the CLI then
 *  JSON.stringifies them → timestamptz becomes ISO strings the loader reads back as strings). */
export async function captureFixture(
  pool: Pool,
  manifest: FixtureManifest,
  ids: FixtureRootIds,
): Promise<FixtureFile> {
  const tables: FixtureTableData[] = []
  for (const t of manifest.tables) {
    const { sql, params } = t.filter(ids)
    const res = await pool.query(`SELECT * FROM "${t.name}" WHERE ${sql}`, [...params])
    tables.push({ name: t.name, shared: t.shared ?? false, rows: res.rows as Record<string, unknown>[] })
  }
  return {
    name: manifest.name,
    capturedAt: new Date().toISOString(),
    schemaVersion: latestMigration(),
    rootCampaignId: ids.campaignId,
    rootWorldId: ids.worldId,
    tables,
  }
}

/* c8 ignore start — CLI entry; the engine (captureFixture) is unit-tested */
async function main(): Promise<void> {
  const [manifestName, campaignId] = process.argv.slice(2)
  if (!manifestName || !campaignId) throw new Error('usage: capture.ts <manifestName> <rootCampaignId>')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL required')
  const mod = (await import(`./${manifestName}.manifest.js`)) as Record<string, FixtureManifest>
  const manifest = Object.values(mod).find((m): m is FixtureManifest => typeof m === 'object' && 'tables' in m)
  if (!manifest) throw new Error(`no FixtureManifest export in ${manifestName}.manifest.ts`)
  const pool = new PgPool({ connectionString: dbUrl })
  try {
    const wr = await pool.query<{ world_id: string }>(`SELECT world_id FROM campaigns WHERE id = $1`, [campaignId])
    const worldId = wr.rows[0]?.world_id
    if (!worldId) throw new Error(`campaign ${campaignId} not found`)
    const file = await captureFixture(pool, manifest, { campaignId, worldId })
    const out = join(HERE, `${manifest.name}.json`)
    writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    process.stdout.write(`captured ${String(file.tables.reduce((n, t) => n + t.rows.length, 0))} rows → ${out}\n`)
  } finally {
    await pool.end()
  }
}

if (process.argv[1]?.endsWith('capture.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exit(1)
  })
}
/* c8 ignore stop */
