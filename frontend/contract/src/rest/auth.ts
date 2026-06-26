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

export const RefreshResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
})
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>
