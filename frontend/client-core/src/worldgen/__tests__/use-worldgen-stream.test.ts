import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createStore } from 'zustand/vanilla'
import type { PipelineEvent, PipelinePhase } from '@mythrun/contract/events'
import type { ApiContext } from '../../api/endpoint.ts'
import type { ConnectionState } from '../../realtime/connection.ts'
import type { SseStatusClient } from '../../realtime/sse-status-client.ts'
import { HttpError } from '../../api/errors.ts'
import {
  configureStreamingFetch,
  resetStreamingFetch,
} from '../../platform/streaming-fetch.ts'
import { resetTokenManager } from '../../auth/token-manager.ts'
import { useWorldGenStream } from '../use-worldgen-stream.ts'

// useWorldGenStream (MYT-89 Phase C, C5): the data layer for the streaming
// world-gen graph. Opens the status SSE, folds `PipelineEvent`s into
// nodes/edges (via the C1 reducers), rehydrates from the world-snapshot once
// stage 4 is reachable, and branches the failure→resume path. Every test
// injects a mock SSE client + spy fetch/resume through the `deps` seam — no
// real transport, no MSW.

const CID = 'campaign-123'
const ctx: ApiContext = { baseUrl: 'http://api.test', getAuthHeaders: () => Promise.resolve({}) }

/** A hand-driven `SseStatusClient`: the test pushes events/snapshot frames and
 *  observes `open`/`close`. Listener unsubscribe is honoured (the default) so a
 *  post-unmount emit is a genuine no-op. Pass `honorUnsub: false` for a "leaky"
 *  transport that keeps delivering after teardown — the case the hook's
 *  `mountedRef` guard exists to absorb (a real SSE frame in flight when the flow
 *  unmounts). */
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

describe('useWorldGenStream', () => {
  // The real-default test below wires the two module-global transport seams
  // (streaming fetch + token refresh). Reset them so no state leaks between tests.
  afterEach(() => {
    resetStreamingFetch()
    resetTokenManager()
  })

  it('folds pipeline events into nodes and edges', () => {
    const mock = makeMockClient()
    const createClient = () => mock.client
    const { result } = renderHook(() =>
      useWorldGenStream(ctx, CID, { createClient, fetchSnapshot: vi.fn(), resume: vi.fn() }),
    )

    act(() => {
      mock.emit({
        type: 'entity-added',
        synthKey: 'world_and_factions/f1',
        entityKind: 'faction',
        name: 'The Ashen Court',
      })
      mock.emit({
        type: 'entity-added',
        synthKey: 'world_and_factions/f2',
        entityKind: 'faction',
        name: 'Rivergaard',
      })
      mock.emit({
        type: 'edge-added',
        synthKey: 'entity_relationships/e1',
        from: 'world_and_factions/f1',
        to: 'world_and_factions/f2',
        relationship: 'rivals',
      })
    })

    expect(mock.openedPath()).toBe(`/api/campaigns/${CID}/status/stream`)
    expect(result.current.nodes.map((n) => n.name)).toEqual(['The Ashen Court', 'Rivergaard'])
    expect(result.current.edges).toHaveLength(1)
    expect(result.current.edges[0]).toMatchObject({
      from: 'world_and_factions/f1',
      to: 'world_and_factions/f2',
      relationship: 'rivals',
    })
    expect(result.current.status).toBe('generating')
  })

  it('exposes per-stage progress and cumulative cost from the first-frame snapshot', () => {
    const mock = makeMockClient()
    const stages = [
      {
        stage: 'concept_intake',
        status: 'completed' as const,
        userId: null,
        costUsd: 0.12,
        startedAt: '2026-06-19T10:00:00.000Z',
        completedAt: '2026-06-19T10:00:05.000Z',
      },
      {
        stage: 'world_and_factions',
        status: 'running' as const,
        userId: null,
        costUsd: 0,
        startedAt: '2026-06-19T10:00:05.000Z',
        completedAt: null,
      },
    ]
    const { result } = renderHook(() =>
      useWorldGenStream(ctx, CID, {
        createClient: () => mock.client,
        fetchSnapshot: vi.fn(),
        resume: vi.fn(),
      }),
    )

    // Before any frame the hook reports an empty, cost-less snapshot.
    expect(result.current.stages).toEqual([])
    expect(result.current.costUsd).toBeNull()

    act(() => {
      mock.emitSnapshot({ phase: 'world_gen', stages, cumulativeCostUsd: 3.75 })
    })

    expect(result.current.stages).toEqual(stages)
    expect(result.current.costUsd).toBe(3.75)
  })

  it('advances stages[] LIVE past the snapshot state and reaches all-complete', () => {
    // The ship-blocker (MYT-89 C7): `stages[]` was written ONLY from the
    // connect-time snapshot, so the status-card % and the fog fade froze for
    // the whole ~10-min gen. The backend emits incremental stage-*
    // events; the hook must fold them so `stages[]` advances and reaches
    // all-complete at the reveal.
    const mock = makeMockClient()
    const { result } = renderHook(() =>
      useWorldGenStream(ctx, CID, {
        createClient: () => mock.client,
        fetchSnapshot: vi.fn(),
        resume: vi.fn(),
      }),
    )

    // Snapshot at connect: one stage running, none complete (the frozen state).
    act(() => {
      mock.emitSnapshot({
        phase: 'world_gen',
        stages: [
          {
            stage: 'concept_intake',
            status: 'running',
            userId: null,
            costUsd: 0,
            startedAt: '2026-06-19T10:00:00.000Z',
            completedAt: null,
          },
        ],
        cumulativeCostUsd: 0.05,
      })
    })
    const completedCount = (): number =>
      result.current.stages.filter((s) => s.status === 'completed').length
    expect(completedCount()).toBe(0)
    expect(result.current.costUsd).toBe(0.05)

    // Live progression: complete stage 1, start + complete a stage the
    // snapshot never carried (proves append + advance).
    act(() => {
      mock.emit({
        type: 'stage-completed',
        stage: 'concept_intake',
        userId: null,
        durationMs: 5000,
        costUsd: 0.1,
      })
      mock.emit({
        type: 'stage-started',
        stage: 'world_color',
        userId: null,
        startedAt: '2026-06-19T10:00:05.000Z',
      })
    })

    // Advanced PAST the snapshot: one complete, a new running stage appended.
    expect(completedCount()).toBe(1)
    expect(result.current.stages).toHaveLength(2)
    expect(result.current.stages.find((s) => s.status === 'running')?.stage).toBe('world_color')

    // Finish the last stage → all-complete (the reveal / fog fully gone).
    act(() => {
      mock.emit({
        type: 'stage-completed',
        stage: 'world_color',
        userId: null,
        durationMs: 3000,
        costUsd: 0.2,
      })
      mock.emit({ type: 'cost-update', cumulativeUsd: 0.3 })
    })

    expect(result.current.stages).toHaveLength(2)
    expect(completedCount()).toBe(2)
    expect(result.current.stages.every((s) => s.status === 'completed')).toBe(true)
    // The completed stages carry their live cost + a derived completedAt.
    expect(result.current.stages.find((s) => s.stage === 'world_color')?.costUsd).toBe(0.2)
    expect(result.current.stages.find((s) => s.stage === 'world_color')?.completedAt).toBe(
      '2026-06-19T10:00:08.000Z',
    )
    // costUsd also tracks the live absolute cost-update (frozen no more).
    expect(result.current.costUsd).toBe(0.3)
  })

  it('marks a stage failed on a live stage-failed event', () => {
    const mock = makeMockClient()
    const { result } = renderHook(() =>
      useWorldGenStream(ctx, CID, {
        createClient: () => mock.client,
        fetchSnapshot: vi.fn(),
        resume: vi.fn(),
      }),
    )

    act(() => {
      mock.emitSnapshot({
        phase: 'world_gen',
        stages: [
          {
            stage: 'world_and_factions',
            status: 'running',
            userId: null,
            costUsd: 0,
            startedAt: '2026-06-19T10:00:00.000Z',
            completedAt: null,
          },
        ],
        cumulativeCostUsd: 0,
      })
      mock.emit({
        type: 'stage-failed',
        stage: 'world_and_factions',
        userId: null,
        errorCode: 'llm_timeout',
        willRetry: false,
      })
    })

    expect(result.current.stages).toHaveLength(1)
    expect(result.current.stages[0]?.status).toBe('failed')
  })

  it('folds stage-completed / stage-failed for stages absent from the snapshot', () => {
    // Pipeline_runs rows are created lazily, so a mid-window snapshot omits
    // not-yet-started stages. A live stage-completed / stage-failed for such a
    // stage APPENDS it (no prior `stage-started` seen → null start/end).
    const mock = makeMockClient()
    const { result } = renderHook(() =>
      useWorldGenStream(ctx, CID, {
        createClient: () => mock.client,
        fetchSnapshot: vi.fn(),
        resume: vi.fn(),
      }),
    )

    act(() => {
      mock.emitSnapshot({ phase: 'world_gen', stages: [], cumulativeCostUsd: 0 })
      mock.emit({
        type: 'stage-completed',
        stage: 'random_tables',
        userId: null,
        durationMs: 1000,
        costUsd: 0.05,
      })
      mock.emit({
        type: 'stage-failed',
        stage: 'coherence_pass',
        userId: null,
        errorCode: 'llm_timeout',
        willRetry: false,
      })
    })

    const completed = result.current.stages.find((s) => s.stage === 'random_tables')
    expect(completed).toMatchObject({ status: 'completed', costUsd: 0.05, startedAt: null })
    // No prior start → the derived completedAt is null (start unknown).
    expect(completed?.completedAt).toBeNull()
    const failed = result.current.stages.find((s) => s.stage === 'coherence_pass')
    expect(failed).toMatchObject({ status: 'failed', costUsd: 0, startedAt: null, completedAt: null })
  })

  it('updates a snapshot stage in place on a live start + tolerates an unparseable startedAt', () => {
    const mock = makeMockClient()
    const { result } = renderHook(() =>
      useWorldGenStream(ctx, CID, {
        createClient: () => mock.client,
        fetchSnapshot: vi.fn(),
        resume: vi.fn(),
      }),
    )

    act(() => {
      mock.emitSnapshot({
        phase: 'world_gen',
        stages: [
          // A running stage whose startedAt can't be parsed → its later
          // completedAt derivation must fall back to null (not NaN/Invalid Date).
          {
            stage: 'concept_intake',
            status: 'running',
            userId: null,
            costUsd: 0,
            startedAt: 'not-a-date',
            completedAt: null,
          },
          // A pending stage the snapshot already carries → a live stage-started
          // updates it IN PLACE, preserving its prior cost (prev defined).
          {
            stage: 'world_color',
            status: 'pending',
            userId: null,
            costUsd: 0.07,
            startedAt: null,
            completedAt: null,
          },
        ],
        cumulativeCostUsd: 0.07,
      })
      mock.emit({
        type: 'stage-completed',
        stage: 'concept_intake',
        userId: null,
        durationMs: 1000,
        costUsd: 0.1,
      })
      mock.emit({
        type: 'stage-started',
        stage: 'world_color',
        userId: null,
        startedAt: '2026-06-19T10:00:10.000Z',
      })
    })

    // Both updated in place — no duplicate rows appended.
    expect(result.current.stages).toHaveLength(2)
    const concept = result.current.stages.find((s) => s.stage === 'concept_intake')
    expect(concept?.status).toBe('completed')
    // Unparseable startedAt → null completedAt (the NaN guard).
    expect(concept?.completedAt).toBeNull()
    const color = result.current.stages.find((s) => s.stage === 'world_color')
    expect(color).toMatchObject({ status: 'running', costUsd: 0.07 })
  })

  it('exposes costUsd as null when the snapshot payload omits cumulativeCostUsd', () => {
    const mock = makeMockClient()
    const { result } = renderHook(() =>
      useWorldGenStream(ctx, CID, {
        createClient: () => mock.client,
        fetchSnapshot: vi.fn(),
        resume: vi.fn(),
      }),
    )

    act(() => {
      mock.emitSnapshot({ phase: 'world_gen', stages: [] })
    })

    expect(result.current.stages).toEqual([])
    expect(result.current.costUsd).toBeNull()
  })

  it('fetches the world-snapshot once and seeds the graph at world_snapshot_ready', async () => {
    const mock = makeMockClient()
    const createClient = () => mock.client
    const fetchSnapshot = vi.fn().mockResolvedValue({
      entities: [
        { id: 'ent-1', entityType: 'npc', name: 'Seeded NPC' },
        { id: 'ent-2', entityType: 'location', name: 'Seeded Keep' },
      ],
      relationships: [
        { sourceEntityId: 'ent-1', targetEntityId: 'ent-2', relationshipType: 'guards' },
      ],
    })
    const { result } = renderHook(() =>
      useWorldGenStream(ctx, CID, { createClient, fetchSnapshot, resume: vi.fn() }),
    )

    act(() => {
      mock.emitSnapshot({ phase: 'world_snapshot_ready', stages: [], cumulativeCostUsd: 0 })
    })

    await waitFor(() => {
      expect(result.current.nodes.some((n) => n.name === 'Seeded NPC')).toBe(true)
    })
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)
    expect(result.current.nodes.map((n) => n.name)).toEqual(['Seeded NPC', 'Seeded Keep'])
    expect(result.current.edges).toHaveLength(1)
    // world_snapshot_ready is still "generating" for the UI.
    expect(result.current.status).toBe('generating')
    expect(result.current.phase).toBe('world_snapshot_ready')
  })

  it('does not fetch the snapshot before world_snapshot_ready (honestly sparse)', () => {
    const mock = makeMockClient()
    const createClient = () => mock.client
    const fetchSnapshot = vi.fn()
    const { result } = renderHook(() =>
      useWorldGenStream(ctx, CID, { createClient, fetchSnapshot, resume: vi.fn() }),
    )

    act(() => {
      mock.emit({ type: 'phase', phase: 'world_gen' })
    })

    expect(fetchSnapshot).not.toHaveBeenCalled()
    expect(result.current.nodes).toEqual([])
    expect(result.current.status).toBe('generating')
  })

  it('exposes retry on failure; a 202 resume returns status to generating', async () => {
    const mock = makeMockClient()
    const createClient = () => mock.client
    const resume = vi.fn().mockResolvedValue({ campaignId: CID, action: 'world-gen-re-enqueued' })
    const { result } = renderHook(() =>
      useWorldGenStream(ctx, CID, { createClient, fetchSnapshot: vi.fn(), resume }),
    )

    act(() => {
      mock.emit({ type: 'phase', phase: 'world_gen_failed' })
    })
    expect(result.current.status).toBe('failed')
    expect(typeof result.current.retry).toBe('function')

    await act(async () => {
      await result.current.retry()
    })

    expect(resume).toHaveBeenCalledWith(ctx, CID)
    expect(result.current.status).toBe('generating')
  })

  it('sets status terminal when resume rejects with a terminal HttpError', async () => {
    const mock = makeMockClient()
    const createClient = () => mock.client
    const resume = vi.fn().mockRejectedValue(new HttpError(409, 'Conflict', 'world_gen_capped'))
    const { result } = renderHook(() =>
      useWorldGenStream(ctx, CID, { createClient, fetchSnapshot: vi.fn(), resume }),
    )

    act(() => {
      mock.emit({ type: 'phase', phase: 'world_gen_failed' })
    })
    await act(async () => {
      await result.current.retry()
    })

    expect(result.current.status).toBe('terminal')
  })

  it('stays failed (retryable) when resume fails transiently, not with an HttpError', async () => {
    const mock = makeMockClient()
    const createClient = () => mock.client
    const resume = vi.fn().mockRejectedValue(new Error('network down'))
    const { result } = renderHook(() =>
      useWorldGenStream(ctx, CID, { createClient, fetchSnapshot: vi.fn(), resume }),
    )

    act(() => {
      mock.emit({ type: 'phase', phase: 'world_gen_failed' })
    })
    await act(async () => {
      await result.current.retry()
    })

    expect(result.current.status).toBe('failed')
  })

  it('closes the stream on unmount and ignores post-unmount emits', () => {
    const mock = makeMockClient()
    const createClient = () => mock.client
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { unmount } = renderHook(() =>
      useWorldGenStream(ctx, CID, { createClient, fetchSnapshot: vi.fn(), resume: vi.fn() }),
    )

    expect(mock.isClosed()).toBe(false)
    unmount()
    expect(mock.isClosed()).toBe(true)

    // A late frame after teardown must not throw or setState-after-unmount.
    act(() => {
      mock.emit({ type: 'phase', phase: 'world_gen' })
    })
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('a late frame from a leaky client (no unsubscribe) is dropped by the mounted-ref guard', () => {
    const mock = makeMockClient({ honorUnsub: false })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { unmount } = renderHook(() =>
      useWorldGenStream(ctx, CID, {
        createClient: () => mock.client,
        fetchSnapshot: vi.fn(),
        resume: vi.fn(),
      }),
    )

    unmount()
    // The leaky transport never removed our listeners, so BOTH the event and the
    // snapshot callback still fire after teardown — the case the hook's
    // `mountedRef` guard exists to absorb. Neither may setState-after-unmount or
    // throw (React logs a console.error on a post-unmount setState).
    act(() => {
      mock.emit({ type: 'phase', phase: 'world_gen' })
      mock.emitSnapshot({ phase: 'world_gen', stages: [], cumulativeCostUsd: 0 })
    })

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('maps phase `failed` to the terminal (non-resumable) status', () => {
    const mock = makeMockClient()
    const { result } = renderHook(() =>
      useWorldGenStream(ctx, CID, {
        createClient: () => mock.client,
        fetchSnapshot: vi.fn(),
        resume: vi.fn(),
      }),
    )

    act(() => {
      mock.emit({ type: 'phase', phase: 'failed' })
    })

    expect(result.current.status).toBe('terminal')
  })

  it('maps every world-ready-and-beyond phase to the complete status', () => {
    const completePhases: PipelinePhase[] = [
      'world_ready',
      'character_creation',
      'post_creation',
      'complete',
    ]

    for (const phase of completePhases) {
      const mock = makeMockClient()
      // These phases are all snapshot-ready → they trigger the one-shot rehydrate,
      // so fetchSnapshot must resolve (an empty world is enough for the status assert).
      const fetchSnapshot = vi.fn().mockResolvedValue({ entities: [], relationships: [] })
      const { result } = renderHook(() =>
        useWorldGenStream(ctx, CID, {
          createClient: () => mock.client,
          fetchSnapshot,
          resume: vi.fn(),
        }),
      )

      act(() => {
        mock.emit({ type: 'phase', phase })
      })

      expect(result.current.status).toBe('complete')
    }
  })

  it('ignores a first-frame snapshot whose payload carries no usable phase', () => {
    // Each raw exercises a distinct null-guard in phaseFromSnapshot:
    //   null                     → raw === null
    //   a bare string            → typeof raw !== 'object'
    //   an object without `phase` → !('phase' in raw)
    //   { phase: <non-string> }  → the `: null` arm of the string check
    const rawCases: unknown[] = [null, 'world_snapshot_ready', { stages: [] }, { phase: 42 }]

    for (const raw of rawCases) {
      const mock = makeMockClient()
      const { result } = renderHook(() =>
        useWorldGenStream(ctx, CID, {
          createClient: () => mock.client,
          fetchSnapshot: vi.fn(),
          resume: vi.fn(),
        }),
      )

      act(() => {
        mock.emitSnapshot(raw)
      })

      // phaseFromSnapshot returned null → the hook never sets a phase.
      expect(result.current.phase).toBeNull()
      expect(result.current.status).toBe('generating')
    }
  })

  it('defaults fetchSnapshot + resume (wired, uninvoked) when the flow neither rehydrates nor retries', () => {
    const mock = makeMockClient()
    // Only createClient is injected; fetchSnapshot + resume fall through to the
    // real getWorldSnapshot / resumeGeneration defaults. Neither is CALLED here
    // (no world_snapshot_ready → no rehydrate; no retry()), so the defaults are
    // assigned but never hit the network — the branch is the `??` fallback itself.
    const { result } = renderHook(() =>
      useWorldGenStream(ctx, CID, { createClient: () => mock.client }),
    )

    act(() => {
      mock.emit({
        type: 'entity-added',
        synthKey: 'world_and_factions/f1',
        entityKind: 'faction',
        name: 'The Ashen Court',
      })
    })

    expect(result.current.nodes.map((n) => n.name)).toEqual(['The Ashen Court'])
    expect(result.current.status).toBe('generating')
  })

  it('defaults createClient to the real SSE status client when no transport is injected', () => {
    // Park the connect coroutine on a never-settling streaming fetch so the REAL
    // createSseStatusClient default constructs + opens without a wiring throw and
    // without arming a reconnect timer. This proves the production default wiring
    // (not just the injected test seam) yields a working stream.
    configureStreamingFetch(
      () => new Promise<{ status: number; chunks: AsyncIterable<string> }>(() => undefined),
    )

    const { result, unmount } = renderHook(() =>
      useWorldGenStream(ctx, CID, { fetchSnapshot: vi.fn(), resume: vi.fn() }),
    )

    expect(result.current.status).toBe('generating')
    expect(result.current.phase).toBeNull()
    expect(result.current.nodes).toEqual([])
    // Teardown drives the real client's close() (abort + markClosed) — no throw.
    expect(() => {
      unmount()
    }).not.toThrow()
  })

  it('dedups a snapshot entity the live stream re-emits + finalizes to the same UUID into ONE node', async () => {
    // spec §6 (Iridessa-C1) rehydration guarantee: the persisted snapshot seeds a
    // node keyed by its real UUID; when the SAME entity also streams live and
    // finalizes to that UUID, the seam must render ONE node — the live copy
    // superseding the seed by matching `displayId` — never a phantom duplicate.
    const SHARED_ID = '0192f0aa-1111-7abc-8def-000000000042'
    const mock = makeMockClient()
    const fetchSnapshot = vi.fn().mockResolvedValue({
      entities: [{ id: SHARED_ID, entityType: 'npc', name: 'Seeded Warden' }],
      relationships: [],
    })
    const { result } = renderHook(() =>
      useWorldGenStream(ctx, CID, { createClient: () => mock.client, fetchSnapshot, resume: vi.fn() }),
    )

    // Rehydrate: the seed node's displayId IS the real UUID.
    act(() => {
      mock.emitSnapshot({ phase: 'world_snapshot_ready', stages: [], cumulativeCostUsd: 0 })
    })
    await waitFor(() => {
      expect(result.current.nodes.some((n) => n.displayId === SHARED_ID)).toBe(true)
    })

    // The same entity now arrives live and finalizes to the SAME UUID. Post-finalize
    // its displayId === SHARED_ID, so mergeNodes drops the seed copy.
    act(() => {
      mock.emit({
        type: 'entity-added',
        synthKey: 'locations_and_npcs/npcs/0',
        entityKind: 'npc',
        name: 'Warden (live)',
      })
      mock.emit({ type: 'finalized', synthKey: 'locations_and_npcs/npcs/0', entityId: SHARED_ID })
    })

    const matching = result.current.nodes.filter((n) => n.displayId === SHARED_ID)
    expect(matching).toHaveLength(1)
    // The live copy wins (fresher) — the seed is superseded, not duplicated.
    expect(matching[0]?.name).toBe('Warden (live)')
    expect(matching[0]?.synthKey).toBe('locations_and_npcs/npcs/0')
  })

  it('leaves the graph honestly sparse when the snapshot rehydrate fetch rejects', async () => {
    const mock = makeMockClient()
    const fetchSnapshot = vi
      .fn()
      .mockRejectedValue(new HttpError(409, 'Conflict', 'snapshot_not_ready'))
    const { result } = renderHook(() =>
      useWorldGenStream(ctx, CID, { createClient: () => mock.client, fetchSnapshot, resume: vi.fn() }),
    )

    act(() => {
      mock.emitSnapshot({ phase: 'world_snapshot_ready', stages: [], cumulativeCostUsd: 0 })
    })
    await waitFor(() => {
      expect(fetchSnapshot).toHaveBeenCalledTimes(1)
    })

    // loadSeed swallowed the 409 race → no seed, no crash. Live events still fold.
    act(() => {
      mock.emit({
        type: 'entity-added',
        synthKey: 'world_and_factions/f1',
        entityKind: 'faction',
        name: 'The Ashen Court',
      })
    })

    expect(result.current.nodes.map((n) => n.name)).toEqual(['The Ashen Court'])
  })
})
