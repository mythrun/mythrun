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

// --- MYT-95: response schemas for the billing screens ---

// Mirrors backend/src/billing/lookup-keys.ts LookupKey (the closed SKU enum).
export const LookupKeySchema = z.enum([
  'tier_wayfarer',
  'tier_sojourner',
  'tier_mythwright',
  'sku_session',
  'sku_world',
])
export type LookupKey = z.infer<typeof LookupKeySchema>

// GET /api/billing/skus — the public pricing catalogue. Mirrors the backend
// SkuPublicListing (billing/sku-cache.ts) EXACTLY — note: NO stripe_price_id.
export const SkuPriceSchema = z.object({
  unit_amount_cents: z.number().int(),
  currency: z.string(),
})
export const SkuListingSchema = z.object({
  lookup_key: LookupKeySchema,
  displayName: z.string(),
  type: z.enum(['recurring', 'one_time']),
  sessionsGranted: z.number().int(),
  worldsGranted: z.number().int(),
  price: SkuPriceSchema,
})
export type SkuListing = z.infer<typeof SkuListingSchema>
export const SkuListingResponseSchema = z.array(SkuListingSchema)
export type SkuListingResponse = z.infer<typeof SkuListingResponseSchema>

// GET /api/billing/history — the unified billing audit feed. `lookup_key` is
// NULL for à-la-carte pack rows (they cannot name credit counts); populated for
// subscription invoice rows. Cursor is opaque base64url; null = last page.
export const BillingHistoryEventSchema = z.object({
  id: z.string(),
  kind: z.enum(['purchase', 'invoice', 'refund']),
  occurred_at: z.iso.datetime(),
  amount_cents: z.number().int(),
  currency: z.string(),
  lookup_key: z.string().nullable(),
  status: z.enum(['completed', 'refunded']),
  source_id_stripe: z.string(),
})
export type BillingHistoryEvent = z.infer<typeof BillingHistoryEventSchema>
export const BillingHistoryResponseSchema = z.object({
  events: z.array(BillingHistoryEventSchema),
  nextCursor: z.string().nullable(),
})
export type BillingHistoryResponse = z.infer<typeof BillingHistoryResponseSchema>

// POST /api/billing/checkout — returns the Stripe redirect (grants NOTHING).
export const CheckoutResponseSchema = z.object({
  checkout_session_id: z.string(),
  url: z.string(),
})
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>

// POST /api/billing/portal — the Customer Portal redirect.
export const PortalResponseSchema = z.object({ url: z.string() })
export type PortalResponse = z.infer<typeof PortalResponseSchema>

// POST /api/billing/upgrade-tier — 200 shape. The 409 upgrade_already_pending
// body is an ERROR payload (surfaced via HttpError.code), not a success shape.
export const UpgradeTierResponseSchema = z.object({ invoice_id: z.string().nullable() })
export type UpgradeTierResponse = z.infer<typeof UpgradeTierResponseSchema>
