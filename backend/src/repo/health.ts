// backend/src/repo/health.ts
//
// Liveness-probe namespace. The `/health/ready` route used to issue a raw
// `deps.pg.query('SELECT 1')` to probe Postgres reachability (sibling to the
// Redis `.ping()` probes). The data-layer unification routes ALL Postgres
// access through the repo surface — including this liveness probe — so the
// `SELECT 1` lives here as `repo.health.ping()` rather than as a raw query in
// the route. Keeps the "all DB access through the repository layer" rule
// total (the route no longer touches a pg client directly).
//
// Composable binder: the single read is one statement over a ClientLike (pool
// OR an in-flight tx client), so it binds on both surfaces. Mirrors the
// settingsNs / statBlocksNs pattern.

import type { Pool } from 'pg'
import type { ClientLike } from './_types.js'

export interface HealthRepo {
  /**
   * Postgres liveness probe — issues `SELECT 1`. Resolves when the connection
   * is reachable; rejects (propagating the pg error) when it is not. The
   * caller (the `/health/ready` route's probe wrapper) races this against a
   * timeout and maps a rejection to a 503. SQL verbatim from the former inline
   * `deps.pg.query('SELECT 1')`.
   */
  readonly ping: () => Promise<void>
}

export function healthNs(c: ClientLike): HealthRepo {
  return {
    ping: async (): Promise<void> => {
      await c.query(`SELECT 1`)
    },
  }
}

/** Back-compat factory — pool-bound `health` surface. New code goes through
 *  `repo.health`. */
export const createHealthRepo = (pool: Pool): HealthRepo => healthNs(pool)
