import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WS_TICKET_TTL_SECONDS, consumeWsTicket, mintWsTicket } from '../ws-ticket.js'

const KEY_PREFIX = 'staging:use1:ws:ticket:'

describe('mintWsTicket', () => {
  let redis: Redis

  beforeEach(() => {
    redis = new IoRedisMock()
  })
  afterEach(async () => {
    await redis.quit()
  })

  it('returns 64-char hex ticket', async () => {
    const result = await mintWsTicket(
      { redis, keyPrefix: KEY_PREFIX },
      { userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' },
    )
    expect(result.ticket).toMatch(/^[0-9a-f]{64}$/)
  })

  it('stores key with payload JSON under the prefix', async () => {
    const { ticket } = await mintWsTicket(
      { redis, keyPrefix: KEY_PREFIX },
      { userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' },
    )
    const raw = await redis.get(`${KEY_PREFIX}${ticket}`)
    if (raw === null) throw new Error('expected stored ticket value')
    const parsed = JSON.parse(raw) as Record<string, string>
    expect(parsed).toEqual({ userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' })
  })

  it('sets PTTL within (27000, 30000] immediately after mint', async () => {
    const { ticket } = await mintWsTicket(
      { redis, keyPrefix: KEY_PREFIX },
      { userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' },
    )
    const pttl = await redis.pttl(`${KEY_PREFIX}${ticket}`)
    expect(pttl).toBeGreaterThan(27_000)
    expect(pttl).toBeLessThanOrEqual(30_000)
  })

  it('returns expiresAt ~30s in future, ISO-8601 parseable', async () => {
    const before = Date.now()
    const { expiresAt } = await mintWsTicket(
      { redis, keyPrefix: KEY_PREFIX },
      { userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' },
    )
    const parsed = Date.parse(expiresAt)
    expect(parsed).not.toBeNaN()
    expect(parsed - before).toBeGreaterThanOrEqual(WS_TICKET_TTL_SECONDS * 1000 - 100)
    expect(parsed - before).toBeLessThanOrEqual(WS_TICKET_TTL_SECONDS * 1000 + 100)
  })

  it('two mints produce distinct tickets', async () => {
    const a = await mintWsTicket(
      { redis, keyPrefix: KEY_PREFIX },
      { userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' },
    )
    const b = await mintWsTicket(
      { redis, keyPrefix: KEY_PREFIX },
      { userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' },
    )
    expect(a.ticket).not.toBe(b.ticket)
  })
})

describe('consumeWsTicket', () => {
  let redis: Redis

  beforeEach(() => {
    redis = new IoRedisMock()
  })
  afterEach(async () => {
    await redis.quit()
  })

  it('returns payload and removes the key', async () => {
    const { ticket } = await mintWsTicket(
      { redis, keyPrefix: KEY_PREFIX },
      { userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' },
    )
    const result = await consumeWsTicket({ redis, keyPrefix: KEY_PREFIX }, ticket)
    expect(result).toEqual({ userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' })
    expect(await redis.get(`${KEY_PREFIX}${ticket}`)).toBeNull()
  })

  it('second consume returns null', async () => {
    const { ticket } = await mintWsTicket(
      { redis, keyPrefix: KEY_PREFIX },
      { userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' },
    )
    await consumeWsTicket({ redis, keyPrefix: KEY_PREFIX }, ticket)
    expect(await consumeWsTicket({ redis, keyPrefix: KEY_PREFIX }, ticket)).toBeNull()
  })

  it('non-existent ticket returns null', async () => {
    expect(await consumeWsTicket({ redis, keyPrefix: KEY_PREFIX }, 'never-existed')).toBeNull()
  })

  it('corrupt JSON payload returns null', async () => {
    await redis.set(`${KEY_PREFIX}corrupt`, '{not json', 'EX', 30)
    expect(await consumeWsTicket({ redis, keyPrefix: KEY_PREFIX }, 'corrupt')).toBeNull()
  })

  it('payload missing required campaignId returns null', async () => {
    await redis.set(
      `${KEY_PREFIX}incomplete`,
      JSON.stringify({ userId: 'u-1', sessionId: 's-1' }),
      'EX',
      30,
    )
    expect(await consumeWsTicket({ redis, keyPrefix: KEY_PREFIX }, 'incomplete')).toBeNull()
  })

  it('payload with extra fields parses cleanly (forward compat)', async () => {
    await redis.set(
      `${KEY_PREFIX}extra`,
      JSON.stringify({
        userId: 'u-1',
        sessionId: 's-1',
        campaignId: 'c-1',
        clientVersion: '2.0',
      }),
      'EX',
      30,
    )
    const result = await consumeWsTicket({ redis, keyPrefix: KEY_PREFIX }, 'extra')
    expect(result).toMatchObject({ userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' })
  })
})
