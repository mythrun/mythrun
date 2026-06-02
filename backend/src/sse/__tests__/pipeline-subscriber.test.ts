import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Redis } from 'ioredis'
import { EventEmitter } from 'node:events'
import pino from 'pino'
import { classifyPipelineEvent, createPipelineSubscriber } from '../pipeline-subscriber.js'
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

  it('wastedMessageCount increments for PMESSAGEs on a channel with no attached sinks', async () => {
    const sub = createPipelineSubscriber(redis, PREFIX, pino({ level: 'silent' }))
    // Wait for the subscriber to issue PSUBSCRIBE before publishing.
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(sub.wastedMessageCount()).toBe(0)
    // Publish to a channel with no sinks attached — should increment wasted counter.
    await publisher.publish(
      `${PREFIX}pipeline:campaign:cmp-no-listener`,
      JSON.stringify({ type: 'phase', phase: 'world_gen' }),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(sub.wastedMessageCount()).toBe(1)
    await sub.close()
  })
})

// --- Error-path coverage --------------------------------------------
//
// These tests stub the Redis client entirely (no live redis required)
// so we can drive the catch arms in createPipelineSubscriber:
//   - initial `psubscribe` rejection (line 172)
//   - sink.close throwing during shutdown (line 158-159)
//   - sub.quit rejecting (line 165-167)
//
// Construct a minimal Redis-like duplicate target by extending an
// EventEmitter and stubbing the bare methods the subscriber actually
// calls on the duplicate.

interface FakeSub extends EventEmitter {
  psubscribe: ReturnType<typeof vi.fn>
  punsubscribe: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
}

function makeFakeSub(): FakeSub {
  const fake = new EventEmitter() as FakeSub
  fake.psubscribe = vi.fn().mockResolvedValue(undefined)
  fake.punsubscribe = vi.fn().mockResolvedValue(undefined)
  fake.quit = vi.fn().mockResolvedValue('OK')
  return fake
}

function makeFakeRedis(sub: FakeSub): Redis {
  // The subscriber calls `redis.duplicate({...})`; everything else lives
  // on the duplicate. Cast through unknown — the surface here is
  // structurally adequate for the subscriber's contract.
  return {
    duplicate: (): FakeSub => sub,
  } as unknown as Redis
}

describe('pipeline-subscriber error paths (stubbed redis)', () => {
  it('logs an error when the initial psubscribe rejects', async () => {
    const sub = makeFakeSub()
    sub.psubscribe.mockRejectedValueOnce(new Error('initial-subscribe-failed'))
    const logs: { level: string; obj: unknown }[] = []
    const logger = pino(
      { level: 'error' },
      {
        write: (line: string): void => {
          const parsed = JSON.parse(line) as { level: number }
          logs.push({ level: String(parsed.level), obj: parsed })
        },
      },
    )
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', logger)
    // Allow the .catch to settle.
    await new Promise<void>((resolve) => setImmediate(resolve))
    // pino error level = 50.
    expect(logs.some((l) => l.level === '50')).toBe(true)
    await pipe.close()
  })

  it('logs a warning when a sink.close throws during shutdown', async () => {
    const sub = makeFakeSub()
    const warnings: unknown[] = []
    const logger = pino(
      { level: 'warn' },
      {
        write: (line: string): void => {
          const parsed = JSON.parse(line) as { level: number }
          if (parsed.level === 40) warnings.push(parsed)
        },
      },
    )
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', logger)
    const throwingSink: SseSink = {
      write: () => true,
      close: () => {
        throw new Error('close-boom')
      },
    }
    pipe.attach('cmp-x', throwingSink)
    await pipe.close()
    // At least one warn was emitted from the catch arm. (close also
    // emits 'reconnecting' / 'error' warnings, but those don't fire in
    // this stub.)
    expect(
      warnings.some((w) => JSON.stringify(w).includes('failed to close sink on shutdown')),
    ).toBe(true)
  })

  it('logs a warning when sub.quit rejects during shutdown', async () => {
    const sub = makeFakeSub()
    sub.quit.mockRejectedValueOnce(new Error('quit-failed'))
    const warnings: unknown[] = []
    const logger = pino(
      { level: 'warn' },
      {
        write: (line: string): void => {
          const parsed = JSON.parse(line) as { level: number }
          if (parsed.level === 40) warnings.push(parsed)
        },
      },
    )
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', logger)
    await pipe.close()
    expect(warnings.some((w) => JSON.stringify(w).includes('quit failed'))).toBe(true)
  })

  it('logs a warning when punsubscribe rejects during shutdown', async () => {
    const sub = makeFakeSub()
    sub.punsubscribe.mockRejectedValueOnce(new Error('punsub-failed'))
    const warnings: unknown[] = []
    const logger = pino(
      { level: 'warn' },
      {
        write: (line: string): void => {
          const parsed = JSON.parse(line) as { level: number }
          if (parsed.level === 40) warnings.push(parsed)
        },
      },
    )
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', logger)
    await pipe.close()
    expect(
      warnings.some((w) => JSON.stringify(w).includes('punsubscribe failed during close')),
    ).toBe(true)
  })

  it('logs an error when a reconnect ready-event psubscribe rejects', async () => {
    // Drives the on('ready') branch psubscribe.catch (line 66-68). The
    // first 'ready' is the initial connect; we emit a second to force the
    // reconnect arm, then make psubscribe reject on that second call.
    const sub = makeFakeSub()
    // First call (from `sub.psubscribe(pattern)` near end of constructor)
    // resolves; the 'ready' handler will fire psubscribe again — we want
    // THAT one to reject.
    sub.psubscribe.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('resub-failed'))
    const errors: unknown[] = []
    const logger = pino(
      { level: 'error' },
      {
        write: (line: string): void => {
          const parsed = JSON.parse(line) as { level: number }
          if (parsed.level === 50) errors.push(parsed)
        },
      },
    )
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', logger)
    // Initial ready — sets everReady = true, no resync close.
    sub.emit('ready')
    await new Promise<void>((resolve) => setImmediate(resolve))
    // Reconnect ready — this time we want the psubscribe.catch arm to log.
    sub.emit('ready')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(
      errors.some((e) => JSON.stringify(e).includes('psubscribe failed on ready')),
    ).toBe(true)
    await pipe.close()
  })

  it('closes attached sinks on reconnect (resync) and clears the map', async () => {
    // Drives the resync arm at line 75-90: after a reconnect, attached
    // sinks are closed with reason='redis-resync-required' and the map
    // is cleared.
    const sub = makeFakeSub()
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', pino({ level: 'silent' }))
    const sink = makeSink()
    pipe.attach('cmp-resync', sink)
    expect(pipe.activeConnectionCount()).toBe(1)
    // First 'ready' is the initial connect (everReady becomes true, no resync).
    sub.emit('ready')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(sink.closed).toBeNull()
    // Second 'ready' is the reconnect — triggers the resync close.
    sub.emit('ready')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(sink.closed).toBe('redis-resync-required')
    expect(pipe.activeConnectionCount()).toBe(0)
    await pipe.close()
  })

  it('swallows sink-close errors during resync (sink keeps detaching)', async () => {
    // The resync loop wraps sink.close in try/catch (line 82-86); a
    // throwing sink must not stop the rest of the map from being cleared.
    const sub = makeFakeSub()
    const warnings: unknown[] = []
    const logger = pino(
      { level: 'warn' },
      {
        write: (line: string): void => {
          const parsed = JSON.parse(line) as { level: number }
          if (parsed.level === 40) warnings.push(parsed)
        },
      },
    )
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', logger)
    const throwingSink: SseSink = {
      write: () => true,
      close: () => {
        throw new Error('sink-boom')
      },
    }
    pipe.attach('cmp-bad', throwingSink)
    sub.emit('ready') // initial
    await new Promise<void>((resolve) => setImmediate(resolve))
    sub.emit('ready') // reconnect — triggers resync + catch
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(
      warnings.some((w) => JSON.stringify(w).includes('failed to close sink on resync')),
    ).toBe(true)
    expect(pipe.activeConnectionCount()).toBe(0)
    await pipe.close()
  })

  it('emits redis-error and reconnecting events without crashing', async () => {
    const sub = makeFakeSub()
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', pino({ level: 'silent' }))
    // Both handlers are attached during construction; emitting these
    // exercises the warn-and-continue arms (line 56-62).
    expect(() => sub.emit('error', new Error('stub-redis-error'))).not.toThrow()
    expect(() => sub.emit('reconnecting')).not.toThrow()
    await pipe.close()
  })

  it('pmessage with no attached sinks increments wastedMessageCount', async () => {
    // Drives the wasted-message arm (line 97-100): a pmessage for a
    // campaign with no attached sinks should bump the counter and
    // return early without iterating.
    const sub = makeFakeSub()
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', pino({ level: 'silent' }))
    // Payload must be a valid pipeline event so it survives the type-tripwire
    // and reaches the wasted-message arm (no attached sinks).
    const validEvent = JSON.stringify({ type: 'phase', phase: 'world_gen' })
    sub.emit('pmessage', 'rt:pipeline:campaign:*', 'rt:pipeline:campaign:cmp-orphan', validEvent)
    expect(pipe.wastedMessageCount()).toBe(1)
    // pmessage on a channel that doesn't match the prefix is ignored.
    sub.emit('pmessage', 'rt:pipeline:campaign:*', 'mismatched:channel', validEvent)
    expect(pipe.wastedMessageCount()).toBe(1)
    await pipe.close()
  })

  it('pmessage with attached sinks writes the SSE frame', async () => {
    const sub = makeFakeSub()
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', pino({ level: 'silent' }))
    const sink = makeSink()
    pipe.attach('cmp-y', sink)
    sub.emit(
      'pmessage',
      'rt:pipeline:campaign:*',
      'rt:pipeline:campaign:cmp-y',
      '{"type":"phase"}',
    )
    expect(sink.written[0]).toBe('data: {"type":"phase"}\n\n')
    await pipe.close()
  })

  it('detaches sinks that throw inside write (continues iteration)', async () => {
    // Drives the per-sink write-throw catch (line 106-117): the failing
    // sink is closed + detached, the good sink still receives the frame.
    const sub = makeFakeSub()
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', pino({ level: 'silent' }))
    let badClosed: CloseReason | null = null
    const bad: SseSink = {
      write: () => {
        throw new Error('write-boom')
      },
      close: (r) => {
        badClosed = r
      },
    }
    const good = makeSink()
    pipe.attach('cmp-z', bad)
    pipe.attach('cmp-z', good)
    sub.emit(
      'pmessage',
      'rt:pipeline:campaign:*',
      'rt:pipeline:campaign:cmp-z',
      '{"type":"phase","phase":"world_gen"}',
    )
    expect(good.written).toHaveLength(1)
    expect(badClosed).toBe('unknown')
    await pipe.close()
  })

  it('swallows close-throws inside the per-sink write catch', async () => {
    // The inner try/catch at line 111-115 — if both write AND close
    // throw, the loop still proceeds.
    const sub = makeFakeSub()
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', pino({ level: 'silent' }))
    const fullyBroken: SseSink = {
      write: () => {
        throw new Error('write-boom')
      },
      close: () => {
        throw new Error('close-boom')
      },
    }
    const good = makeSink()
    pipe.attach('cmp-zz', fullyBroken)
    pipe.attach('cmp-zz', good)
    expect(() =>
      sub.emit(
        'pmessage',
        'rt:pipeline:campaign:*',
        'rt:pipeline:campaign:cmp-zz',
        '{"type":"phase","phase":"world_gen"}',
      ),
    ).not.toThrow()
    expect(good.written).toHaveLength(1)
    await pipe.close()
  })
})

// --- MYT-62 Task 2: type-tripwire + prose-channel reuse ----------------
//
// The pipeline channel is player-facing. A type-tripwire drops + logs any
// message whose parsed `type` is not in PIPELINE_SSE_EVENTS — defense in
// depth so a stray `prep-delta` (secret-bearing prose) can never reach a
// player sink. The prose channel (`prep:campaign:*`) does NOT apply this
// gate; the prose subscriber forwards everything verbatim.

describe('pipeline-subscriber type-tripwire (pipeline channel)', () => {
  it('drops + warns on a forbidden event type (prep-delta) published on the pipeline channel', () => {
    const sub = makeFakeSub()
    const warnings: unknown[] = []
    const logger = pino(
      { level: 'warn' },
      {
        write: (line: string): void => {
          const parsed = JSON.parse(line) as { level: number }
          if (parsed.level === 40) warnings.push(parsed)
        },
      },
    )
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', logger)
    const sink = makeSink()
    pipe.attach('cmp-trip', sink)
    sub.emit(
      'pmessage',
      'rt:pipeline:campaign:*',
      'rt:pipeline:campaign:cmp-trip',
      JSON.stringify({ type: 'prep-delta', field: 'sd_playbook', text: 'a secret' }),
    )
    // Never written to the player sink.
    expect(sink.written).toHaveLength(0)
    // A warn was logged identifying the dropped type.
    expect(
      warnings.some((w) => JSON.stringify(w).includes('dropped message with unknown/forbidden event type')),
    ).toBe(true)
    // The dropped type reaches the warn payload for forensics — this
    // distinguishes the forbidden-known-type case (parsedType='prep-delta')
    // from the malformed-JSON case (parsedType=undefined).
    expect(JSON.stringify(warnings)).toContain('prep-delta')
  })

  it('forwards a legit pipeline event (prep-started) to the attached sink', () => {
    const sub = makeFakeSub()
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', pino({ level: 'silent' }))
    const sink = makeSink()
    pipe.attach('cmp-ok', sink)
    const payload = JSON.stringify({ type: 'prep-started', sessionNumber: 1 })
    sub.emit('pmessage', 'rt:pipeline:campaign:*', 'rt:pipeline:campaign:cmp-ok', payload)
    expect(sink.written).toHaveLength(1)
    expect(sink.written[0]).toBe(`data: ${payload}\n\n`)
  })

  it('drops + warns on a malformed (non-JSON) message on the pipeline channel', () => {
    const sub = makeFakeSub()
    const warnings: unknown[] = []
    const logger = pino(
      { level: 'warn' },
      {
        write: (line: string): void => {
          const parsed = JSON.parse(line) as { level: number }
          if (parsed.level === 40) warnings.push(parsed)
        },
      },
    )
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', logger)
    const sink = makeSink()
    pipe.attach('cmp-bad-json', sink)
    sub.emit('pmessage', 'rt:pipeline:campaign:*', 'rt:pipeline:campaign:cmp-bad-json', 'not-json{')
    expect(sink.written).toHaveLength(0)
    expect(
      warnings.some((w) => JSON.stringify(w).includes('dropped message with unknown/forbidden event type')),
    ).toBe(true)
  })
})

describe('pipeline-subscriber prose channel (no tripwire)', () => {
  it('forwards a prep-delta verbatim on prep:campaign: without the pipeline tripwire', () => {
    const sub = makeFakeSub()
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', pino({ level: 'silent' }), {
      channel: 'prep',
    })
    const sink = makeSink()
    pipe.attach('cmp-prose', sink)
    const payload = JSON.stringify({ type: 'prep-delta', field: 'sd_playbook', text: 'prose' })
    sub.emit('pmessage', 'rt:prep:campaign:*', 'rt:prep:campaign:cmp-prose', payload)
    expect(sink.written).toHaveLength(1)
    expect(sink.written[0]).toBe(`data: ${payload}\n\n`)
  })

  it('subscribes to the prep:campaign:* pattern when channel is prep', () => {
    const sub = makeFakeSub()
    const pipe = createPipelineSubscriber(makeFakeRedis(sub), 'rt:', pino({ level: 'silent' }), {
      channel: 'prep',
    })
    expect(sub.psubscribe).toHaveBeenCalledWith('rt:prep:campaign:*')
    void pipe
  })
})

describe('classifyPipelineEvent (pure tripwire classifier)', () => {
  it('allows a known pipeline event type', () => {
    const result = classifyPipelineEvent(JSON.stringify({ type: 'prep-started', sessionNumber: 1 }))
    expect(result.allowed).toBe(true)
    expect(result.parsedType).toBe('prep-started')
  })

  it('rejects an unknown / forbidden event type, surfacing parsedType for forensics', () => {
    const result = classifyPipelineEvent(JSON.stringify({ type: 'prep-delta', text: 'secret' }))
    expect(result.allowed).toBe(false)
    expect(result.parsedType).toBe('prep-delta')
  })

  it('rejects malformed (non-JSON) input with parsedType undefined', () => {
    const result = classifyPipelineEvent('not-json{')
    expect(result.allowed).toBe(false)
    expect(result.parsedType).toBeUndefined()
  })

  it('rejects a payload with a missing / non-string type', () => {
    const missing = classifyPipelineEvent(JSON.stringify({ phase: 'world_gen' }))
    expect(missing.allowed).toBe(false)
    expect(missing.parsedType).toBeUndefined()
    const nonString = classifyPipelineEvent(JSON.stringify({ type: 42 }))
    expect(nonString.allowed).toBe(false)
    expect(nonString.parsedType).toBe(42)
  })
})
