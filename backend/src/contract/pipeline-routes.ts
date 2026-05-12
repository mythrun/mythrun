// Declarative list of prep-pipeline HTTP routes. The ship-gate check
// (backend/scripts/dev-tool-check.ts) reads this list to ensure every
// entry has corresponding dev-tool coverage (or an explicit exempt
// entry).
//
// Format: '<METHOD> /api/<path>' (e.g., 'GET /api/campaigns/:campaignId/status').
// Route param tokens (`:campaignId`) MUST match the actual handler
// registration in routes/campaigns.ts — the dev-tool check does an
// exact-string compare against the route URLs Fastify reports.
export const PIPELINE_ROUTES: readonly string[] = [
  'GET /api/campaigns/:campaignId/status',
  'GET /api/campaigns/:campaignId/status/stream',
] as const

export type PipelineRoute = (typeof PIPELINE_ROUTES)[number]
