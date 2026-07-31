import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { getLlmHealth } from './llm-health.ts'
import type { ApiContext } from './endpoint.ts'

const BASE_URL = 'http://api.test'
const server = setupServer()
beforeAll(() => { server.listen({ onUnhandledRequest: 'error' }) })
afterEach(() => { server.resetHandlers() })
afterAll(() => { server.close() })

const ctx: ApiContext = { baseUrl: BASE_URL, getAuthHeaders: () => Promise.resolve({}) }

describe('getLlmHealth', () => {
  it('GETs /api/llm-health and returns the parsed ok reading', async () => {
    let seenMethod: string | undefined
    server.use(
      http.get(`${BASE_URL}/api/llm-health`, ({ request }) => {
        seenMethod = request.method
        return HttpResponse.json({ state: 'ok', since: null })
      }),
    )
    const res = await getLlmHealth(undefined, ctx)
    expect(seenMethod).toBe('GET')
    expect(res).toEqual({ state: 'ok', since: null })
  })

  it('parses the degraded reading (since in epoch ms)', async () => {
    server.use(
      http.get(`${BASE_URL}/api/llm-health`, () =>
        HttpResponse.json({ state: 'degraded', since: 1_722_300_000_000 }),
      ),
    )
    const res = await getLlmHealth(undefined, ctx)
    expect(res).toEqual({ state: 'degraded', since: 1_722_300_000_000 })
  })

  it('rejects a shape-drifted payload (the schema pin the NoticeStrip depends on)', async () => {
    // The strip shows only on a positive "degraded" parse; a drifted backend
    // payload must FAIL the parse loudly here rather than silently reading
    // as ok in the hook's error-degrade path.
    server.use(
      http.get(`${BASE_URL}/api/llm-health`, () =>
        HttpResponse.json({ state: 'down', since: null }),
      ),
    )
    await expect(getLlmHealth(undefined, ctx)).rejects.toThrow()
  })
})
