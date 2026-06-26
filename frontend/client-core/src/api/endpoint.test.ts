import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { z } from 'zod'
import { defineEndpoint, type ApiContext } from './endpoint.ts'
import {
  HttpError,
  isContractValidationError,
  isHttpError,
  isNetworkError,
} from './errors.ts'
import {
  configureTokenRefresh,
  resetTokenManager,
  getAccessToken,
} from '../auth/token-manager.ts'

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

describe('defineEndpoint — MYT-84 transport', () => {
  afterEach(() => {
    resetTokenManager()
  })

  it('threads credentials:"include" into the request init', async () => {
    let seenCredentials: RequestCredentials | undefined
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      seenCredentials = init?.credentials
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    })
    const ep = defineEndpoint({
      method: 'POST',
      path: () => '/x',
      response: z.object({ ok: z.boolean() }),
      credentials: 'include',
      skipAuthRetry: true,
    })
    await ep(undefined, ctx)
    expect(seenCredentials).toBe('include')
    fetchSpy.mockRestore()
  })

  it('attaches the server `code` + raw `body` to HttpError on a typed 4xx', async () => {
    server.use(
      http.post(`${BASE_URL}/reg`, () =>
        HttpResponse.json({ code: 'username_taken', suggestion: 'bob123' }, { status: 409 }),
      ),
    )
    const ep = defineEndpoint({
      method: 'POST',
      path: () => '/reg',
      response: z.object({ ok: z.boolean() }),
      skipAuthRetry: true,
    })
    await expect(ep(undefined, ctx)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof HttpError &&
        e.status === 409 &&
        e.code === 'username_taken' &&
        (e.body as { suggestion?: string }).suggestion === 'bob123',
    )
  })

  it('leaves code undefined for a non-string code, an absent code, a non-object body, and a non-JSON body', async () => {
    const cases: { path: string; res: () => Response }[] = [
      { path: '/e1', res: () => HttpResponse.json({ code: 123 }, { status: 400 }) },
      { path: '/e2', res: () => HttpResponse.json({ message: 'x' }, { status: 400 }) },
      { path: '/e3', res: () => HttpResponse.json(42, { status: 400 }) },
      { path: '/e4', res: () => new HttpResponse('not json', { status: 500 }) },
    ]
    for (const c of cases) {
      server.use(http.post(`${BASE_URL}${c.path}`, c.res))
      const ep = defineEndpoint({
        method: 'POST',
        path: () => c.path,
        response: z.object({ ok: z.boolean() }),
        skipAuthRetry: true,
      })
      await expect(ep(undefined, ctx)).rejects.toSatisfy(
        (e: unknown) => e instanceof HttpError && e.code === undefined,
      )
    }
  })

  it('on a 401 (non-skip): refreshes, rebuilds the init with a FRESH Bearer, retries once → resolves', async () => {
    const seenAuth: (string | null)[] = []
    let call = 0
    server.use(
      http.get(`${BASE_URL}/guarded`, ({ request }) => {
        seenAuth.push(request.headers.get('authorization'))
        call += 1
        return call === 1
          ? HttpResponse.json({ code: 'unauthenticated' }, { status: 401 })
          : HttpResponse.json({ ok: true })
      }),
    )
    configureTokenRefresh(() => Promise.resolve({ accessToken: 'fresh', expiresIn: 3600 }))
    const refreshCtx: ApiContext = {
      baseUrl: BASE_URL,
      getAuthHeaders: () => {
        const t = getAccessToken()
        return Promise.resolve(t === null ? {} : { authorization: `Bearer ${t}` })
      },
    }
    const ep = defineEndpoint({
      method: 'GET',
      path: () => '/guarded',
      response: z.object({ ok: z.boolean() }),
    })
    await expect(ep(undefined, refreshCtx)).resolves.toEqual({ ok: true })
    expect(seenAuth[0]).toBeNull()
    expect(seenAuth[1]).toBe('Bearer fresh')
  })

  it('on a 401 (non-skip) where refresh FAILS: does not retry, throws the 401', async () => {
    let calls = 0
    server.use(
      http.get(`${BASE_URL}/guarded2`, () => {
        calls += 1
        return HttpResponse.json({ code: 'unauthenticated' }, { status: 401 })
      }),
    )
    configureTokenRefresh(() => Promise.reject(new Error('no cookie')))
    const ep = defineEndpoint({
      method: 'GET',
      path: () => '/guarded2',
      response: z.object({ ok: z.boolean() }),
    })
    await expect(ep(undefined, ctx)).rejects.toSatisfy(
      (e: unknown) => e instanceof HttpError && e.status === 401,
    )
    expect(calls).toBe(1)
  })

  it('on a 401 from a skipAuthRetry endpoint: never refreshes, throws immediately', async () => {
    let refreshCalls = 0
    server.use(
      http.post(`${BASE_URL}/auth/refresh`, () =>
        HttpResponse.json({ code: 'no_refresh_token' }, { status: 401 }),
      ),
    )
    configureTokenRefresh(() => {
      refreshCalls += 1
      return Promise.resolve({ accessToken: 'x', expiresIn: 1 })
    })
    const ep = defineEndpoint({
      method: 'POST',
      path: () => '/auth/refresh',
      response: z.object({ ok: z.boolean() }),
      credentials: 'include',
      skipAuthRetry: true,
    })
    await expect(ep(undefined, ctx)).rejects.toSatisfy(
      (e: unknown) => e instanceof HttpError && e.status === 401,
    )
    expect(refreshCalls).toBe(0)
  })

  it('resolves void on a 204 (no body) response', async () => {
    server.use(http.post(`${BASE_URL}/logout`, () => new HttpResponse(null, { status: 204 })))
    const ep = defineEndpoint({
      method: 'POST',
      path: () => '/logout',
      response: z.void(),
      credentials: 'include',
      skipAuthRetry: true,
    })
    await expect(ep(undefined, ctx)).resolves.toBeUndefined()
  })
})
