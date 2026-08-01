// backend/scripts/cost/scenarios/assemble-prep.ts
//
// S-4/S-5 assembly (cost-wave1 spec §5): per-stage $ ceilings, PER-MODEL
// scoped. The manifest key is `<prefix>.<stage>.<model>` — "configured model
// asserted" is structural: a model swap or an unexpected stage has no key
// and throws, never silently prices under the wrong expectation. Stage
// retry/repair cost is counted separately: each group prices ALL its calls
// against the ceiling (a retry IS extra spend — a red cost smoke is a red
// smoke), and calls beyond the pinned per-group `count` are aggregated into
// a dedicated excess row so the report explains WHY a group went red.
//
// Per spec §4 (OPT-8 retired): S-4/S-5 carry NO retry-cache assertions.
// Id-less lines (in-request calls that predate the campaign row: input
// gate, preview-time concept_intake) arrive via `stageOnly` (window+stage
// scoped) and join as their own noted group; quiet-stack discipline is what
// keeps them attributable.

import type { LlmCallLine } from '../lib/extract.js'
import type { CostEntry } from '../lib/manifest.js'
import { callUsd } from '../lib/usd.js'
import type { ComponentRow } from '../lib/report.js'

export interface PrepAssembleInput {
  readonly prefix: 's4' | 's5'
  readonly calls: LlmCallLine[]
  readonly stageOnly: LlmCallLine[]
  readonly dropped: LlmCallLine[]
  readonly manifest: Record<string, CostEntry>
}

const sumUsd = (lines: LlmCallLine[]): number => lines.reduce((s, l) => s + callUsd(l), 0)

interface Group {
  readonly key: string
  readonly stage: string
  readonly model: string
  readonly lines: LlmCallLine[]
  readonly idLess: boolean
}

function groupByStageModel(input: PrepAssembleInput): Group[] {
  const groups = new Map<string, Group>()
  const add = (line: LlmCallLine, idLess: boolean): void => {
    if (line.stage === undefined) {
      throw new Error(
        `${input.prefix}: stage-less llm.call line in a prep window (model ${line.model}, t=${String(line.time)}) — prep lines must carry a stage`,
      )
    }
    const key = `${input.prefix}.${line.stage}.${line.model}`
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, { key, stage: line.stage, model: line.model, lines: [line], idLess })
    } else existing.lines.push(line)
  }
  for (const line of input.calls) add(line, false)
  for (const line of input.stageOnly) add(line, true)
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))
}

function requireEntry(manifest: Record<string, CostEntry>, key: string): CostEntry {
  const entry = manifest[key]
  if (entry === undefined) {
    throw new Error(
      `missing manifest key "${key}" — unexpected stage×model group (model swap? new stage?) or an unseeded manifest; add the entry to expected-costs.json`,
    )
  }
  return entry
}

function requireUsd(key: string, entry: CostEntry): number {
  if (entry.usd === undefined) {
    throw new Error(`manifest key "${key}" must define usd for this ceiling`)
  }
  return entry.usd
}

function groupRow(group: Group, entry: CostEntry): ComponentRow {
  const notes = [
    `n=${String(group.lines.length)}${entry.count === undefined ? ' (count unpinned)' : ` (expected ${String(entry.count)})`}`,
  ]
  if (group.idLess) notes.push('id-less (window+stage scoped)')
  return {
    component: group.key,
    unit: 'usd',
    actual: sumUsd(group.lines),
    expected: requireUsd(group.key, entry),
    tolerancePct: entry.tolerancePct,
    direction: 'max',
    note: notes.join('; '),
  }
}

/** Cost of calls beyond each group's pinned count (later calls by time —
 *  retries/repairs come after the happy-path call). */
function excessRow(prefix: string, groups: Group[], manifest: Record<string, CostEntry>): ComponentRow[] {
  let excessUsd = 0
  const noted: string[] = []
  for (const group of groups) {
    const count = manifest[group.key]?.count
    if (count === undefined || group.lines.length <= count) continue
    const later = [...group.lines].sort((a, b) => a.time - b.time).slice(count)
    excessUsd += sumUsd(later)
    noted.push(`${group.stage}×${String(later.length)}`)
  }
  if (noted.length === 0) return []
  return [
    {
      component: `${prefix}.excess_calls_usd`,
      unit: 'usd',
      actual: excessUsd,
      informational: true,
      note: `retry/repair calls beyond pinned counts: ${noted.join(' ')}`,
    },
  ]
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

export function assemblePrep(input: PrepAssembleInput): ComponentRow[] {
  if (input.calls.length + input.stageOnly.length === 0) {
    throw new Error(
      `${input.prefix}: no llm.call lines captured in the window — is the stack running under pnpm dev (logged)?`,
    )
  }
  const totalKey = `${input.prefix}.total_usd`
  const totalEntry = requireEntry(input.manifest, totalKey)
  const groups = groupByStageModel(input)
  const rows: ComponentRow[] = groups.map((g) => groupRow(g, requireEntry(input.manifest, g.key)))
  rows.push(...excessRow(input.prefix, groups, input.manifest))
  rows.push({
    component: totalKey,
    unit: 'usd',
    actual: sumUsd([...input.calls, ...input.stageOnly]),
    expected: requireUsd(totalKey, totalEntry),
    tolerancePct: totalEntry.tolerancePct,
    direction: 'max',
  })
  if (input.dropped.length > 0) {
    rows.push({
      component: `${input.prefix}.dropped`,
      unit: 'tokens',
      actual: input.dropped.length,
      informational: true,
      note: `dropped-and-flagged: ${stageCountsNote(input.dropped)}`,
    })
  }
  return rows
}
