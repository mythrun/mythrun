import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { z } from 'zod'
import { defineEndpoint, type ApiContext } from './endpoint.ts'
import {
  isContractValidationError,
  isHttpError,
  isNetworkError,
} from './errors.ts'

// `defineEndpoint` is the ONLY way the app makes a backend call: it binds a
// method + typed path builder + Zod request/response schemas into a single
// caller `(input, ctx) => Promise<Res>`. These tests exercise every branch of
// the returned function — the request-schema present/absent split, the 2xx vs
// non-2xx split, the parse-success vs parse-fail split, and the fetch
// resolve-vs-reject split — so the failure surface (HttpError /
// ContractValidationError / NetworkError) is fully covered, and assert the
// auth headers from `ctx.getAuthHeaders()` actually reach the wire.

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

const ctx: ApiContext = {
  baseUrl: BASE_URL,
  getAuthHeaders: () => Promise.resolve({ authorization: 'Bearer test-token' }),
}

describe('defineEndpoint', () => {
  it('resolves the parsed body of a 2xx GET response', async () => {
    server.use(
      http.get(`${BASE_URL}/ok`, () => HttpResponse.json({ ok: true })),
    )
    const getOk = defineEndpoint({
      method: 'GET',
      path: () => '/ok',
      response: z.object({ ok: z.boolean() }),
    })

    await expect(getOk(undefined, ctx)).resolves.toEqual({ ok: true })
  })

  it('builds the URL from the typed path builder using the input', async () => {
    server.use(
      http.get(`${BASE_URL}/items/42`, () => HttpResponse.json({ id: '42' })),
    )
    const getItem = defineEndpoint<{ id: string }, { id: string }>({
      method: 'GET',
      path: (input) => `/items/${input.id}`,
      response: z.object({ id: z.string() }),
    })

    await expect(getItem({ id: '42' }, ctx)).resolves.toEqual({ id: '42' })
  })

  it('sends the headers returned by ctx.getAuthHeaders()', async () => {
    let seenAuth: string | null = null
    server.use(
      http.get(`${BASE_URL}/whoami`, ({ request }) => {
        seenAuth = request.headers.get('authorization')
        return HttpResponse.json({ ok: true })
      }),
    )
    const whoami = defineEndpoint({
      method: 'GET',
      path: () => '/whoami',
      response: z.object({ ok: z.boolean() }),
    })

    await whoami(undefined, ctx)
    expect(seenAuth).toBe('Bearer test-token')
  })

  it('throws HttpError with .status on a non-2xx response', async () => {
    server.use(
      http.get(`${BASE_URL}/forbidden`, () =>
        HttpResponse.json({ message: 'nope' }, { status: 403 }),
      ),
    )
    const getForbidden = defineEndpoint({
      method: 'GET',
      path: () => '/forbidden',
      response: z.object({ ok: z.boolean() }),
    })

    await expect(getForbidden(undefined, ctx)).rejects.toSatisfy(
      (e: unknown) => isHttpError(e) && e.status === 403,
    )
  })

  it('throws ContractValidationError when the response fails the schema', async () => {
    server.use(
      http.get(`${BASE_URL}/bad-shape`, () =>
        HttpResponse.json({ ok: 'not-a-boolean' }),
      ),
    )
    const getBadShape = defineEndpoint({
      method: 'GET',
      path: () => '/bad-shape',
      response: z.object({ ok: z.boolean() }),
    })

    await expect(getBadShape(undefined, ctx)).rejects.toSatisfy(
      isContractValidationError,
    )
  })

  it('throws NetworkError when fetch rejects (transport failure)', async () => {
    server.use(
      http.get(`${BASE_URL}/down`, () => HttpResponse.error()),
    )
    const getDown = defineEndpoint({
      method: 'GET',
      path: () => '/down',
      response: z.object({ ok: z.boolean() }),
    })

    await expect(getDown(undefined, ctx)).rejects.toSatisfy(isNetworkError)
  })

  it('falls back to a generic NetworkError message when fetch rejects with a non-Error', async () => {
    // The `cause instanceof Error` guard's false arm: a non-Error rejection
    // value (rare, but legal — a transport could reject with a string) must
    // still surface as a NetworkError carrying the fallback message.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce('socket hang up')
    const getDown = defineEndpoint({
      method: 'GET',
      path: () => '/down',
      response: z.object({ ok: z.boolean() }),
    })

    await expect(getDown(undefined, ctx)).rejects.toSatisfy(
      (e: unknown) => isNetworkError(e) && e.message === 'request failed',
    )
    fetchSpy.mockRestore()
  })

  it('falls back to a synthetic HttpError message when statusText is empty', async () => {
    // The `res.statusText || ...` fallback's right arm: HTTP/2 responses carry
    // no reason phrase (statusText is ''), so the message is synthesised from
    // the status code. Drive it with a hand-built empty-statusText Response.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 503, statusText: '' }))
    const getDown = defineEndpoint({
      method: 'GET',
      path: () => '/down',
      response: z.object({ ok: z.boolean() }),
    })

    await expect(getDown(undefined, ctx)).rejects.toSatisfy(
      (e: unknown) => isHttpError(e) && e.status === 503 && e.message === 'HTTP 503',
    )
    fetchSpy.mockRestore()
  })

  it('validates + sends the body when a request schema is present', async () => {
    let seenBody: unknown = null
    let seenContentType: string | null = null
    server.use(
      http.post(`${BASE_URL}/items`, async ({ request }) => {
        seenContentType = request.headers.get('content-type')
        seenBody = await request.json()
        return HttpResponse.json({ id: 'created' })
      }),
    )
    const createItem = defineEndpoint<{ id: string }, { name: string }>({
      method: 'POST',
      path: () => '/items',
      request: z.object({ name: z.string() }),
      response: z.object({ id: z.string() }),
    })

    await expect(createItem({ name: 'sword' }, ctx)).resolves.toEqual({
      id: 'created',
    })
    expect(seenBody).toEqual({ name: 'sword' })
    expect(seenContentType).toContain('application/json')
  })

  it('throws ContractValidationError BEFORE fetching when the body fails the request schema', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const createItem = defineEndpoint<{ id: string }, { name: string }>({
      method: 'POST',
      path: () => '/items',
      request: z.object({ name: z.string() }),
      response: z.object({ id: z.string() }),
    })

    await expect(
      // @ts-expect-error — deliberately invalid body to exercise the guard
      createItem({ name: 123 }, ctx),
    ).rejects.toSatisfy(isContractValidationError)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
