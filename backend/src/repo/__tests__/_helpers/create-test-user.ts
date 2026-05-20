import type { ClientLike } from '../../../repo/_types.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import type { ScopedSub, TestScope } from './test-scope.js'

/**
 * Insert a minimal users row and return `{ id }`.
 *
 * The `scope` parameter forces the test author to thread the scope through to
 * the fixture builder, even though it isn't read directly here — the brand on
 * `opts.sub` (which can only be produced via `scope.userSub(n)`) does the
 * actual type-level enforcement. Together they guarantee that every test user
 * is owned by exactly one scope and therefore cleaned up by
 * `cleanupTestScope`.
 */
export async function createTestUser(
  tx: ClientLike,
  scope: TestScope,
  opts: { sub: ScopedSub; displayName?: string },
): Promise<{ id: string }> {
  // Touch `scope` so unused-param lint stays quiet without an underscore
  // prefix (which the codebase's eslint config may not allow).
  void scope.id
  const id = uuidv7()
  // Derive username deterministically from the scoped sub so callers don't
  // have to thread a second scoped identifier — the sub is already unique
  // per (scope, n).
  const username = opts.sub.replace(/-/g, '').slice(0, 28)
  const displayName = opts.displayName ?? `Test User (${opts.sub})`
  await tx.query(
    `INSERT INTO users (id, cognito_sub, username, display_name)
     VALUES ($1, $2, $3, $4)`,
    [id, opts.sub, username, displayName],
  )
  return { id }
}
