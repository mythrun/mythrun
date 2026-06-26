import { z } from 'zod'
import {
  SessionRequestSchema,
  SessionResponseSchema,
  RefreshResponseSchema,
  type SessionRequest,
  type SessionResponse,
  type RefreshResponse,
} from '@mythrun/contract/rest'
import { defineEndpoint } from './endpoint.ts'

// The BFF session endpoints. All three send `credentials:'include'` (the
// cross-origin half of the httpOnly-refresh-cookie model) and `skipAuthRetry`
// (they are the refresh path — a 401 here must NOT recurse into another refresh).

export const createSession = defineEndpoint<SessionResponse, SessionRequest>({
  method: 'POST',
  path: () => '/api/auth/session',
  request: SessionRequestSchema,
  response: SessionResponseSchema,
  credentials: 'include',
  skipAuthRetry: true,
})

export const refreshSession = defineEndpoint<RefreshResponse>({
  method: 'POST',
  path: () => '/api/auth/refresh',
  response: RefreshResponseSchema,
  credentials: 'include',
  skipAuthRetry: true,
})

export const logout = defineEndpoint<void>({
  method: 'POST',
  path: () => '/api/auth/logout',
  response: z.void(),
  credentials: 'include',
  skipAuthRetry: true,
})
