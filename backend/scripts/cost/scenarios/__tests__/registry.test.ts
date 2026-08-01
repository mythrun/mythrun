// backend/scripts/cost/scenarios/__tests__/registry.test.ts
//
// The scenario registry: the runner's pure dispatch surface. Scope-id
// derivation encodes the Wave-1 review routing (S-1/S-2 scope by BOTH
// sessionId AND campaignId — FT lines carry campaignId only), and the
// required-manifest-key lists are what the runner pre-checks BEFORE spending
// live-Anthropic money.

import { describe, expect, it } from 'vitest'
import type { LlmCallLine } from '../../lib/extract.js'
import type { CapturedRun } from '../../run-state.js'
import { parseScenarioId, SCENARIOS } from '../registry.js'
import { S1_REQUIRED_KEYS, S2_REQUIRED_KEYS } from '../assemble-session.js'

const RUN: CapturedRun = {
  scenario: 's1',
  window: { fromMs: 1_000, toMs: 2_000 },
  campaignId: 'camp-1',
  sessionId: 'sess-1',
  turns: 12,
  completedAt: '2026-07-31T18:00:00.000Z',
}

function line(over: Partial<LlmCallLine>): LlmCallLine {
  return { time: 1_500, model: 'claude-sonnet-5', inputTokens: 1_000, outputTokens: 100, ...over }
}

describe('parseScenarioId', () => {
  it('accepts the four scenario ids', () => {
    expect(parseScenarioId('s1')).toBe('s1')
    expect(parseScenarioId('s2')).toBe('s2')
    expect(parseScenarioId('s4')).toBe('s4')
    expect(parseScenarioId('s5')).toBe('s5')
  })

  it('rejects unknown or missing ids with a usage message', () => {
    expect(() => parseScenarioId('s3')).toThrow(/s1\|s2\|s4\|s5/)
    expect(() => parseScenarioId(undefined)).toThrow(/s1\|s2\|s4\|s5/)
  })
})

describe('scope ids', () => {
  it('s1/s2 scope by BOTH sessionId and campaignId', () => {
    expect(SCENARIOS.s1.scopeIds(RUN)).toEqual(['sess-1', 'camp-1'])
    expect(SCENARIOS.s2.scopeIds(RUN)).toEqual(['sess-1', 'camp-1'])
  })

  it('s1/s2 refuse a run missing either id', () => {
    expect(() => SCENARIOS.s1.scopeIds({ ...RUN, sessionId: undefined })).toThrow(/sessionId/)
    expect(() => SCENARIOS.s2.scopeIds({ ...RUN, campaignId: undefined })).toThrow(/campaignId/)
  })

  it('s4/s5 scope by campaignId', () => {
    const prepRun: CapturedRun = {
      scenario: 's4',
      window: { fromMs: 1, toMs: 2 },
      campaignId: 'camp-9',
      completedAt: '2026-07-31T18:00:00.000Z',
    }
    expect(SCENARIOS.s4.scopeIds(prepRun)).toEqual(['camp-9'])
    expect(SCENARIOS.s5.scopeIds(prepRun)).toEqual(['camp-9'])
    expect(() => SCENARIOS.s4.scopeIds({ ...prepRun, campaignId: undefined })).toThrow(/campaignId/)
  })
})

describe('required manifest keys', () => {
  it('s1/s2 reuse the assembly exports', () => {
    expect(SCENARIOS.s1.requiredManifestKeys).toEqual(S1_REQUIRED_KEYS)
    expect(SCENARIOS.s2.requiredManifestKeys).toEqual(S2_REQUIRED_KEYS)
  })
})

describe('stage-only (id-less) capture sets', () => {
  it('s4 keeps a belt-and-braces tripwire arm; s5 captures pre-campaign calls', () => {
    // The input gate and preview-time concept_intake run before the campaign
    // row exists (genuinely id-less). The vetOpening tripwire stamps
    // campaignId at HEAD — s4's entry only guards against a stamping
    // regression and normally captures nothing.
    expect(SCENARIOS.s4.stageOnlyStages).toEqual(['secret_tripwire'])
    expect(SCENARIOS.s5.stageOnlyStages).toEqual(['input_gate', 'concept_intake'])
    expect(SCENARIOS.s1.stageOnlyStages).toEqual([])
    expect(SCENARIOS.s2.stageOnlyStages).toEqual([])
  })
})

describe('assemble delegation', () => {
  it('s1 assembles rows from calls + manifest + the run turns', () => {
    const calls = [
      line({ campaignId: 'camp-1' }),
      line({
        model: 'claude-opus-5',
        sessionId: 'sess-1',
        stage: 'st_eval',
        inputTokens: 12_000,
        outputTokens: 2_000,
      }),
    ]
    const manifest = {
      's1.ft_usd_per_turn': { usd: 0.001, tolerancePct: 50 },
      's1.st_eval_usd_mean': { usd: 0.11, tolerancePct: 25 },
      's1.st_eval_count': { count: 1, tolerancePct: 0 },
    }
    const rows = SCENARIOS.s1.assemble({ run: RUN, calls, dropped: [], stageOnly: [], manifest })
    expect(rows.map((r) => r.component)).toContain('s1.ft_usd_per_turn')
  })

  it('s1/s2 refuse a run without turns', () => {
    expect(() =>
      SCENARIOS.s1.assemble({
        run: { ...RUN, turns: undefined },
        calls: [line({})],
        dropped: [],
        stageOnly: [],
        manifest: {},
      }),
    ).toThrow(/turns/)
  })
})
