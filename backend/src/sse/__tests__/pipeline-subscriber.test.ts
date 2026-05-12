import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Redis } from 'ioredis'
import pino from 'pino'
import { createPipelineSubscriber } from '../pipeline-subscriber.js'
import type { SseSink, CloseReason } from '../sse-connection.js'

const REDIS_URL = process.env.REDIS_REALTIME_URL ?? 'redis://localhost:6379'
const PREFIX = `test:${Math.random().toString(36).slice(2)}:` // unique per run

function makeSink(): SseSink & { written: string[]; closed: CloseReason | null } {
  const written: string[] = []
  let closed: CloseReason | null = null
  return {
    written,
    get closed(): CloseReason | null {
      return closed
    },
    write: (frame: string): boolean => {
      written.push(frame)
      return true
    },
    close: (reason: CloseReason): void => {
      closed = reason
    },
  }
}

describe('pipeline-subscriber', () => {
  let redis: Redis
  let publisher: Redis

  beforeEach(async () => {
    redis = new Redis(REDIS_URL, { lazyConnect: true })
    publisher = new Redis(REDIS_URL, { lazyConnect: true })
    await redis.connect()
    await publisher.connect()
  })

  afterEach(async () => {
    await redis.quit()
    await publisher.quit()
  })

  it('attach + PUBLISH delivers to the attached sink', async () => {
    const sub = createPipelineSubscriber(redis, PREFIX, pino({ level: 'silent' }))
    const sink = makeSink()
    sub.attach('cmp-1', sink)
    // Subscriber's PSUBSCRIBE is async; wait a beat.
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await publisher.publish(
      `${PREFIX}pipeline:campaign:cmp-1`,
      JSON.stringify({ type: 'phase', phase: 'world_gen' }),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(sink.written.some((w) => w.includes('"phase":"world_gen"'))).toBe(true)
    await sub.close()
  })

  it('detach removes the sink from the map; subsequent publishes are not delivered', async () => {
    const sub = createPipelineSubscriber(redis, PREFIX, pino({ level: 'silent' }))
    const sink = makeSink()
    const detach = sub.attach('cmp-2', sink)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    detach()
    await publisher.publish(
      `${PREFIX}pipeline:campaign:cmp-2`,
      JSON.stringify({ type: 'phase', phase: 'world_gen' }),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(sink.written).toHaveLength(0)
    await sub.close()
  })

  it('only routes messages to sinks for the matching campaignId', async () => {
    const sub = createPipelineSubscriber(redis, PREFIX, pino({ level: 'silent' }))
    const sinkA = makeSink()
    const sinkB = makeSink()
    sub.attach('cmp-A', sinkA)
    sub.attach('cmp-B', sinkB)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await publisher.publish(
      `${PREFIX}pipeline:campaign:cmp-A`,
      JSON.stringify({ type: 'phase', phase: 'world_gen' }),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(sinkA.written).toHaveLength(1)
    expect(sinkB.written).toHaveLength(0)
    await sub.close()
  })

  it('continues delivering to other sinks when one sink.write throws', async () => {
    const sub = createPipelineSubscriber(redis, PREFIX, pino({ level: 'silent' }))
    const badSink: SseSink = {
      write: (): boolean => {
        throw new Error('boom')
      },
      close: () => undefined,
    }
    const goodSink = makeSink()
    sub.attach('cmp-3', badSink)
    sub.attach('cmp-3', goodSink)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await publisher.publish(
      `${PREFIX}pipeline:campaign:cmp-3`,
      JSON.stringify({ type: 'phase', phase: 'world_gen' }),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(goodSink.written).toHaveLength(1)
    await sub.close()
  })

  it('reports activeConnectionCount', async () => {
    const sub = createPipelineSubscriber(redis, PREFIX, pino({ level: 'silent' }))
    expect(sub.activeConnectionCount()).toBe(0)
    const s1 = makeSink()
    const s2 = makeSink()
    const d1 = sub.attach('cmp-a', s1)
    sub.attach('cmp-b', s2)
    expect(sub.activeConnectionCount()).toBe(2)
    d1()
    expect(sub.activeConnectionCount()).toBe(1)
    await sub.close()
  })

  it('close() unsubscribes + drops all attached sinks', async () => {
    const sub = createPipelineSubscriber(redis, PREFIX, pino({ level: 'silent' }))
    const sink = makeSink()
    sub.attach('cmp-4', sink)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await sub.close()
    expect(sub.activeConnectionCount()).toBe(0)
  })
})
