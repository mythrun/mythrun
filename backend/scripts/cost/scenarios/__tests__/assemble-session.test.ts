// backend/scripts/cost/scenarios/__tests__/assemble-session.test.ts
//
// S-1/S-2 assembly: extracted `llm.call` lines + manifest → component rows
// (cost-wave1 spec §5, S-1/S-2). Aggregation math uses callUsd as the
// reference (the derivation itself is oracle-tested in usd.test.ts); these
// tests pin the row STRUCTURE: segmentation, the mandatory dropped-line
// surfacing, missing-manifest-key loudness, and S-2's manifest-gated cache
// arms with their accommodation logic (first-eval cold write, >TTL gaps,
// sub-4096 spans logged-not-failed).

import { describe, expect, it } from 'vitest'
import type { LlmCallLine } from '../../lib/extract.js'
import { callUsd } from '../../lib/usd.js'
import { rowStatus, type ComponentRow } from '../../lib/report.js'
import {
  assembleS1,
  assembleS2,
  S1_REQUIRED_KEYS,
  S2_REQUIRED_KEYS,
  segmentSessionCalls,
} from '../assemble-session.js'

const SESSION = 'sess-1'
const CAMPAIGN = 'camp-1'

let clock = 1_000_000
function line(over: Partial<LlmCallLine>): LlmCallLine {
  clock += 10_000
  return {
    time: clock,
    model: 'claude-haiku-4-5-20251001',
    inputTokens: 1_000,
    outputTokens: 100,
    sessionId: SESSION,
    campaignId: CAMPAIGN,
    ...over,
  }
}

// FT lines: campaignId only, NO stage (turn 1 = cold cache write).
const ft1 = line({
  model: 'claude-sonnet-5',
  sessionId: undefined,
  inputTokens: 20_000,
  outputTokens: 500,
  cacheReadTokens: 0,
  cacheWriteTokens: 15_000,
})
const ft2 = line({
  model: 'claude-sonnet-5',
  sessionId: undefined,
  inputTokens: 21_000,
  outputTokens: 400,
  cacheReadTokens: 19_000,
  cacheWriteTokens: 1_000,
})
const ft3 = line({
  model: 'claude-sonnet-5',
  sessionId: undefined,
  inputTokens: 22_000,
  outputTokens: 450,
  cacheReadTokens: 20_000,
  cacheWriteTokens: 1_000,
})

// ST evals (Opus): first cold-write, then a cache hit, then a no-cache line.
const eval1 = line({
  model: 'claude-opus-5',
  stage: 'st_eval',
  inputTokens: 12_000,
  outputTokens: 2_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 9_000,
})
const eval2 = line({
  model: 'claude-opus-5',
  stage: 'st_eval',
  inputTokens: 12_500,
  outputTokens: 1_800,
  cacheReadTokens: 9_000,
  cacheWriteTokens: 500,
})
const eval3 = line({
  model: 'claude-opus-5',
  stage: 'st_eval',
  inputTokens: 13_000,
  outputTokens: 2_100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

const gate1 = line({ stage: 'st_gate', inputTokens: 10_000, cacheWriteTokens: 7_500 })
const gate2 = line({ stage: 'st_gate', inputTokens: 10_200, cacheReadTokens: 7_500 })
const audit1 = line({ stage: 'turn_audit', inputTokens: 2_700 })
const trip1 = line({ stage: 'secret_tripwire', inputTokens: 9_000, cacheWriteTokens: 6_000 })
const trip2 = line({ stage: 'secret_tripwire', inputTokens: 9_100, cacheReadTokens: 6_000 })

// A campaign-scoped prep line riding inside the session window (M-1: e.g. a
// next-session prep) — never priced into session components, segmented out.
const prepLine = line({
  model: 'claude-opus-5',
  sessionId: undefined,
  stage: 'session_prep',
  inputTokens: 30_000,
  outputTokens: 8_000,
})

// A repair line extractCalls dropped-and-flagged (sessionId + world-gen stage).
const droppedLine = line({ stage: 'concept_intake', inputTokens: 5_000 })

const CALLS = [ft1, ft2, ft3, eval1, eval2, eval3, gate1, gate2, audit1, trip1, trip2, prepLine]
const DROPPED = [droppedLine]

const usd = (lines: LlmCallLine[]): number => lines.reduce((s, l) => s + callUsd(l), 0)

const S1_MANIFEST = {
  's1.ft_usd_per_turn': { usd: usd([ft1, ft2, ft3]) / 3, tolerancePct: 20 },
  's1.st_eval_usd_mean': { usd: usd([eval1, eval2, eval3]) / 3, tolerancePct: 25 },
  's1.st_eval_count': { count: 3, tolerancePct: 0 },
}

function row(rows: ComponentRow[], component: string): ComponentRow {
  const found = rows.find((r) => r.component === component)
  if (found === undefined) {
    throw new Error(`row ${component} missing; got ${rows.map((r) => r.component).join(', ')}`)
  }
  return found
}

describe('segmentSessionCalls', () => {
  it('splits FT (no stage), session stages, and foreign-stage prep lines', () => {
    const seg = segmentSessionCalls(CALLS)
    expect(seg.ft).toEqual([ft1, ft2, ft3])
    expect(seg.byStage.get('st_eval')).toEqual([eval1, eval2, eval3])
    expect(seg.byStage.get('st_gate')).toEqual([gate1, gate2])
    expect(seg.prepSegment).toEqual([prepLine])
  })
})

describe('assembleS1', () => {
  const rows = assembleS1({ calls: CALLS, dropped: DROPPED, manifest: S1_MANIFEST, turns: 3 })

  it('asserts FT $/turn, ST $/eval mean, and eval count against the manifest', () => {
    const ft = row(rows, 's1.ft_usd_per_turn')
    expect(ft.actual).toBeCloseTo(usd([ft1, ft2, ft3]) / 3, 10)
    expect(rowStatus(ft)).toBe('PASS')

    const st = row(rows, 's1.st_eval_usd_mean')
    expect(st.actual).toBeCloseTo(usd([eval1, eval2, eval3]) / 3, 10)
    expect(rowStatus(st)).toBe('PASS')

    const count = row(rows, 's1.st_eval_count')
    expect(count.actual).toBe(3)
    expect(count.expected).toBe(3)
    expect(rowStatus(count)).toBe('PASS')
  })

  it('renders per-stage aux components and the session total as INFO', () => {
    const gate = row(rows, 's1.st_gate_usd')
    expect(rowStatus(gate)).toBe('INFO')
    expect(gate.actual).toBeCloseTo(usd([gate1, gate2]), 10)
    expect(gate.note).toContain('n=2')

    const total = row(rows, 's1.total_usd')
    expect(rowStatus(total)).toBe('INFO')
    // Session-only: the prep segment is NOT absorbed into the session total.
    expect(total.actual).toBeCloseTo(
      usd([ft1, ft2, ft3, eval1, eval2, eval3, gate1, gate2, audit1, trip1, trip2]),
      10,
    )
  })

  it('segments campaign-scoped prep-stage lines into their own INFO row', () => {
    const prep = row(rows, 's1.prep_segment_usd')
    expect(rowStatus(prep)).toBe('INFO')
    expect(prep.actual).toBeCloseTo(usd([prepLine]), 10)
    expect(prep.note).toContain('session_prep')
    // No prep segment → no row.
    const without = assembleS1({
      calls: CALLS.filter((c) => c !== prepLine),
      dropped: [],
      manifest: S1_MANIFEST,
      turns: 3,
    })
    expect(without.some((r) => r.component === 's1.prep_segment_usd')).toBe(false)
  })

  it('surfaces dropped-and-flagged lines (mandatory — never silently absorbed)', () => {
    const dropped = row(rows, 's1.dropped')
    expect(dropped.actual).toBe(1)
    expect(dropped.note).toContain('concept_intake')
  })

  it('fails loudly on a missing expected manifest key', () => {
    const { 's1.st_eval_count': omitted, ...partial } = S1_MANIFEST
    expect(omitted).toBeDefined()
    expect(() =>
      assembleS1({ calls: CALLS, dropped: [], manifest: partial, turns: 3 }),
    ).toThrow(/s1\.st_eval_count/)
  })

  it('fails loudly when no FT lines were captured (worker-leg logging hint)', () => {
    expect(() =>
      assembleS1({
        calls: CALLS.filter((c) => ![ft1, ft2, ft3].includes(c)),
        dropped: [],
        manifest: S1_MANIFEST,
        turns: 3,
      }),
    ).toThrow(/no FT lines/i)
  })

  it('fails loudly on an empty capture', () => {
    expect(() => assembleS1({ calls: [], dropped: [], manifest: S1_MANIFEST, turns: 3 })).toThrow(
      /no llm\.call lines/i,
    )
  })
})

describe('assembleS2 — FT cache floor', () => {
  const manifest = { 's2.ft_cache_read_pct': { cacheReadMin: 85, tolerancePct: 0 } }

  it('asserts cacheRead% over FT lines excluding the first (cold write) as a floor', () => {
    const rows = assembleS2({ calls: CALLS, dropped: [], manifest, turns: 3 })
    const ft = row(rows, 's2.ft_cache_read_pct')
    // ft2 + ft3: (19,000 + 20,000) / (21,000 + 22,000) = 90.7%
    expect(ft.actual).toBeCloseTo((39_000 / 43_000) * 100, 6)
    expect(ft.direction).toBe('min')
    expect(ft.expected).toBe(85)
    expect(rowStatus(ft)).toBe('PASS')
    expect(ft.note).toContain('excluding first')
  })

  it('fails the floor when the cache is cold', () => {
    const cold = [ft2, ft3].map((f) => ({ ...f, cacheReadTokens: 0 }))
    const rows = assembleS2({ calls: [ft1, ...cold, eval1], dropped: [], manifest, turns: 3 })
    expect(rowStatus(row(rows, 's2.ft_cache_read_pct'))).toBe('FAIL')
  })

  it('fails loudly with fewer than two FT lines', () => {
    expect(() => assembleS2({ calls: [ft1, eval1], dropped: [], manifest, turns: 3 })).toThrow(
      /FT lines/,
    )
  })

  it('fails loudly when the required key is missing', () => {
    expect(() => assembleS2({ calls: CALLS, dropped: [], manifest: {}, turns: 3 })).toThrow(
      /s2\.ft_cache_read_pct/,
    )
  })
})

describe('assembleS2 — manifest-gated cache arms (ST, gate, tripwire)', () => {
  const base = { 's2.ft_cache_read_pct': { cacheReadMin: 85, tolerancePct: 0 } }

  it('renders arms as INFO with measured cacheRead% while the manifest key is absent', () => {
    const rows = assembleS2({ calls: CALLS, dropped: [], manifest: base, turns: 3 })
    const st = row(rows, 's2.st_eval_cache_read_pct')
    expect(rowStatus(st)).toBe('INFO')
    expect(st.note).toContain('arm off')
    expect(rowStatus(row(rows, 's2.st_gate_cache_read_pct'))).toBe('INFO')
    expect(rowStatus(row(rows, 's2.secret_tripwire_cache_read_pct'))).toBe('INFO')
  })

  it('ST arm on: cold-write first eval and cache-hit evals pass; a cold non-first eval violates', () => {
    const manifest = { ...base, 's2.st_eval_cache': { cacheReadMin: 1, tolerancePct: 0 } }
    // eval3 has read 0 / write 0 with a 10s gap — a genuine violation.
    const rows = assembleS2({ calls: CALLS, dropped: [], manifest, turns: 3 })
    const arm = row(rows, 's2.st_eval_cache_violations')
    expect(arm.actual).toBe(1)
    expect(rowStatus(arm)).toBe('FAIL')
    // With eval3 reading cache instead: zero violations.
    const healed = CALLS.map((c) => (c === eval3 ? { ...c, cacheReadTokens: 9_000 } : c))
    const ok = row(
      assembleS2({ calls: healed, dropped: [], manifest, turns: 3 }),
      's2.st_eval_cache_violations',
    )
    expect(ok.actual).toBe(0)
    expect(rowStatus(ok)).toBe('PASS')
  })

  it('ST arm: a >TTL gap is accommodated (logged, not failed)', () => {
    const manifest = { ...base, 's2.st_eval_cache': { cacheReadMin: 1, tolerancePct: 0 } }
    const lateEval3 = { ...eval3, time: eval2.time + 6 * 60_000 }
    const calls = CALLS.map((c) => (c === eval3 ? lateEval3 : c))
    const arm = row(
      assembleS2({ calls, dropped: [], manifest, turns: 3 }),
      's2.st_eval_cache_violations',
    )
    expect(arm.actual).toBe(0)
    expect(rowStatus(arm)).toBe('PASS')
    expect(arm.note).toContain('TTL')
  })

  it('gate/tripwire arms are span-conditional: below 4096 renders INFO, not FAIL', () => {
    const manifest = {
      ...base,
      's2.st_gate_cache': { spanTokens: 3_894, cacheReadMin: 1, tolerancePct: 0 },
    }
    const gateCold = { ...gate2, cacheReadTokens: 0 }
    const calls = CALLS.map((c) => (c === gate2 ? gateCold : c))
    const arm = row(
      assembleS2({ calls, dropped: [], manifest, turns: 3 }),
      's2.st_gate_cache_read_pct',
    )
    expect(rowStatus(arm)).toBe('INFO')
    expect(arm.note).toContain('4096')
  })

  it('gate arm on (span ≥ 4096): cold non-first gate lines violate', () => {
    const manifest = {
      ...base,
      's2.st_gate_cache': { spanTokens: 7_500, cacheReadMin: 1, tolerancePct: 0 },
    }
    const rows = assembleS2({ calls: CALLS, dropped: [], manifest, turns: 3 })
    expect(rowStatus(row(rows, 's2.st_gate_cache_violations'))).toBe('PASS')
    const gateCold = { ...gate2, cacheReadTokens: 0 }
    const calls = CALLS.map((c) => (c === gate2 ? gateCold : c))
    const bad = row(
      assembleS2({ calls, dropped: [], manifest, turns: 3 }),
      's2.st_gate_cache_violations',
    )
    expect(bad.actual).toBe(1)
    expect(rowStatus(bad)).toBe('FAIL')
  })

  it('tripwire arm mirrors the gate arm', () => {
    const manifest = {
      ...base,
      's2.secret_tripwire_cache': { spanTokens: 6_000, cacheReadMin: 1, tolerancePct: 0 },
    }
    const rows = assembleS2({ calls: CALLS, dropped: [], manifest, turns: 3 })
    expect(rowStatus(row(rows, 's2.secret_tripwire_cache_violations'))).toBe('PASS')
  })

  it('surfaces dropped lines like S-1', () => {
    const rows = assembleS2({ calls: CALLS, dropped: DROPPED, manifest: base, turns: 3 })
    expect(row(rows, 's2.dropped').note).toContain('concept_intake')
  })
})

describe('required-key exports', () => {
  it('name the keys the runner pre-checks before spending money', () => {
    expect(S1_REQUIRED_KEYS).toEqual([
      's1.ft_usd_per_turn',
      's1.st_eval_usd_mean',
      's1.st_eval_count',
    ])
    expect(S2_REQUIRED_KEYS).toEqual(['s2.ft_cache_read_pct'])
  })
})
