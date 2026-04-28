import { uuidv7 as uuidv7Pkg } from 'uuidv7'

/**
 * UUIDv7 generator — time-ordered keys for B-tree locality on PK indexes.
 *
 * Wraps the `uuidv7` package as a single-line module so:
 *   1. Tests can vi.mock('./uuidv7.js') if deterministic IDs are needed.
 *   2. A future migration to a different UUIDv7 lib is a one-file change.
 *
 * Used by every repo create method and by the migration runner CLI's runId.
 */
export const uuidv7 = (): string => uuidv7Pkg()
