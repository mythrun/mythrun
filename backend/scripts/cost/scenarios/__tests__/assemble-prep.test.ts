// backend/scripts/cost/scenarios/__tests__/assemble-prep.test.ts
//
// S-4/S-5 assembly (cost-wave1 spec §5): per-stage $ ceilings, PER-MODEL
// scoped — the manifest key is `<prefix>.<stage>.<model>`, so "configured
// model asserted" falls out structurally: a model swap (or a brand-new
// stage) has no manifest key and fails LOUDLY instead of silently pricing
// under the wrong expectation. Stage retry/repair cost is surfaced
// separately (excess calls beyond the pinned per-group count). Id-less
// tripwire lines (window+stage scoped) join as their own group, noted.

import { describe, expect, it } from 'vitest'
import type { LlmCallLine } from '../../lib/extract.js'
import { callUsd } from '../../lib/usd.js'
import { rowStatus, type ComponentRow } from '../../lib/report.js'
import { assemblePrep } from '../assemble-prep.js'

const CAMPAIGN = 'camp-prep'

let clock = 2_000_000
function line(over: Partial<LlmCallLine>): LlmCallLine {
  clock += 30_000
  return {
    time: clock,
    model: 'claude-opus-5',
    inputTokens: 30_000,
    outputTokens: 8_000,
    campaignId: CAMPAIGN,
    ...over,
  }
}

const intake = line({ model: 'claude-haiku-4-5-20251001', stage: 'concept_intake', inputTokens: 2_000, outputTokens: 300 })
const worldFactions = line({ stage: 'world_and_factions', inputTokens: 59_205, outputTokens: 30_199 })
const locations = line({ stage: 'locations_and_npcs', inputTokens: 46_728, outputTokens: 23_965, model: 'claude-sonnet-5' })
// A repair/retry: second call in an expected-count-1 group.
const locationsRetry = line({ stage: 'locations_and_npcs', inputTokens: 47_000, outputTokens: 9_000, model: 'claude-sonnet-5' })
// Id-less prep-context tripwire (window+stage scoped, merged via stageOnly).
const tripwire: LlmCallLine = {
  time: clock + 30_000,
  model: 'claude-haiku-4-5-20251001',
  stage: 'secret_tripwire',
  inputTokens: 10_160,
  outputTokens: 23,
}

const usd = (l: LlmCallLine[]): number => l.reduce((s, c) => s + callUsd(c), 0)

const MANIFEST = {
  's5.total_usd': { usd: usd([intake, worldFactions, locations, locationsRetry, tripwire]), tolerancePct: 25 },
  's5.concept_intake.claude-haiku-4-5-20251001': { usd: usd([intake]), count: 1, tolerancePct: 20 },
  's5.world_and_factions.claude-opus-5': { usd: usd([worldFactions]), count: 1, tolerancePct: 20 },
  's5.locations_and_npcs.claude-sonnet-5': { usd: usd([locations]), count: 1, tolerancePct: 20 },
  's5.secret_tripwire.claude-haiku-4-5-20251001': { usd: usd([tripwire]), count: 1, tolerancePct: 20 },
}

function row(rows: ComponentRow[], component: string): ComponentRow {
  const found = rows.find((r) => r.component === component)
  if (found === undefined) {
    throw new Error(`row ${component} missing; got ${rows.map((r) => r.component).join(', ')}`)
  }
  return found
}

describe('assemblePrep', () => {
  const input = {
    prefix: 's5' as const,
    calls: [intake, worldFactions, locations, locationsRetry],
    stageOnly: [tripwire],
    dropped: [],
    manifest: MANIFEST,
  }
  const rows = assemblePrep(input)

  it('asserts each stage×model group as a ceiling, pricing ALL its calls', () => {
    const wf = row(rows, 's5.world_and_factions.claude-opus-5')
    expect(wf.actual).toBeCloseTo(usd([worldFactions]), 10)
    expect(wf.direction).toBe('max')
    expect(rowStatus(wf)).toBe('PASS')
    // The retried group prices both calls — over its 1-call ceiling → FAIL
    // (a retry IS extra spend; the excess row below explains why).
    const loc = row(rows, 's5.locations_and_npcs.claude-sonnet-5')
    expect(loc.actual).toBeCloseTo(usd([locations, locationsRetry]), 10)
    expect(rowStatus(loc)).toBe('FAIL')
    expect(loc.note).toContain('n=2')
  })

  it('counts retry/excess cost separately (calls beyond the pinned count)', () => {
    const excess = row(rows, 's5.excess_calls_usd')
    expect(rowStatus(excess)).toBe('INFO')
    expect(excess.actual).toBeCloseTo(usd([locationsRetry]), 10)
    expect(excess.note).toContain('locations_and_npcs')
  })

  it('merges id-less stage-only lines as their own noted group', () => {
    const trip = row(rows, 's5.secret_tripwire.claude-haiku-4-5-20251001')
    expect(trip.actual).toBeCloseTo(usd([tripwire]), 10)
    expect(trip.note).toContain('id-less')
    expect(rowStatus(trip)).toBe('PASS')
  })

  it('asserts the total as a ceiling including stage-only lines', () => {
    const total = row(rows, 's5.total_usd')
    expect(total.actual).toBeCloseTo(usd([intake, worldFactions, locations, locationsRetry, tripwire]), 10)
    expect(total.direction).toBe('max')
    expect(rowStatus(total)).toBe('PASS')
  })

  it('fails loudly on a stage×model group with no manifest key (model swap / new stage)', () => {
    const swapped = [{ ...worldFactions, model: 'claude-sonnet-5' }]
    expect(() =>
      assemblePrep({ ...input, calls: swapped, stageOnly: [] }),
    ).toThrow(/s5\.world_and_factions\.claude-sonnet-5/)
  })

  it('fails loudly on a stage-less line in a prep window', () => {
    expect(() =>
      assemblePrep({ ...input, calls: [...input.calls, line({ stage: undefined })] }),
    ).toThrow(/stage-less/)
  })

  it('fails loudly on an empty capture and on a missing total key', () => {
    expect(() => assemblePrep({ ...input, calls: [], stageOnly: [] })).toThrow(/no llm\.call/i)
    const { 's5.total_usd': omitted, ...rest } = MANIFEST
    expect(omitted).toBeDefined()
    expect(() => assemblePrep({ ...input, manifest: rest })).toThrow(/s5\.total_usd/)
  })

  it('surfaces dropped lines', () => {
    const withDropped = assemblePrep({ ...input, dropped: [line({ stage: 'mystery', sessionId: 'sess-x' })] })
    expect(row(withDropped, 's5.dropped').note).toContain('mystery')
  })

  it('skips excess computation when count is unpinned, noting it', () => {
    const manifest = {
      ...MANIFEST,
      's5.locations_and_npcs.claude-sonnet-5': { usd: usd([locations, locationsRetry]), tolerancePct: 20 },
    }
    const relaxed = assemblePrep({ ...input, manifest })
    const loc = row(relaxed, 's5.locations_and_npcs.claude-sonnet-5')
    expect(rowStatus(loc)).toBe('PASS')
    expect(loc.note).toContain('count unpinned')
    expect(relaxed.some((r) => r.component === 's5.excess_calls_usd')).toBe(false)
  })
})
