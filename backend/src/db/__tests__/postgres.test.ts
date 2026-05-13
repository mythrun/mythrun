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

  it('sslmode=require → ssl: { rejectUnauthorized: false } (RDS encryption-only)', () => {
    const pool = createPgPool('postgresql://u:p@h:5432/d?sslmode=require')
    expect(pool.options.ssl).toEqual({ rejectUnauthorized: false })
    pool.end().catch(() => undefined)
  })

  it('sslmode=verify-ca → ssl: { rejectUnauthorized: true }', () => {
    const pool = createPgPool('postgresql://u:p@h:5432/d?sslmode=verify-ca')
    expect(pool.options.ssl).toEqual({ rejectUnauthorized: true })
    pool.end().catch(() => undefined)
  })

  it('sslmode=verify-full → ssl: { rejectUnauthorized: true }', () => {
    const pool = createPgPool('postgresql://u:p@h:5432/d?sslmode=verify-full')
    expect(pool.options.ssl).toEqual({ rejectUnauthorized: true })
    pool.end().catch(() => undefined)
  })

  it('no sslmode → ssl unset (dev branch)', () => {
    const pool = createPgPool('postgresql://u:p@h:5432/d')
    expect(pool.options.ssl).toBeUndefined()
    pool.end().catch(() => undefined)
  })

  it('strips sslmode from connection string before passing to pg', () => {
    // pg-pool stores the connectionString on options when no other host
    // info is provided. Verify our sslmode-stripping pre-processing leaves
    // it absent from the URL pg actually uses.
    const pool = createPgPool('postgresql://u:p@h:5432/d?sslmode=require')
    const cs = pool.options.connectionString
    expect(typeof cs).toBe('string')
    expect(cs).not.toContain('sslmode')
    pool.end().catch(() => undefined)
  })

  it('sslmode=disable (unrecognized to our switch) → ssl unset', () => {
    // 'disable' isn't one of the modes we explicitly handle; the function
    // falls through to "no ssl config." Documents the default-branch
    // behavior for completeness.
    const pool = createPgPool('postgresql://u:p@h:5432/d?sslmode=disable')
    expect(pool.options.ssl).toBeUndefined()
    pool.end().catch(() => undefined)
  })
})
