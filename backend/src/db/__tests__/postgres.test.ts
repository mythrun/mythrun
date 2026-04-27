import { describe, it, expect } from 'vitest'
import { createPgPool } from '../postgres.js'

describe('createPgPool', () => {
  it('accepts pool overrides (max, connectionTimeoutMillis)', () => {
    const pool = createPgPool('postgresql://u:p@h:5432/d', {
      max: 1,
      connectionTimeoutMillis: 10_000,
    })
    // pg-pool exposes options on the pool instance; verify they're applied.
    expect(pool.options.max).toBe(1)
    expect(pool.options.connectionTimeoutMillis).toBe(10_000)
    pool.end().catch(() => undefined)
  })

  it('works with no overrides (existing callers)', () => {
    const pool = createPgPool('postgresql://u:p@h:5432/d')
    expect(pool).toBeDefined()
    pool.end().catch(() => undefined)
  })

  it('overrides win when the same key would have come from URL/SSL derivation', () => {
    // We narrow the type to disallow connectionString/ssl, but verify the
    // spread ORDER is correct in case the type is ever loosened.
    const pool = createPgPool('postgresql://u:p@h:5432/d', {
      max: 7,
    })
    expect(pool.options.max).toBe(7)
    pool.end().catch(() => undefined)
  })
})
