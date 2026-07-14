import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createStore } from 'zustand/vanilla'
import type { PipelineEvent } from '@mythrun/contract/events'
import type { ApiContext } from '../../api/endpoint.ts'
import type { ConnectionState, ConnectionStatus } from '../../realtime/connection.ts'
import type { SseStatusClient } from '../../realtime/sse-status-client.ts'
import type { CharacterCreationProgress } from '../../api/characters.ts'
import {
  configureStreamingFetch,
  resetStreamingFetch,
} from '../../platform/streaming-fetch.ts'
import { resetTokenManager } from '../../auth/token-manager.ts'
import { useLiveRoster } from '../use-live-roster.ts'

// useLiveRoster (MYT-91): the DOM-free data layer behind the party-staging roster.
// It owns the initial progress fetch, opens the campaign status SSE, and reloads the
// WHOLE roster on the real liveness signals — any `character_creation_complete` and
// each entry into `connected` (initial + every reconnect). Every test injects a
// hand-driven `SseStatusClient` (a real zustand connection store + an event emitter)
// plus a `getProgress` spy — no real transport, no MSW.

const CID = 'campaign-123'
const testCtx: ApiContext = {
  baseUrl: 'http://api.test',
  getAuthHeaders: () => Promise.resolve({}),
}

function makeProgress(over: Partial<CharacterCreationProgress> = {}): CharacterCreationProgress {
  return {
    campaignId: CID,
    totalMembers: 1,
    concepts: [{ userId: 'owner', displayName: 'Kessa', status: 'completed', submittedAt: 't1' }],
    missing: [],
    ...over,
  }
}

const complete = (userId: string): PipelineEvent => ({ type: 'character_creation_complete', userId })

/** A hand-driven `SseStatusClient`: the test pushes events, drives the connection
 *  store, and observes `open`/`close`. `honorUnsub: false` models a leaky transport
 *  that keeps delivering after teardown — the case the hook's mounted-ref guard
 *  absorbs. */
function makeDriver(opts: { honorUnsub?: boolean } = {}) {
  const honorUnsub = opts.honorUnsub ?? true
  const eventCbs = new Set<(e: PipelineEvent) => void>()
  const store = createStore<ConnectionState>(() => ({ status: 'connecting', attempt: 0 }))
  let openedPath: string | null = null
  let closed = false

  const client: SseStatusClient = {
    connectionState: store,
    open: (path) => {
      openedPath = path
    },
    onEvent: (cb) => {
      eventCbs.add(cb)
      return () => {
        if (honorUnsub) eventCbs.delete(cb)
      }
    },
    onSnapshot: () => () => undefined,
    close: () => {
      closed = true
    },
  }

  return {
    client,
    // A STABLE factory reference (defined once) — mirrors production, where
    // party-staging passes a stable `createClient`, so the SSE effect mounts once
    // and the connection-transition tracker persists across reload-driven renders.
    createClient: () => client,
    emit: (e: PipelineEvent) => {
      for (const cb of eventCbs) cb(e)
    },
    setStatus: (status: ConnectionStatus) => {
      store.setState({ status, attempt: 0 }, true)
    },
    isClosed: () => closed,
    openedPath: () => openedPath,
  }
}

afterEach(() => {
  resetStreamingFetch()
  resetTokenManager()
  vi.unstubAllGlobals()
})

describe('useLiveRoster', () => {
  it('fetches the roster on mount, opens the status stream, and reports ready', async () => {
    const progress = makeProgress()
    const getProgress = vi.fn().mockResolvedValue(progress)
    const driver = makeDriver()

    const { result } = renderHook(() =>
      useLiveRoster(CID, testCtx, { getProgress, createClient: driver.createClient }),
    )

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready')
    })
    expect(getProgress).toHaveBeenCalledWith(testCtx, CID)
    expect(driver.openedPath()).toBe(`/api/campaigns/${CID}/status/stream`)
    if (result.current.state.status === 'ready') {
      expect(result.current.state.progress).toBe(progress)
    }
  })

  it('refetches the roster when any character_creation_complete event arrives', async () => {
    const getProgress = vi.fn().mockResolvedValue(makeProgress())
    const driver = makeDriver()
    const { result } = renderHook(() =>
      useLiveRoster(CID, testCtx, { getProgress, createClient: driver.createClient }),
    )
    await waitFor(() => {
      expect(result.current.state.status).toBe('ready')
    })

    getProgress.mockClear()
    act(() => {
      driver.emit(complete('someone-else'))
    })
    await waitFor(() => {
      expect(getProgress).toHaveBeenCalledTimes(1)
    })
  })

  it('ignores a non-completion event (no refetch)', async () => {
    const getProgress = vi.fn().mockResolvedValue(makeProgress())
    const driver = makeDriver()
    const { result } = renderHook(() =>
      useLiveRoster(CID, testCtx, { getProgress, createClient: driver.createClient }),
    )
    await waitFor(() => {
      expect(result.current.state.status).toBe('ready')
    })

    getProgress.mockClear()
    act(() => {
      driver.emit({ type: 'cost-update', cumulativeUsd: 0.5 })
    })
    expect(getProgress).not.toHaveBeenCalled()
  })

  it('reloads on each entry into connected (initial connect + reconnect), not intermediate states', async () => {
    const getProgress = vi.fn().mockResolvedValue(makeProgress())
    const driver = makeDriver()
    const { result } = renderHook(() =>
      useLiveRoster(CID, testCtx, { getProgress, createClient: driver.createClient }),
    )
    await waitFor(() => {
      expect(result.current.state.status).toBe('ready')
    })

    getProgress.mockClear()
    act(() => {
      driver.setStatus('connected')
    })
    await waitFor(() => {
      expect(getProgress).toHaveBeenCalledTimes(1)
    })

    // A drop then a recover reloads again; the intermediate reconnecting state does not.
    act(() => {
      driver.setStatus('reconnecting')
    })
    act(() => {
      driver.setStatus('connected')
    })
    await waitFor(() => {
      expect(getProgress).toHaveBeenCalledTimes(2)
    })
  })

  it('does not reload when a connected store re-emits while already connected', async () => {
    const getProgress = vi.fn().mockResolvedValue(makeProgress())
    const driver = makeDriver()
    const { result } = renderHook(() =>
      useLiveRoster(CID, testCtx, { getProgress, createClient: driver.createClient }),
    )
    await waitFor(() => {
      expect(result.current.state.status).toBe('ready')
    })

    getProgress.mockClear()
    act(() => {
      driver.setStatus('connected')
    })
    await waitFor(() => {
      expect(getProgress).toHaveBeenCalledTimes(1)
    })
    // A second `connected` notification (no drop between) is not a fresh entry — no reload.
    act(() => {
      driver.setStatus('connected')
    })
    expect(getProgress).toHaveBeenCalledTimes(1)
  })

  it('closes the SSE on unmount', () => {
    const getProgress = vi.fn().mockResolvedValue(makeProgress())
    const driver = makeDriver()
    const { unmount } = renderHook(() =>
      useLiveRoster(CID, testCtx, { getProgress, createClient: driver.createClient }),
    )

    expect(driver.isClosed()).toBe(false)
    unmount()
    expect(driver.isClosed()).toBe(true)
  })

  it('surfaces error when the fetch rejects, and self-heals on reload', async () => {
    const getProgress = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(makeProgress())
    const driver = makeDriver()
    const { result } = renderHook(() =>
      useLiveRoster(CID, testCtx, { getProgress, createClient: driver.createClient }),
    )

    await waitFor(() => {
      expect(result.current.state.status).toBe('error')
    })
    act(() => {
      result.current.reload()
    })
    await waitFor(() => {
      expect(result.current.state.status).toBe('ready')
    })
  })

  it('ignores a fetch that settles after teardown (guarded setState, no console error)', async () => {
    let resolveIt!: (p: CharacterCreationProgress) => void
    const pending = new Promise<CharacterCreationProgress>((res) => {
      resolveIt = res
    })
    const getProgress = vi.fn().mockReturnValue(pending)
    const driver = makeDriver()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { unmount } = renderHook(() =>
      useLiveRoster(CID, testCtx, { getProgress, createClient: driver.createClient }),
    )
    unmount()
    await act(async () => {
      resolveIt(makeProgress())
      await Promise.resolve()
    })

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('drops a late completion frame from a leaky client via the mounted-ref guard', () => {
    const getProgress = vi.fn().mockResolvedValue(makeProgress())
    const driver = makeDriver({ honorUnsub: false })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { unmount } = renderHook(() =>
      useLiveRoster(CID, testCtx, { getProgress, createClient: driver.createClient }),
    )
    unmount()
    // The leaky transport never removed our listener, so the callback still fires
    // after teardown — the case the mounted-ref guard absorbs (no reload, no error).
    act(() => {
      driver.emit(complete('late'))
    })

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('defaults getProgress + createClient to the real client-core endpoints', () => {
    // Park the real getProgress fetch and the real SSE connect so the production
    // default wiring constructs + opens without a throw and without arming a timer.
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined))
    configureStreamingFetch(
      () => new Promise<{ status: number; chunks: AsyncIterable<string> }>(() => undefined),
    )

    const { result, unmount } = renderHook(() => useLiveRoster(CID, testCtx))

    expect(result.current.state.status).toBe('loading')
    expect(() => {
      unmount()
    }).not.toThrow()
  })
})
