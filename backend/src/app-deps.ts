import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Repo } from './repo/index.js'
import type { WorldGenQueueLike } from './routes/campaigns.js'

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
  /** BullMQ Queue handle for `world-gen` jobs. Constructed in server.ts at
   *  boot (after Redis is reachable) and threaded into the campaigns plugin
   *  registration so POST /api/campaigns + POST /resume can enqueue. Typed
   *  as the minimal WorldGenQueueLike contract — the plugin doesn't need
   *  BullMQ's full generic-heavy class type, and tests inject hand-rolled
   *  spies that satisfy the same shape. */
  worldGenQueue: WorldGenQueueLike
}
