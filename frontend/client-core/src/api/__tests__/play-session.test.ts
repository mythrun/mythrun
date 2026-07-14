import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { ApiContext } from '../endpoint.ts'
import { HttpError } from '../errors.ts'
import {
  startSession,
  getActiveSession,
  type InsufficientCreditsBody,
} from '../play-session.ts'

// The MYT-92 play-session lifecycle slice (start + active). Each function is a
// `defineEndpoint` (method + typed path + Zod response), so the response is
// contract-validated on arrival and a non-2xx surfaces a typed `HttpError`.
// These tests drive the real endpoint through MSW and assert against the LIVE
// contract recorded verbatim in tmp/sdd/myt92-verify-notes.md: start 200
// `{sessionId}`; the 409 codes (`session_already_active` post-DEV-1-fix is the
// truthful mid-session signal); the 402 `{code:'insufficient_credits',available,
// required:1}` purchase-moment seam; and GET /active `{session: null | {id,
// status,sessionNumber,startedAt,endedAt}}`.

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

describe('startSession', () => {
  it('POSTs /api/sessions/:campaignId/start and resolves {sessionId} on 200', async () => {
    let seenMethod: string | undefined
    server.use(
      http.post(`${BASE_URL}/api/sessions/cmp-1/start`, ({ request }) => {
        seenMethod = request.method
        return HttpResponse.json({ sessionId: '019eb414-546f-7bd6-98a8-6dd07e0c903b' })
      }),
    )

    await expect(startSession({ campaignId: 'cmp-1' }, testCtx)).resolves.toEqual({
      sessionId: '019eb414-546f-7bd6-98a8-6dd07e0c903b',
    })
    expect(seenMethod).toBe('POST')
  })

  it('encodes the campaignId into the path', async () => {
    let seenPath: string | undefined
    server.use(
      http.post(`${BASE_URL}/api/sessions/:campaignId/start`, ({ request }) => {
        seenPath = new URL(request.url).pathname
        return HttpResponse.json({ sessionId: '019eb414-546f-7bd6-98a8-6dd07e0c903b' })
      }),
    )

    await startSession({ campaignId: 'a/b' }, testCtx)
    expect(seenPath).toBe('/api/sessions/a%2Fb/start')
  })

  it('surfaces a 409 as HttpError.status===409 / .code==="session_already_active"', async () => {
    server.use(
      http.post(`${BASE_URL}/api/sessions/cmp-1/start`, () =>
        HttpResponse.json({ code: 'session_already_active' }, { status: 409 }),
      ),
    )

    await expect(startSession({ campaignId: 'cmp-1' }, testCtx)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof HttpError && e.status === 409 && e.code === 'session_already_active',
    )
  })

  it('surfaces a 402 as HttpError whose .body parses as InsufficientCreditsBody', async () => {
    server.use(
      http.post(`${BASE_URL}/api/sessions/cmp-1/start`, () =>
        HttpResponse.json(
          { code: 'insufficient_credits', available: 0, required: 1 },
          { status: 402 },
        ),
      ),
    )

    await expect(startSession({ campaignId: 'cmp-1' }, testCtx)).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof HttpError) || e.status !== 402) return false
      const body = e.body as InsufficientCreditsBody
      return body.code === 'insufficient_credits' && body.available === 0 && body.required === 1
    })
  })
})

describe('getActiveSession', () => {
  it('GETs /api/sessions/:campaignId/active and parses {session: null}', async () => {
    let seenMethod: string | undefined
    server.use(
      http.get(`${BASE_URL}/api/sessions/cmp-1/active`, ({ request }) => {
        seenMethod = request.method
        return HttpResponse.json({ session: null })
      }),
    )

    await expect(getActiveSession({ campaignId: 'cmp-1' }, testCtx)).resolves.toEqual({
      session: null,
    })
    expect(seenMethod).toBe('GET')
  })

  it('parses the populated active-session shape (startedAt string, endedAt null)', async () => {
    const session = {
      id: '019eb414-546f-7bd6-98a8-6dd07e0c903b',
      status: 'active',
      sessionNumber: 1,
      startedAt: '2026-06-11T00:28:11.759Z',
      endedAt: null,
    }
    server.use(
      http.get(`${BASE_URL}/api/sessions/cmp-1/active`, () => HttpResponse.json({ session })),
    )

    await expect(getActiveSession({ campaignId: 'cmp-1' }, testCtx)).resolves.toEqual({ session })
  })
})
