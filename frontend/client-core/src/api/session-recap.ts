import { useSuspenseQuery } from '@tanstack/react-query'
import { SessionRecapResponseSchema, type SessionRecapResponse } from '@mythrun/contract/rest'
import { defineEndpoint } from './endpoint.ts'
import { useApiContext } from './client-context.tsx'

// The player-facing session-recap read (myth-lhp99) — GET the campaign's
// most-recent ended session's SECRET-FREE close-out (summary + emerging
// threads). Distinct from the play-session lifecycle endpoints (start/active):
// this is the post-play landing read. The post-session analysis is ASYNC
// (enqueued at finalize, written by an Opus job), so a just-ended session
// answers `status:'pending'` (facts only); the hook POLLS every RECAP_POLL_MS
// until the write flips it to `ready`, then stops. Enforced ignorance holds
// server-side: the endpoint never reads the secret-aware handoff column.

/** Poll cadence while the async analysis is still being written. */
const RECAP_POLL_MS = 3_000

export const getSessionRecap = defineEndpoint<SessionRecapResponse, { campaignId: string }>({
  method: 'GET',
  path: ({ campaignId }) => `/api/sessions/${encodeURIComponent(campaignId)}/recap`,
  response: SessionRecapResponseSchema,
})

export function useSessionRecap(campaignId: string) {
  const ctx = useApiContext()
  return useSuspenseQuery({
    queryKey: ['session-recap', campaignId],
    queryFn: () => getSessionRecap({ campaignId }, ctx),
    // Background-poll ONLY while the analysis is still pending; a written recap
    // is durable, so stop refetching once it lands.
    refetchInterval: (query) =>
      query.state.data?.recap?.status === 'pending' ? RECAP_POLL_MS : false,
  })
}
