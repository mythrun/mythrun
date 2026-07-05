import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createStore } from 'zustand/vanilla'
import type { PipelineEvent } from '@mythrun/contract/events'
import type { ApiContext } from '../../api/endpoint.ts'
import type { ConnectionState } from '../../realtime/connection.ts'
import type { SseStatusClient } from '../../realtime/sse-status-client.ts'
import { HttpError } from '../../api/errors.ts'
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
 *  observes `open`/`close`. Listener unsubscribe is honoured so a post-unmount
 *  emit is a genuine no-op. */
function makeMockClient() {
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
      return () => eventCbs.delete(cb)
    },
    onSnapshot: (cb) => {
      snapshotCbs.add(cb)
      return () => snapshotCbs.delete(cb)
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
})
