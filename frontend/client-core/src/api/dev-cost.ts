import { z } from 'zod'
import { defineEndpoint, type ApiContext } from './endpoint.ts'

// The dev-tooling slice of the data layer (R5: all backend access goes through
// client-core). `getDevApiCost` reads the dev/staging-only GET /api/dev/api-cost
// endpoint — the process-level cumulative approximate Anthropic spend the
// floating DevCostTicker widget polls.
//
// The response schema is declared inline (not sourced from @mythrun/contract)
// on purpose: this is an internal dev tool, and a trivial `{ totalUsd }` shape
// doesn't warrant contract-package ripple.
//
// In production the endpoint is not registered and returns 404; `defineEndpoint`
// throws an `HttpError` with `status === 404`, which the widget catches to hide
// itself. (A non-404 failure — e.g. the dev backend being down — surfaces as a
// different error the widget renders muted rather than crashing on.)

const DevApiCostResponseSchema = z.object({ totalUsd: z.number() })
export type DevApiCostResponse = z.infer<typeof DevApiCostResponseSchema>

const getDevApiCostEndpoint = defineEndpoint<DevApiCostResponse>({
  method: 'GET',
  path: () => '/api/dev/api-cost',
  response: DevApiCostResponseSchema,
})

export function getDevApiCost(ctx: ApiContext): Promise<DevApiCostResponse> {
  return getDevApiCostEndpoint(undefined, ctx)
}
