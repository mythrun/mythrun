// REST contract for the user-scoped endpoints.
//
//  1. WIRE shape ≠ domain type. The backend `User.createdAt` is a `Date`, but it
//     serializes to an ISO-8601 string over JSON, so `createdAt` is
//     `z.iso.datetime()` (a string validator), NEVER `z.date()`.
//  2. Public projection. `PublicUserSchema` carries only the wire-safe fields
//     (`cognitoSub/stripeCustomerId/suspendedAt/updatedAt` are stripped by Zod's
//     default object parse). `/me` returns this shape; `register` also returns this
//     shape (Task 6 narrows the backend), and the client validates against this
//     projection so a leaked field is stripped client-side too.
import { z } from 'zod'

/** 3–20 chars; alphanumeric + underscore; first/last char alphanumeric; no
 *  length-2. Canonical mirror of the backend regex in routes/users.ts. */
export const USERNAME_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9_]{1,18}[a-zA-Z0-9])?$/

const PublicUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  freeTrialUsed: z.boolean(),
  createdAt: z.iso.datetime(),
})

export const MeResponseSchema = z.object({ user: PublicUserSchema })
export type MeResponse = z.infer<typeof MeResponseSchema>

/** Structure-only mirror of the backend register body (length + regex; profanity
 *  is a server-only gate). The frontend derives a valid-by-construction handle
 *  (§6), so a local rejection here is rare — the contract still encodes it. */
export const RegisterRequestSchema = z.object({
  username: z.string().min(3).max(20).regex(USERNAME_REGEX),
  displayName: z.string().min(1).max(40),
})
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>

export const RegisterResponseSchema = z.object({
  user: PublicUserSchema,
  created: z.boolean(),
})
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>

export const CheckUsernameResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
})
export type CheckUsernameResponse = z.infer<typeof CheckUsernameResponseSchema>
