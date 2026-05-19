// Tests target the dedicated test DB (`mythrun_test`) or a per-worktree
// variant (`mythrun_test_<worktree>`). The dev DB (`mythrun_dev`) and any
// other name is rejected — destructive operations (TRUNCATE CASCADE,
// DROP SCHEMA) must never run against dev or production data.
const ALLOWED_DBS = /^mythrun_test(_.+)?$/

// Async signature is intentional: a future iteration will query pg_stat_database
// to verify the DB is empty before running destructive tests. Keeping the
// signature async now means callers don't need to change later.
// eslint-disable-next-line @typescript-eslint/require-await
export async function guardTestDatabase(databaseUrl: string): Promise<void> {
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL not set — run `pnpm db:up` and ensure backend/.env.development exists, or set DATABASE_URL in CI',
    )
  }
  const url = new URL(databaseUrl)
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  const dbName = url.pathname.slice(1)
  if (!isLocal || !ALLOWED_DBS.test(dbName)) {
    throw new Error(
      `Refusing to run destructive tests against ${url.hostname}/${dbName}. ` +
        `Tests require localhost with a database name matching /^mythrun_test(_.+)?$/.`,
    )
  }
}
