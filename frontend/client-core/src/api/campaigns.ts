import { useSuspenseQuery } from '@tanstack/react-query'
import { z } from 'zod'
import {
  MyCampaignsResponseSchema,
  type MyCampaignsResponse,
  WorldSnapshotSchema,
} from '@mythrun/contract/rest'
import { defineEndpoint, type ApiContext } from './endpoint.ts'
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

// -----------------------------------------------------------------------------
// World-snapshot fetch + resume (MYT-89 Phase C, C5 / Phase D, D3).
//
// Two imperative endpoints the world-gen flow calls OUTSIDE react-query: the
// point-in-time world snapshot (seeds the graph on a mid-generation mount; feeds
// the post-gen wiki reveal) and the resume trigger (the failure-recovery branch).
//
// ONE endpoint, TWO consumers. The schema is the contract's known-tier
// `WorldSnapshotSchema` (entities + facts + entityHierarchy — the D1 wiki view
// model) WIDENED with the graph's `relationships` edges. `snapshotToSeed` (the
// graph, C5) reads entities + relationships; `toWikiViewModel` (the wiki, D3)
// reads entities + facts + entityHierarchy. The union type is a SUPERSET of the
// contract `WorldSnapshot`, so it drops straight into `toWikiViewModel`. Zod's
// `object()` strips the richer payload (world summary, prose kernels, stat
// blocks) so extra columns fall away without a schema churn. The backend view
// always emits facts + entityHierarchy as arrays (empty pre-facts), and the
// endpoint 409s until stage 4 commits, so both the mid-gen seed fetch and the
// post-gen wiki fetch validate against this shape.
// -----------------------------------------------------------------------------

/** The graph edges — the one collection the contract `WorldSnapshot` omits (it is
 *  the wiki's projection); the graph seed folds these into rendered relationships. */
const WorldGenRelationshipSchema = z.object({
  sourceEntityId: z.string(),
  targetEntityId: z.string(),
  relationshipType: z.string(),
})

/** GET /api/campaigns/:campaignId/world-snapshot as the frontend consumes it —
 *  the contract known-tier projection widened with the graph's `relationships`. */
const WorldGenSnapshotSchema = WorldSnapshotSchema.extend({
  relationships: z.array(WorldGenRelationshipSchema),
})

export type WorldGenSnapshot = z.infer<typeof WorldGenSnapshotSchema>

const getWorldSnapshotEndpoint = defineEndpoint<WorldGenSnapshot, { campaignId: string }>({
  method: 'GET',
  path: (input) => `/api/campaigns/${encodeURIComponent(input.campaignId)}/world-snapshot`,
  response: WorldGenSnapshotSchema,
})

/** Any campaign member (known-tier filtered server-side; was owner-only until
 *  myth-0xwos). 409 `snapshot_not_ready` until the reveal-boundary stage
 *  (world_introduction) commits → the caller (`useWorldGenStream`) gates the
 *  fetch on `phase >= world_snapshot_ready` and swallows a race-window 409. */
export function getWorldSnapshot(ctx: ApiContext, campaignId: string): Promise<WorldGenSnapshot> {
  return getWorldSnapshotEndpoint({ campaignId }, ctx)
}

/** The POST /api/campaigns/:campaignId/resume 202 body. A terminal code (409
 *  `world_gen_capped` / `phase_not_yet_implementable`) throws `HttpError`
 *  instead — the hook branches on resolve-vs-throw. */
const ResumeResultSchema = z.object({
  campaignId: z.string(),
  action: z.string(),
})

export type ResumeResult = z.infer<typeof ResumeResultSchema>

const resumeGenerationEndpoint = defineEndpoint<ResumeResult, { campaignId: string }>({
  method: 'POST',
  path: (input) => `/api/campaigns/${encodeURIComponent(input.campaignId)}/resume`,
  response: ResumeResultSchema,
})

/** Owner-only. Re-enqueues a failed world-gen job (202) or throws `HttpError`
 *  on a terminal / non-resumable state. */
export function resumeGeneration(ctx: ApiContext, campaignId: string): Promise<ResumeResult> {
  return resumeGenerationEndpoint({ campaignId }, ctx)
}

// -----------------------------------------------------------------------------
// Starting-situation pick (MYT-89 Phase D, D4).
//
// After the reveal, the owner picks one of three opening hooks — the choice seeds
// where play begins. Two endpoints: GET the three situations (member) + POST the
// chosen index (owner). The GET's `title`/`locationName` were added by myth-k1ee;
// every world that reaches this screen (a fresh post-generation world) carries
// them, so both are required here (a pre-k1ee world never surfaces this flow).
// The POST 200s `{ index }`; it throws `HttpError` 409 `situation_locked` once a
// party member's concept is locked (the pick is done) — the screen treats that as
// idempotent-success and proceeds to the campaign page anyway.
// -----------------------------------------------------------------------------

/** Fallback grounding prompt for pre-MYT-90 worlds whose starting-situation
 *  JSONB predates the generated `invitation` whisper. Every new world carries a
 *  situation-specific invitation; this generic prompt only surfaces for a legacy
 *  world so the character-creation screen always has a grounding prompt to show. */
const GENERIC_INVITATION = 'What brought your character to this place?'

/** One opening hook from GET …/starting-situations. `title`/`locationName`/`prose`/
 *  `invitation` are LLM-authored DATA (not i18n) the screen renders verbatim; the
 *  backend's `locationEntityId` (+ any richer keys) strip away under `z.object()`.
 *
 *  `invitation` (MYT-90) is OPTIONAL on the wire — a pre-MYT-90 world's JSONB lacks
 *  it, so a required field would fail the Zod parse for every legacy world. The
 *  transform fills a generic fallback so consumers always receive a string. */
const StartingSituationSchema = z
  .object({
    index: z.number().int(),
    title: z.string(),
    locationName: z.string(),
    prose: z.string(),
    invitation: z.string().optional(),
  })
  .transform((s) => ({ ...s, invitation: s.invitation ?? GENERIC_INVITATION }))

export type StartingSituation = z.infer<typeof StartingSituationSchema>

/** GET …/starting-situations response: the three hooks + the owner's prior pick
 *  (`chosenIndex` is null until the owner POSTs) + the party's starting level
 *  (`startingLevel`, MYT-90 A3/A6 — null until the owner sets it via
 *  POST …/starting-level; the backend GET now always emits the column). */
const StartingSituationsResponseSchema = z.object({
  situations: z.array(StartingSituationSchema),
  chosenIndex: z.number().int().nullable(),
  startingLevel: z.number().int().nullable(),
})

export type StartingSituationsResponse = z.infer<typeof StartingSituationsResponseSchema>

const getStartingSituationsEndpoint = defineEndpoint<
  StartingSituationsResponse,
  { campaignId: string }
>({
  method: 'GET',
  path: (input) => `/api/campaigns/${encodeURIComponent(input.campaignId)}/starting-situations`,
  response: StartingSituationsResponseSchema,
})

/** Member-visible. Fetches the three opening hooks + the owner's prior pick.
 *  Throws `HttpError` 404 `world_not_ready` before the situations stage has run. */
export function getStartingSituations(
  ctx: ApiContext,
  campaignId: string,
): Promise<StartingSituationsResponse> {
  return getStartingSituationsEndpoint({ campaignId }, ctx)
}

/** POST …/starting-situation body — the chosen hook's index (0..2). */
const ChooseStartingSituationBodySchema = z.object({
  index: z.number().int().min(0).max(2),
})

/** POST …/starting-situation 200 body — the recorded index. */
const ChooseStartingSituationResultSchema = z.object({
  index: z.number().int(),
})

export type ChooseStartingSituationResult = z.infer<typeof ChooseStartingSituationResultSchema>

const chooseStartingSituationEndpoint = defineEndpoint<
  ChooseStartingSituationResult,
  { campaignId: string; index: number }
>({
  method: 'POST',
  path: (input) => `/api/campaigns/${encodeURIComponent(input.campaignId)}/starting-situation`,
  request: ChooseStartingSituationBodySchema,
  response: ChooseStartingSituationResultSchema,
})

/** Owner-only. Records the chosen opening hook (200 `{ index }`); throws
 *  `HttpError` 409 `situation_locked` once the pick is already locked in — the
 *  caller treats that as idempotent-success. The request body (`{ index }`) is
 *  contract-validated; the `campaignId` rides the path, not the body. */
export function chooseStartingSituation(
  ctx: ApiContext,
  campaignId: string,
  index: number,
): Promise<ChooseStartingSituationResult> {
  return chooseStartingSituationEndpoint({ campaignId, index }, ctx)
}
