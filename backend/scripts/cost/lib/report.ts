// backend/scripts/cost/lib/report.ts
//
// The one-page component report the runner prints after asserting a scenario.
// Spec: docs/superpowers/specs/2026-07-31-cost-wave1-harness-caching-trims-design.md §1.1(5).
//
// One row per cost component: actual vs the manifest expectation, signed
// delta (absolute + percent), the tolerance band, and PASS/FAIL. Rows with
// no expectation — informational totals and the spec's logged-not-failed
// arms (>TTL gaps, sub-4096 spans) — render as INFO and never fail the
// report. The terminal RESULT line is the runner's exit-code source: FAIL if
// any asserted row fails ("a red cost smoke is a red smoke").

import { withinBand } from './manifest.js'

export type RowStatus = 'PASS' | 'FAIL' | 'INFO'

export interface ComponentRow {
  readonly component: string
  readonly unit: 'usd' | 'tokens' | 'pct'
  readonly actual: number
  readonly expected?: number | undefined
  readonly tolerancePct?: number | undefined
  /**
   * Assertion shape (default 'band'). 'min' is a floor (S-2's cacheRead ≥
   * 85% — a better-than-expected value must never fail); 'max' is a ceiling
   * (S-4/S-5's "$ ≤ manifest"). tolerancePct loosens the bound one-sided:
   * floor × (1 − tol/100), ceiling × (1 + tol/100). Boundary inclusive.
   */
  readonly direction?: 'band' | 'min' | 'max' | undefined
  /** Informational row: rendered, never asserted (e.g. S-1's in-session total). */
  readonly informational?: boolean | undefined
  /** Free-text annotation, e.g. the logged-not-failed arm's reason. */
  readonly note?: string | undefined
}

/** Effective one-sided bound for a directional row; undefined for band rows. */
function directionalBound(row: ComponentRow): number | undefined {
  if (row.direction !== 'min' && row.direction !== 'max') return undefined
  if (row.expected === undefined || row.tolerancePct === undefined) return undefined
  const factor = row.direction === 'min' ? 1 - row.tolerancePct / 100 : 1 + row.tolerancePct / 100
  return row.expected * factor
}

export function rowStatus(row: ComponentRow): RowStatus {
  if (row.informational === true || row.expected === undefined) return 'INFO'
  if (row.tolerancePct === undefined) {
    throw new Error(
      `report: row "${row.component}" has an expected value but no tolerancePct — half-specified assertion`,
    )
  }
  const bound = directionalBound(row)
  if (bound !== undefined) {
    if (!Number.isFinite(row.actual) || !Number.isFinite(bound)) {
      throw new Error(
        `report: row "${row.component}" has a non-finite actual (${String(row.actual)}) or bound (${String(bound)})`,
      )
    }
    return (row.direction === 'min' ? row.actual >= bound : row.actual <= bound) ? 'PASS' : 'FAIL'
  }
  return withinBand(row.actual, row.expected, row.tolerancePct) ? 'PASS' : 'FAIL'
}

interface Cells {
  readonly component: string
  readonly actual: string
  readonly expected: string
  readonly delta: string
  readonly band: string
  readonly status: string
}

const COLUMNS: readonly { key: keyof Cells; header: string; align: 'left' | 'right' }[] = [
  { key: 'component', header: 'component', align: 'left' },
  { key: 'actual', header: 'actual', align: 'right' },
  { key: 'expected', header: 'expected', align: 'right' },
  { key: 'delta', header: 'delta', align: 'right' },
  { key: 'band', header: 'band', align: 'right' },
  { key: 'status', header: 'status', align: 'left' },
]

function fmtValue(v: number, unit: ComponentRow['unit']): string {
  if (unit === 'usd') return `$${v.toFixed(4)}`
  if (unit === 'pct') return `${v.toFixed(1)}%`
  return Math.round(v).toLocaleString('en-US')
}

function fmtDelta(actual: number, expected: number, unit: ComponentRow['unit']): string {
  const diff = actual - expected
  const sign = diff < 0 ? '-' : '+'
  const abs = `${sign}${fmtValue(Math.abs(diff), unit)}`
  const pct =
    expected === 0 ? '—' : `${sign}${((Math.abs(diff) / expected) * 100).toFixed(1)}%`
  return `${abs} (${pct})`
}

function renderCells(row: ComponentRow, status: RowStatus): Cells {
  const base = {
    component: row.component,
    actual: fmtValue(row.actual, row.unit),
    status: row.note === undefined ? status : `${status}  ${row.note}`,
  }
  if (row.expected === undefined) return { ...base, expected: '—', delta: '—', band: '—' }
  const bound = directionalBound(row)
  const band =
    bound !== undefined
      ? `${row.direction === 'min' ? '≥' : '≤'}${fmtValue(bound, row.unit)}`
      : row.tolerancePct === undefined
        ? '—'
        : `±${String(row.tolerancePct)}%`
  return {
    ...base,
    expected: fmtValue(row.expected, row.unit),
    delta: fmtDelta(row.actual, row.expected, row.unit),
    band,
  }
}

export function renderReport(components: ComponentRow[]): string {
  if (components.length === 0) {
    throw new Error('renderReport: no components — a zero-row report is a runner bug, not a PASS')
  }
  const rendered = components.map((row) => {
    const status = rowStatus(row)
    return { status, cells: renderCells(row, status) }
  })
  const cols = COLUMNS.map((col) => ({
    ...col,
    width: Math.max(col.header.length, ...rendered.map((r) => r.cells[col.key].length)),
  }))
  const line = (get: (col: (typeof cols)[number]) => string): string =>
    cols
      .map((col) => {
        const text = get(col)
        return col.align === 'left' ? text.padEnd(col.width) : text.padStart(col.width)
      })
      .join('  ')
      .trimEnd()
  const pass = rendered.filter((r) => r.status === 'PASS').length
  const fail = rendered.filter((r) => r.status === 'FAIL').length
  const info = rendered.filter((r) => r.status === 'INFO').length
  const result = fail > 0 ? 'FAIL' : 'PASS'
  return [
    line((col) => col.header),
    line((col) => '-'.repeat(col.width)),
    ...rendered.map((r) => line((col) => r.cells[col.key])),
    '',
    `RESULT: ${result} (${String(pass)} pass, ${String(fail)} fail, ${String(info)} info)`,
  ].join('\n')
}
