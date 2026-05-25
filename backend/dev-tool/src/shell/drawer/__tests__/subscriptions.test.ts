// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSubscriptionManager } from '../subscriptions.js'

// myth-y58n: subscriptions now goes through sse-client.openSse(), which
// reads the dev identity via getCurrentDevSub() → localStorage. We mock
// the identity module so the test doesn't depend on localStorage state
// or jsdom-flavored storage backends.
vi.mock('../../../identity.js', () => ({
  getCurrentDevSub: () => 'dev-user-1',
}))

// myth-y58n: subscriptions now goes through openSse() (fetch-based)
// instead of the native EventSource so the dev-identity header can be
// stamped on the SSE request. Tests drive a fake fetch that returns a
// ReadableStream the manager parses, plus a per-fetch handle so a test
// can push frames and abort.

interface OpenStream {
  readonly url: string
  push: (chunk: string) => void
  endStream: () => void
  signal: AbortSignal
}
const openStreams: OpenStream[] = []

function makeFetchStub(): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    let pushChunk!: (chunk: string) => void
    let endStream!: () => void
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        pushChunk = (s) => {
          controller.enqueue(enc.encode(s))
        }
        endStream = () => {
          controller.close()
        }
      },
    })
    const signal = init?.signal ?? new AbortController().signal
    openStreams.push({ url, push: pushChunk, endStream, signal })
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    )
  }
}

beforeEach(() => {
  openStreams.length = 0
  vi.stubGlobal('fetch', makeFetchStub())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function tick(): Promise<void> {
  // Let microtasks flush so async fetch + stream reads run before we
  // assert. Two awaits because openSse fires fetch in a void task and
  // the first chunk read also schedules.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('drawer subscriptions', () => {
  it('subscribe opens a fetch SSE per campaign id and dedupes', async () => {
    const onEvent = vi.fn()
    const mgr = createSubscriptionManager({
      onEvent,
      urlFor: (id) => `/api/campaigns/${id}/status/stream`,
    })
    mgr.subscribe('cA')
    mgr.subscribe('cA')
    mgr.subscribe('cB')
    await tick()
    expect(openStreams).toHaveLength(2)
    expect(openStreams[0]?.url).toContain('cA')
    expect(openStreams[1]?.url).toContain('cB')
  })

  it('unsubscribe aborts the open SSE', async () => {
    const mgr = createSubscriptionManager({ onEvent: vi.fn(), urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    await tick()
    mgr.unsubscribe('cA')
    expect(openStreams[0]?.signal.aborted).toBe(true)
  })

  it('list returns the currently subscribed campaign ids', () => {
    const mgr = createSubscriptionManager({ onEvent: vi.fn(), urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    mgr.subscribe('cB')
    expect([...mgr.list()].sort()).toEqual(['cA', 'cB'])
  })

  it('unnamed data frame with body type forwards type to onEvent', async () => {
    const onEvent = vi.fn()
    const mgr = createSubscriptionManager({ onEvent, urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    await tick()
    const s = openStreams[0]
    if (s === undefined) throw new Error('expected one stream')
    s.push('data: {"type":"phase","data":{"phase":"world_gen"}}\n\n')
    await tick()
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: 'cA', type: 'phase' }),
    )
  })

  it('closeAll aborts every subscription', async () => {
    const mgr = createSubscriptionManager({ onEvent: vi.fn(), urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    mgr.subscribe('cB')
    await tick()
    mgr.closeAll()
    expect(openStreams.every((s) => s.signal.aborted)).toBe(true)
  })

  it('named events (event: snapshot, event: stage-completed) are captured (myth-wirelog)', async () => {
    const onEvent = vi.fn()
    const mgr = createSubscriptionManager({ onEvent, urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    await tick()
    const s = openStreams[0]
    if (s === undefined) throw new Error('expected one stream')
    s.push('event: snapshot\ndata: {"phase":"world_gen","stages":[]}\n\n')
    await tick()
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ campaignId: 'cA', type: 'snapshot' }),
    )
    s.push('event: stage-completed\ndata: {"type":"stage-completed","stage":"concept_intake"}\n\n')
    await tick()
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ campaignId: 'cA', type: 'stage-completed' }),
    )
  })

  it('named event without a body type falls back to event name (myth-wirelog)', async () => {
    const onEvent = vi.fn()
    const mgr = createSubscriptionManager({ onEvent, urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    await tick()
    const s = openStreams[0]
    if (s === undefined) throw new Error('expected one stream')
    s.push('event: phase\ndata: {"phase":"world_gen"}\n\n')
    await tick()
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ campaignId: 'cA', type: 'phase' }),
    )
  })
})
