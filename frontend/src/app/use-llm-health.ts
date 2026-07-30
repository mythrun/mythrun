import { useQuery } from '@tanstack/react-query'
import { getLlmHealth, useApiContext } from '@mythrun/client-core'

// The sitewide LLM-health poll behind the frame's NoticeStrip (outage-
// resilience design §4.2). Non-suspense on purpose: the strip is ambient
// chrome — it must never block a route or throw into an error boundary.
// `degraded` is a POSITIVE ASSERTION ONLY: true iff the LAST completed poll
// succeeded AND said "degraded". A failed poll (network blip, backend down)
// reads as ok — the hook relays the backend's Redis verdict, it does not
// detect outages itself — and `!isError` also drops a STALE degraded reading
// whose refetch errored, so a dead poll can't pin the banner up. The 60s
// interval is the per-navigation cadence; refetchOnWindowFocus is pinned ON
// (background tabs pause intervals — a returning tab must update immediately).

/** Whether the sitewide outage notice should show. Polls GET /api/llm-health. */
export function useLlmHealth(): { degraded: boolean } {
  const ctx = useApiContext()
  const { data, isError } = useQuery({
    queryKey: ['llm-health'],
    queryFn: () => getLlmHealth(undefined, ctx),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })
  return { degraded: !isError && data?.state === 'degraded' }
}
