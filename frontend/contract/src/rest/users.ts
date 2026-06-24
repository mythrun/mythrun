// REST response contract for the user-scoped home-hub-smoke endpoints.
//
// `MeResponseSchema` models the WIRE shape of GET /api/users/me. Two design
// points that the schema encodes deliberately:
//
//  1. WIRE shape ≠ domain type. The backend `User.createdAt` is a `Date`, but
//     it serializes to an ISO-8601 string over JSON. The schema therefore types
//     `createdAt` as `z.iso.datetime()` (a string validator), NEVER `z.date()` —
//     a raw `Date` value is REJECTED (rest.test.ts asserts this), which is what
//     proves we're modeling the wire, not the in-memory row.
//
//  2. Public projection. `/me` deliberately OMITS `cognitoSub`,
//     `stripeCustomerId`, `suspendedAt`, and `updatedAt` from the full user row.
//     The backend handler builds this narrowed shape explicitly (typed against
//     `MeResponse`) so the omitted fields can never leak over the wire.
import { z } from 'zod'

export const MeResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    username: z.string(),
    displayName: z.string(),
    freeTrialUsed: z.boolean(),
    createdAt: z.iso.datetime(),
  }),
})

export type MeResponse = z.infer<typeof MeResponseSchema>
