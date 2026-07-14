import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { createStore } from 'zustand/vanilla'
import type { PipelineEvent } from '@mythrun/contract/events'
import type { ApiContext } from '../../api/endpoint.ts'
import type { ConnectionState } from '../../realtime/connection.ts'
import type { SseStatusClient } from '../../realtime/sse-status-client.ts'
import {
  configureStreamingFetch,
  resetStreamingFetch,
} from '../../platform/streaming-fetch.ts'
import { resetTokenManager } from '../../auth/token-manager.ts'
import { useSessionPrep } from '../use-session-prep.ts'

// useSessionPrep (MYT-92 A3): the DOM-free data layer behind the session-prep
// atmospheric wait. Opens the prep-status SSE, seeds `status` from the connect-time
// `event: snapshot` frame ({ status: 'ready' | 'generating' }), then advances it on
// the live prep-* events (prep-started/prep-ready/prep-failed). Mirrors
// use-worldgen-stream's ctx-param + injected-client + mounted-ref test seam: every
// test drives a hand-driven `SseStatusClient` through `deps.createClient` — no real
// transport, no MSW.

const CID = 'campaign-123'
const ctx: ApiContext = { baseUrl: 'http://api.test', getAuthHeaders: () => Promise.resolve({}) }

/** A hand-driven `SseStatusClient`: the test pushes snapshot/event frames and
 *  observes `open`/`close`. Listener unsubscribe is honoured by default so a
 *  post-unmount emit is a genuine no-op; `honorUnsub: false` models a "leaky"
 *  transport that keeps delivering after teardown — the case the hook's
 *  `mountedRef` guard absorbs. */
function makeMockClient(opts: { honorUnsub?: boolean } = {}) {
  const honorUnsub = opts.honorUnsub ?? true
  const eventCbs = new Set<(e: PipelineEvent) => void>()
  const snapshotCbs = new Set<(raw: unknown) => void>()
  let openedPath: string | null = null
  let closed = false

  const client: SseStatusClient = {
    connectionState: createStore<ConnectionState>(() => ({ status: 'connecting', attempt: 0 })),
    open: (path) => {
      openedPath = path
    },
    onEvent: (cb) => {
      eventCbs.add(cb)
      return () => {
        if (honorUnsub) eventCbs.delete(cb)
      }
    },
    onSnapshot: (cb) => {
      snapshotCbs.add(cb)
      return () => {
        if (honorUnsub) snapshotCbs.delete(cb)
      }
    },
    close: () => {
      closed = true
    },
  }

  return {
    client,
    emit: (e: PipelineEvent) => {
      for (const cb of eventCbs) cb(e)
    },
    emitSnapshot: (raw: unknown) => {
      for (const cb of snapshotCbs) cb(raw)
    },
    isClosed: () => closed,
    openedPath: () => openedPath,
  }
}

const prepStarted = (): PipelineEvent => ({ type: 'prep-started', sessionNumber: 1 })
const prepReady = (): PipelineEvent => ({ type: 'prep-ready', sessionNumber: 1, costUsd: 0.12 })
const prepFailed = (terminal: boolean): PipelineEvent => ({
  type: 'prep-failed',
  sessionNumber: 1,
  terminal,
})
/** A fully-typed non-prep pipeline event — the channel is prep-scoped, but the
 *  union is wide; the reducer must ignore anything that isn't a prep-* event. */
const nonPrepEvent = (): PipelineEvent => ({ type: 'finalized', synthKey: 's', entityId: 'e' })

describe('useSessionPrep', () => {
  afterEach(() => {
    resetStreamingFetch()
    resetTokenManager()
  })

  it('opens the prep-status stream and a generating snapshot yields generating', () => {
    const mock = makeMockClient()
    const { result } = renderHook(() =>
      useSessionPrep(ctx, CID, { createClient: () => mock.client }),
    )

    expect(mock.openedPath()).toBe(`/api/campaigns/${CID}/prep-status`)
    act(() => {
      mock.emitSnapshot({ status: 'generating' })
    })
    expect(result.current).toEqual({ status: 'generating', terminal: false })
  })

  it('flips to ready on a ready first-frame snapshot (prep already done), no events', () => {
    const mock = makeMockClient()
    const { result } = renderHook(() =>
      useSessionPrep(ctx, CID, { createClient: () => mock.client }),
    )

    act(() => {
      mock.emitSnapshot({ status: 'ready' })
    })
    expect(result.current).toEqual({ status: 'ready', terminal: false })
  })

  it('flips to ready on a prep-ready event', () => {
    const mock = makeMockClient()
    const { result } = renderHook(() =>
      useSessionPrep(ctx, CID, { createClient: () => mock.client }),
    )

    expect(result.current.status).toBe('generating')
    act(() => {
      mock.emit(prepReady())
    })
    expect(result.current).toEqual({ status: 'ready', terminal: false })
  })

  it('yields failed + terminal:true on a prep-failed{terminal:true} event', () => {
    const mock = makeMockClient()
    const { result } = renderHook(() =>
      useSessionPrep(ctx, CID, { createClient: () => mock.client }),
    )

    act(() => {
      mock.emit(prepFailed(true))
    })
    expect(result.current).toEqual({ status: 'failed', terminal: true })
  })

  it('a non-terminal prep-failed then a prep-started retry resets to generating (terminal:false)', () => {
    const mock = makeMockClient()
    const { result } = renderHook(() =>
      useSessionPrep(ctx, CID, { createClient: () => mock.client }),
    )

    act(() => {
      mock.emit(prepFailed(false))
    })
    expect(result.current).toEqual({ status: 'failed', terminal: false })

    act(() => {
      mock.emit(prepStarted())
    })
    expect(result.current).toEqual({ status: 'generating', terminal: false })
  })

  it('ignores a non-prep event on the channel (state unchanged)', () => {
    const mock = makeMockClient()
    const { result } = renderHook(() =>
      useSessionPrep(ctx, CID, { createClient: () => mock.client }),
    )

    act(() => {
      mock.emit(prepReady())
    })
    expect(result.current.status).toBe('ready')

    act(() => {
      mock.emit(nonPrepEvent())
    })
    expect(result.current).toEqual({ status: 'ready', terminal: false })
  })

  it('treats a malformed snapshot payload (non-object, null, or missing/other status) as generating', () => {
    const mock = makeMockClient()
    const { result } = renderHook(() =>
      useSessionPrep(ctx, CID, { createClient: () => mock.client }),
    )

    for (const bad of [42, null, {}, { status: 'nope' }]) {
      act(() => {
        mock.emitSnapshot({ status: 'ready' })
      })
      expect(result.current.status).toBe('ready')
      act(() => {
        mock.emitSnapshot(bad)
      })
      expect(result.current).toEqual({ status: 'generating', terminal: false })
    }
  })

  it('opens the correct path and closes the stream on unmount', () => {
    const mock = makeMockClient()
    const { unmount } = renderHook(() =>
      useSessionPrep(ctx, CID, { createClient: () => mock.client }),
    )

    expect(mock.openedPath()).toBe(`/api/campaigns/${CID}/prep-status`)
    expect(mock.isClosed()).toBe(false)
    unmount()
    expect(mock.isClosed()).toBe(true)
  })

  it('drops late snapshot + event frames from a leaky client via the mounted-ref guard', () => {
    const mock = makeMockClient({ honorUnsub: false })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { unmount } = renderHook(() =>
      useSessionPrep(ctx, CID, { createClient: () => mock.client }),
    )

    unmount()
    // The leaky transport never removed our listeners, so both callbacks still fire
    // after teardown — the case the hook's `mountedRef` guard exists to absorb. It
    // must not setState-after-unmount (React logs a console.error if it does).
    act(() => {
      mock.emitSnapshot({ status: 'ready' })
      mock.emit(prepReady())
    })

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('defaults createClient to the real SSE status client when no transport is injected', () => {
    // Park the connect coroutine on a never-settling streaming fetch so the REAL
    // createSseStatusClient default constructs + opens without a wiring throw and
    // without arming a reconnect timer — proving the production default wiring, not
    // just the injected seam.
    configureStreamingFetch(
      () => new Promise<{ status: number; chunks: AsyncIterable<string> }>(() => undefined),
    )

    const { result, unmount } = renderHook(() => useSessionPrep(ctx, CID))

    expect(result.current).toEqual({ status: 'generating', terminal: false })
    expect(() => {
      unmount()
    }).not.toThrow()
  })
})
