import type { QueryResult, QueryResultRow } from 'pg'

/**
 * Minimal query interface satisfied by both `pg.Pool` and `pg.PoolClient`.
 *
 * Use this type for repository methods that must work inside a caller-managed
 * transaction (i.e. the caller passes an in-flight PoolClient) as well as
 * methods that acquire their own connection from the pool. Keeping the
 * parameter type narrow avoids leaking pool-lifecycle concerns (connect /
 * release) into repository code.
 */
export interface ClientLike {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>
}
