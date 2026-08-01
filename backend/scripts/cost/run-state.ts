// backend/scripts/cost/run-state.ts
//
// Cross-invocation run state for the cost-smoke runner. S-2 re-asserts S-1's
// capture window (spec §5) without re-driving the session, so a successful
// scenario run persists its window + scope ids to a small JSON file under
// backend/logs/cost-smoke/ (gitignored with the rest of logs/). Strictly
// validated on load — a stale or hand-mangled file must fail loudly, not
// scope a capture to garbage.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

export interface CapturedRun {
  readonly scenario: string
  readonly window: { readonly fromMs: number; readonly toMs: number }
  readonly campaignId?: string | undefined
  readonly sessionId?: string | undefined
  readonly turns?: number | undefined
  /** ISO timestamp of the drive's completion, for staleness warnings. */
  readonly completedAt: string
}

const capturedRunSchema = z.strictObject({
  scenario: z.string().min(1),
  window: z.strictObject({ fromMs: z.number(), toMs: z.number() }),
  campaignId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  turns: z.number().int().positive().optional(),
  completedAt: z.string().min(1),
})

function statePath(dir: string, scenario: string): string {
  return join(dir, `last-${scenario}.json`)
}

export function saveRun(dir: string, run: CapturedRun): string {
  mkdirSync(dir, { recursive: true })
  const path = statePath(dir, run.scenario)
  writeFileSync(path, `${JSON.stringify(capturedRunSchema.parse(run), null, 2)}\n`)
  return path
}

export function loadRun(dir: string, scenario: string): CapturedRun {
  const path = statePath(dir, scenario)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(
      `no saved ${scenario} run at ${path} — run \`cost-smoke ${scenario}\` after the scenario it re-asserts (s2 re-asserts s1's window)`,
      { cause: err },
    )
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`saved run ${path} is not valid JSON`, { cause: err })
  }
  const parsed = capturedRunSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(`saved run ${path} failed validation: ${parsed.error.message}`)
  }
  return parsed.data
}
