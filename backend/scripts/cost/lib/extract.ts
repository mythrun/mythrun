// backend/scripts/cost/lib/extract.ts
//
// NDJSON `llm.call` extraction for the cost-assertion harness.
// Spec: docs/superpowers/specs/2026-07-31-cost-wave1-harness-caching-trims-design.md §1.0-1.1.
//
// Pure log plumbing: read the two dev-log legs (`dev-<date>.log` API +
// `dev-worker-<date>.log` worker — queue-driven calls log to the worker,
// in-request calls to the API), keep the scenario's calls by capture window +
// scenario-correlated ids, and DROP-AND-FLAG session-attributed lines that
// carry an unknown or world-gen stage. That last arm is not defensive
// paranoia: ai.ts `extractStage` re-stamps structured-output REPAIR calls
// with a world-gen stage (unknown stages narrow to `concept_intake`), so a
// mid-session repair line would otherwise be silently priced into a session
// component. Prep windows (S-4/S-5) are unaffected — their lines carry
// campaignId but never sessionId, so world-gen stages there stay in `calls`.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LlmCallLine {
  time: number
  model: string
  stage?: string | undefined
  sessionId?: string | undefined
  campaignId?: string | undefined
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number | undefined
  cacheWriteTokens?: number | undefined
}

export interface CaptureWindow {
  readonly fromMs: number
  readonly toMs: number
}

/**
 * The per-session call-site labels Task 1 stamps via
 * `providerOptions.mythrun.stage` (plan Task 1 Produces / spec §1.0). A
 * session-attributed line whose stage is NOT in this set is dropped-and-
 * flagged. If a future call site adds a label without updating this set, the
 * failure direction is loud (the runner reports flagged drops), never a
 * silent miscount.
 */
export const SESSION_STAGES: ReadonlySet<string> = new Set([
  'st_eval',
  'st_gate',
  'turn_audit',
  'dm_trigger',
  'secret_tripwire',
  'skill_check_dc',
  'input_gate',
  'profanity_gate',
  'st_narrative_progress',
  'st_lookup_vet',
  'world_lookup_gate',
  'session_reconcile',
  'post_session_analysis',
  // 749b3d65 additions: retcon author (scribe handleBreach, hard_reveal only)
  // and the FT combat-outcome call — both session spend, both absent from
  // scripted baselines (no breaches, no combat) but never drop-and-flagged.
  'retcon_author',
  'ft_combat_outcome',
])

function assertWindow(window: CaptureWindow): void {
  if (!Number.isFinite(window.fromMs) || !Number.isFinite(window.toMs) || window.fromMs > window.toMs) {
    throw new Error(
      `invalid capture window: fromMs=${String(window.fromMs)} toMs=${String(window.toMs)}`,
    )
  }
}

/** Parse one NDJSON line into an LlmCallLine, or undefined for everything
 *  else (non-JSON runner noise, boot lines, `llm.call.started`, `llm.error`,
 *  and structurally incomplete `llm.call` lines). */
function parseLlmCallLine(raw: string): LlmCallLine | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const rec = parsed as Record<string, unknown>
  if (rec.event !== 'llm.call') return undefined
  const { time, model, inputTokens, outputTokens } = rec
  if (typeof time !== 'number' || typeof model !== 'string') return undefined
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined
  return {
    time,
    model,
    inputTokens,
    outputTokens,
    stage: typeof rec.stage === 'string' ? rec.stage : undefined,
    sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : undefined,
    campaignId: typeof rec.campaignId === 'string' ? rec.campaignId : undefined,
    cacheReadTokens: typeof rec.cacheReadTokens === 'number' ? rec.cacheReadTokens : undefined,
    cacheWriteTokens: typeof rec.cacheWriteTokens === 'number' ? rec.cacheWriteTokens : undefined,
  }
}

/** Session-attributed (carries a sessionId) AND carrying a stage that is not
 *  a known session stage — the misattribution arm. Lines with no stage at
 *  all are kept: the FT stamps ids but no stage, and the drop rule is
 *  spec-literal ("lines CARRYING unknown or world-gen stages"). */
function isForeignSessionStage(line: LlmCallLine): boolean {
  return (
    line.sessionId !== undefined && line.stage !== undefined && !SESSION_STAGES.has(line.stage)
  )
}

/**
 * Extract the scenario's `llm.call` lines from the given NDJSON files.
 *
 * A line is in scope when its `time` falls inside the window (inclusive both
 * ends) AND its sessionId or campaignId is one of `scopeIds`. Nonexistent
 * paths are skipped — `logPathsForWindow` names candidates per date and a
 * leg's file legitimately may not exist for every date the window touches.
 */
export function extractCalls(
  ndjsonPaths: string[],
  window: { fromMs: number; toMs: number },
  scopeIds: string[],
): { calls: LlmCallLine[]; dropped: LlmCallLine[] } {
  assertWindow(window)
  if (scopeIds.length === 0) {
    throw new Error(
      'extractCalls: scopeIds must be non-empty — without ids, scenario scoping degrades to timestamps (spec §1.0)',
    )
  }
  const scope = new Set(scopeIds)
  const calls: LlmCallLine[] = []
  const dropped: LlmCallLine[] = []
  for (const path of ndjsonPaths) {
    if (!existsSync(path)) continue
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const line = parseLlmCallLine(raw)
      if (line === undefined) continue
      if (line.time < window.fromMs || line.time > window.toMs) continue
      const inScope =
        (line.sessionId !== undefined && scope.has(line.sessionId)) ||
        (line.campaignId !== undefined && scope.has(line.campaignId))
      if (!inScope) continue
      if (isForeignSessionStage(line)) dropped.push(line)
      else calls.push(line)
    }
  }
  const byTime = (a: LlmCallLine, b: LlmCallLine): number => a.time - b.time
  calls.sort(byTime)
  dropped.sort(byTime)
  return { calls, dropped }
}

/**
 * Extract in-window `llm.call` lines that carry one of the named stages and
 * NO ids at all (neither sessionId nor campaignId) — the S-4/S-5 arm for
 * in-request calls that run BEFORE any campaign row exists (input gate,
 * preview-time concept_intake), which id-scoped extraction can never see.
 * Restricted to id-less lines so a line can never be counted by both this
 * and `extractCalls` (double-pricing).
 */
export function extractStageOnlyCalls(
  ndjsonPaths: string[],
  window: CaptureWindow,
  stages: readonly string[],
): LlmCallLine[] {
  assertWindow(window)
  if (stages.length === 0) {
    throw new Error('extractStageOnlyCalls: stages must be non-empty')
  }
  const wanted = new Set(stages)
  const lines: LlmCallLine[] = []
  for (const path of ndjsonPaths) {
    if (!existsSync(path)) continue
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const line = parseLlmCallLine(raw)
      if (line === undefined) continue
      if (line.time < window.fromMs || line.time > window.toMs) continue
      if (line.sessionId !== undefined || line.campaignId !== undefined) continue
      if (line.stage === undefined || !wanted.has(line.stage)) continue
      lines.push(line)
    }
  }
  lines.sort((a, b) => a.time - b.time)
  return lines
}

/** Local date as `YYYY-MM-DD`, matching dev-logged.sh's `date +%F` naming. */
function localDateStr(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${String(d.getFullYear())}-${mm}-${dd}`
}

/**
 * Candidate log paths for a capture window: for every LOCAL date the window
 * touches PLUS the preceding date, both legs (`dev-<date>.log`,
 * `dev-worker-<date>.log`). The preceding date is unconditional: a long-lived
 * process keeps appending to its boot-date file across midnight (static
 * shell redirects don't roll), so a post-midnight window's lines can sit in
 * yesterday's files — the time filter in `extractCalls` keeps correctness.
 * Pure name computation; `extractCalls` tolerates candidates that don't
 * exist on disk.
 */
export function logPathsForWindow(logDir: string, window: CaptureWindow): string[] {
  assertWindow(window)
  const paths: string[] = []
  const cursor = new Date(window.fromMs)
  cursor.setHours(0, 0, 0, 0)
  cursor.setDate(cursor.getDate() - 1)
  while (cursor.getTime() <= window.toMs) {
    const date = localDateStr(cursor)
    paths.push(join(logDir, `dev-${date}.log`), join(logDir, `dev-worker-${date}.log`))
    cursor.setDate(cursor.getDate() + 1)
  }
  return paths
}
