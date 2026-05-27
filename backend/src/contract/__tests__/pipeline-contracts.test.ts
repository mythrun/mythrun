// Coverage sanity asserts for the runtime constants exported alongside
// the pipeline contract types. The arrays are consumed by dev-tool-check
// (PIPELINE_SSE_EVENTS) and surfaced as a typed shape for future client
// validation (PIPELINE_ERROR_CODES). The tests here exist to keep the
// arrays from drifting silently — every code/event referenced in the
// union types must also appear in the runtime array.

import { describe, it, expect } from 'vitest'
import {
  PIPELINE_ERROR_CODES,
  type PipelineErrorCode,
} from '../pipeline-errors.js'
import {
  PIPELINE_SSE_EVENTS,
  type PipelineSseEvent,
} from '../pipeline-events.js'

describe('PIPELINE_ERROR_CODES', () => {
  it('includes every documented error code', () => {
    const expected: readonly PipelineErrorCode[] = [
      'concept_rejected',
      'insufficient_credits',
      'queue_full',
      'rejection_storm_cooldown',
      'concurrent_generation_in_progress',
      'llm_upstream_unavailable',
      'content_filtered',
      'world_gen_in_progress',
      'phase_not_yet_implementable',
      'world_gen_capped',
      'nothing_to_resume',
      'already_complete',
      'terminal_failure',
      'phase_resume_not_yet_implemented',
    ]
    expect([...PIPELINE_ERROR_CODES].sort()).toEqual([...expected].sort())
  })
})

describe('PIPELINE_SSE_EVENTS', () => {
  it('includes every documented SSE event name', () => {
    const expected: readonly PipelineSseEvent[] = [
      'phase',
      'stage-started',
      'stage-completed',
      'stage-failed',
      'cost-update',
      'job-failed',
      'stage-reset',
      'entity-added',
      'entity-updated',
      'entity-removed',
      'edge-added',
      'edge-removed',
      'fact-added',
      'fact-removed',
      'fact-updated',
      'finalized',
    ]
    expect([...PIPELINE_SSE_EVENTS].sort()).toEqual([...expected].sort())
  })
})
