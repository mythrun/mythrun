import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { getDevApiCost } from './dev-cost.ts'
import type { ApiContext } from './endpoint.ts'

const BASE_URL = 'http://api.test'
const server = setupServer()
beforeAll(() => { server.listen({ onUnhandledRequest: 'error' }) })
afterEach(() => { server.resetHandlers() })
afterAll(() => { server.close() })

const ctx: ApiContext = { baseUrl: BASE_URL, getAuthHeaders: () => Promise.resolve({}) }

describe('getDevApiCost', () => {
  it('GETs /api/dev/api-cost and returns the parsed { totalUsd }', async () => {
    let seenMethod: string | undefined
    server.use(
      http.get(`${BASE_URL}/api/dev/api-cost`, ({ request }) => {
        seenMethod = request.method
        return HttpResponse.json({ totalUsd: 1.2345 })
      }),
    )
    const res = await getDevApiCost(ctx)
    expect(seenMethod).toBe('GET')
    expect(res).toEqual({ totalUsd: 1.2345 })
  })
})
