import type { Pool } from 'pg'
import type { Redis } from 'ioredis'

export interface AppDeps {
  pg: Pool
  redisRealtime: Redis
  redisBatch: Redis
}
