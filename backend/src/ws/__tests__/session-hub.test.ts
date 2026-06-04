import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Redis } from 'ioredis'
import { EventEmitter } from 'node:events'
import pino from 'pino'
import { createSessionHub } from '../session-hub.js'
import type { WSLike } from '../session-hub.js'

// ioredis-mock does NOT faithfully emulate PSUBSCRIBE across clients, so the
// fan-out tests run against REAL Redis (the dev docker-compose redis-realtime
// at localhost:6379). A unique per-run key prefix isolates concurrent runs.
// The robustness tests (fault isolation + resync) instead drive a synthetic
// EventEmitter-backed subscriber stub so 'ready'/'pmessage' fire
// deterministically (forcing a real Redis reconnect is flaky) — same pattern
// as sse/__tests__/pipeline-subscriber.test.ts.
const REDIS_URL = process.env.REDIS_REALTIME_URL ?? 'redis://localhost:6379'
const PREFIX = `test:${Math.random().toString(36).slice(2)}:` // unique per run

const silentLogger = pino({ level: 'silent' })

type FakeSocket = WSLike & {
  sent: string[]
  closed: { code: number | undefined; reason: string | undefined } | null
}

// `throwOnSend` makes send() throw — used to assert per-socket fault
// isolation (the hub evicts the throwing socket, others still receive).
function fakeSocket(opts: { throwOnSend?: boolean } = {}): FakeSocket {
  const sent: string[] = []
  let closed: { code: number | undefined; reason: string | undefined } | null = null
  return {
    sent,
    get closed(): { code: number | undefined; reason: string | undefined } | null {
      return closed
    },
    send: (data: string): void => {
      if (opts.throwOnSend) throw new Error('send-boom')
      sent.push(data)
    },
    close: (code?: number, reason?: string): void => {
      closed = { code, reason }
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${String(timeoutMs)}ms`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

describe('session-hub (real Redis)', () => {
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

  it('fans a published frame to all locally-registered sockets; deregister stops delivery', async () => {
    const campaignId = 'cmp-fan'
    const hub = await createSessionHub({ redis, keyPrefix: PREFIX, logger: silentLogger })
    const a = fakeSocket()
    const b = fakeSocket()
    hub.register(campaignId, 'userA', a)
    hub.register(campaignId, 'userB', b)

    await hub.publish(campaignId, {
      type: 'player_message',
      seq: 1,
      userId: 'userA',
      displayName: 'A',
      characterName: 'Ax',
      text: 'hi',
    })
    // Both local sockets receive via the pub/sub round-trip.
    await waitFor(() => a.sent.length === 1 && b.sent.length === 1)
    const [first] = b.sent
    expect(first).toBeDefined()
    expect(JSON.parse(first ?? '{}')).toMatchObject({ type: 'player_message', seq: 1 })

    hub.deregister(campaignId, 'userA')
    await hub.publish(campaignId, {
      type: 'player_message',
      seq: 2,
      userId: 'userB',
      displayName: 'B',
      characterName: 'Bx',
      text: 'yo',
    })
    await waitFor(() => b.sent.length === 2)
    // a no longer receives after deregister.
    expect(a.sent.length).toBe(1)

    await hub.close()
  })

  it('hasLocal reflects whether a campaign has any registered sockets', async () => {
    const hub = await createSessionHub({ redis, keyPrefix: PREFIX, logger: silentLogger })
    expect(hub.hasLocal('cmp-has')).toBe(false)
    const s = fakeSocket()
    hub.register('cmp-has', 'u1', s)
    expect(hub.hasLocal('cmp-has')).toBe(true)
    hub.deregister('cmp-has', 'u1')
    expect(hub.hasLocal('cmp-has')).toBe(false)
    await hub.close()
  })

  it('only delivers to sockets registered for the matching campaign', async () => {
    const hub = await createSessionHub({ redis, keyPrefix: PREFIX, logger: silentLogger })
    const a = fakeSocket()
    const b = fakeSocket()
    hub.register('cmp-X', 'uX', a)
    hub.register('cmp-Y', 'uY', b)
    await hub.publish('cmp-X', {
      type: 'player_message',
      seq: 1,
      userId: 'uX',
      displayName: 'X',
      characterName: 'Xx',
      text: 'x',
    })
    await waitFor(() => a.sent.length === 1)
    expect(b.sent.length).toBe(0)
    await hub.close()
  })
})

// --- Robustness paths (synthetic stub subscriber) ---------------------
//
// Per-socket fault isolation and resync teardown can't be driven reliably
// against real Redis (forcing a reconnect mid-test is flaky), so these use
// the pipeline-subscriber.test.ts approach: a FAKE redis whose .duplicate()
// returns an EventEmitter-backed stub. We then emit 'pmessage'/'ready'
// deterministically. createSessionHub awaits the stub's psubscribe (mocked
// to resolve), so the hub is fully constructed before we drive events.

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

// The hub calls `redis.duplicate({...})` for its subscriber and `redis.publish`
// for publish(); everything else lives on the duplicate. Cast through unknown —
// this surface is structurally adequate for the hub's contract.
function makeFakeRedis(sub: FakeSub): Redis {
  return {
    duplicate: (): FakeSub => sub,
    publish: vi.fn().mockResolvedValue(0),
  } as unknown as Redis
}

const PMSG_PATTERN = `${PREFIX}session:campaign:*`
function channel(campaignId: string): string {
  return `${PREFIX}session:campaign:${campaignId}`
}

describe('session-hub robustness (stubbed redis subscriber)', () => {
  it('isolates a throwing socket: the other still receives + the dead socket is evicted', async () => {
    const sub = makeFakeSub()
    const hub = await createSessionHub({
      redis: makeFakeRedis(sub),
      keyPrefix: PREFIX,
      logger: silentLogger,
    })
    const bad = fakeSocket({ throwOnSend: true })
    const good = fakeSocket()
    hub.register('cmp-iso', 'userBad', bad)
    hub.register('cmp-iso', 'userGood', good)

    const payload = JSON.stringify({ type: 'player_message', seq: 1 })
    sub.emit('pmessage', PMSG_PATTERN, channel('cmp-iso'), payload)

    // The good socket received despite the bad socket throwing.
    expect(good.sent).toEqual([payload])
    // The throwing socket is evicted; the good one remains registered.
    expect(hub.hasLocal('cmp-iso')).toBe(true)

    // A second delivery reaches only the surviving socket (bad was evicted).
    const payload2 = JSON.stringify({ type: 'player_message', seq: 2 })
    sub.emit('pmessage', PMSG_PATTERN, channel('cmp-iso'), payload2)
    expect(good.sent).toEqual([payload, payload2])

    // Deregister the survivor — campaign now has no local sockets, proving
    // the evicted bad socket was already gone (not just masked).
    hub.deregister('cmp-iso', 'userGood')
    expect(hub.hasLocal('cmp-iso')).toBe(false)

    await hub.close()
  })

  it('closes all sockets with (1011, redis-resync-required) and clears the registry on reconnect', async () => {
    const sub = makeFakeSub()
    const hub = await createSessionHub({
      redis: makeFakeRedis(sub),
      keyPrefix: PREFIX,
      logger: silentLogger,
    })
    const s1 = fakeSocket()
    const s2 = fakeSocket()
    hub.register('cmp-resync', 'u1', s1)
    hub.register('cmp-resync', 'u2', s2)

    // First 'ready' is the initial connect — the everReady guard means NO
    // resync close.
    sub.emit('ready')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(s1.closed).toBeNull()
    expect(s2.closed).toBeNull()
    expect(hub.hasLocal('cmp-resync')).toBe(true)

    // Second 'ready' is a reconnect — all registered sockets are force-closed
    // for resync and the registry is cleared.
    sub.emit('ready')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(s1.closed).toEqual({ code: 1011, reason: 'redis-resync-required' })
    expect(s2.closed).toEqual({ code: 1011, reason: 'redis-resync-required' })
    expect(hub.hasLocal('cmp-resync')).toBe(false)

    await hub.close()
  })

  it('register overwrites the prior socket for the same userId', async () => {
    const sub = makeFakeSub()
    const hub = await createSessionHub({
      redis: makeFakeRedis(sub),
      keyPrefix: PREFIX,
      logger: silentLogger,
    })
    const first = fakeSocket()
    const second = fakeSocket()
    hub.register('cmp-ovr', 'u1', first)
    hub.register('cmp-ovr', 'u1', second)

    const payload = JSON.stringify({ type: 'player_message', seq: 1 })
    sub.emit('pmessage', PMSG_PATTERN, channel('cmp-ovr'), payload)

    // Only the second (current) socket receives; the replaced one does not.
    expect(first.sent).toEqual([])
    expect(second.sent).toEqual([payload])

    await hub.close()
  })
})
