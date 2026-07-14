import { z } from 'zod'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import {
  BalanceResponseSchema,
  type BalanceResponse,
  SkuListingResponseSchema,
  type SkuListingResponse,
  BillingHistoryResponseSchema,
  type BillingHistoryResponse,
  CheckoutResponseSchema,
  type CheckoutResponse,
  PortalResponseSchema,
  type PortalResponse,
  UpgradeTierResponseSchema,
  type UpgradeTierResponse,
  LookupKeySchema,
} from '@mythrun/contract/rest'
import { defineEndpoint, type ApiContext } from './endpoint.ts'
import { useApiContext } from './client-context.tsx'

// The billing-scoped slice of the data layer. `getBalance` is the declarative
// endpoint (GET /api/billing/balance, response validated against the contract's
// `BalanceResponseSchema`); `useBalance` is the thin TanStack-suspense hook the
// home hub's header credit display renders against — same wiring shape as
// `useMyCampaigns` / `useMe`: read the `ApiContext`, hand the endpoint to
// `useSuspenseQuery`.
//
// MYT-95 adds the rest of the billing surface for the Sessions & Billing screen:
//   - `getSkus`/`useSkus`       — the public pricing catalogue (GET suspense read)
//   - `getHistory`/`useHistory` — the unified purchase-history feed (GET suspense
//                                 read; `?cursor=` when paging)
//   - `createCheckout`          — POST → the Stripe Checkout redirect (grants NOTHING)
//   - `openPortal`              — POST → the Customer Portal redirect
//   - `upgradeTier`             — POST → the prorated monotonic tier upgrade
// The three mutations follow the imperative `(ctx, body)` shape (like
// `createCampaign`), never the suspense-hook shape. On a non-2xx, `defineEndpoint`
// throws an `HttpError` carrying `.status`/`.code`/`.body`; this layer NEVER
// swallows or remaps it — the caller branches on `.code` (e.g. `upgradeTier`'s
// 409 `upgrade_already_pending`, which the settings screen renders as the calm
// pending arm).

export const getBalance = defineEndpoint<BalanceResponse>({
  method: 'GET',
  path: () => '/api/billing/balance',
  response: BalanceResponseSchema,
})

export function useBalance() {
  const ctx = useApiContext()
  return useSuspenseQuery({
    queryKey: ['billing', 'balance'],
    queryFn: () => getBalance(undefined, ctx),
  })
}

export const getSkus = defineEndpoint<SkuListingResponse>({
  method: 'GET',
  path: () => '/api/billing/skus',
  response: SkuListingResponseSchema,
})

export function useSkus() {
  const ctx = useApiContext()
  return useSuspenseQuery({
    queryKey: ['billing', 'skus'],
    queryFn: () => getSkus(undefined, ctx),
  })
}

export const getHistory = defineEndpoint<BillingHistoryResponse, { cursor?: string }>({
  method: 'GET',
  path: (input) =>
    input.cursor !== undefined
      ? `/api/billing/history?cursor=${encodeURIComponent(input.cursor)}`
      : '/api/billing/history',
  response: BillingHistoryResponseSchema,
})

export function useHistory() {
  const ctx = useApiContext()
  return useSuspenseQuery({
    queryKey: ['billing', 'history'],
    queryFn: () => getHistory({}, ctx),
  })
}

const CheckoutItemSchema = z.object({
  lookup_key: LookupKeySchema,
  quantity: z.number().int().min(1).max(100),
})
const CheckoutBodySchema = z.object({
  items: z.array(CheckoutItemSchema).min(1).max(100),
  success_url: z.string(),
  cancel_url: z.string(),
})
export type CheckoutBody = z.infer<typeof CheckoutBodySchema>
const checkoutEndpoint = defineEndpoint<CheckoutResponse, CheckoutBody>({
  method: 'POST',
  path: () => '/api/billing/checkout',
  request: CheckoutBodySchema,
  response: CheckoutResponseSchema,
})
/** Create a Stripe Checkout Session for à-la-carte packs OR a subscription tier.
 *  Returns the redirect URL — the web caller navigates to it (grants nothing;
 *  the credit grant rides the `checkout.session.completed` webhook). */
export function createCheckout(ctx: ApiContext, body: CheckoutBody): Promise<CheckoutResponse> {
  return checkoutEndpoint(body, ctx)
}

const PortalBodySchema = z.object({ return_url: z.string() })
export type PortalBody = z.infer<typeof PortalBodySchema>
const portalEndpoint = defineEndpoint<PortalResponse, PortalBody>({
  method: 'POST',
  path: () => '/api/billing/portal',
  request: PortalBodySchema,
  response: PortalResponseSchema,
})
/** Open the Customer Portal (downgrades / cancel / payment methods). */
export function openPortal(ctx: ApiContext, body: PortalBody): Promise<PortalResponse> {
  return portalEndpoint(body, ctx)
}

const UpgradeTierBodySchema = z.object({ target_tier_lookup_key: LookupKeySchema })
export type UpgradeTierBody = z.infer<typeof UpgradeTierBodySchema>
const upgradeTierEndpoint = defineEndpoint<UpgradeTierResponse, UpgradeTierBody>({
  method: 'POST',
  path: () => '/api/billing/upgrade-tier',
  request: UpgradeTierBodySchema,
  response: UpgradeTierResponseSchema,
})
/** Monotonic tier upgrade (prorated). Throws `HttpError` 409 `upgrade_already_pending`
 *  when a prior upgrade is mid-flight — the caller renders the calm pending arm. */
export function upgradeTier(ctx: ApiContext, body: UpgradeTierBody): Promise<UpgradeTierResponse> {
  return upgradeTierEndpoint(body, ctx)
}

/** Fail-OPEN low-credit signal for decorative surfaces (the hub card nudge,
 *  MYT-95 T13). NON-suspense: while loading, on error, or with no data it
 *  reports `false` — a billing blip must never degrade the hub (the shipped
 *  resilience contract isolates billing failures to the credits slot). Shares
 *  the ['billing','balance'] cache the header warms. */
export function useLowSessionCredits(threshold = 1): boolean {
  const ctx = useApiContext()
  const { data } = useQuery({
    queryKey: ['billing', 'balance'],
    queryFn: () => getBalance(undefined, ctx),
    retry: false,
    staleTime: 30_000,
  })
  return data !== undefined && data.session <= threshold
}
