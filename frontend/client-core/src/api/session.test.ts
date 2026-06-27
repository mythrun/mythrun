import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { createSession, refreshSession, logout } from './session.ts'
import type { ApiContext } from './endpoint.ts'

const BASE_URL = 'http://api.test'
const server = setupServer()
beforeAll(() => { server.listen({ onUnhandledRequest: 'error' }) })
afterEach(() => { server.resetHandlers() })
afterAll(() => { server.close() })

const ctx: ApiContext = { baseUrl: BASE_URL, getAuthHeaders: () => Promise.resolve({}) }

describe('createSession', () => {
  it('POSTs { code, codeVerifier } with credentials:include and returns the session', async () => {
    let seenCredentials: string | undefined
    let seenBody: unknown
    server.use(
      http.post(`${BASE_URL}/api/auth/session`, async ({ request }) => {
        seenCredentials = request.credentials
        seenBody = await request.json()
        return HttpResponse.json({ accessToken: 'a', expiresIn: 3600, name: 'Ada' })
      }),
    )
    const res = await createSession({ code: 'c', codeVerifier: 'v' }, ctx)
    expect(res).toEqual({ accessToken: 'a', expiresIn: 3600, name: 'Ada' })
    expect(seenBody).toEqual({ code: 'c', codeVerifier: 'v' })
    expect(seenCredentials).toBe('include')
  })
})

describe('refreshSession', () => {
  it('POSTs /api/auth/refresh (no body) and returns the rotated access token', async () => {
    server.use(
      http.post(`${BASE_URL}/api/auth/refresh`, () =>
        HttpResponse.json({ accessToken: 'fresh', expiresIn: 3600 }),
      ),
    )
    await expect(refreshSession(undefined, ctx)).resolves.toEqual({ accessToken: 'fresh', expiresIn: 3600 })
  })
})

describe('logout', () => {
  it('POSTs /api/auth/logout and resolves void on 204', async () => {
    server.use(http.post(`${BASE_URL}/api/auth/logout`, () => new HttpResponse(null, { status: 204 })))
    await expect(logout(undefined, ctx)).resolves.toBeUndefined()
  })
})
