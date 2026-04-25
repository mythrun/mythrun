import { Redis, type RedisOptions } from 'ioredis'

export function createRedisClient(url: string): Redis {
  // Prevent ioredis's default infinite-retry behavior from fighting our
  // own waitFor loop and from emitting unhandled 'error' events after
  // process.exit(1). All retry policy lives in waitFor.
  const options: RedisOptions = {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    enableOfflineQueue: false,
  }
  return new Redis(url, options)
}
