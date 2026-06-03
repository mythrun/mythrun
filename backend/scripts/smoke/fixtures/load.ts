import type { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { FixtureFile } from './types.js'

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url))

/** Quote a SQL identifier (table/column). Fixtures are trusted dev artifacts; quoting
 *  keeps reserved words + casing safe. */
function q(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`
}

/** pg sends a JS object/array as a text param; a jsonb column rejects it without an
 *  explicit ::jsonb cast. Key off the JS value shape. */
function isJsonbValue(v: unknown): boolean {
  return typeof v === 'object' && v !== null
}

export function readFixture(name: string): FixtureFile {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')) as FixtureFile
}

/** Replay a captured fixture into the pool's DB. Delete-then-load (idempotent):
 *  non-shared tables are deleted bottom-to-top by `id`, then all tables inserted
 *  top-to-bottom (FK order). Shared rows (`shared: true`, e.g. globalSetup users) are
 *  inserted ON CONFLICT DO NOTHING and NEVER deleted. Every table is assumed to have an
 *  `id` PK (Mythrun's UUIDv7-everywhere convention). */
export async function loadFixture(pool: Pool, name: string): Promise<FixtureFile> {
  const fixture = readFixture(name)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const table of [...fixture.tables].reverse()) {
      if (table.shared) continue
      const ids = table.rows.map((r) => r.id)
      if (ids.length > 0) await client.query(`DELETE FROM ${q(table.name)} WHERE id = ANY($1)`, [ids])
    }
    for (const table of fixture.tables) {
      for (const row of table.rows) {
        const cols = Object.keys(row)
        const vals = cols.map((c) => (isJsonbValue(row[c]) ? JSON.stringify(row[c]) : row[c]))
        const placeholders = cols.map((c, i) => (isJsonbValue(row[c]) ? `$${String(i + 1)}::jsonb` : `$${String(i + 1)}`))
        const conflict = table.shared ? ' ON CONFLICT DO NOTHING' : ''
        await client.query(
          `INSERT INTO ${q(table.name)} (${cols.map(q).join(', ')}) VALUES (${placeholders.join(', ')})${conflict}`,
          vals,
        )
      }
    }
    await client.query('COMMIT')
    return fixture
  } catch (err) {
    await client.query('ROLLBACK')
    const cause = err instanceof Error ? err.message : String(err)
    // Preserve the original error (stack + pg fields like code/column/detail) via `cause`
    // while surfacing the actionable regenerate hint in the message.
    throw new Error(
      `loadFixture(${name}) failed (fixture captured against schemaVersion=${fixture.schemaVersion}). ` +
        `If a migration changed a column since, regenerate via capture.ts. Cause: ${cause}`,
      { cause: err },
    )
  } finally {
    client.release()
  }
}
