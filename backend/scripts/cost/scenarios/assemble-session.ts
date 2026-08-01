// backend/scripts/cost/scenarios/assemble-session.ts
//
// S-1/S-2 assembly: extracted `llm.call` lines + the expected-costs manifest
// → component rows for the report (cost-wave1 spec §5, S-1/S-2 rows).
//
// Scoping context (Wave-1 review routing): S-1/S-2 windows are scoped by BOTH
// sessionId AND campaignId (FT lines carry campaignId only), so campaign-
// scoped prep-stage lines can legitimately ride inside a session window (a
// next-session prep landing before quiescence). Those are SEGMENTED into
// their own INFO row — never priced into session components, never silently
// absorbed. Lines extractCalls dropped-and-flagged (sessionId + world-gen
// stage = structured-output repairs) are surfaced as a mandatory INFO row.
//
// S-2's ST/gate/tripwire cache arms are MANIFEST-GATED: absent key = arm off
// (rendered INFO with the measured cacheRead% — as-built pre-OPT-1/OPT-7 has
// no session caching). OPT-1/OPT-7 flip them on by adding the manifest keys
// in the same commit (spec §1.2). Gate/tripwire arms are additionally
// span-conditional: measured spanTokens < 4096 renders logged-not-failed
// (spec §3 — below the Haiku minimum the provider silently doesn't cache).

import { SESSION_STAGES, type LlmCallLine } from '../lib/extract.js'
import type { CostEntry } from '../lib/manifest.js'
import { callUsd } from '../lib/usd.js'
import type { ComponentRow } from '../lib/report.js'

export interface SessionAssembleInput {
  readonly calls: LlmCallLine[]
  readonly dropped: LlmCallLine[]
  readonly manifest: Record<string, CostEntry>
  readonly turns: number
}

export interface SessionSegments {
  /** Stage-less lines — the Fast Thinker (stamps ids but no stage). */
  readonly ft: LlmCallLine[]
  /** Session-stage lines, grouped by stage label. */
  readonly byStage: ReadonlyMap<string, LlmCallLine[]>
  /** Foreign-stage lines kept by extraction (campaign-scoped prep stages). */
  readonly prepSegment: LlmCallLine[]
}

export const S1_REQUIRED_KEYS: readonly string[] = [
  's1.ft_usd_per_turn',
  's1.st_eval_usd_mean',
  's1.st_eval_count',
]

export const S2_REQUIRED_KEYS: readonly string[] = ['s2.ft_cache_read_pct']

/** 5-minute ephemeral cache TTL (the only TTL the billing layer admits). */
const CACHE_TTL_MS = 5 * 60_000

/** Haiku 4.5's minimum cacheable prefix (spec §3): below this the provider
 *  silently doesn't cache, so cache arms are logged-not-failed. */
const MIN_CACHEABLE_SPAN_TOKENS = 4_096

export function segmentSessionCalls(calls: LlmCallLine[]): SessionSegments {
  const ft: LlmCallLine[] = []
  const byStage = new Map<string, LlmCallLine[]>()
  const prepSegment: LlmCallLine[] = []
  for (const call of calls) {
    if (call.stage === undefined) ft.push(call)
    else if (SESSION_STAGES.has(call.stage)) {
      const group = byStage.get(call.stage)
      if (group === undefined) byStage.set(call.stage, [call])
      else group.push(call)
    } else prepSegment.push(call)
  }
  return { ft, byStage, prepSegment }
}

function requireEntry(manifest: Record<string, CostEntry>, key: string): CostEntry {
  const entry = manifest[key]
  if (entry === undefined) {
    throw new Error(
      `missing manifest key "${key}" — add it to expected-costs.json (the runner refuses half-assertions)`,
    )
  }
  return entry
}

function requireField(key: string, field: 'usd' | 'count' | 'cacheReadMin', entry: CostEntry): number {
  const value = entry[field]
  if (value === undefined) {
    throw new Error(`manifest key "${key}" must define ${field} for this assertion`)
  }
  return value
}

const sumUsd = (lines: LlmCallLine[]): number => lines.reduce((s, l) => s + callUsd(l), 0)

function cacheReadPct(lines: LlmCallLine[]): number {
  const input = lines.reduce((s, l) => s + l.inputTokens, 0)
  if (input === 0) return 0
  return (100 * lines.reduce((s, l) => s + (l.cacheReadTokens ?? 0), 0)) / input
}

function stageCountsNote(lines: LlmCallLine[]): string {
  const counts = new Map<string, number>()
  for (const l of lines) {
    const stage = l.stage ?? '(none)'
    counts.set(stage, (counts.get(stage) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stage, n]) => `${stage}×${String(n)}`)
    .join(' ')
}

/** Mandatory surfacing of extractCalls' dropped-and-flagged lines. */
function droppedRow(scenario: 's1' | 's2', dropped: LlmCallLine[]): ComponentRow[] {
  if (dropped.length === 0) return []
  return [
    {
      component: `${scenario}.dropped`,
      unit: 'tokens',
      actual: dropped.length,
      informational: true,
      note: `dropped-and-flagged (repair/foreign stages in session scope): ${stageCountsNote(dropped)}`,
    },
  ]
}

function segmentCommon(input: SessionAssembleInput, scenario: 's1' | 's2'): SessionSegments {
  if (input.calls.length === 0) {
    throw new Error(
      `${scenario}: no llm.call lines captured in the window — is the stack running under pnpm dev (logged)?`,
    )
  }
  const seg = segmentSessionCalls(input.calls)
  if (seg.ft.length === 0) {
    throw new Error(
      `${scenario}: no FT lines captured — the worker leg must run under pnpm dev so its stdout lands in dev-worker-<date>.log`,
    )
  }
  return seg
}

export function assembleS1(input: SessionAssembleInput): ComponentRow[] {
  const seg = segmentCommon(input, 's1')
  const { manifest, turns } = input
  const ftEntry = requireEntry(manifest, 's1.ft_usd_per_turn')
  const stEntry = requireEntry(manifest, 's1.st_eval_usd_mean')
  const countEntry = requireEntry(manifest, 's1.st_eval_count')
  const evals = seg.byStage.get('st_eval') ?? []

  const rows: ComponentRow[] = [
    {
      component: 's1.ft_usd_per_turn',
      unit: 'usd',
      actual: sumUsd(seg.ft) / turns,
      expected: requireField('s1.ft_usd_per_turn', 'usd', ftEntry),
      tolerancePct: ftEntry.tolerancePct,
      note: `n=${String(seg.ft.length)} FT lines / ${String(turns)} turns`,
    },
    {
      component: 's1.st_eval_usd_mean',
      unit: 'usd',
      actual: evals.length === 0 ? 0 : sumUsd(evals) / evals.length,
      expected: requireField('s1.st_eval_usd_mean', 'usd', stEntry),
      tolerancePct: stEntry.tolerancePct,
      note: evals.length === 0 ? 'no evals captured' : `n=${String(evals.length)}`,
    },
    {
      component: 's1.st_eval_count',
      unit: 'tokens',
      actual: evals.length,
      expected: requireField('s1.st_eval_count', 'count', countEntry),
      tolerancePct: countEntry.tolerancePct,
    },
  ]

  const auxStages = [...seg.byStage.keys()].filter((s) => s !== 'st_eval').sort()
  for (const stage of auxStages) {
    const lines = seg.byStage.get(stage) ?? []
    rows.push({
      component: `s1.${stage}_usd`,
      unit: 'usd',
      actual: sumUsd(lines),
      informational: true,
      note: `n=${String(lines.length)}`,
    })
  }

  const sessionLines = [...seg.ft, ...[...seg.byStage.values()].flat()]
  rows.push({
    component: 's1.total_usd',
    unit: 'usd',
    actual: sumUsd(sessionLines),
    informational: true,
    note: 'informational (S-1) — session lines only',
  })

  if (seg.prepSegment.length > 0) {
    rows.push({
      component: 's1.prep_segment_usd',
      unit: 'usd',
      actual: sumUsd(seg.prepSegment),
      informational: true,
      note: `campaign-scoped prep lines in-window, NOT in session total: ${stageCountsNote(seg.prepSegment)}`,
    })
  }

  rows.push(...droppedRow('s1', input.dropped))
  return rows
}

/** Per-line cache-health check with the spec's accommodations: the group's
 *  first line may cold-write; a line following a >TTL gap is logged, not
 *  failed. Everything else must have cacheRead > 0. */
function cacheViolations(lines: LlmCallLine[]): { violations: number; ttlGaps: number; note: string } {
  const sorted = [...lines].sort((a, b) => a.time - b.time)
  let violations = 0
  let ttlGaps = 0
  sorted.forEach((line, i) => {
    if ((line.cacheReadTokens ?? 0) > 0) return
    if (i === 0 && (line.cacheWriteTokens ?? 0) > 0) return
    const prev = sorted[i - 1]
    if (prev !== undefined && line.time - prev.time > CACHE_TTL_MS) {
      ttlGaps += 1
      return
    }
    violations += 1
  })
  const note = `n=${String(sorted.length)}; TTL-gap accommodations=${String(ttlGaps)}`
  return { violations, ttlGaps, note }
}

/** One cache arm: manifest-gated, optionally span-conditional (spec §3/§5). */
function cacheArmRows(
  stage: string,
  lines: LlmCallLine[],
  manifest: Record<string, CostEntry>,
  armKey: string,
  spanConditional: boolean,
): ComponentRow[] {
  const entry = manifest[armKey]
  const pctRow = (note: string): ComponentRow => ({
    component: `s2.${stage}_cache_read_pct`,
    unit: 'pct',
    actual: cacheReadPct(lines),
    informational: true,
    note,
  })
  if (entry === undefined) {
    return [pctRow(`arm off — no manifest entry "${armKey}" (flips on with its OPT landing)`)]
  }
  if (spanConditional) {
    const span = entry.spanTokens
    if (span === undefined) {
      throw new Error(`manifest key "${armKey}" must record measured spanTokens (spec §3)`)
    }
    if (span < MIN_CACHEABLE_SPAN_TOKENS) {
      return [
        pctRow(
          `span ${String(span)} < ${String(MIN_CACHEABLE_SPAN_TOKENS)} — logged, not failed (spec §3)`,
        ),
      ]
    }
  }
  const { violations, note } = cacheViolations(lines)
  return [
    {
      component: `s2.${stage}_cache_violations`,
      unit: 'tokens',
      actual: violations,
      expected: 0,
      tolerancePct: entry.tolerancePct,
      note,
    },
  ]
}

export function assembleS2(input: SessionAssembleInput): ComponentRow[] {
  const seg = segmentCommon(input, 's2')
  const { manifest } = input
  const ftEntry = requireEntry(manifest, 's2.ft_cache_read_pct')
  const ftSorted = [...seg.ft].sort((a, b) => a.time - b.time)
  if (ftSorted.length < 2) {
    throw new Error('s2: needs at least two FT lines (turn 1 is the excluded cold write)')
  }
  const warm = ftSorted.slice(1)
  const rows: ComponentRow[] = [
    {
      component: 's2.ft_cache_read_pct',
      unit: 'pct',
      actual: cacheReadPct(warm),
      expected: requireField('s2.ft_cache_read_pct', 'cacheReadMin', ftEntry),
      tolerancePct: ftEntry.tolerancePct,
      direction: 'min',
      note: `excluding first FT line (session cold write); n=${String(warm.length)}`,
    },
  ]
  rows.push(
    ...cacheArmRows('st_eval', seg.byStage.get('st_eval') ?? [], manifest, 's2.st_eval_cache', false),
    ...cacheArmRows('st_gate', seg.byStage.get('st_gate') ?? [], manifest, 's2.st_gate_cache', true),
    ...cacheArmRows(
      'secret_tripwire',
      seg.byStage.get('secret_tripwire') ?? [],
      manifest,
      's2.secret_tripwire_cache',
      true,
    ),
  )
  rows.push(...droppedRow('s2', input.dropped))
  return rows
}
