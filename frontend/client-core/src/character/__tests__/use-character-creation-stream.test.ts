import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createStore } from 'zustand/vanilla'
import type { PipelineEvent } from '@mythrun/contract/events'
import type { ApiContext } from '../../api/endpoint.ts'
import type { ConnectionState } from '../../realtime/connection.ts'
import type { SseStatusClient } from '../../realtime/sse-status-client.ts'
import { ApiClientProvider } from '../../api/client-context.tsx'
import {
  configureStreamingFetch,
  resetStreamingFetch,
} from '../../platform/streaming-fetch.ts'
import { resetTokenManager } from '../../auth/token-manager.ts'
import { useCharacterCreationStream } from '../use-character-creation-stream.ts'

// useCharacterCreationStream (MYT-90 B5): the per-user data layer feeding the
// character-creation loading beat. Opens the campaign-wide status SSE, filters
// the `PipelineEvent` log to the CURRENT user, folds that user's stage progress
// into `LoadingBeat[]`, and flips `done` on the user's `character_creation_complete`
// event. Mirrors use-worldgen-stream's connection + reducer structure + test seam:
// every test injects a hand-driven `SseStatusClient` through `deps.createClient` —
// no real transport, no MSW.

const CID = 'campaign-123'
const VIEWER = 'user-viewer'
const OTHER = 'user-other'
const testCtx: ApiContext = {
  baseUrl: 'http://api.test',
  getAuthHeaders: () => Promise.resolve({}),
}

/** The provider the hook's `useApiContext()` reads its ctx from. Built with
 *  `createElement` so this stays a `.test.ts` (no JSX) file. */
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ApiClientProvider, { value: testCtx, children })

/** A hand-driven `SseStatusClient`: the test pushes events and observes
 *  `open`/`close`. Listener unsubscribe is honoured by default so a post-unmount
 *  emit is a genuine no-op; `honorUnsub: false` models a "leaky" transport that
 *  keeps delivering after teardown — the case the hook's `mountedRef` guard
 *  absorbs. */
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
    isClosed: () => closed,
    openedPath: () => openedPath,
  }
}

const started = (userId: string, stage: string): PipelineEvent => ({
  type: 'stage-started',
  stage,
  userId,
  startedAt: '2026-07-11T10:00:00.000Z',
})
const completed = (userId: string, stage: string): PipelineEvent => ({
  type: 'stage-completed',
  stage,
  userId,
  durationMs: 1000,
  costUsd: 0.05,
})
const complete = (userId: string): PipelineEvent => ({
  type: 'character_creation_complete',
  userId,
})

const stateOf = (beats: { id: string; state: string }[], id: string): string | undefined =>
  beats.find((b) => b.id === id)?.state

describe('useCharacterCreationStream', () => {
  afterEach(() => {
    resetStreamingFetch()
    resetTokenManager()
  })

  it('opens the campaign status stream and starts with every beat pending, not done', () => {
    const mock = makeMockClient()
    const { result } = renderHook(
      () => useCharacterCreationStream(CID, VIEWER, { createClient: () => mock.client }),
      { wrapper },
    )

    expect(mock.openedPath()).toBe(`/api/campaigns/${CID}/status/stream`)
    expect(result.current.beats.map((b) => b.id)).toEqual(['name', 'class', 'scores', 'kit'])
    expect(result.current.beats.every((b) => b.state === 'pending')).toBe(true)
    expect(result.current.beats.every((b) => b.label.length > 0)).toBe(true)
    expect(result.current.done).toBe(false)
  })

  it("ignores another user's stage + completion events (no beats advance, done stays false)", () => {
    const mock = makeMockClient()
    const { result } = renderHook(
      () => useCharacterCreationStream(CID, VIEWER, { createClient: () => mock.client }),
      { wrapper },
    )

    act(() => {
      mock.emit(started(OTHER, 'character_concept'))
      mock.emit(completed(OTHER, 'character_concept'))
      mock.emit(started(OTHER, 'character_sheet'))
      mock.emit(completed(OTHER, 'character_sheet'))
      mock.emit(complete(OTHER))
    })

    expect(result.current.beats.every((b) => b.state === 'pending')).toBe(true)
    expect(result.current.done).toBe(false)
  })

  it("advances the viewer's beats as their stages start and complete", () => {
    const mock = makeMockClient()
    const { result } = renderHook(
      () => useCharacterCreationStream(CID, VIEWER, { createClient: () => mock.client }),
      { wrapper },
    )

    // The silent setup stage carries no beat; the concept stage lights name + class.
    act(() => {
      mock.emit(completed(VIEWER, 'location_selection'))
      mock.emit(started(VIEWER, 'character_concept'))
    })
    expect(stateOf(result.current.beats, 'name')).toBe('active')
    expect(stateOf(result.current.beats, 'class')).toBe('active')
    expect(stateOf(result.current.beats, 'scores')).toBe('pending')
    expect(stateOf(result.current.beats, 'kit')).toBe('pending')

    // Concept done → name + class done; sheet running → scores + kit active.
    act(() => {
      mock.emit(completed(VIEWER, 'character_concept'))
      mock.emit(started(VIEWER, 'character_sheet'))
    })
    expect(stateOf(result.current.beats, 'name')).toBe('done')
    expect(stateOf(result.current.beats, 'class')).toBe('done')
    expect(stateOf(result.current.beats, 'scores')).toBe('active')
    expect(stateOf(result.current.beats, 'kit')).toBe('active')

    // Sheet done → every beat done — but done stays false until the completion event.
    act(() => {
      mock.emit(completed(VIEWER, 'character_sheet'))
    })
    expect(result.current.beats.every((b) => b.state === 'done')).toBe(true)
    expect(result.current.done).toBe(false)
  })

  it("sets done when the viewer's character_creation_complete event arrives", () => {
    const mock = makeMockClient()
    const { result } = renderHook(
      () => useCharacterCreationStream(CID, VIEWER, { createClient: () => mock.client }),
      { wrapper },
    )

    expect(result.current.done).toBe(false)
    act(() => {
      mock.emit(complete(VIEWER))
    })
    expect(result.current.done).toBe(true)
  })

  it("does not set done on another user's completion event", () => {
    const mock = makeMockClient()
    const { result } = renderHook(
      () => useCharacterCreationStream(CID, VIEWER, { createClient: () => mock.client }),
      { wrapper },
    )

    act(() => {
      mock.emit(complete(OTHER))
    })
    expect(result.current.done).toBe(false)
  })

  it('closes the stream on unmount', () => {
    const mock = makeMockClient()
    const { unmount } = renderHook(
      () => useCharacterCreationStream(CID, VIEWER, { createClient: () => mock.client }),
      { wrapper },
    )

    expect(mock.isClosed()).toBe(false)
    unmount()
    expect(mock.isClosed()).toBe(true)
  })

  it('drops a late frame from a leaky client (no unsubscribe) via the mounted-ref guard', () => {
    const mock = makeMockClient({ honorUnsub: false })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { unmount } = renderHook(
      () => useCharacterCreationStream(CID, VIEWER, { createClient: () => mock.client }),
      { wrapper },
    )

    unmount()
    // The leaky transport never removed our listener, so the callback still fires
    // after teardown — the case the hook's `mountedRef` guard exists to absorb. It
    // must not setState-after-unmount (React logs a console.error if it does).
    act(() => {
      mock.emit(complete(VIEWER))
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

    const { result, unmount } = renderHook(() => useCharacterCreationStream(CID, VIEWER), {
      wrapper,
    })

    expect(result.current.beats.map((b) => b.id)).toEqual(['name', 'class', 'scores', 'kit'])
    expect(result.current.beats.every((b) => b.state === 'pending')).toBe(true)
    expect(result.current.done).toBe(false)
    expect(() => {
      unmount()
    }).not.toThrow()
  })
})
