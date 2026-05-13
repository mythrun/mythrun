// Unit tests for the two Redis client factories. Both construct ioredis
// clients with non-default option sets — the API factory uses fast-fail
// retry semantics for request-path code; the BullMQ factory uses the
// blocking-command-friendly settings BullMQ requires.

import { afterAll, describe, expect, it, vi } from 'vitest'
import { Redis } from 'ioredis'
import { createRedisClient } from '../client.js'
import { createBullmqRedisClient } from '../bullmq-client.js'

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
    // Emitting an error should be a no-op (the swallow listener handles it).
    expect(() => client.emit('error', new Error('boom'))).not.toThrow()
  })

  it('configures fast-fail retry semantics: lazyConnect + maxRetriesPerRequest=1 + offline-queue disabled + retryStrategy returning null', () => {
    const client = createRedisClient('redis://127.0.0.1:6379')
    clients.push(client)
    expect(client.options.lazyConnect).toBe(true)
    expect(client.options.maxRetriesPerRequest).toBe(1)
    expect(client.options.enableOfflineQueue).toBe(false)
    // retryStrategy is a function — invoke and assert null.
    expect(typeof client.options.retryStrategy).toBe('function')
    expect(client.options.retryStrategy?.(1)).toBeNull()
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

  it('attaches the same swallow listener', () => {
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

  it('error events are swallowed silently (BullMQ workers reconnect; surfaced errors come via promise rejections from blocking commands)', () => {
    const client = createBullmqRedisClient('redis://127.0.0.1:6379')
    clients.push(client)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    client.emit('error', new Error('transient'))
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
