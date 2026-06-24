import { useSuspenseQuery } from '@tanstack/react-query'
import { MyCampaignsResponseSchema, type MyCampaignsResponse } from '@mythrun/contract/rest'
import { defineEndpoint } from './endpoint.ts'
import { useApiContext } from './client-context.tsx'

// The campaign-scoped slice of the data layer. `getMyCampaigns` is the
// declarative endpoint (GET /api/campaigns/mine, response validated against the
// contract's `MyCampaignsResponseSchema`); `useMyCampaigns` is the thin
// TanStack-suspense hook the home hub renders against — same wiring shape as
// `useMe`: read the `ApiContext`, hand the endpoint to `useSuspenseQuery`.

export const getMyCampaigns = defineEndpoint<MyCampaignsResponse>({
  method: 'GET',
  path: () => '/api/campaigns/mine',
  response: MyCampaignsResponseSchema,
})

export function useMyCampaigns() {
  const ctx = useApiContext()
  return useSuspenseQuery({
    queryKey: ['campaigns', 'mine'],
    queryFn: () => getMyCampaigns(undefined, ctx),
  })
}
