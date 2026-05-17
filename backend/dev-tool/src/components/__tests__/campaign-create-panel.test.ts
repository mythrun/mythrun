// Unit tests for campaign-create-panel narrowing helpers (myth-yfxf).
//
// The DOM-mount path is not exercised here — like live-events-panel,
// mount tests would need a DOM stub. The pure narrowing/headline
// helpers cover the wire-format contract surface; DOM behavior is
// covered by the dev-tool:verify harness (panel reaches data-state
// "ready" on mount).

import { describe, expect, it } from 'vitest'

import {
  buildHeadline,
  readStageFailed,
  type StageFailedEvent,
} from '../campaign-create-panel.js'

describe('readStageFailed', () => {
  it('narrows a well-formed stage-failed event with optional diagnostic', () => {
    const wire = {
      type: 'stage-failed',
      stage: 'concept_intake',
      userId: null,
      errorCode: 'llm_content_filtered',
      willRetry: false,
      diagnostic: {
        callSite: 'world-gen-processor#concept_intake',
        schemaName: 'ConceptIntakeOutput',
        modelId: 'claude-sonnet-4-5-20250929',
        repairStrategy: 'haiku-then-sonnet',
        repairAttempted: false,
        repairOutcome: 'none',
        rawTextSnippet: null,
        zodIssues: null,
      },
    }
    const parsed = readStageFailed(wire)
    expect(parsed).not.toBeNull()
    if (parsed === null) return
    expect(parsed.stage).toBe('concept_intake')
    expect(parsed.errorCode).toBe('llm_content_filtered')
    expect(parsed.willRetry).toBe(false)
    expect(parsed.diagnostic).not.toBeNull()
    expect(parsed.diagnostic?.schemaName).toBe('ConceptIntakeOutput')
  })

  it('narrows a stage-failed event without diagnostic (non-LLM failure)', () => {
    const wire = {
      type: 'stage-failed',
      stage: 'concept_intake',
      userId: null,
      errorCode: 'db_error',
      willRetry: true,
    }
    const parsed = readStageFailed(wire)
    expect(parsed).not.toBeNull()
    expect(parsed?.diagnostic).toBeNull()
    expect(parsed?.willRetry).toBe(true)
  })

  it('rejects events with non-stage-failed type', () => {
    expect(readStageFailed({ type: 'stage-started', stage: 'x' })).toBeNull()
  })

  it('rejects events with malformed fields', () => {
    expect(
      readStageFailed({ type: 'stage-failed', stage: 1, errorCode: 'x', willRetry: false }),
    ).toBeNull()
    expect(
      readStageFailed({ type: 'stage-failed', stage: 'x', errorCode: 'y', willRetry: 'no' }),
    ).toBeNull()
  })

  it('rejects non-object input', () => {
    expect(readStageFailed(null)).toBeNull()
    expect(readStageFailed('stage-failed')).toBeNull()
    expect(readStageFailed(42)).toBeNull()
  })

  it('preserves zodIssues path/message pairs and drops malformed entries', () => {
    const wire = {
      type: 'stage-failed',
      stage: 'world_and_factions',
      userId: null,
      errorCode: 'llm_structured_output_failed',
      willRetry: false,
      diagnostic: {
        callSite: 'x',
        schemaName: 'y',
        modelId: 'z',
        repairStrategy: 'sonnet',
        repairAttempted: true,
        repairOutcome: 'sonnet_failed',
        rawTextSnippet: 'partial output',
        zodIssues: [
          { path: 'world.name', message: 'required' },
          { path: 42, message: 'bad' }, // malformed — dropped
          { path: 'world.kind', message: 'enum' },
        ],
      },
    }
    const parsed = readStageFailed(wire)
    expect(parsed?.diagnostic?.zodIssues).toEqual([
      { path: 'world.name', message: 'required' },
      { path: 'world.kind', message: 'enum' },
    ])
    expect(parsed?.diagnostic?.rawTextSnippet).toBe('partial output')
  })
})

describe('buildHeadline', () => {
  const base: StageFailedEvent = {
    type: 'stage-failed',
    stage: 'concept_intake',
    errorCode: 'llm_content_filtered',
    willRetry: false,
    diagnostic: null,
  }

  it('returns the paint-job message for concept_intake_paint_job_loop_exhausted', () => {
    const ev: StageFailedEvent = { ...base, errorCode: 'concept_intake_paint_job_loop_exhausted' }
    expect(buildHeadline(ev)).toContain('mirror an existing copyrighted work')
  })

  it('returns the content-filter message for llm_content_filtered', () => {
    expect(buildHeadline(base)).toContain('content filter')
  })

  it('returns the structured-output message for llm_structured_output_failed', () => {
    const ev: StageFailedEvent = { ...base, errorCode: 'llm_structured_output_failed' }
    expect(buildHeadline(ev)).toContain("Couldn't generate a world")
  })

  it('returns operator-facing copy for llm_auth_failed / llm_invalid_request / llm_context_too_long', () => {
    for (const code of ['llm_auth_failed', 'llm_invalid_request', 'llm_context_too_long']) {
      const ev: StageFailedEvent = { ...base, errorCode: code }
      expect(buildHeadline(ev)).toMatch(/operator/i)
    }
  })

  it('falls through to a generic stage-failed message for unknown codes', () => {
    const ev: StageFailedEvent = { ...base, errorCode: 'unknown_code' }
    expect(buildHeadline(ev)).toBe('Stage failed: unknown_code')
  })

  it('appends repairOutcome when diagnostic is present on an unknown code', () => {
    const ev: StageFailedEvent = {
      ...base,
      errorCode: 'unknown_code',
      diagnostic: {
        callSite: 'x',
        schemaName: 'y',
        modelId: 'z',
        repairStrategy: 'sonnet',
        repairAttempted: true,
        repairOutcome: 'parse_failed',
        rawTextSnippet: null,
        zodIssues: null,
      },
    }
    expect(buildHeadline(ev)).toBe('Stage failed: unknown_code (repair: parse_failed)')
  })
})
