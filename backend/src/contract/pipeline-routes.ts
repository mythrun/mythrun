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
] as const

export type PipelineRoute = (typeof PIPELINE_ROUTES)[number]
