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
  const client = new Redis(url, options)
  // ioredis emits 'error' events for transient connection failures even when
  // the calling code already handles the rejection via .ping()/.get() etc.
  // Without a listener, Node logs "Unhandled error event" noise during
  // closePartials cleanup if the client never successfully connected. Real
  // errors still surface through the per-call promise rejections.
  client.on('error', () => undefined)
  return client
}
