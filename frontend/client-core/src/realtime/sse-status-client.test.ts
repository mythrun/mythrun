import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PipelineEvent } from '@mythrun/contract/events'
import { createSseStatusClient, type SseStatusClient } from './sse-status-client.ts'
import type { ApiContext } from '../api/endpoint.ts'
import type { StreamingFetch } from '../platform/streaming-fetch.ts'
import { configureStreamingFetch, resetStreamingFetch } from '../platform/streaming-fetch.ts'
import { configureTokenRefresh, resetTokenManager } from '../auth/token-manager.ts'

// The SSE status client: the DOM-free framing/decode/reconnect brain over the
// injected `StreamingFetch` seam. These tests pin each spec requirement
// (docs/.../2026-06-28-myt-85-realtime-transport-design.md §"SSE contract"):
// auth computed IN CORE, `\n\n` reassembly across chunk boundaries, `:keepalive`
// skipped, the `event: snapshot` raw special-case vs `PipelineEvent` decode,
// open-status routing (403/404 → denied; other non-200 → transient), a
// stream-end-with-no-`event: close` → transient, and "the transport never
// auto-closes on a data frame — the flow calls close()".
//
// The platform seam is INJECTED: each test scripts a fake `StreamingFetch` that
// yields the exact chunk sequence + the open status, and records the headers
// core handed it (proving auth-in-core).

const BASE_URL = 'http://api.test'

function ctxWith(headers: Record<string, string>): ApiContext {
  return { baseUrl: BASE_URL, getAuthHeaders: () => Promise.resolve(headers) }
}

interface Script {
  status?: number
  chunks?: string[]
  /** Keep the stream open after the scripted chunks (park until aborted), so the
   *  read does not end + reconnect mid-assertion. Mirrors a live, silent stream. */
  keepOpen?: boolean
}

interface FakeCall {
  url: string
  headers: Record<string, string>
}

function makeFake(scripts: Script[]): { fn: StreamingFetch; calls: FakeCall[] } {
  const queue = [...scripts]
  const calls: FakeCall[] = []
  const fn: StreamingFetch = (url, init) => {
    calls.push({ url, headers: init.headers })
    const script: Script = queue.shift() ?? { status: 200, chunks: [] }
    const status = script.status ?? 200
    const chunks = (async function* (): AsyncGenerator<string> {
      for (const c of script.chunks ?? []) yield c
      if (script.keepOpen === true) {
        await new Promise<void>((resolve) => {
          if (init.signal.aborted) {
            resolve()
            return
          }
          init.signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      }
    })()
    return Promise.resolve({ status, chunks })
  }
  return { fn, calls }
}

const clients: SseStatusClient[] = []

function newClient(ctx: ApiContext): SseStatusClient {
  const client = createSseStatusClient(ctx)
  clients.push(client)
  return client
}

beforeEach(() => {
  configureTokenRefresh(() => Promise.resolve({ accessToken: 'tok', expiresIn: 3600 }))
})

afterEach(() => {
  for (const client of clients) client.close()
  clients.length = 0
  resetStreamingFetch()
  resetTokenManager()
  vi.useRealTimers()
})

describe('createSseStatusClient — auth in core', () => {
  it('computes ctx.getAuthHeaders() and passes them to the streaming fetch (jwt)', async () => {
    const fake = makeFake([{ status: 200, chunks: [], keepOpen: true }])
    configureStreamingFetch(fake.fn)
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))

    client.open('/api/campaigns/c1/status/stream')

    await vi.waitFor(() => { expect(fake.calls).toHaveLength(1) })
    expect(fake.calls[0]?.headers).toEqual({ authorization: 'Bearer tok' })
    expect(fake.calls[0]?.url).toBe('http://api.test/api/campaigns/c1/status/stream')
  })

  it('passes x-mythrun-dev-sub headers through (bypass mode), never a hardcoded Bearer', async () => {
    const fake = makeFake([{ status: 200, chunks: [], keepOpen: true }])
    configureStreamingFetch(fake.fn)
    const client = newClient(ctxWith({ 'x-mythrun-dev-sub': 'sub-1' }))

    client.open('/api/campaigns/c1/status/stream')

    await vi.waitFor(() => { expect(fake.calls).toHaveLength(1) })
    expect(fake.calls[0]?.headers).toEqual({ 'x-mythrun-dev-sub': 'sub-1' })
  })
})

describe('framing', () => {
  it('reassembles \\n\\n frames split across chunk boundaries', async () => {
    const fake = makeFake([
      {
        status: 200,
        keepOpen: true,
        chunks: [
          'event: snapshot\nda',
          'ta: {"status":"r',
          'eady"}\n\n',
          'data: {"type":"ph',
          'ase","phase":"world_gen"}\n\n',
        ],
      },
    ])
    configureStreamingFetch(fake.fn)
    const snapshots: unknown[] = []
    const events: PipelineEvent[] = []
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))
    client.onSnapshot((s) => snapshots.push(s))
    client.onEvent((e) => events.push(e))

    client.open('/api/campaigns/c1/status/stream')

    await vi.waitFor(() => { expect(events).toHaveLength(1) })
    expect(snapshots).toEqual([{ status: 'ready' }])
    expect(events).toEqual([{ type: 'phase', phase: 'world_gen' }])
  })

  it('skips :keepalive comment frames', async () => {
    const fake = makeFake([
      {
        status: 200,
        keepOpen: true,
        chunks: [':keepalive\n\n', 'data: {"type":"cost-update","cumulativeUsd":2}\n\n'],
      },
    ])
    configureStreamingFetch(fake.fn)
    const snapshots: unknown[] = []
    const events: PipelineEvent[] = []
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))
    client.onSnapshot((s) => snapshots.push(s))
    client.onEvent((e) => events.push(e))

    client.open('/api/campaigns/c1/status/stream')

    await vi.waitFor(() => { expect(events).toHaveLength(1) })
    expect(snapshots).toHaveLength(0)
    expect(events).toEqual([{ type: 'cost-update', cumulativeUsd: 2 }])
  })
})

describe('snapshot special-case', () => {
  it('routes the first event: snapshot to onSnapshot (raw, NOT decoded as PipelineEvent) and subsequent data: frames to onEvent', async () => {
    const fake = makeFake([
      {
        status: 200,
        keepOpen: true,
        chunks: [
          // An arbitrary snapshot shape that is NOT a valid PipelineEvent — it
          // must pass through raw, never be coerced onto the event union.
          'event: snapshot\ndata: {"status":"world_gen","members":3}\n\n',
          'data: {"type":"stage-started","stage":"world","userId":null,"startedAt":"t0"}\n\n',
        ],
      },
    ])
    configureStreamingFetch(fake.fn)
    const snapshots: unknown[] = []
    const events: PipelineEvent[] = []
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))
    client.onSnapshot((s) => snapshots.push(s))
    client.onEvent((e) => events.push(e))

    client.open('/api/campaigns/c1/status/stream')

    await vi.waitFor(() => { expect(events).toHaveLength(1) })
    expect(snapshots).toEqual([{ status: 'world_gen', members: 3 }])
    expect(events).toEqual([
      { type: 'stage-started', stage: 'world', userId: null, startedAt: 't0' },
    ])
  })
})

describe('open-status routing', () => {
  it.each([403, 404])('routes open status %i to terminal failed{denied} (no reconnect)', async (status) => {
    const fake = makeFake([{ status }])
    configureStreamingFetch(fake.fn)
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))

    client.open('/api/campaigns/c1/status/stream')

    await vi.waitFor(() => {
      expect(client.connectionState.getState()).toEqual({
        status: 'failed',
        attempt: 0,
        failedReason: 'denied',
      })
    })
    expect(fake.calls).toHaveLength(1)
  })

  it.each([401, 429, 503, 502, 504])(
    'routes open status %i to a transient reconnect',
    async (status) => {
      const fake = makeFake([{ status }])
      configureStreamingFetch(fake.fn)
      const client = newClient(ctxWith({ authorization: 'Bearer tok' }))

      client.open('/api/campaigns/c1/status/stream')

      await vi.waitFor(() => {
        expect(client.connectionState.getState().status).toBe('reconnecting')
      })
    },
  )
})

describe('stream-end + flow-owned close', () => {
  it('treats a stream-end with no event: close as a transient drop and reconnects (after emitting live frames)', async () => {
    const fake = makeFake([
      { status: 200, chunks: ['data: {"type":"cost-update","cumulativeUsd":1}\n\n'] },
    ])
    configureStreamingFetch(fake.fn)
    const events: PipelineEvent[] = []
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))
    client.onEvent((e) => events.push(e))

    client.open('/api/campaigns/c1/status/stream')

    await vi.waitFor(() => {
      expect(client.connectionState.getState().status).toBe('reconnecting')
    })
    expect(events).toEqual([{ type: 'cost-update', cumulativeUsd: 1 }])
  })

  it('does NOT auto-close on a data frame (finalized is per-entity, not terminal); only close() closes', async () => {
    const fake = makeFake([
      {
        status: 200,
        keepOpen: true,
        chunks: ['data: {"type":"finalized","synthKey":"npc/x","entityId":"e1"}\n\n'],
      },
    ])
    configureStreamingFetch(fake.fn)
    const events: PipelineEvent[] = []
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))
    client.onEvent((e) => events.push(e))

    client.open('/api/campaigns/c1/status/stream')

    await vi.waitFor(() => { expect(events).toHaveLength(1) })
    // The stream is still open and the transport stays connected — it did not
    // self-close on the `finalized` data frame.
    expect(client.connectionState.getState().status).toBe('connected')

    client.close()
    expect(client.connectionState.getState()).toEqual({ status: 'closed', attempt: 0 })
  })

  it('onEvent unsubscribe stops further delivery', async () => {
    // A gate releases the second frame only AFTER the test unsubscribes; a
    // barrier listener (never unsubscribed) confirms the second frame really was
    // routed — so the off'd listener staying at length 1 is load-bearing.
    let releaseSecond = (): void => undefined
    const gate = new Promise<void>((resolve) => { releaseSecond = resolve })
    const fn: StreamingFetch = (_url, init) => {
      const chunks = (async function* (): AsyncGenerator<string> {
        yield 'data: {"type":"cost-update","cumulativeUsd":1}\n\n'
        await gate
        yield 'data: {"type":"cost-update","cumulativeUsd":2}\n\n'
        await new Promise<void>((resolve) => {
          init.signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      })()
      return Promise.resolve({ status: 200, chunks })
    }
    configureStreamingFetch(fn)
    const offEvents: PipelineEvent[] = []
    const barrier: PipelineEvent[] = []
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))
    const off = client.onEvent((e) => offEvents.push(e))
    client.onEvent((e) => barrier.push(e))

    client.open('/api/campaigns/c1/status/stream')

    await vi.waitFor(() => { expect(barrier).toHaveLength(1) })
    expect(offEvents).toHaveLength(1)
    off()
    releaseSecond()

    await vi.waitFor(() => { expect(barrier).toHaveLength(2) })
    expect(offEvents).toHaveLength(1) // unsubscribed listener saw none of the second
  })
})

describe('reconnect actually re-fetches', () => {
  it('after a transient drop, waits the backoff then re-mints the stream and replays the snapshot', async () => {
    vi.useFakeTimers()
    const fake = makeFake([
      { status: 503 }, // call 1: transient open failure
      { status: 200, keepOpen: true, chunks: ['event: snapshot\ndata: {"status":"x"}\n\n'] },
    ])
    configureStreamingFetch(fake.fn)
    const snapshots: unknown[] = []
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))
    client.onSnapshot((s) => snapshots.push(s))

    client.open('/api/campaigns/c1/status/stream')

    await vi.advanceTimersByTimeAsync(0)
    expect(fake.calls).toHaveLength(1)
    expect(client.connectionState.getState().status).toBe('reconnecting')

    // The first backoff step is ~1s (±10% jitter); 1200ms covers it.
    await vi.advanceTimersByTimeAsync(1200)
    expect(fake.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots).toEqual([{ status: 'x' }])
    expect(client.connectionState.getState().status).toBe('connected')
  })
})

// ─── frame-parser edges + transport-fault routing ────────────────────────────
// These pin the parse branches the happy-path tests don't reach (a colon-less
// line, a no-leading-space value, a multi-`data:` join, an explicit `event: close`
// frame, an event-with-empty-data frame) and the fault/abort routing (the open
// fetch rejecting, the chunk stream throwing mid-read, close() racing an in-flight
// await), plus the onSnapshot unsubscribe.

describe('frame-parser edges', () => {
  it('drops a colon-less line + a no-leading-space value, still frames the valid frame', async () => {
    const fake = makeFake([
      {
        status: 200,
        keepOpen: true,
        chunks: [
          'weirdlinewithnocolon\n\n', // colon === -1 → name=the line, value '' (no leading space)
          'data:{"type":"cost-update","cumulativeUsd":1}\n\n', // no space after the colon
        ],
      },
    ])
    configureStreamingFetch(fake.fn)
    const events: PipelineEvent[] = []
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))
    client.onEvent((e) => events.push(e))

    client.open('/api/campaigns/c1/status/stream')

    await vi.waitFor(() => { expect(events).toHaveLength(1) })
    expect(events).toEqual([{ type: 'cost-update', cumulativeUsd: 1 }])
  })

  it('joins multiple data: lines in one frame with \\n', async () => {
    const fake = makeFake([
      {
        status: 200,
        keepOpen: true,
        chunks: ['data: {"type":"cost-update",\ndata: "cumulativeUsd":7}\n\n'],
      },
    ])
    configureStreamingFetch(fake.fn)
    const events: PipelineEvent[] = []
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))
    client.onEvent((e) => events.push(e))

    client.open('/api/campaigns/c1/status/stream')

    await vi.waitFor(() => { expect(events).toHaveLength(1) })
    expect(events).toEqual([{ type: 'cost-update', cumulativeUsd: 7 }])
  })

  it('treats an explicit event: close frame as a transient drop (reconnect)', async () => {
    const fake = makeFake([
      { status: 200, chunks: ['event: close\ndata: {"reason":"idle-timeout"}\n\n'] },
    ])
    configureStreamingFetch(fake.fn)
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))

    client.open('/api/campaigns/c1/status/stream')

    await vi.waitFor(() => {
      expect(client.connectionState.getState().status).toBe('reconnecting')
    })
  })

  it('skips a frame that has an event but empty data', async () => {
    const fake = makeFake([
      {
        status: 200,
        keepOpen: true,
        chunks: [
          'event: ping\n\n', // event present, data === '' → routed nowhere
          'data: {"type":"cost-update","cumulativeUsd":1}\n\n',
        ],
      },
    ])
    configureStreamingFetch(fake.fn)
    const events: PipelineEvent[] = []
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))
    client.onEvent((e) => events.push(e))

    client.open('/api/campaigns/c1/status/stream')

    await vi.waitFor(() => { expect(events).toHaveLength(1) })
    expect(events).toEqual([{ type: 'cost-update', cumulativeUsd: 1 }])
  })
})

describe('transport faults', () => {
  it('reconnects when the open fetch rejects (transient)', async () => {
    const fn: StreamingFetch = () => Promise.reject(new Error('boom'))
    configureStreamingFetch(fn)
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))

    client.open('/api/campaigns/c1/status/stream')

    await vi.waitFor(() => {
      expect(client.connectionState.getState().status).toBe('reconnecting')
    })
  })

  it('reconnects when the chunk stream throws mid-read (was connected)', async () => {
    const fn: StreamingFetch = () => {
      const chunks = (async function* (): AsyncGenerator<string> {
        await Promise.resolve()
        throw new Error('stream boom')
      })()
      return Promise.resolve({ status: 200, chunks })
    }
    configureStreamingFetch(fn)
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))

    client.open('/api/campaigns/c1/status/stream')

    // It opened (200 → connected) then the read threw → transient reconnect.
    await vi.waitFor(() => {
      expect(client.connectionState.getState().status).toBe('reconnecting')
    })
  })

  it('aborts the in-flight stream when open() is called again (re-open)', async () => {
    const fake = makeFake([
      { status: 200, keepOpen: true },
      { status: 200, keepOpen: true },
    ])
    configureStreamingFetch(fake.fn)
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))

    client.open('/api/campaigns/c1/status/stream')
    await vi.waitFor(() => { expect(fake.calls).toHaveLength(1) })

    client.open('/api/campaigns/c2/status/stream') // controller?.abort() the live stream
    await vi.waitFor(() => { expect(fake.calls).toHaveLength(2) })
    expect(fake.calls[1]?.url).toContain('/c2/')
  })
})

describe('close() racing an in-flight await', () => {
  it('ignores a connect superseded during the pre-flight refresh', async () => {
    let releaseRefresh = (): void => undefined
    const gate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    configureTokenRefresh(() =>
      gate.then(() => ({ accessToken: 't', expiresIn: 3600 })),
    )
    const fake = makeFake([{ status: 200, keepOpen: true }])
    configureStreamingFetch(fake.fn)
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))

    client.open('/api/campaigns/c1/status/stream') // parks at await runRefresh()
    client.close() // closed = true → the post-refresh staleness guard returns
    releaseRefresh()
    await vi.waitFor(() => {
      expect(client.connectionState.getState().status).toBe('closed')
    })
    expect(fake.calls).toHaveLength(0) // returned before the fetch
  })

  it('ignores a connect superseded during the open fetch', async () => {
    let releaseFetch = (): void => undefined
    const gate = new Promise<void>((resolve) => { releaseFetch = resolve })
    const calls: string[] = []
    const fn: StreamingFetch = (url, init) => {
      calls.push(url)
      return gate.then(() => {
        const chunks = (async function* (): AsyncGenerator<string> {
          await new Promise<void>((resolve) => {
            init.signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        })()
        return { status: 200, chunks }
      })
    }
    configureStreamingFetch(fn)
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))

    client.open('/api/campaigns/c1/status/stream') // parks at await getStreamingFetch()(...)
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    client.close() // closed = true → the post-fetch staleness guard returns
    releaseFetch()
    // The post-fetch guard returns BEFORE onOpenSuccess(), so the state stays
    // `closed` rather than flipping to `connected`.
    await Promise.resolve()
    await Promise.resolve()
    expect(client.connectionState.getState()).toEqual({ status: 'closed', attempt: 0 })
  })

  it('stops reading + does not reconnect when closed mid-stream', async () => {
    let releaseSecond = (): void => undefined
    const gate = new Promise<void>((resolve) => { releaseSecond = resolve })
    const fn: StreamingFetch = () => {
      const chunks = (async function* (): AsyncGenerator<string> {
        yield 'data: {"type":"cost-update","cumulativeUsd":1}\n\n'
        await gate
        yield 'data: {"type":"cost-update","cumulativeUsd":2}\n\n'
      })()
      return Promise.resolve({ status: 200, chunks })
    }
    configureStreamingFetch(fn)
    const events: PipelineEvent[] = []
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))
    client.onEvent((e) => events.push(e))

    client.open('/api/campaigns/c1/status/stream')
    await vi.waitFor(() => { expect(events).toHaveLength(1) })

    client.close()
    releaseSecond() // the next chunk arrives stale → readStream returns, no reconnect
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toHaveLength(1) // the post-close chunk was NOT emitted
    expect(client.connectionState.getState()).toEqual({ status: 'closed', attempt: 0 })
  })
})

describe('ceiling exhaustion', () => {
  it('reaches failed{exhausted} after the reconnect ceiling (recordDrop returns false)', async () => {
    vi.useFakeTimers()
    const fn: StreamingFetch = () => {
      const chunks = (async function* (): AsyncGenerator<string> {
        // never yields — status 503 routes before the body is read
      })()
      return Promise.resolve({ status: 503, chunks })
    }
    configureStreamingFetch(fn)
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))

    client.open('/api/campaigns/c1/status/stream')

    // Each 503 drops again; the backoff caps at 30s, so advance generously past
    // the ceiling (10). The final drop's recordDrop() returns false → exhausted.
    for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(35_000)
    expect(client.connectionState.getState()).toEqual({
      status: 'failed',
      attempt: 10,
      failedReason: 'exhausted',
    })
  })
})

describe('onSnapshot unsubscribe', () => {
  it('stops further snapshot delivery once unsubscribed', async () => {
    let releaseSecond = (): void => undefined
    const gate = new Promise<void>((resolve) => { releaseSecond = resolve })
    const fn: StreamingFetch = (_url, init) => {
      const chunks = (async function* (): AsyncGenerator<string> {
        yield 'event: snapshot\ndata: {"n":1}\n\n'
        await gate
        yield 'event: snapshot\ndata: {"n":2}\n\n'
        await new Promise<void>((resolve) => {
          init.signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      })()
      return Promise.resolve({ status: 200, chunks })
    }
    configureStreamingFetch(fn)
    const offSnaps: unknown[] = []
    const barrier: unknown[] = []
    const client = newClient(ctxWith({ authorization: 'Bearer tok' }))
    const off = client.onSnapshot((s) => offSnaps.push(s))
    client.onSnapshot((s) => barrier.push(s))

    client.open('/api/campaigns/c1/status/stream')

    await vi.waitFor(() => { expect(barrier).toHaveLength(1) })
    expect(offSnaps).toHaveLength(1)
    off()
    releaseSecond()

    await vi.waitFor(() => { expect(barrier).toHaveLength(2) })
    expect(offSnaps).toHaveLength(1) // the unsubscribed listener saw none of the second
  })
})
