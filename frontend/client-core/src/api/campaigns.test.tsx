import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { renderHook, waitFor } from '@testing-library/react'
import { Suspense } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiContext } from './endpoint.ts'
import { ApiClientProvider } from './client-context.tsx'
import { isContractValidationError } from './errors.ts'
import { HttpError, isHttpError } from './errors.ts'
import {
  chooseStartingSituation,
  getMyCampaigns,
  getStartingSituations,
  getWorldSnapshot,
  resumeGeneration,
  useMyCampaigns,
} from './campaigns.ts'

// `useMyCampaigns` wires `getMyCampaigns` (GET /api/campaigns/mine, response
// validated against the contract's MyCampaignsResponseSchema) into a TanStack
// suspense query keyed `['campaigns','mine']`. As with useMe the hook is a thin
// wiring shell. These tests drive the real queryFn through MSW: a valid list
// resolves the parsed campaigns; a malformed campaign (missing required fields)
// makes the suspense query surface a `ContractValidationError` (asserted via the
// query's error after waitFor, with retry:false so it errors immediately).

const BASE_URL = 'http://api.test'
const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

const testCtx: ApiContext = {
  baseUrl: BASE_URL,
  getAuthHeaders: () => Promise.resolve({}),
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ApiClientProvider value={testCtx}>
        <Suspense fallback={<span>loading</span>}>{children}</Suspense>
      </ApiClientProvider>
    </QueryClientProvider>
  )
}

const validCampaign = {
  id: 'c-1',
  worldId: 'w-1',
  name: 'The Sunken Coast',
  status: 'active' as const,
  language: 'en',
  createdAt: '2026-06-24T10:00:00.000Z',
  updatedAt: '2026-06-24T11:00:00.000Z',
  // MYT-87 T11 hub-card fields (the schema widened; this mock had lagged behind).
  worldName: 'Aerthmoor',
  worldColors: { from: 'verdigris-200', to: 'moss-800' },
  creator: null,
  party: [{ userId: 'u-1', displayName: 'Ada', hasCharacter: true }],
  sessionCount: 3,
  lastPlayedAt: '2026-06-24T12:00:00.000Z',
  cardPhase: 'played' as const,
}

describe('useMyCampaigns', () => {
  it('resolves the parsed campaign array from a valid payload', async () => {
    server.use(
      http.get(`${BASE_URL}/api/campaigns/mine`, () =>
        HttpResponse.json({ campaigns: [validCampaign] }),
      ),
    )

    const { result } = renderHook(() => useMyCampaigns(), { wrapper: makeWrapper() })

    await waitFor(() => {
      expect(result.current.data).toBeDefined()
    })
    expect(result.current.data).toEqual({ campaigns: [validCampaign] })
  })

  it('surfaces a ContractValidationError for a malformed campaign', async () => {
    server.use(
      http.get(`${BASE_URL}/api/campaigns/mine`, () =>
        HttpResponse.json({ campaigns: [{ id: 'x' }] }),
      ),
    )

    // useSuspenseQuery throws into the error boundary; using the non-suspense
    // path here would still surface .error, but to read the error legibly we
    // capture it via the query result after it settles. A bare Suspense wrapper
    // (no ErrorBoundary) would let the thrown error escape render, so we assert
    // the error directly off the QueryClient cache instead of rendering it.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ApiClientProvider value={testCtx}>
          <Suspense fallback={<span>loading</span>}>{children}</Suspense>
        </ApiClientProvider>
      </QueryClientProvider>
    )

    renderHook(() => useMyCampaigns(), { wrapper })

    await waitFor(() => {
      const state = client.getQueryState(['campaigns', 'mine'])
      expect(state?.error).toBeDefined()
    })
    const error = client.getQueryState(['campaigns', 'mine'])?.error
    expect(isContractValidationError(error)).toBe(true)
  })
})

describe('getMyCampaigns', () => {
  it('fetches and validates /api/campaigns/mine directly', async () => {
    server.use(
      http.get(`${BASE_URL}/api/campaigns/mine`, () =>
        HttpResponse.json({ campaigns: [validCampaign] }),
      ),
    )
    await expect(getMyCampaigns(undefined, testCtx)).resolves.toEqual({
      campaigns: [validCampaign],
    })
  })
})

describe('getWorldSnapshot', () => {
  it('parses the graph + wiki projections and strips the richer payload', async () => {
    server.use(
      http.get(`${BASE_URL}/api/campaigns/c-9/world-snapshot`, () =>
        HttpResponse.json({
          // The full payload the endpoint returns. The widened schema keeps
          // entities + relationships (graph) AND facts + entityHierarchy (wiki),
          // each narrowed to their display fields; the world summary, prose
          // kernels, stat blocks and per-row extras all strip away.
          world: { id: 'w-9', keyTensions: ['SECRET'] },
          proseKernels: [{ id: 'pk-1', body: 'ignored' }],
          statBlocks: [{ id: 'sb-1' }],
          entities: [
            { id: 'ent-1', entityType: 'npc', name: 'The Spymaster', accessLevel: 'known' },
            { id: 'ent-2', entityType: 'location', name: 'The Reach', accessLevel: 'known' },
          ],
          facts: [
            {
              id: 'f-1',
              entityId: 'ent-1',
              topic: 'Role',
              content: 'Runs the harbour spies.',
              accessLevel: 'known',
              source: 'prep',
            },
          ],
          entityHierarchy: [
            { id: 'h-1', parentEntityId: 'ent-2', childEntityId: 'ent-1' },
          ],
          relationships: [
            {
              id: 'r-1',
              sourceEntityId: 'ent-1',
              targetEntityId: 'ent-2',
              relationshipType: 'serves',
              description: 'ignored',
            },
          ],
        }),
      ),
    )
    await expect(getWorldSnapshot(testCtx, 'c-9')).resolves.toEqual({
      entities: [
        { id: 'ent-1', entityType: 'npc', name: 'The Spymaster' },
        { id: 'ent-2', entityType: 'location', name: 'The Reach' },
      ],
      facts: [
        { id: 'f-1', entityId: 'ent-1', topic: 'Role', content: 'Runs the harbour spies.' },
      ],
      entityHierarchy: [{ parentEntityId: 'ent-2', childEntityId: 'ent-1' }],
      relationships: [
        { sourceEntityId: 'ent-1', targetEntityId: 'ent-2', relationshipType: 'serves' },
      ],
    })
  })
})

describe('resumeGeneration', () => {
  it('resolves the 202 re-enqueue body', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns/c-9/resume`, () =>
        HttpResponse.json({ campaignId: 'c-9', action: 'world-gen-re-enqueued' }, { status: 202 }),
      ),
    )
    await expect(resumeGeneration(testCtx, 'c-9')).resolves.toEqual({
      campaignId: 'c-9',
      action: 'world-gen-re-enqueued',
    })
  })

  it('throws a typed HttpError on a terminal 409 code', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns/c-9/resume`, () =>
        HttpResponse.json({ code: 'world_gen_capped' }, { status: 409 }),
      ),
    )
    const error = await resumeGeneration(testCtx, 'c-9').catch((e: unknown) => e)
    expect(isHttpError(error)).toBe(true)
    expect((error as HttpError).status).toBe(409)
    expect((error as HttpError).code).toBe('world_gen_capped')
  })
})

describe('getStartingSituations', () => {
  it('parses the three hooks + chosenIndex and strips the extra keys', async () => {
    server.use(
      http.get(`${BASE_URL}/api/campaigns/c-9/starting-situations`, () =>
        HttpResponse.json({
          situations: [
            // `locationEntityId` (+ any richer keys) strip away under z.object().
            { index: 0, title: 'Low tide', locationName: 'Ashfen Reach', prose: 'A skiff came in wrong.', locationEntityId: 'ent-1' },
            { index: 1, title: 'A debt due', locationName: 'The Salt Ledger', prose: 'The house wants paying.', locationEntityId: 'ent-2' },
          ],
          chosenIndex: null,
        }),
      ),
    )
    await expect(getStartingSituations(testCtx, 'c-9')).resolves.toEqual({
      situations: [
        { index: 0, title: 'Low tide', locationName: 'Ashfen Reach', prose: 'A skiff came in wrong.' },
        { index: 1, title: 'A debt due', locationName: 'The Salt Ledger', prose: 'The house wants paying.' },
      ],
      chosenIndex: null,
    })
  })

  it('throws a typed HttpError 404 when the situations stage has not run', async () => {
    server.use(
      http.get(`${BASE_URL}/api/campaigns/c-9/starting-situations`, () =>
        HttpResponse.json({ code: 'world_not_ready' }, { status: 404 }),
      ),
    )
    const error = await getStartingSituations(testCtx, 'c-9').catch((e: unknown) => e)
    expect(isHttpError(error)).toBe(true)
    expect((error as HttpError).status).toBe(404)
    expect((error as HttpError).code).toBe('world_not_ready')
  })
})

describe('chooseStartingSituation', () => {
  it('posts the chosen index as the body and resolves the recorded index', async () => {
    let posted: unknown
    server.use(
      http.post(`${BASE_URL}/api/campaigns/c-9/starting-situation`, async ({ request }) => {
        posted = await request.json()
        return HttpResponse.json({ index: 2 })
      }),
    )
    await expect(chooseStartingSituation(testCtx, 'c-9', 2)).resolves.toEqual({ index: 2 })
    // Only `{ index }` rides the body — the campaignId travels in the path.
    expect(posted).toEqual({ index: 2 })
  })

  it('throws a typed HttpError 409 situation_locked once the pick is locked in', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns/c-9/starting-situation`, () =>
        HttpResponse.json({ code: 'situation_locked' }, { status: 409 }),
      ),
    )
    const error = await chooseStartingSituation(testCtx, 'c-9', 1).catch((e: unknown) => e)
    expect(isHttpError(error)).toBe(true)
    expect((error as HttpError).status).toBe(409)
    expect((error as HttpError).code).toBe('situation_locked')
  })
})
