import { describe, it, expect } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import { makeTriggerState } from '../trigger-state.js'
const mk = () => makeTriggerState(new IoRedisMock(), 't:')

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
})
