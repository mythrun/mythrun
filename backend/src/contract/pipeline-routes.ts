// backend/src/contract/pipeline-routes.ts
//
// Declarative list of campaign-scoped pipeline HTTP routes. Boot-time
// enforcement (per MYT-51 D12) verifies every entry is registered AND
// every route marked `config.pipelineRoute = true` appears here.
//
// Format: '<METHOD> /api/<path>' with Fastify route patterns
// (e.g., `:campaignId`, not request URLs).

export const PIPELINE_ROUTES: readonly string[] = [
  // Status surface (from the status-surface ticket; pre-existing):
  'GET /api/campaigns/:campaignId/status',
  'GET /api/campaigns/:campaignId/status/stream',
  // World gen (this ticket):
  'POST /api/campaigns',
  'GET /api/campaigns/:campaignId',
  'GET /api/campaigns/mine',
  'POST /api/campaigns/:campaignId/resume',
  'DELETE /api/campaigns/:campaignId',
  // myth-4lhr — rename a campaign (auto-generated name → user override):
  'PATCH /api/campaigns/:campaignId/name',
  // myth-exac — dev-tool snapshot inspector (owner-only, gated on stage 4):
  'GET /api/campaigns/:campaignId/world-snapshot',
  // MYT-53 — per-player parallel character creation. NOTE:
  // POST /archive is intentionally NOT here — the route is a campaign-
  // level state flip (setup/active → archived), not a stage in the prep
  // pipeline, so its handler omits the `config: { pipelineRoute: true }`
  // marker. It is still surfaced in `backend-routes.ts` as a registered
  // route, just not as a pipeline-status surface.
  'POST /api/campaigns/:campaignId/starting-situation',
  'POST /api/campaigns/:campaignId/start-character-creation',
  'POST /api/campaigns/:campaignId/characters',
  'GET /api/campaigns/:campaignId/starting-situations',
  'GET /api/campaigns/:campaignId/characters',
  'GET /api/campaigns/:campaignId/characters/:charId',
  'GET /api/campaigns/:campaignId/hierarchy',
  'GET /api/campaigns/:campaignId/random-tables',
  // MYT-54 T12 — per-PC character-creation progress board (any member).
  'GET /api/campaigns/:campaignId/character-creation-progress',
  // MYT-54 T13 — owner fan-in trigger for the campaign-scoped
  // character_integration stage (singleton job, BullMQ-deduped on jobId).
  'POST /api/campaigns/:campaignId/finalize-character-creation',
] as const

export type PipelineRoute = (typeof PIPELINE_ROUTES)[number]
