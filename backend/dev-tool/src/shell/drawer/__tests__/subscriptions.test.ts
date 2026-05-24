// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSubscriptionManager } from '../subscriptions.js'

// JSDOM has no real EventSource; we stub it. myth-wirelog extended
// the subscription manager to listen for named events
// (snapshot/phase/stage-started/...) via addEventListener as well as
// onmessage, so the fake needs an addEventListener that the manager
// can attach handlers to + a helper to dispatch by name.
interface FakeES {
  onmessage: ((e: MessageEvent) => void) | null
  onerror: ((e: Event) => void) | null
  close(): void
  readyState: number
  url: string
  addEventListener(name: string, fn: (e: MessageEvent) => void): void
  dispatch(name: string, data: string): void
}
const opened: FakeES[] = []
class FakeEventSource implements FakeES {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  readyState = 0
  private readonly listeners = new Map<string, (e: MessageEvent) => void>()
  constructor(public url: string) { opened.push(this) }
  close(): void { this.readyState = 2 }
  addEventListener(name: string, fn: (e: MessageEvent) => void): void {
    this.listeners.set(name, fn)
  }
  dispatch(name: string, data: string): void {
    const fn = this.listeners.get(name)
    if (fn) fn(new MessageEvent(name, { data }))
  }
}

beforeEach(() => {
  opened.length = 0
  ;(globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource
})
afterEach(() => {
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
    expect([...mgr.list()].sort()).toEqual(['cA', 'cB'])
  })

  it('onmessage parses payload and forwards to onEvent with campaign id', () => {
    const onEvent = vi.fn()
    const mgr = createSubscriptionManager({ onEvent, urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    const fake = opened[0]
    if (fake === undefined) throw new Error('expected one EventSource to be opened')
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

  it('named events (event: snapshot, event: phase, etc.) are captured via addEventListener (myth-wirelog)', () => {
    const onEvent = vi.fn()
    const mgr = createSubscriptionManager({ onEvent, urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    const fake = opened[0]
    if (fake === undefined) throw new Error('expected one EventSource')
    fake.dispatch('snapshot', '{"phase":"world_gen","stages":[]}')
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ campaignId: 'cA', type: 'snapshot' }),
    )
    fake.dispatch('stage-completed', '{"type":"stage-completed","stage":"concept_intake"}')
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ campaignId: 'cA', type: 'stage-completed' }),
    )
  })

  it('named event without a body type uses the event name (myth-wirelog)', () => {
    const onEvent = vi.fn()
    const mgr = createSubscriptionManager({ onEvent, urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    const fake = opened[0]
    if (fake === undefined) throw new Error('expected one EventSource')
    // event: phase / data: {"phase":"world_gen"} — the JSON has no `type` field.
    fake.dispatch('phase', '{"phase":"world_gen"}')
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ campaignId: 'cA', type: 'phase' }),
    )
  })
})
