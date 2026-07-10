// Unit tests for the two Redis client factories. Both construct ioredis
// clients with non-default option sets — the API factory uses fast-fail
// command semantics (offline queue OFF) for request-path code; the BullMQ
// factory uses the blocking-command-friendly settings BullMQ requires. BOTH
// now reconnect via the shared bounded-backoff-with-jitter strategy (the P1
// fix: the old `retryStrategy: () => null` severed clients permanently on the
// first blip) and log lifecycle transitions.

import { afterAll, describe, expect, it, vi } from 'vitest'
import { Redis } from 'ioredis'
import {
  attachRedisLifecycleLogging,
  createRedisClient,
  type RedisClientLogger,
} from '../client.js'
import { createBullmqRedisClient } from '../bullmq-client.js'

function makeSpyLogger(): RedisClientLogger & {
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  debug: ReturnType<typeof vi.fn>
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

// Both factories accept a URL but the lazyConnect / no-connect options
// mean we don't actually need a reachable Redis for construction; they
// only attempt to connect on the first command. Tests dispose clients
// immediately via .disconnect() to keep timers from leaking.

describe('createRedisClient (API profile)', () => {
  const clients: Redis[] = []
  afterAll(() => {
    for (const c of clients) c.disconnect()
  })

  it('returns an ioredis client', () => {
    const client = createRedisClient('redis://127.0.0.1:6379')
    clients.push(client)
    expect(client).toBeInstanceOf(Redis)
  })

  it('attaches an error listener so transient connection errors do not surface as Unhandled error events', () => {
    const client = createRedisClient('redis://127.0.0.1:6379')
    clients.push(client)
    expect(client.listenerCount('error')).toBeGreaterThan(0)
    // Emitting an error should be a no-op (the debug-log listener handles it).
    expect(() => client.emit('error', new Error('boom'))).not.toThrow()
  })

  it('configures fast-fail command semantics: lazyConnect + maxRetriesPerRequest=1 + offline-queue disabled', () => {
    const client = createRedisClient('redis://127.0.0.1:6379')
    clients.push(client)
    expect(client.options.lazyConnect).toBe(true)
    expect(client.options.maxRetriesPerRequest).toBe(1)
    expect(client.options.enableOfflineQueue).toBe(false)
  })

  it('reconnects: retryStrategy returns a bounded positive delay (never null — the P1 fix)', () => {
    const logger = makeSpyLogger()
    const client = createRedisClient('redis://127.0.0.1:6379', { label: 'redis-realtime', logger })
    clients.push(client)
    expect(typeof client.options.retryStrategy).toBe('function')
    const delay = client.options.retryStrategy?.(1)
    expect(typeof delay).toBe('number')
    expect(delay as number).toBeGreaterThan(0)
    expect(delay).not.toBeNull()
    // A high attempt count still yields a number (indefinite retry) capped at 10s.
    const capped = client.options.retryStrategy?.(9999)
    expect(capped as number).toBeGreaterThan(0)
    expect(capped as number).toBeLessThanOrEqual(10_000)
    // The strategy logs a structured reconnect warn.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'redis.reconnecting', label: 'redis-realtime' }),
      expect.any(String),
    )
  })
})

describe('createBullmqRedisClient (worker profile)', () => {
  const clients: Redis[] = []
  afterAll(() => {
    for (const c of clients) c.disconnect()
  })

  it('returns an ioredis client', () => {
    const client = createBullmqRedisClient('redis://127.0.0.1:6379')
    clients.push(client)
    expect(client).toBeInstanceOf(Redis)
  })

  it('attaches the error listener', () => {
    const client = createBullmqRedisClient('redis://127.0.0.1:6379')
    clients.push(client)
    expect(client.listenerCount('error')).toBeGreaterThan(0)
  })

  it('configures BullMQ-friendly settings: maxRetriesPerRequest=null (required by BullMQ) + ready check enabled', () => {
    const client = createBullmqRedisClient('redis://127.0.0.1:6379')
    clients.push(client)
    expect(client.options.maxRetriesPerRequest).toBeNull()
    expect(client.options.enableReadyCheck).toBe(true)
  })

  it('reconnects: retryStrategy returns a bounded positive delay (never null)', () => {
    const client = createBullmqRedisClient('redis://127.0.0.1:6379', { logger: makeSpyLogger() })
    clients.push(client)
    expect(typeof client.options.retryStrategy).toBe('function')
    const delay = client.options.retryStrategy?.(2)
    expect(delay as number).toBeGreaterThan(0)
    expect(delay).not.toBeNull()
  })

  it('error events do not throw (the debug-log listener handles them; blocking-command errors surface via promise rejections)', () => {
    const client = createBullmqRedisClient('redis://127.0.0.1:6379', { logger: makeSpyLogger() })
    clients.push(client)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => client.emit('error', new Error('transient'))).not.toThrow()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('attachRedisLifecycleLogging', () => {
  it('logs ready (info), end (info, not error), and error (debug) with a structured event + label', () => {
    const logger = makeSpyLogger()
    const client = createRedisClient('redis://127.0.0.1:6379', { label: 'svc', logger })
    client.disconnect()
    // The factory already attached logging; emit the lifecycle events to cover
    // the listener bodies deterministically.
    client.emit('ready')
    client.emit('end')
    client.emit('error', new Error('boom'))
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'redis.ready', label: 'svc' }),
      expect.any(String),
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'redis.end', label: 'svc' }),
      expect.any(String),
    )
    // 'end' at shutdown is not an error — nothing should log at error level.
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'redis.error', label: 'svc' }),
      expect.any(String),
    )
  })

  it('is callable standalone on a bare client', () => {
    const logger = makeSpyLogger()
    const client = new Redis('redis://127.0.0.1:6379', { lazyConnect: true })
    attachRedisLifecycleLogging(client, 'bare', logger)
    client.disconnect()
    client.emit('ready')
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'redis.ready', label: 'bare' }),
      expect.any(String),
    )
  })
})
