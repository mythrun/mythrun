// REST contract for the BFF session endpoints (MYT-84). The SPA hands the
// backend only { code, codeVerifier } and receives only the access token + the
// pre-fill `name`; the refresh token never enters JS (httpOnly cookie).
import { z } from 'zod'

export const SessionRequestSchema = z.object({
  code: z.string().min(1),
  codeVerifier: z.string().min(1),
})
export type SessionRequest = z.infer<typeof SessionRequestSchema>

export const SessionResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  /** Parsed backend-side from the id_token `name` claim; null when absent. */
  name: z.string().nullable(),
})
export type SessionResponse = z.infer<typeof SessionResponseSchema>

// The SPA's on-load session probe. The token-bearing variant on a live session; the
// null variant when there is no (valid) session — returned with HTTP 200, NOT 401, so
// the SPA bootstrap doesn't log a console error on the sign-in screen (canonical BFF
// "anonymous -> 200" pattern). The token manager treats a null accessToken as "no
// session" → unauthenticated.
export const RefreshResponseSchema = z.union([
  z.object({
    accessToken: z.string(),
    expiresIn: z.number().int().positive(),
  }),
  z.object({
    accessToken: z.null(),
    expiresIn: z.null(),
  }),
])
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>
