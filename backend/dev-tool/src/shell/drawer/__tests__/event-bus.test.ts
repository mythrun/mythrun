import { describe, it, expect, vi } from 'vitest'
import { createEventBus } from '../event-bus.js'

interface E { campaignId: string; type: string; data: Record<string, unknown> }

describe('drawer event-bus', () => {
  it('publishes to all subscribers', () => {
    const bus = createEventBus<E>()
    const a = vi.fn()
    const b = vi.fn()
    bus.subscribe(a)
    bus.subscribe(b)
    const ev = { campaignId: 'c1', type: 'phase', data: { phase: 'world_gen' } }
    bus.publish(ev)
    expect(a).toHaveBeenCalledWith(ev)
    expect(b).toHaveBeenCalledWith(ev)
  })

  it('subscribe returns unsubscribe fn', () => {
    const bus = createEventBus<E>()
    const cb = vi.fn()
    const off = bus.subscribe(cb)
    bus.publish({ campaignId: 'c', type: 't', data: {} })
    off()
    bus.publish({ campaignId: 'c', type: 't', data: {} })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('publishes do not throw if a subscriber throws (other subs still get notified)', () => {
    const bus = createEventBus<E>()
    bus.subscribe(() => { throw new Error('boom') })
    const ok = vi.fn()
    bus.subscribe(ok)
    expect(() => bus.publish({ campaignId: 'c', type: 't', data: {} })).not.toThrow()
    expect(ok).toHaveBeenCalled()
  })
})
