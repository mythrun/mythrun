import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { getStageTimings } from './worldgen.ts'
import type { ApiContext } from './endpoint.ts'

const BASE_URL = 'http://api.test'
const server = setupServer()
beforeAll(() => { server.listen({ onUnhandledRequest: 'error' }) })
afterEach(() => { server.resetHandlers() })
afterAll(() => { server.close() })

const ctx: ApiContext = { baseUrl: BASE_URL, getAuthHeaders: () => Promise.resolve({}) }

describe('getStageTimings', () => {
  it('GETs /api/worldgen/stage-timings and returns the parsed timings array', async () => {
    let seenMethod: string | undefined
    server.use(
      http.get(`${BASE_URL}/api/worldgen/stage-timings`, ({ request }) => {
        seenMethod = request.method
        return HttpResponse.json([
          { stage: 'world_and_factions', avgMs: 42000 },
          { stage: 'locations_and_npcs', avgMs: 51000 },
        ])
      }),
    )
    const res = await getStageTimings(ctx)
    expect(seenMethod).toBe('GET')
    expect(res).toEqual([
      { stage: 'world_and_factions', avgMs: 42000 },
      { stage: 'locations_and_npcs', avgMs: 51000 },
    ])
  })

  it('returns [] on cold-start (no completed history)', async () => {
    server.use(http.get(`${BASE_URL}/api/worldgen/stage-timings`, () => HttpResponse.json([])))
    await expect(getStageTimings(ctx)).resolves.toEqual([])
  })
})
