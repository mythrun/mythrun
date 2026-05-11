// Shared filename pattern for forward-rolling SQL migrations.
//
// Consumed by:
//   - backend/src/db/migrate.ts        (the migration runner)
//   - backend/src/boot/migrations-current.ts (the boot-gate probe)
//
// Keep these consumers locked to one regex; a probe that filters
// differently than the runner produces silent count drift.
export const MIGRATION_FILE_RE = /^[0-9]{3,}_[a-z0-9_]+\.sql$/

export function isValidMigrationFilename(name: string): boolean {
  return MIGRATION_FILE_RE.test(name)
}
