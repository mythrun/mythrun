import { describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { withTransaction } from '../transaction.js'

interface QueryStub {
  readonly client: PoolClient
  readonly query: ReturnType<typeof vi.fn>
}

function emptyResult(): { rows: unknown[]; rowCount: number } {
  return { rows: [], rowCount: 0 }
}

function makeClient(): QueryStub {
  const query = vi.fn(() => Promise.resolve(emptyResult()))
  return { client: { query } as unknown as PoolClient, query }
}

function sqlAt(query: ReturnType<typeof vi.fn>, i: number): string {
  return (query.mock.calls[i]?.[0] ?? '') as string
}

describe('withTransaction', () => {
  it('commits on success and returns fn result', async () => {
    const { client, query } = makeClient()
    const result = await withTransaction(client, () => Promise.resolve('ok'))
    expect(result).toBe('ok')
    expect([sqlAt(query, 0), sqlAt(query, 1)]).toEqual(['BEGIN', 'COMMIT'])
  })

  it('rolls back when fn throws and rethrows the original error', async () => {
    const { client, query } = makeClient()
    const err = new Error('boom')
    await expect(withTransaction(client, () => Promise.reject(err))).rejects.toBe(err)
    expect([sqlAt(query, 0), sqlAt(query, 1)]).toEqual(['BEGIN', 'ROLLBACK'])
  })

  it('swallows secondary ROLLBACK errors and surfaces the original throw', async () => {
    // First call BEGIN succeeds; fn rejects with `boom`; ROLLBACK rejects
    // with `pg_connection_broken` (e.g., the original error already broke
    // the connection). The original `boom` must still surface.
    const query = vi.fn()
    query.mockImplementationOnce(() => Promise.resolve(emptyResult())) // BEGIN
    query.mockImplementationOnce(() => Promise.reject(new Error('pg_connection_broken'))) // ROLLBACK
    const client = { query } as unknown as PoolClient
    const boom = new Error('boom')
    await expect(withTransaction(client, () => Promise.reject(boom))).rejects.toBe(boom)
    expect([sqlAt(query, 0), sqlAt(query, 1)]).toEqual(['BEGIN', 'ROLLBACK'])
  })
})
