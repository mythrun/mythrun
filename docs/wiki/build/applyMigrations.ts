import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'

const FILENAME_RE = /^[0-9]{3,}_[a-z0-9_]+\.sql$/

/**
 * Reads every `NNN_name.sql` file in `migrationsDir` (alphabetical order is
 * the apply order), and executes them inside a single transaction against the
 * pool's current search_path. Throws if a file fails. Used by the wiki schema
 * extractor to populate a throwaway schema before introspection — it does not
 * track migrations in `_migrations`, take advisory locks, or log structured
 * events the way the backend's runMigrations does. The wiki owns its schema.
 */
export async function applyMigrations(pool: Pool, migrationsDir: string): Promise<void> {
  const entries = await readdir(migrationsDir)
  const files = entries.filter((name) => FILENAME_RE.test(name)).sort()
  if (files.length === 0) {
    throw new Error(`applyMigrations: no migrations found in ${migrationsDir}`)
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), 'utf-8')
      await client.query(sql)
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // Swallow rollback errors so the original failure surfaces.
    })
    throw err
  } finally {
    client.release()
  }
}
