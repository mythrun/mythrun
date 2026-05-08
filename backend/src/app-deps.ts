import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Repo } from './repo/index.js'

export interface AppDeps {
  pg: Pool
  redisRealtime: Redis
  redisBatch: Redis
  /** Per-environment+region prefix for Redis keys, e.g. "production:use1:".
   *  Threaded through to ws-ticket helpers (and any future Redis-keyed
   *  subsystem) so staging+prod sharing one ElastiCache cluster don't
   *  share keyspace. Derived in env.ts as ${MYTHRUN_ENV}:${REGION_PREFIX}:. */
  redisKeyPrefix: string
  repo: Repo
}
