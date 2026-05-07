import type { ClientLike } from '../../../repo/_types.js'
import { uuidv7 } from '../../../repo/uuidv7.js'

let counter = 0

/**
 * Insert a minimal users row and return `{ id }`.
 *
 * Generates a unique cognito_sub and username per call so tests that call
 * this helper multiple times within the same transaction don't hit the
 * UNIQUE constraints.
 */
export async function createTestUser(tx: ClientLike): Promise<{ id: string }> {
  const id = uuidv7()
  const n = ++counter
  await tx.query(
    `INSERT INTO users (id, cognito_sub, username, display_name)
     VALUES ($1, $2, $3, $4)`,
    [id, `test_sub_${String(n)}`, `testuser${String(n)}`, `Test User ${String(n)}`],
  )
  return { id }
}
