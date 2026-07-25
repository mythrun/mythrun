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
    hub.register(campaignId, 'userA', 'connA', a)
    hub.register(campaignId, 'userB', 'connB', b)

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

    hub.deregister(campaignId, 'connA')
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
    hub.register('cmp-has', 'u1', 'conn1', s)
    expect(hub.hasLocal('cmp-has')).toBe(true)
    hub.deregister('cmp-has', 'conn1')
    expect(hub.hasLocal('cmp-has')).toBe(false)
    await hub.close()
  })

  it('fans a published frame to BOTH of one user’s concurrent connections (multi-tab, no overwrite)', async () => {
    // myth-wat0m: a user's second tab must NOT evict the first from the registry.
    // Two connections for the SAME userId, distinct connIds, both receive.
    const campaignId = 'cmp-multitab'
    const hub = await createSessionHub({ redis, keyPrefix: PREFIX, logger: silentLogger })
    const tab1 = fakeSocket()
    const tab2 = fakeSocket()
    hub.register(campaignId, 'userA', 'conn-1', tab1)
    hub.register(campaignId, 'userA', 'conn-2', tab2)

    await hub.publish(campaignId, {
      type: 'player_message',
      seq: 1,
      userId: 'userB',
      displayName: 'B',
      characterName: 'Bx',
      text: 'hi both tabs',
    })
    await waitFor(() => tab1.sent.length === 1 && tab2.sent.length === 1)

    // Deregister ONLY tab1 (socket-identity-safe): tab2 keeps receiving.
    hub.deregister(campaignId, 'conn-1')
    await hub.publish(campaignId, {
      type: 'player_message',
      seq: 2,
      userId: 'userB',
      displayName: 'B',
      characterName: 'Bx',
      text: 'only tab2 now',
    })
    await waitFor(() => tab2.sent.length === 2)
    // tab1 was evicted; its count stays at 1.
    expect(tab1.sent.length).toBe(1)
    expect(hub.hasLocal(campaignId)).toBe(true)

    await hub.close()
  })

  it('only delivers to sockets registered for the matching campaign', async () => {
    const hub = await createSessionHub({ redis, keyPrefix: PREFIX, logger: silentLogger })
    const a = fakeSocket()
    const b = fakeSocket()
    hub.register('cmp-X', 'uX', 'connX', a)
    hub.register('cmp-Y', 'uY', 'connY', b)
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

/** A pino-shaped logger whose error/warn calls are recorded for assertions. */
function makeRecordingLogger(): {
  logger: typeof silentLogger
  error: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
} {
  const error = vi.fn()
  const warn = vi.fn()
  const logger = {
    error,
    warn,
    info: vi.fn(),
    debug: vi.fn(),
  } as unknown as typeof silentLogger
  return { logger, error, warn }
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
    hub.register('cmp-iso', 'userBad', 'conn-bad', bad)
    hub.register('cmp-iso', 'userGood', 'conn-good', good)

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
    hub.deregister('cmp-iso', 'conn-good')
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
    hub.register('cmp-resync', 'u1', 'conn1', s1)
    hub.register('cmp-resync', 'u2', 'conn2', s2)

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

  it('two connections for the same user each keep their own registry slot (no overwrite)', async () => {
    // myth-wat0m: the pre-fix per-user map made a second register() overwrite the
    // first socket. Now each connId is its own slot, so BOTH receive.
    const sub = makeFakeSub()
    const hub = await createSessionHub({
      redis: makeFakeRedis(sub),
      keyPrefix: PREFIX,
      logger: silentLogger,
    })
    const first = fakeSocket()
    const second = fakeSocket()
    hub.register('cmp-ovr', 'u1', 'conn-a', first)
    hub.register('cmp-ovr', 'u1', 'conn-b', second)

    const payload = JSON.stringify({ type: 'player_message', seq: 1 })
    sub.emit('pmessage', PMSG_PATTERN, channel('cmp-ovr'), payload)

    // BOTH sockets receive — neither overwrote the other.
    expect(first.sent).toEqual([payload])
    expect(second.sent).toEqual([payload])

    await hub.close()
  })

  it('deregister is socket-identity-safe: a stale close for one connId cannot evict the user’s newer socket', async () => {
    // The make-before-break reconnect hazard (myth-wat0m): a NEW socket registers
    // (conn-new) while the OLD socket's delayed close deregisters (conn-old). The
    // old connId's deregister must NOT touch the new socket.
    const sub = makeFakeSub()
    const hub = await createSessionHub({
      redis: makeFakeRedis(sub),
      keyPrefix: PREFIX,
      logger: silentLogger,
    })
    const oldSock = fakeSocket()
    const newSock = fakeSocket()
    hub.register('cmp-mbb', 'u1', 'conn-old', oldSock)
    hub.register('cmp-mbb', 'u1', 'conn-new', newSock)

    // The old socket's close fires late and deregisters ITS connId only.
    hub.deregister('cmp-mbb', 'conn-old')

    const payload = JSON.stringify({ type: 'player_message', seq: 1 })
    sub.emit('pmessage', PMSG_PATTERN, channel('cmp-mbb'), payload)

    // The newer socket survived the stale deregister and still receives.
    expect(newSock.sent).toEqual([payload])
    expect(oldSock.sent).toEqual([])
    expect(hub.hasLocal('cmp-mbb')).toBe(true)

    await hub.close()
  })

  it('logs (error) a subscriber error event without throwing', async () => {
    const sub = makeFakeSub()
    const { logger, error } = makeRecordingLogger()
    const hub = await createSessionHub({
      redis: makeFakeRedis(sub),
      keyPrefix: PREFIX,
      logger,
    })
    // The 'error' handler is warn-and-continue: it logs and lets ioredis
    // auto-reconnect. Emitting it must not throw.
    sub.emit('error', new Error('subscriber-boom'))
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'session-hub redis subscriber error',
    )
    await hub.close()
  })

  it('ignores a pmessage on a non-matching channel prefix', async () => {
    const sub = makeFakeSub()
    const hub = await createSessionHub({
      redis: makeFakeRedis(sub),
      keyPrefix: PREFIX,
      logger: silentLogger,
    })
    const s = fakeSocket()
    hub.register('cmp-nm', 'u1', 'conn1', s)
    // A pmessage whose channel does NOT start with the hub's channel prefix is
    // dropped (defensive — the pattern can't match this in practice).
    sub.emit('pmessage', PMSG_PATTERN, 'some:other:channel', '{"type":"x"}')
    expect(s.sent).toEqual([])
    await hub.close()
  })

  it('drops a pmessage for a campaign with no locally-registered sockets', async () => {
    const sub = makeFakeSub()
    const hub = await createSessionHub({
      redis: makeFakeRedis(sub),
      keyPrefix: PREFIX,
      logger: silentLogger,
    })
    // No socket registered for cmp-empty → users map is absent → early return.
    sub.emit('pmessage', PMSG_PATTERN, channel('cmp-empty'), '{"type":"x"}')
    expect(hub.hasLocal('cmp-empty')).toBe(false)
    await hub.close()
  })

  it('deregister on an unknown campaign is a no-op (no inner map)', async () => {
    const sub = makeFakeSub()
    const hub = await createSessionHub({
      redis: makeFakeRedis(sub),
      keyPrefix: PREFIX,
      logger: silentLogger,
    })
    // No map for this campaign → deregister returns early without throwing.
    expect(() => {
      hub.deregister('cmp-never', 'conn-nobody')
    }).not.toThrow()
    await hub.close()
  })

  it('a ready event AFTER close is ignored (no resync, no re-subscribe)', async () => {
    const sub = makeFakeSub()
    const hub = await createSessionHub({
      redis: makeFakeRedis(sub),
      keyPrefix: PREFIX,
      logger: silentLogger,
    })
    const s = fakeSocket()
    hub.register('cmp-closed', 'u1', 'conn1', s)
    await hub.close()
    // psubscribe was called once at construction; a post-close 'ready' must not
    // re-subscribe or close the (already torn-down) socket.
    const callsBefore = sub.psubscribe.mock.calls.length
    sub.emit('ready')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(sub.psubscribe.mock.calls.length).toBe(callsBefore)
    expect(s.closed).toBeNull()
  })

  it('swallows a throwing ws.close during a resync teardown (logs warn, continues)', async () => {
    const sub = makeFakeSub()
    const { logger, warn } = makeRecordingLogger()
    const hub = await createSessionHub({
      redis: makeFakeRedis(sub),
      keyPrefix: PREFIX,
      logger,
    })
    // s1's close() throws; s2's must still be closed (per-socket isolation in
    // the resync loop). The throw is logged-and-swallowed.
    const s1: FakeSocket = {
      ...fakeSocket(),
      close: () => {
        throw new Error('close-boom')
      },
    }
    const s2 = fakeSocket()
    hub.register('cmp-rt', 'u1', 'conn1', s1)
    hub.register('cmp-rt', 'u2', 'conn2', s2)

    sub.emit('ready') // initial connect — everReady guard, no teardown
    await new Promise<void>((resolve) => setImmediate(resolve))
    sub.emit('ready') // reconnect — teardown; s1.close throws, s2.close runs
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'session-hub failed to close socket on resync',
    )
    expect(s2.closed).toEqual({ code: 1011, reason: 'redis-resync-required' })
    expect(hub.hasLocal('cmp-rt')).toBe(false)

    await hub.close()
  })

  it('close() swallows a throwing punsubscribe (logs warn, still clears + quits)', async () => {
    const sub = makeFakeSub()
    sub.punsubscribe = vi.fn().mockRejectedValue(new Error('punsub-boom'))
    const { logger, warn } = makeRecordingLogger()
    const hub = await createSessionHub({
      redis: makeFakeRedis(sub),
      keyPrefix: PREFIX,
      logger,
    })
    const s = fakeSocket()
    hub.register('cmp-pun', 'u1', 'conn1', s)

    await hub.close()

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'session-hub punsubscribe failed during close',
    )
    // The registry was still cleared and quit was still attempted.
    expect(hub.hasLocal('cmp-pun')).toBe(false)
    expect(sub.quit).toHaveBeenCalledTimes(1)
  })

  it('close() swallows a throwing quit (logs warn)', async () => {
    const sub = makeFakeSub()
    sub.quit = vi.fn().mockRejectedValue(new Error('quit-boom'))
    const { logger, warn } = makeRecordingLogger()
    const hub = await createSessionHub({
      redis: makeFakeRedis(sub),
      keyPrefix: PREFIX,
      logger,
    })

    await hub.close()

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'session-hub quit failed during close',
    )
    expect(sub.punsubscribe).toHaveBeenCalledTimes(1)
  })

  // myth-ficc: the termination primitive behind suspended-user enforcement.
  // Killing a user's live sockets is a per-container operation over the local
  // registry — the same shape the resync teardown uses, but scoped to one user.
  describe('closeUser', () => {
    it('closes + deregisters EVERY socket the user holds, across campaigns', async () => {
      const sub = makeFakeSub()
      const hub = await createSessionHub({
        redis: makeFakeRedis(sub),
        keyPrefix: PREFIX,
        logger: silentLogger,
      })
      // The target holds two tabs on one campaign and a third on another.
      const tab1 = fakeSocket()
      const tab2 = fakeSocket()
      const otherCampaignTab = fakeSocket()
      const bystander = fakeSocket()
      hub.register('cmp-a', 'banned', 'c1', tab1)
      hub.register('cmp-a', 'banned', 'c2', tab2)
      hub.register('cmp-b', 'banned', 'c3', otherCampaignTab)
      hub.register('cmp-a', 'innocent', 'c4', bystander)

      const closed = hub.closeUser('banned')

      expect(closed).toBe(3)
      for (const s of [tab1, tab2, otherCampaignTab]) {
        expect(s.closed).toEqual({ code: 4403, reason: 'account_suspended' })
      }
      // The bystander keeps its socket AND its delivery.
      expect(bystander.closed).toBeNull()
      expect(hub.hasLocal('cmp-a')).toBe(true)
      // cmp-b held only the banned user, so its inner map is dropped entirely.
      expect(hub.hasLocal('cmp-b')).toBe(false)

      sub.emit('pmessage', PMSG_PATTERN, channel('cmp-a'), '{"type":"x"}')
      await new Promise<void>((resolve) => setImmediate(resolve))
      // Deregistered, not merely closed: no further frames reach the dead tabs.
      expect(tab1.sent).toHaveLength(0)
      expect(tab2.sent).toHaveLength(0)
      expect(bystander.sent).toHaveLength(1)

      await hub.close()
    })

    it('is a no-op returning 0 when the user holds no local socket', async () => {
      const sub = makeFakeSub()
      const hub = await createSessionHub({
        redis: makeFakeRedis(sub),
        keyPrefix: PREFIX,
        logger: silentLogger,
      })
      const bystander = fakeSocket()
      hub.register('cmp-none', 'innocent', 'c1', bystander)

      expect(hub.closeUser('banned')).toBe(0)
      expect(bystander.closed).toBeNull()

      await hub.close()
    })

    it('swallows a throwing ws.close and still deregisters the socket', async () => {
      // A socket already torn down at the transport layer must not stop the
      // sweep — the registry entry has to go regardless, or a suspended user
      // keeps receiving fan-out through a zombie entry.
      const sub = makeFakeSub()
      const { logger, warn } = makeRecordingLogger()
      const hub = await createSessionHub({
        redis: makeFakeRedis(sub),
        keyPrefix: PREFIX,
        logger,
      })
      const throwing: FakeSocket = {
        ...fakeSocket(),
        close: () => {
          throw new Error('close-boom')
        },
      }
      const healthy = fakeSocket()
      hub.register('cmp-thr', 'banned', 'c1', throwing)
      hub.register('cmp-thr', 'banned', 'c2', healthy)

      expect(hub.closeUser('banned')).toBe(2)
      expect(healthy.closed).toEqual({ code: 4403, reason: 'account_suspended' })
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) as unknown }),
        'session-hub failed to close socket for a suspended user',
      )
      expect(hub.hasLocal('cmp-thr')).toBe(false)

      await hub.close()
    })
  })
})
