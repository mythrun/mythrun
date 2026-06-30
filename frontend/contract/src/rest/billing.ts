// REST response contract for GET /api/billing/balance (MYT-42 billing route,
// consumed by the home hub's live credit display via the T13 `useBalance`
// hook). `BalanceResponseSchema` models the WIRE shape the balance handler
// already sends. Two design points:
//
//  1. snake_case, not the camelCase domain type. The /api/billing/* endpoints
//     are hand-shaped inline and emit snake_case keys (`world_gen`,
//     `active_subscription`, ...). The contract mirrors that EXACTLY so the
//     handler types against the real wire via `satisfies BalanceResponse`,
//     with no re-shaping of the response.
//
//  2. WIRE shape ≠ domain row. `current_period_end` is a `Date` on the
//     `UserSubscriptionRow`, but the handler calls `.toISOString()` before
//     send, so the wire value is an ISO string — typed `z.iso.datetime()`
//     here (a raw `Date` is REJECTED).
import { z } from 'zod'

export const ActiveSubscriptionSummarySchema = z.object({
  tier_lookup_key: z.string(),
  current_period_end: z.iso.datetime(),
  cancel_at_period_end: z.boolean(),
  status: z.string(),
})

export type ActiveSubscriptionSummary = z.infer<typeof ActiveSubscriptionSummarySchema>

export const BalanceResponseSchema = z.object({
  session: z.number(),
  world_gen: z.number(),
  active_subscription: ActiveSubscriptionSummarySchema.nullable(),
})

export type BalanceResponse = z.infer<typeof BalanceResponseSchema>
