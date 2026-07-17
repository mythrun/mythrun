import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import type { CharacterCreationProgress } from '../../api/characters.ts'
import { resetStreamingFetch } from '../../platform/streaming-fetch.ts'
import { resetTokenManager } from '../../auth/token-manager.ts'
import {
  CID,
  VIEWER,
  OTHER,
  testCtx,
  makeMockClient,
  started,
  completed,
  complete,
  row,
  snapshotWith,
  progressOf,
  renderStream,
  flush,
  stateOf,
} from './creation-stream-harness.ts'

// useCharacterCreationStream — the MYT-102 LIVENESS upgrades. Two guarantees on
// top of the base live fold (use-character-creation-stream.test.ts):
//
//   1. SNAPSHOT SEEDING (the mid-creation refresh): the connect-time `snapshot`
//      frame's per-user `stages[]` seeds the viewer's progress, live events
//      fold on top, a reconnect's fresher snapshot replaces the seed, and a
//      stale buffered event never regresses a completed stage.
//   2. THE RELOAD-STABLE DONE (the progress GET): `done` also flips when the
//      probe reports the viewer's concept `completed` — checked once at mount,
//      and re-checked when a snapshot shows the terminal stage complete, so a
//      completion event missed across a refresh/reconnect can never strand the
//      screen.
//
// The shared hand-driven transport + stubs live in creation-stream-harness.ts.

describe('useCharacterCreationStream — snapshot seeding (the mid-creation refresh)', () => {
  afterEach(() => {
    resetStreamingFetch()
    resetTokenManager()
  })

  it("seeds the beats from the connect-time snapshot's per-user stage rows", () => {
    const mock = makeMockClient()
    const { result } = renderStream(mock)

    // A refresh mid-creation: the snapshot already carries the viewer's progress.
    act(() => {
      mock.emitSnapshot(
        snapshotWith([
          row(VIEWER, 'location_selection', 'completed'),
          row(VIEWER, 'character_concept', 'running', '2026-07-17T11:59:00.000Z'),
        ]),
      )
    })

    expect(stateOf(result.current.beats, 'name')).toBe('active')
    expect(stateOf(result.current.beats, 'class')).toBe('active')
    expect(stateOf(result.current.beats, 'scores')).toBe('pending')
    expect(stateOf(result.current.beats, 'kit')).toBe('pending')
  })

  it("ignores other players' and world-scoped rows in the snapshot seed", () => {
    const mock = makeMockClient()
    const { result } = renderStream(mock)

    act(() => {
      mock.emitSnapshot(
        snapshotWith([
          row(OTHER, 'character_concept', 'completed'),
          row(OTHER, 'character_sheet', 'running'),
          row(null, 'entity_relationships', 'completed'),
        ]),
      )
    })

    expect(result.current.beats.every((b) => b.state === 'pending')).toBe(true)
    expect(result.current.stages).toEqual([])
  })

  it('folds live events on top of the snapshot seed', () => {
    const mock = makeMockClient()
    const { result } = renderStream(mock)

    act(() => {
      mock.emitSnapshot(
        snapshotWith([row(VIEWER, 'character_concept', 'running', '2026-07-17T11:59:00.000Z')]),
      )
      mock.emit(completed(VIEWER, 'character_concept'))
      mock.emit(started(VIEWER, 'character_sheet'))
    })

    expect(stateOf(result.current.beats, 'name')).toBe('done')
    expect(stateOf(result.current.beats, 'class')).toBe('done')
    expect(stateOf(result.current.beats, 'scores')).toBe('active')
    expect(stateOf(result.current.beats, 'kit')).toBe('active')
  })

  it('a later (reconnect) snapshot replaces the seed', () => {
    const mock = makeMockClient()
    const { result } = renderStream(mock)

    act(() => {
      mock.emitSnapshot(snapshotWith([row(VIEWER, 'character_concept', 'running')]))
    })
    expect(stateOf(result.current.beats, 'name')).toBe('active')

    act(() => {
      mock.emitSnapshot(
        snapshotWith([
          row(VIEWER, 'character_concept', 'completed'),
          row(VIEWER, 'character_sheet', 'running'),
        ]),
      )
    })
    expect(stateOf(result.current.beats, 'name')).toBe('done')
    expect(stateOf(result.current.beats, 'scores')).toBe('active')
  })

  it('a stale buffered start event never regresses a stage the snapshot reports completed', () => {
    const mock = makeMockClient()
    const { result } = renderStream(mock)

    // The event log can hold a `stage-started` from BEFORE a reconnect whose
    // fresher snapshot already reports that stage completed — beats only advance.
    act(() => {
      mock.emit(started(VIEWER, 'character_concept'))
      mock.emitSnapshot(snapshotWith([row(VIEWER, 'character_concept', 'completed')]))
    })

    expect(stateOf(result.current.beats, 'name')).toBe('done')
    expect(stateOf(result.current.beats, 'class')).toBe('done')
  })

  it('ignores malformed snapshot frames (non-object / missing stages) without crashing', () => {
    const mock = makeMockClient()
    const { result } = renderStream(mock)

    act(() => {
      mock.emitSnapshot('not-an-object')
      mock.emitSnapshot({ phase: 'character_creation' })
      mock.emitSnapshot(null)
    })

    expect(result.current.beats.every((b) => b.state === 'pending')).toBe(true)
    expect(result.current.stages).toEqual([])
  })

  it("exposes the viewer's folded stage progress rows (seed + live, startedAt preserved)", () => {
    const mock = makeMockClient()
    const { result } = renderStream(mock)

    act(() => {
      mock.emitSnapshot(
        snapshotWith([
          row(VIEWER, 'location_selection', 'completed'),
          row(VIEWER, 'character_concept', 'running', '2026-07-17T11:59:00.000Z'),
          row(OTHER, 'character_concept', 'running'),
        ]),
      )
      mock.emit(completed(VIEWER, 'character_concept'))
      mock.emit(started(VIEWER, 'character_sheet'))
    })

    expect(result.current.stages).toEqual([
      row(VIEWER, 'location_selection', 'completed'),
      {
        stage: 'character_concept',
        status: 'completed',
        userId: VIEWER,
        costUsd: 0.05,
        startedAt: '2026-07-17T11:59:00.000Z',
        // Derived from the seed's startedAt + the event's durationMs (the wire
        // carries duration, not an end timestamp).
        completedAt: '2026-07-17T11:59:01.000Z',
      },
      row(VIEWER, 'character_sheet', 'running', '2026-07-11T10:00:00.000Z'),
    ])
  })

  it('a completion with an unknown or unparseable start yields a null completedAt', () => {
    const mock = makeMockClient()
    const { result } = renderStream(mock)

    act(() => {
      // No prior start seen at all → startedAt null; a seed row with a garbage
      // startedAt → unparseable. Both settle completedAt to null, never NaN.
      mock.emit(completed(VIEWER, 'location_selection'))
      mock.emitSnapshot(snapshotWith([row(VIEWER, 'character_concept', 'running', 'garbage')]))
      mock.emit(completed(VIEWER, 'character_concept'))
    })

    const byStage = new Map(result.current.stages.map((s) => [s.stage, s]))
    expect(byStage.get('location_selection')?.completedAt).toBeNull()
    expect(byStage.get('location_selection')?.startedAt).toBeNull()
    expect(byStage.get('character_concept')?.completedAt).toBeNull()
  })
})

describe('useCharacterCreationStream — the reload-stable done (progress GET)', () => {
  afterEach(() => {
    resetStreamingFetch()
    resetTokenManager()
  })

  it("flips done when the mount-time probe reports the viewer's concept completed", async () => {
    const mock = makeMockClient()
    const fetchProgress = vi.fn().mockResolvedValue(progressOf('completed'))
    const { result } = renderStream(mock, { fetchProgress })

    await flush()
    expect(fetchProgress).toHaveBeenCalledWith(testCtx, CID)
    expect(result.current.done).toBe(true)
  })

  it('keeps done false while the probe reports processing', async () => {
    const mock = makeMockClient()
    const { result } = renderStream(mock)

    await flush()
    expect(result.current.done).toBe(false)
  })

  it("keeps done false when the viewer has no concept row (another player's completion is not ours)", async () => {
    const mock = makeMockClient()
    const fetchProgress = vi.fn().mockResolvedValue(progressOf(null))
    const { result } = renderStream(mock, { fetchProgress })

    await flush()
    expect(result.current.done).toBe(false)
  })

  it('absorbs a failed probe calmly (the live completion event remains the signal)', async () => {
    const mock = makeMockClient()
    const fetchProgress = vi.fn().mockRejectedValue(new Error('network'))
    const { result } = renderStream(mock, { fetchProgress })

    await flush()
    expect(result.current.done).toBe(false)
    // The live path still works after the failed probe.
    act(() => {
      mock.emit(complete(VIEWER))
    })
    expect(result.current.done).toBe(true)
  })

  it("re-checks the progress GET when a snapshot shows the viewer's terminal stage completed (the missed-event backstop)", async () => {
    const mock = makeMockClient()
    const fetchProgress = vi
      .fn()
      .mockResolvedValueOnce(progressOf('processing'))
      .mockResolvedValueOnce(progressOf('completed'))
    const { result } = renderStream(mock, { fetchProgress })
    await flush()
    expect(result.current.done).toBe(false)

    // A reconnect snapshot carries the finished pipeline, but the live
    // `character_creation_complete` was emitted during the gap — never seen.
    act(() => {
      mock.emitSnapshot(
        snapshotWith([
          row(VIEWER, 'location_selection', 'completed'),
          row(VIEWER, 'character_concept', 'completed'),
          row(VIEWER, 'character_sheet', 'completed'),
        ]),
      )
    })
    await flush()

    expect(fetchProgress).toHaveBeenCalledTimes(2)
    expect(result.current.done).toBe(true)
  })

  it('does not re-check once done already latched', async () => {
    const mock = makeMockClient()
    const fetchProgress = vi.fn().mockResolvedValue(progressOf('processing'))
    const { result } = renderStream(mock, { fetchProgress })
    await flush()

    act(() => {
      mock.emit(complete(VIEWER))
    })
    act(() => {
      mock.emitSnapshot(snapshotWith([row(VIEWER, 'character_sheet', 'completed')]))
    })
    await flush()

    expect(result.current.done).toBe(true)
    expect(fetchProgress).toHaveBeenCalledTimes(1) // the mount probe only
  })

  it('collapses concurrent checks — a snapshot trigger during an in-flight probe does not double-fetch', async () => {
    const mock = makeMockClient()
    let resolveProbe: ((p: CharacterCreationProgress) => void) | undefined
    const fetchProgress = vi.fn().mockImplementation(
      () =>
        new Promise<CharacterCreationProgress>((resolve) => {
          resolveProbe = resolve
        }),
    )
    const { result } = renderStream(mock, { fetchProgress })

    // The mount probe hangs in flight; the snapshot recheck must coalesce.
    act(() => {
      mock.emitSnapshot(snapshotWith([row(VIEWER, 'character_sheet', 'completed')]))
    })
    expect(fetchProgress).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveProbe?.(progressOf('completed'))
      await Promise.resolve()
    })
    expect(result.current.done).toBe(true)
  })
})
