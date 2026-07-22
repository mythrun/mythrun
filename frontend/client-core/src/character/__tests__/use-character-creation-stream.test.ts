import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  configureStreamingFetch,
  resetStreamingFetch,
} from '../../platform/streaming-fetch.ts'
import { resetTokenManager } from '../../auth/token-manager.ts'
import { useCharacterCreationStream } from '../use-character-creation-stream.ts'
import {
  CID,
  VIEWER,
  OTHER,
  wrapper,
  makeMockClient,
  started,
  completed,
  failed,
  complete,
  row,
  snapshotWith,
  renderStream,
  stateOf,
} from './creation-stream-harness.ts'

// useCharacterCreationStream (MYT-90 B5) — the per-user data layer feeding the
// character-creation loading beat: the base LIVE-fold behaviour. Opens the
// campaign-wide status SSE, filters to the viewer, folds their stage events
// into the fixed `LoadingBeat[]`, and flips `done` on the viewer's live
// `character_creation_complete`. The MYT-102 liveness upgrades (snapshot
// seeding + the reload-stable progress probe) are specified in
// use-character-creation-stream.liveness.test.ts; the shared hand-driven
// transport + stubs live in creation-stream-harness.ts. Mirrors
// use-worldgen-stream's connection + reducer structure + test seam — no real
// transport, no MSW.

describe('useCharacterCreationStream', () => {
  afterEach(() => {
    resetStreamingFetch()
    resetTokenManager()
  })

  it('opens the campaign status stream and starts with every beat pending, not done', () => {
    const mock = makeMockClient()
    const { result } = renderStream(mock)

    expect(mock.openedPath()).toBe(`/api/campaigns/${CID}/status/stream`)
    expect(result.current.beats.map((b) => b.id)).toEqual(['name', 'class', 'scores', 'kit'])
    expect(result.current.beats.every((b) => b.state === 'pending')).toBe(true)
    // This layer emits stable beat IDs only, never display strings — the screen
    // maps each id → t('characterCreate.loading.beat.<id>'). So label stays empty.
    expect(result.current.beats.every((b) => b.label === '')).toBe(true)
    expect(result.current.done).toBe(false)
    expect(result.current.stages).toEqual([])
  })

  it("ignores another user's stage + completion events (no beats advance, done stays false)", () => {
    const mock = makeMockClient()
    const { result } = renderStream(mock)

    act(() => {
      mock.emit(started(OTHER, 'character_concept'))
      mock.emit(completed(OTHER, 'character_concept'))
      mock.emit(started(OTHER, 'character_sheet'))
      mock.emit(completed(OTHER, 'character_sheet'))
      mock.emit(complete(OTHER))
    })

    expect(result.current.beats.every((b) => b.state === 'pending')).toBe(true)
    expect(result.current.done).toBe(false)
    expect(result.current.stages).toEqual([])
  })

  it("advances the viewer's beats as their stages start and complete", () => {
    const mock = makeMockClient()
    const { result } = renderStream(mock)

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

  it("keeps a failed stage's beats surfacing (active, not regressed) — the retry re-runs it", () => {
    const mock = makeMockClient()
    const { result } = renderStream(mock)

    act(() => {
      mock.emit(started(VIEWER, 'character_concept'))
      mock.emit(failed(VIEWER, 'character_concept'))
    })
    expect(stateOf(result.current.beats, 'name')).toBe('active')
    // The folded row is honest data for the countdown: a failed stage re-runs,
    // so its whole average is still ahead.
    expect(result.current.stages).toEqual([
      row(VIEWER, 'character_concept', 'failed', '2026-07-11T10:00:00.000Z'),
    ])
  })

  it('a failure with no observed start still folds, and a retry re-start resumes it as running', () => {
    const mock = makeMockClient()
    const { result } = renderStream(mock)

    // The failure can be the FIRST thing we see for a stage (connected after its
    // start): the row folds with no start knowledge rather than being dropped.
    act(() => {
      mock.emit(failed(VIEWER, 'character_concept'))
    })
    expect(result.current.stages).toEqual([row(VIEWER, 'character_concept', 'failed')])

    // The retry's re-emitted start advances it back to running (carrying the
    // prior row's accumulated cost — 0 here).
    act(() => {
      mock.emit(started(VIEWER, 'character_concept'))
    })
    expect(result.current.stages).toEqual([
      row(VIEWER, 'character_concept', 'running', '2026-07-11T10:00:00.000Z'),
    ])
    expect(stateOf(result.current.beats, 'name')).toBe('active')
  })

  it("sets done when the viewer's character_creation_complete event arrives", () => {
    const mock = makeMockClient()
    const { result } = renderStream(mock)

    expect(result.current.done).toBe(false)
    act(() => {
      mock.emit(complete(VIEWER))
    })
    expect(result.current.done).toBe(true)
  })

  it("does not set done on another user's completion event", () => {
    const mock = makeMockClient()
    const { result } = renderStream(mock)

    act(() => {
      mock.emit(complete(OTHER))
    })
    expect(result.current.done).toBe(false)
  })

  it('closes the stream on unmount', () => {
    const mock = makeMockClient()
    const { unmount } = renderStream(mock)

    expect(mock.isClosed()).toBe(false)
    unmount()
    expect(mock.isClosed()).toBe(true)
  })

  it('drops a late frame from a leaky client (no unsubscribe) via the mounted-ref guard', () => {
    const mock = makeMockClient({ honorUnsub: false })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { unmount } = renderStream(mock)

    unmount()
    // The leaky transport never removed our listeners, so the callbacks still fire
    // after teardown — the case the hook's `mountedRef` guard exists to absorb. It
    // must not setState-after-unmount (React logs a console.error if it does).
    act(() => {
      mock.emit(complete(VIEWER))
      mock.emitSnapshot(snapshotWith([row(VIEWER, 'character_concept', 'running')]))
    })

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('defaults createClient + fetchProgress to the real endpoints when no deps are injected', () => {
    // Park the connect coroutine on a never-settling streaming fetch so the REAL
    // createSseStatusClient default constructs + opens without a wiring throw and
    // without arming a reconnect timer — proving the production default wiring, not
    // just the injected seam. The real progress GET fires against the unreachable
    // test host and rejects; the hook's calm catch absorbs it (done stays false).
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
