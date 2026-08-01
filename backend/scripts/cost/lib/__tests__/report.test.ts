// backend/scripts/cost/lib/__tests__/report.test.ts
//
// The one-page component report (cost-wave1 spec §1.1(5)): a fixed-width
// table with per-row deltas vs the manifest expectation, PASS/FAIL per
// asserted row, INFO for informational / logged-not-failed arms, and a
// terminal RESULT line — "a red cost smoke is a red smoke".

import { describe, expect, it } from 'vitest'
import { renderReport, rowStatus, type ComponentRow } from '../report.js'

// PASS: |0.3930 − 0.39| = 0.0030 ≤ 0.39 × 20% = 0.078; Δ% = +0.8.
const ftTurn: ComponentRow = {
  component: 'ft_turn_mean',
  unit: 'usd',
  actual: 0.393,
  expected: 0.39,
  tolerancePct: 20,
}
// FAIL: |0.52 − 0.40| = 0.12 > 0.40 × 20% = 0.08; Δ% = +30.0.
const stEval: ComponentRow = {
  component: 'st_eval_mean',
  unit: 'usd',
  actual: 0.52,
  expected: 0.4,
  tolerancePct: 20,
}
// INFO: informational row (S-1's total in-session dollars).
const sessionTotal: ComponentRow = {
  component: 'session_total',
  unit: 'usd',
  actual: 4.2101,
  informational: true,
  note: 'informational (S-1)',
}
// PASS (tokens): |388,010 − 428,189| = 40,179 ≤ 428,189 × 15% = 64,228.35.
const ftCacheRead: ComponentRow = {
  component: 'ft_cache_read',
  unit: 'tokens',
  actual: 388_010,
  expected: 428_189,
  tolerancePct: 15,
}
// INFO: logged-not-failed arm (no expectation at all).
const tripwireCache: ComponentRow = {
  component: 'tripwire_cache',
  unit: 'usd',
  actual: 0,
  note: 'span 3894 < 4096 — logged, not failed',
}
// PASS with expected 0: delta percent is undefined, rendered as a dash.
const gateCacheWrite: ComponentRow = {
  component: 'gate_cache_write',
  unit: 'tokens',
  actual: 0,
  expected: 0,
  tolerancePct: 10,
}
// INFO with an expectation: comparison shown for context, no band, never asserted.
const prepTotal: ComponentRow = {
  component: 'prep_total',
  unit: 'usd',
  actual: 2.31,
  expected: 2.2,
  informational: true,
}

const ROWS: ComponentRow[] = [
  ftTurn,
  stEval,
  sessionTotal,
  ftCacheRead,
  tripwireCache,
  gateCacheWrite,
  prepTotal,
]

describe('rowStatus', () => {
  it('classifies asserted rows by band and unasserted rows as INFO', () => {
    expect(rowStatus(ftTurn)).toBe('PASS')
    expect(rowStatus(stEval)).toBe('FAIL')
    expect(rowStatus(sessionTotal)).toBe('INFO')
    expect(rowStatus(tripwireCache)).toBe('INFO')
  })

  it('throws when expected is set without tolerancePct (a half-specified assertion)', () => {
    expect(() => rowStatus({ component: 'x', unit: 'usd', actual: 1, expected: 1 })).toThrow(
      /tolerancePct/,
    )
  })
})

describe('renderReport', () => {
  it('renders the one-page table with deltas and a terminal RESULT line', () => {
    const report = renderReport(ROWS)
    expect(report).toMatchInlineSnapshot(`
      "component          actual  expected              delta  band  status
      ----------------  -------  --------  -----------------  ----  -------------------------------------------
      ft_turn_mean      $0.3930   $0.3900   +$0.0030 (+0.8%)  ±20%  PASS
      st_eval_mean      $0.5200   $0.4000  +$0.1200 (+30.0%)  ±20%  FAIL
      session_total     $4.2101         —                  —     —  INFO  informational (S-1)
      ft_cache_read     388,010   428,189    -40,179 (-9.4%)  ±15%  PASS
      tripwire_cache    $0.0000         —                  —     —  INFO  span 3894 < 4096 — logged, not failed
      gate_cache_write        0         0             +0 (—)  ±10%  PASS
      prep_total        $2.3100   $2.2000   +$0.1100 (+5.0%)     —  INFO

      RESULT: FAIL (3 pass, 1 fail, 3 info)"
    `)
  })

  it('fails the report when any row fails, passes when none do', () => {
    expect(renderReport(ROWS)).toContain('RESULT: FAIL (3 pass, 1 fail, 3 info)')
    expect(renderReport([ftTurn, sessionTotal])).toContain('RESULT: PASS (1 pass, 0 fail, 1 info)')
  })

  it('shows signed deltas in both directions', () => {
    const report = renderReport(ROWS)
    expect(report).toContain('+$0.1200 (+30.0%)')
    expect(report).toContain('-40,179 (-9.4%)')
  })

  it('throws on an empty row list (a zero-row report is a runner bug, not a PASS)', () => {
    expect(() => renderReport([])).toThrow(/no components/)
  })
})
