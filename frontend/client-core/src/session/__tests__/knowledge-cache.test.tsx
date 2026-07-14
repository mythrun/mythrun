import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { SERVER_FRAME_TYPES } from '@mythrun/contract/events'
import type { ApiContext } from '../../api/endpoint.ts'
import { ApiClientProvider } from '../../api/client-context.tsx'
import type { WorldGenSnapshot } from '../../api/campaigns.ts'
import type { GraphEdge, GraphNode } from '../../worldgen/graph-reducers.ts'
import {
  CACHE_PROMOTION_FRAME_TYPES,
  frameRefetchesCache,
  useKnowledgeCache,
  type SnapshotToGraph,
} from '../knowledge-cache.ts'

// useKnowledgeCache (MYT-94 Task 2): ONE world-snapshot fetch → three projections
// (wiki view model / graph seed / entity index), a quiet boundary refetch on a
// `refreshToken` bump, and the enforced-ignorance invariant that NO session frame
// promotes the cache. Every test injects the snapshot fetch + the graph projection
// through `deps` (no real transport) except the one default-path test, which drives
// the real `getWorldSnapshot` endpoint through MSW.

const BASE_URL = 'http://api.test'
const CID = 'campaign-123'

const testCtx: ApiContext = {
  baseUrl: BASE_URL,
  getAuthHeaders: () => Promise.resolve({}),
}

function makeWrapper() {
  return ({ children }: { children: ReactNode }) => (
    <ApiClientProvider value={testCtx}>{children}</ApiClientProvider>
  )
}

/** A hand-resolved promise so a test controls exactly when a fetch settles —
 *  the seam the `active`-flag guard (drop-a-late-resolve) is exercised through. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** The injected graph projection — Task 4's `snapshotToGraph` shape (finalized
 *  nodes/edges straight off the known-tier snapshot). Injected here so the cache
 *  composes it without a compile dependency on the not-yet-landed Task-4 module. */
const snapshotToGraph: SnapshotToGraph = (snap) => ({
  nodes: snap.entities.map(
    (e): GraphNode => ({
      synthKey: e.id,
      kind: e.entityType,
      name: e.name,
      displayId: e.id,
      state: 'finalized',
      lastEventIndex: -1,
    }),
  ),
  edges: snap.relationships.map(
    (r): GraphEdge => ({
      synthKey: `seed:${r.sourceEntityId}->${r.targetEntityId}`,
      from: r.sourceEntityId,
      to: r.targetEntityId,
      relationship: r.relationshipType,
      arrivalIndex: -1,
      sourceStage: 'snap',
    }),
  ),
})

const snapshotA: WorldGenSnapshot = {
  introduction: { title: 'The Moonlit Tide', prose: 'Welcome to the Crescent Quays.', references: [] },
  entities: [
    { id: 'e-npc', entityType: 'npc', name: 'Elenya' },
    { id: 'e-loc', entityType: 'location', name: 'Highreach' },
  ],
  facts: [{ id: 'f-1', entityId: 'e-npc', topic: 'role', content: 'Elenya keeps the tidewatch.' }],
  entityHierarchy: [],
  relationships: [{ sourceEntityId: 'e-npc', targetEntityId: 'e-loc', relationshipType: 'lives_in' }],
}

const snapshotB: WorldGenSnapshot = {
  entities: [{ id: 'e-fac', entityType: 'faction', name: 'The Ashen Hand' }],
  facts: [],
  entityHierarchy: [],
  relationships: [],
}

const server = setupServer()
beforeAll(() => { server.listen({ onUnhandledRequest: 'error' }); })
afterEach(() => { server.resetHandlers(); })
afterAll(() => { server.close(); })

describe('useKnowledgeCache', () => {
  it('derives wiki + graph + index from one resolved snapshot', async () => {
    const { result, unmount } = renderHook(
      () => useKnowledgeCache(CID, 0, { snapshotToGraph, fetchSnapshot: () => Promise.resolve(snapshotA) }),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => { expect(result.current.loading).toBe(false); })
    expect(result.current.failed).toBe(false)
    expect(result.current.wiki).not.toBeNull()
    expect(result.current.graph).not.toBeNull()
    expect(result.current.index).not.toBeNull()
    // graph seed reflects the snapshot's entities; the index matches a known name.
    expect(result.current.graph?.nodes.map((n) => n.name)).toEqual(['Elenya', 'Highreach'])
    const segments = result.current.index?.segment('Elenya keeps watch.') ?? []
    expect(segments.some((s) => s.kind === 'entity' && s.entityId === 'e-npc')).toBe(true)
    unmount() // flush React's commit queue so no scheduler task outlives the env
  })

  it('refetches and swaps in the fresh cache when refreshToken bumps', async () => {
    const fetchSnapshot = vi
      .fn<(ctx: ApiContext, campaignId: string) => Promise<WorldGenSnapshot>>()
      .mockResolvedValueOnce(snapshotA)
      .mockResolvedValueOnce(snapshotB)

    const { result, rerender } = renderHook(
      ({ token }: { token: number }) => useKnowledgeCache(CID, token, { snapshotToGraph, fetchSnapshot }),
      { wrapper: makeWrapper(), initialProps: { token: 0 } },
    )

    await waitFor(() => { expect(result.current.graph?.nodes.map((n) => n.name)).toEqual(['Elenya', 'Highreach']); })

    rerender({ token: 1 })

    await waitFor(() => { expect(result.current.graph?.nodes.map((n) => n.name)).toEqual(['The Ashen Hand']); })
    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
  })

  it('settles to failed with null projections when the FIRST fetch rejects', async () => {
    const { result, unmount } = renderHook(
      () => useKnowledgeCache(CID, 0, { snapshotToGraph, fetchSnapshot: () => Promise.reject(new Error('boom')) }),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => { expect(result.current.failed).toBe(true); })
    expect(result.current.loading).toBe(false)
    expect(result.current.wiki).toBeNull()
    expect(result.current.graph).toBeNull()
    expect(result.current.index).toBeNull()
    unmount() // flush React's commit queue so no scheduler task outlives the env
  })

  it('keeps the prior cache (no flash, not failed) when a REFETCH rejects', async () => {
    const fetchSnapshot = vi
      .fn<(ctx: ApiContext, campaignId: string) => Promise<WorldGenSnapshot>>()
      .mockResolvedValueOnce(snapshotA)
      .mockRejectedValueOnce(new Error('refetch down'))

    const { result, rerender } = renderHook(
      ({ token }: { token: number }) => useKnowledgeCache(CID, token, { snapshotToGraph, fetchSnapshot }),
      { wrapper: makeWrapper(), initialProps: { token: 0 } },
    )

    await waitFor(() => { expect(result.current.graph?.nodes.map((n) => n.name)).toEqual(['Elenya', 'Highreach']); })

    rerender({ token: 1 })
    await waitFor(() => { expect(fetchSnapshot).toHaveBeenCalledTimes(2); })

    // The prior cache stays live; the failed refetch is invisible (no error flash).
    expect(result.current.graph?.nodes.map((n) => n.name)).toEqual(['Elenya', 'Highreach'])
    expect(result.current.wiki).not.toBeNull()
    expect(result.current.failed).toBe(false)
    expect(result.current.loading).toBe(false)
  })

  it('drops a late RESOLVE after unmount (no state update)', async () => {
    const d = deferred<WorldGenSnapshot>()
    const { result, unmount } = renderHook(
      () => useKnowledgeCache(CID, 0, { snapshotToGraph, fetchSnapshot: () => d.promise }),
      { wrapper: makeWrapper() },
    )

    // Unmount clears the `active` flag; the hook's `.then` (queued first on the
    // shared promise) early-returns before this `await` continues — no setState,
    // so nothing commits and no scheduler task outlives the env.
    unmount()
    d.resolve(snapshotA)
    await d.promise

    expect(result.current.loading).toBe(true)
    expect(result.current.wiki).toBeNull()
  })

  it('drops a late REJECT after unmount (no state update)', async () => {
    const d = deferred<WorldGenSnapshot>()
    const { result, unmount } = renderHook(
      () => useKnowledgeCache(CID, 0, { snapshotToGraph, fetchSnapshot: () => d.promise }),
      { wrapper: makeWrapper() },
    )

    unmount()
    d.reject(new Error('late'))
    await d.promise.catch(() => undefined)

    expect(result.current.loading).toBe(true)
    expect(result.current.failed).toBe(false)
  })

  it('defaults fetchSnapshot to the real getWorldSnapshot endpoint', async () => {
    server.use(
      http.get(`${BASE_URL}/api/campaigns/${CID}/world-snapshot`, () => HttpResponse.json(snapshotA)),
    )

    const { result } = renderHook(() => useKnowledgeCache(CID, 0, { snapshotToGraph }), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => { expect(result.current.loading).toBe(false); })
    expect(result.current.failed).toBe(false)
    expect(result.current.graph?.nodes.map((n) => n.name)).toEqual(['Elenya', 'Highreach'])
  })
})

describe('enforced-ignorance invariant: no session frame promotes the cache', () => {
  it('has an EMPTY cache-promotion frame set (boundary refetch is the only path)', () => {
    expect(CACHE_PROMOTION_FRAME_TYPES).toHaveLength(0)
  })

  it('reports NO ServerFrame type as a cache refetch trigger', () => {
    for (const frameType of SERVER_FRAME_TYPES) {
      expect(frameRefetchesCache(frameType)).toBe(false)
    }
  })
})
