import { z } from 'zod'
import { defineEndpoint, type ApiContext } from './endpoint.ts'

// POST /api/campaigns/:campaignId/starting-level — the owner sets the party's
// starting level (1–5), between the situation pick and character creation. The
// R5 backend seam for the level step; the owner UI calls this imperative
// function, never `fetch`. Bounds mirror the backend `StartingLevelBodySchema`
// (1..5), itself mirroring the migration-033 `campaigns.starting_level` DB CHECK
// — so an out-of-range value fails at the request boundary. The endpoint input
// also carries the path-only `campaignId`; the request schema strips it back out
// at serialization, so it travels in the path, not the body. The route replies
// 204 (the persisted column is the whole payload), so the response is `z.void()`.

const StartingLevelBodySchema = z.object({
  level: z.number().int().min(1).max(5),
})

// `Res` (void) is inferred from `response: z.void()` — writing it as an explicit
// generic argument trips `no-invalid-void-type`; `In` is inferred from the typed
// `path` param instead.
const setStartingLevelEndpoint = defineEndpoint({
  method: 'POST',
  path: (input: { campaignId: string; level: number }) =>
    `/api/campaigns/${encodeURIComponent(input.campaignId)}/starting-level`,
  request: StartingLevelBodySchema,
  response: z.void(),
})

/** Owner-only. Records the party's starting level (204). Throws `HttpError` 409
 *  (`world_not_complete`, `level_locked`) / 400 `bad_body`. */
export function setStartingLevel(
  ctx: ApiContext,
  campaignId: string,
  level: number,
): Promise<void> {
  return setStartingLevelEndpoint({ campaignId, level }, ctx)
}
