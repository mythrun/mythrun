// Declarative list of prep-pipeline HTTP routes. The ship-gate check
// (backend/scripts/dev-tool-check.ts) reads this list to ensure every
// entry has corresponding dev-tool coverage (or an explicit exempt
// entry).
//
// NOTE: at Phase 0 this list does NOT structurally force route handlers
// to import their entry from here. The enforcement layer lands in MYT-50
// alongside the first real routes — either a registerPipelineRoute helper
// that takes `route: PipelineRoute`, or a Fastify onRoute hook that fails
// boot when a pipeline-path URL is registered without being in
// PIPELINE_ROUTES. Phase 0 documents the convention; MYT-50 enforces it.
//
// The list seeds empty; routes accumulate as MYT-50 onward lands them.
// Format: '<METHOD> /api/<path>' (e.g., 'POST /api/worlds').
export const PIPELINE_ROUTES: readonly string[] = [] as const

export type PipelineRoute = (typeof PIPELINE_ROUTES)[number]
