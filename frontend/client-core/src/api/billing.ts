import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { BalanceResponseSchema, type BalanceResponse } from '@mythrun/contract/rest'
import { defineEndpoint } from './endpoint.ts'
import { useApiContext } from './client-context.tsx'

// The billing-scoped slice of the data layer. `getBalance` is the declarative
// endpoint (GET /api/billing/balance, response validated against the contract's
// `BalanceResponseSchema`); `useBalance` is the thin TanStack-suspense hook the
// home hub's header credit display renders against — same wiring shape as
// `useMyCampaigns` / `useMe`: read the `ApiContext`, hand the endpoint to
// `useSuspenseQuery`.

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
