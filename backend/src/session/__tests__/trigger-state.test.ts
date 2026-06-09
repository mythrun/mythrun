import { describe, it, expect } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import { makeTriggerState } from '../trigger-state.js'
const mk = () => makeTriggerState(new IoRedisMock(), 't:')
// Same factory, but hands back the underlying redis so a test can plant a raw
// (non-numeric) value the public setters never write — exercising the
// parse-or-default falses in respondedSeq + firstUnrespondedMs.
const mkWithRedis = () => {
  const redis = new IoRedisMock()
  return { s: makeTriggerState(redis, 't:'), redis }
}

describe('trigger-state', () => {
  it('tracks typing presence with refresh + clear', async () => {
    const s = mk()
    await s.markTyping('c1', 'u1'); expect(await s.listTyping('c1')).toEqual(['u1'])
    await s.clearTyping('c1', 'u1'); expect(await s.listTyping('c1')).toEqual([])
  })
  it('stamps + reads last-activity and the dead-air anchor (first-only)', async () => {
    const s = mk()
    await s.stampActivity('c1', 1000); expect(await s.lastActivityMs('c1')).toBe(1000)
    await s.armFirstUnresponded('c1', 1000)
    await s.armFirstUnresponded('c1', 5000)
    expect(await s.firstUnrespondedMs('c1')).toBe(1000)
    await s.clearFirstUnresponded('c1'); expect(await s.firstUnrespondedMs('c1')).toBeNull()
  })
  it('watermark + dm_responding + explicit-pending lifecycle', async () => {
    const s = mk()
    await s.setRespondedSeq('c1', 7); expect(await s.respondedSeq('c1')).toBe(7)
    expect(await (mk()).respondedSeq('cX')).toBe(0) // default 0
    await s.setResponding('c1', 'tok'); expect(await s.isResponding('c1')).toBe(true)
    await s.clearResponding('c1'); expect(await s.isResponding('c1')).toBe(false)
    await s.setExplicitPending('c1'); expect(await s.takeExplicitPending('c1')).toBe(true)
    expect(await s.takeExplicitPending('c1')).toBe(false)
  })
  it('turn-error latch is one-shot per turnId', async () => {
    const s = mk()
    expect(await s.claimTurnErrorPublish('turn-1')).toBe(true)
    expect(await s.claimTurnErrorPublish('turn-1')).toBe(false)
  })
  it('emitted-anything latch marks + reads per turnId, idempotent, with TTL', async () => {
    const { s, redis } = mkWithRedis()
    expect(await s.wasTurnEmitted('t1')).toBe(false) // unseen → false
    await s.markTurnEmitted('t1')
    expect(await s.wasTurnEmitted('t1')).toBe(true)
    await s.markTurnEmitted('t1') // double-mark is idempotent — no throw
    expect(await s.wasTurnEmitted('t1')).toBe(true)
    // Key carries a TTL (GC'd so a long-lived process doesn't leak a key/turn).
    expect(await redis.ttl('t:turn:t1:emitted')).toBeGreaterThan(0)
  })
  it('falls back to 0 / null when the raw key holds a non-numeric value', async () => {
    // No public setter writes a non-number, so plant garbage at the exact keys
    // (`t:session:{cid}:responded-seq` / `…:first-unresponded`) directly on the
    // mock — hits the `Number.isFinite(n) ? n : 0` / `: null` parse-fallbacks.
    const { s, redis } = mkWithRedis()
    await redis.set('t:session:c1:responded-seq', 'garbage')
    await redis.set('t:session:c1:first-unresponded', 'garbage')
    expect(await s.respondedSeq('c1')).toBe(0)
    expect(await s.firstUnrespondedMs('c1')).toBeNull()
  })
})
