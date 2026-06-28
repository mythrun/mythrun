import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { mintWsTicket } from './ws-ticket.ts'
import type { ApiContext } from '../api/endpoint.ts'
import {
  configureTokenRefresh,
  resetTokenManager,
  getAccessToken,
} from '../auth/token-manager.ts'

// `mintWsTicket` is the declarative endpoint the WS session client calls before
// every (re)connect: POST /api/sessions/:id/ws-ticket → a short-lived ticket
// string that gates the /ws/* CloudFront behavior. It is `defineEndpoint`
// compiled, so it inherits the 401 single-flight refresh-retry for free — these
// tests prove the happy path AND that a 401 refreshes + retries exactly once.

const BASE_URL = 'http://api.test'
const server = setupServer()
beforeAll(() => { server.listen({ onUnhandledRequest: 'error' }) })
afterEach(() => {
  server.resetHandlers()
  resetTokenManager()
})
afterAll(() => { server.close() })

const ctx: ApiContext = { baseUrl: BASE_URL, getAuthHeaders: () => Promise.resolve({}) }

describe('mintWsTicket', () => {
  it('POSTs /api/sessions/:id/ws-ticket and resolves the ticket', async () => {
    server.use(
      http.post(`${BASE_URL}/api/sessions/s1/ws-ticket`, () =>
        HttpResponse.json({ ticket: 'n' }),
      ),
    )
    await expect(mintWsTicket('s1', ctx)).resolves.toEqual({ ticket: 'n' })
  })

  it('on a 401: refreshes, retries once with the FRESH Bearer → resolves the ticket', async () => {
    const seenAuth: (string | null)[] = []
    let call = 0
    server.use(
      http.post(`${BASE_URL}/api/sessions/s1/ws-ticket`, ({ request }) => {
        seenAuth.push(request.headers.get('authorization'))
        call += 1
        return call === 1
          ? HttpResponse.json({ code: 'unauthenticated' }, { status: 401 })
          : HttpResponse.json({ ticket: 'n' })
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
    await expect(mintWsTicket('s1', refreshCtx)).resolves.toEqual({ ticket: 'n' })
    expect(call).toBe(2)
    expect(seenAuth[0]).toBeNull()
    expect(seenAuth[1]).toBe('Bearer fresh')
  })
})
