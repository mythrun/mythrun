// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSubscriptionManager } from '../subscriptions.js'

// JSDOM has no real EventSource; we stub it.
interface FakeES {
  onmessage: ((e: MessageEvent) => void) | null
  onerror: ((e: Event) => void) | null
  close(): void
  readyState: number
  url: string
}
const opened: FakeES[] = []
class FakeEventSource implements FakeES {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  readyState = 0
  constructor(public url: string) { opened.push(this) }
  close(): void { this.readyState = 2 }
}

beforeEach(() => {
  opened.length = 0
  ;(globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource
})
afterEach(() => {
  // @ts-expect-error cleanup
  delete (globalThis as unknown as { EventSource?: typeof FakeEventSource }).EventSource
})

describe('drawer subscriptions', () => {
  it('subscribe opens an EventSource per campaign id and dedupes', () => {
    const onEvent = vi.fn()
    const mgr = createSubscriptionManager({ onEvent, urlFor: (id) => `/api/campaigns/${id}/status/stream` })
    mgr.subscribe('cA')
    mgr.subscribe('cA')
    mgr.subscribe('cB')
    expect(opened).toHaveLength(2)
    expect(opened[0]?.url).toContain('cA')
    expect(opened[1]?.url).toContain('cB')
  })

  it('unsubscribe closes the EventSource', () => {
    const mgr = createSubscriptionManager({ onEvent: vi.fn(), urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    mgr.unsubscribe('cA')
    expect(opened[0]?.readyState).toBe(2)
  })

  it('list returns the currently subscribed campaign ids', () => {
    const mgr = createSubscriptionManager({ onEvent: vi.fn(), urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    mgr.subscribe('cB')
    expect(mgr.list().sort()).toEqual(['cA', 'cB'])
  })

  it('onmessage parses payload and forwards to onEvent with campaign id', () => {
    const onEvent = vi.fn()
    const mgr = createSubscriptionManager({ onEvent, urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    const fake = opened[0]!
    fake.onmessage?.(new MessageEvent('message', { data: '{"type":"phase","data":{"phase":"world_gen"}}' }))
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ campaignId: 'cA', type: 'phase' }))
  })

  it('closeAll closes every subscription', () => {
    const mgr = createSubscriptionManager({ onEvent: vi.fn(), urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    mgr.subscribe('cB')
    mgr.closeAll()
    expect(opened.every((o) => o.readyState === 2)).toBe(true)
  })
})
