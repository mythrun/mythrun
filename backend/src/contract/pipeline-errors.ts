// backend/src/contract/pipeline-errors.ts
//
// Discriminated-union envelope for every error response the pipeline
// HTTP surface can produce (per MYT-51 D10 / Phoenix-Imp7). FE clients
// switch on `code` to dispatch UX; the discriminator is machine-typed
// rather than prose-matched.
//
// Standard 400 (Zod body-parse failure) is NOT enumerated here — those
// are Fastify-level errors with a different envelope.

export type PipelineRouteError =
  // POST /api/campaigns:
  | {
      code: 'concept_rejected'
      reason: 'srd_incompat' | 'clone_intent' | 'inappropriate'
      rejectionMessage: string // ≤400 chars, plain text
      synthesizedConcept?: string // present only on guided-mode reject
    }
  | { code: 'insufficient_credits'; creditType: 'world_gen' | 'session' }
  | { code: 'queue_full'; retryAfterSeconds: number }
  | { code: 'rejection_storm_cooldown'; retryAfterSeconds: number }
  | { code: 'concurrent_generation_in_progress' }
  // POST /api/campaigns/:campaignId/resume:
  | { code: 'world_gen_in_progress' }
  | { code: 'phase_not_yet_implementable'; stuckAtStage: string }
  | { code: 'world_gen_capped' }
  | { code: 'nothing_to_resume' }
  | { code: 'already_complete' }
  | { code: 'terminal_failure' }
  | {
      code: 'phase_resume_not_yet_implemented'
      phase: 'character_creation' | 'post_creation'
    }

export type PipelineErrorCode = PipelineRouteError['code']

export const PIPELINE_ERROR_CODES: readonly PipelineErrorCode[] = [
  'concept_rejected',
  'insufficient_credits',
  'queue_full',
  'rejection_storm_cooldown',
  'concurrent_generation_in_progress',
  'world_gen_in_progress',
  'phase_not_yet_implementable',
  'world_gen_capped',
  'nothing_to_resume',
  'already_complete',
  'terminal_failure',
  'phase_resume_not_yet_implemented',
] as const
