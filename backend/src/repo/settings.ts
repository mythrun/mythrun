// backend/src/repo/settings.ts
//
// Repo for the `settings` table (migration 010) — singleton key/value
// global-policy rows (cost caps, etc.). `value` is NOT NULL by schema, so
// a missing row is the only "absent" case getValue surfaces (as null);
// the caller decides whether absence is an error (cost-cap reads throw).
//
// Composable binder: the single read is one statement over a ClientLike
// (pool OR an in-flight tx client), so it binds on both surfaces. Mirrors
// the worldsNs / pipelineRunsNs pattern.

import type { Pool } from 'pg'
import type { ClientLike } from './_types.js'

export interface SettingsRepo {
  /**
   * Read the value for a settings key. Returns null when no row exists for
   * the key. `settings.value` is NOT NULL per the schema, so a present row
   * always carries a string — the null return signals a MISSING row, not a
   * null column. SQL verbatim from cost-cap.ts's two cap reads (the key is
   * now a parameter so the one method serves both call sites).
   */
  readonly getValue: (key: string) => Promise<string | null>
}

export function settingsNs(c: ClientLike): SettingsRepo {
  return {
    getValue: async (key: string): Promise<string | null> => {
      const result = await c.query<{ value: string }>(
        `SELECT value FROM settings WHERE key = $1`,
        [key],
      )
      return result.rows[0]?.value ?? null
    },
  }
}

/** Back-compat factory — pool-bound `settings` surface. Direct importers keep
 *  working; new code goes through `repo.settings`. */
export const createSettingsRepo = (pool: Pool): SettingsRepo => settingsNs(pool)
