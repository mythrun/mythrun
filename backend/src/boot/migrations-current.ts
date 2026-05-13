// Boot-gate probe: ensure the DB has applied every migration this image
// expects. Run as part of the API server's boot-gate sequence in
// backend/src/server.ts.
//
// Compares by set inclusion (every file in the image is applied), NOT by
// strict count equality. Rollback to an image with fewer migrations is
// tolerated; missing migrations on the DB side is not.
//
// On a fresh DB the _migrations table does not exist. We detect that
// case explicitly via to_regclass and emit an operator-actionable error,
// rather than the generic SQLSTATE 42P01 surface.

import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { MIGRATION_FILE_RE } from '../db/migration-filename.js'

export async function probeMigrationsCurrent(pool: Pool): Promise<void> {
  // Path resolution: in the production image,
  //   /app/dist/boot/migrations-current.js → /app/migrations/*.sql
  // (three `..`s because boot/ is one deeper than dist/ root,
  // and migrations/ is a sibling of dist/).
  const here = fileURLToPath(import.meta.url)
  const migrationsDir = resolve(here, '../../../migrations')
  const allFiles = await readdir(migrationsDir)
  const sqlFiles = allFiles.filter((f) => MIGRATION_FILE_RE.test(f)).sort()

  // Check the table exists before SELECTing from it. SELECT count(*) on a
  // missing relation throws SQLSTATE 42P01; the to_regclass form returns
  // NULL and lets us emit a better error.
  const existsResult = await pool.query<{ reg: string | null }>(
    "SELECT to_regclass('public._migrations')::text AS reg",
  )
  const exists = existsResult.rows[0]?.reg ?? null
  if (exists === null) {
    /* c8 ignore start — '(none)' fallback fires only when migrations/
     * is empty. The repo always ships migrations; this is defense-in-
     * depth for an accidentally-emptied dir. */
    const latest = sqlFiles.at(-1) ?? '(none)'
    /* c8 ignore stop */
    throw new Error(
      `migrations-current: _migrations table does not exist — DB has never been migrated. ` +
        `Run \`gh workflow run db-migrate\` to apply ${String(sqlFiles.length)} migrations ` +
        `(latest in image: ${latest}).`,
    )
  }

  const appliedResult = await pool.query<{ version: string }>('SELECT version FROM _migrations')
  const appliedSet = new Set(appliedResult.rows.map((r) => r.version))
  const missing = sqlFiles.filter((f) => !appliedSet.has(f))

  if (missing.length > 0) {
    throw new Error(
      `migrations-current: image expects ${String(sqlFiles.length)} migrations, ` +
        `DB is missing ${String(missing.length)} (${missing.join(', ')}). ` +
        `Run \`gh workflow run db-migrate\` then re-trigger Deploy.`,
    )
  }
}
