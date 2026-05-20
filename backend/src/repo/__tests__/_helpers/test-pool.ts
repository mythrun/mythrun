// backend/src/repo/__tests__/_helpers/test-pool.ts
//
// Uniform pool factory for test files. Hard-codes `max: 4` so the
// per-fork connection budget is predictable under parallel execution
// (myth-oehx Section 4 — connection budget table).
//
// Every test file should:
//   1. Use createTestPool(url) (not new Pool({...})) to build its pool.
//   2. Call pool.end() in afterAll, so the fork doesn't accumulate
//      sockets across files.
//
// Phase 4 migrates per-file `new Pool(...)` constructions to this factory.

import { Pool } from 'pg'

export function createTestPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 4,
  })
}
