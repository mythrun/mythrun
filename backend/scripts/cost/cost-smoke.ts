// backend/scripts/cost/cost-smoke.ts
//
// The cost-assertion runner (cost-wave1 spec §1.1):
//
//   cost-smoke.ts <s1|s2|s4|s5>        (from backend/: pnpm cost:smoke <id>)
//   cost-smoke.ts s1 --turns N         (shorter S-1 drives; default 12)
//   cost-smoke.ts <id> --reassert      (re-extract + re-assert the LAST saved
//                                       run's window — no drive, no spend;
//                                       how manifest edits are verified
//                                       without re-burning a scenario)
//
// 1. Loads expected-costs.json and pre-checks the scenario's required keys —
//    money is spent only when every static expectation exists.
// 2. Asserts the RUNNING local stack (refuses to boot its own; the liveness
//    probe proves the serving process logs to TODAY'S dev log files).
// 3. Executes the scenario (S-2 re-asserts S-1's saved window, no re-drive).
// 4. Captures `llm.call` NDJSON from BOTH dev-log legs over the window,
//    scoped by the scenario's ids (+ the window+stage-scoped id-less arm).
// 5. Prints a capture summary (per stage×model: calls/$/tokens) BEFORE
//    assembling — so a loud assembly failure (missing manifest key on a
//    first-ever run) still yields the numbers needed to seed the manifest.
// 6. Assembles component rows, prints the one-page report, exits non-zero
//    if any asserted row fails. A red cost smoke is a red smoke.
//
// Real-Anthropic, on-demand only — never wired into pre-push/CI.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractCalls, extractStageOnlyCalls, logPathsForWindow, type LlmCallLine } from './lib/extract.js'
import { loadManifest } from './lib/manifest.js'
import { renderReport, rowStatus } from './lib/report.js'
import { callUsd } from './lib/usd.js'
import { assertLiveStack } from './liveness.js'
import { loadRun, saveRun, type CapturedRun } from './run-state.js'
import { parseScenarioId, SCENARIOS, type ScenarioId } from './scenarios/registry.js'
import { runS1 } from './scenarios/s1-driver.js'
import { runS4 } from './scenarios/s4-driver.js'
import { runS5 } from './scenarios/s5-driver.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG_DIR = join(HERE, '..', '..', 'logs')
const STATE_DIR = join(LOG_DIR, 'cost-smoke')
const MANIFEST_PATH = join(HERE, 'expected-costs.json')

interface RunnerEnv {
  readonly baseUrl: string
  readonly wsUrl: string
  readonly devSub: string
  readonly workerHealthUrl: string
}

function env(): RunnerEnv {
  return {
    baseUrl: process.env.S1_BASE_URL ?? 'http://localhost:3030',
    wsUrl: process.env.S1_WS_URL ?? 'ws://localhost:3030',
    devSub: process.env.S1_DEV_SUB ?? 'dev-user-1',
    workerHealthUrl: process.env.COST_SMOKE_WORKER_HEALTH_URL ?? 'http://localhost:3001/health',
  }
}

function parseTurnsFlag(argv: readonly string[]): number | undefined {
  const i = argv.indexOf('--turns')
  if (i === -1) return undefined
  const n = Number(argv[i + 1])
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--turns expects a positive integer, got ${argv[i + 1] ?? '(missing)'}`)
  }
  return n
}

async function execute(id: ScenarioId, e: RunnerEnv, turns: number | undefined): Promise<CapturedRun> {
  const completedAt = (): string => new Date().toISOString()
  if (id === 's1') {
    const opts = { baseUrl: e.baseUrl, wsUrl: e.wsUrl, devSub: e.devSub, ...(turns === undefined ? {} : { turns }) }
    const r = await runS1(opts)
    return {
      scenario: 's1',
      window: r.window,
      campaignId: r.campaignId,
      sessionId: r.sessionId,
      turns: turns ?? 12,
      completedAt: completedAt(),
    }
  }
  if (id === 's2') {
    throw new Error('s2 never drives — it re-asserts s1\'s saved window (handled in main)')
  }
  if (id === 's4') {
    const r = await runS4({ baseUrl: e.baseUrl, devSub: e.devSub })
    return { scenario: 's4', window: r.window, campaignId: r.campaignId, completedAt: completedAt() }
  }
  const r = await runS5({ baseUrl: e.baseUrl, devSub: e.devSub })
  return { scenario: 's5', window: r.window, campaignId: r.campaignId, completedAt: completedAt() }
}

const sumUsd = (lines: readonly LlmCallLine[]): number => lines.reduce((s, l) => s + callUsd(l), 0)

/** Per stage×model capture summary — printed BEFORE assembly so a loud
 *  missing-manifest-key failure still yields seed numbers. */
function captureSummary(calls: LlmCallLine[], dropped: LlmCallLine[], stageOnly: LlmCallLine[]): string {
  const groups = new Map<string, { n: number; usd: number; tokensIn: number; tokensOut: number; cacheRead: number }>()
  const add = (line: LlmCallLine, tag: string): void => {
    const key = `${line.stage ?? '(no stage)'} · ${line.model}${tag}`
    const g = groups.get(key) ?? { n: 0, usd: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0 }
    g.n += 1
    g.usd += callUsd(line)
    g.tokensIn += line.inputTokens
    g.tokensOut += line.outputTokens
    g.cacheRead += line.cacheReadTokens ?? 0
    groups.set(key, g)
  }
  for (const l of calls) add(l, '')
  for (const l of stageOnly) add(l, ' [id-less]')
  for (const l of dropped) add(l, ' [DROPPED]')
  const lines = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, g]) =>
        `  ${key}: n=${String(g.n)} $${g.usd.toFixed(4)} in=${String(g.tokensIn)} (cacheRead=${String(g.cacheRead)}) out=${String(g.tokensOut)}`,
    )
  return ['capture summary (stage · model):', ...lines].join('\n')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const id = parseScenarioId(argv[0])
  const turns = parseTurnsFlag(argv)
  const reassert = argv.includes('--reassert')
  const scenario = SCENARIOS[id]
  const e = env()

  // 1. Manifest + required-key pre-check BEFORE any live drive.
  const manifest = loadManifest(MANIFEST_PATH)
  const missing = scenario.requiredManifestKeys.filter((k) => manifest[k] === undefined)
  if (missing.length > 0) {
    throw new Error(
      `expected-costs.json is missing required ${id} keys: ${missing.join(', ')} — seed them before driving (the runner refuses half-assertions)`,
    )
  }

  // 2. Liveness (skipped when nothing will be driven — s2 and --reassert
  //    only re-read logs already on disk).
  const drives = id !== 's2' && !reassert
  if (drives) {
    await assertLiveStack({ baseUrl: e.baseUrl, workerHealthUrl: e.workerHealthUrl, logDir: LOG_DIR })
  }

  // 3. Drive (or reload the saved run's window).
  const driveStartMs = Date.now()
  const run = drives ? await execute(id, e, turns) : loadRun(STATE_DIR, id === 's2' ? 's1' : id)
  if (drives) saveRun(STATE_DIR, run)
  if (!drives) {
    const ageMs = Date.now() - new Date(run.completedAt).getTime()
    if (ageMs > 24 * 60 * 60 * 1000) {
      process.stdout.write(
        `WARNING: saved ${run.scenario} run is ${(ageMs / 3_600_000).toFixed(1)}h old — its log lines may have rotated away\n`,
      )
    }
  }

  // 4. Capture.
  const paths = logPathsForWindow(LOG_DIR, run.window)
  const scopeIds = scenario.scopeIds(run)
  const { calls, dropped } = extractCalls(paths, run.window, scopeIds)
  const stageOnly =
    scenario.stageOnlyStages.length === 0
      ? []
      : extractStageOnlyCalls(paths, run.window, scenario.stageOnlyStages)

  // Budget-tracking spend: the drive may cost money BEFORE the window opens
  // (S-1's fixture reload re-runs session prep). Same scope, wider window.
  const wallWindow = { fromMs: Math.min(driveStartMs, run.window.fromMs), toMs: run.window.toMs }
  const wall = extractCalls(paths, wallWindow, scopeIds)
  const wallStageOnly =
    scenario.stageOnlyStages.length === 0
      ? []
      : extractStageOnlyCalls(paths, wallWindow, scenario.stageOnlyStages)
  const windowUsd = sumUsd(calls) + sumUsd(dropped) + sumUsd(stageOnly)
  const wallUsd = sumUsd(wall.calls) + sumUsd(wall.dropped) + sumUsd(wallStageOnly)

  const header = [
    `scenario ${id} — ${scenario.description}`,
    `window ${new Date(run.window.fromMs).toISOString()} → ${new Date(run.window.toMs).toISOString()} (${((run.window.toMs - run.window.fromMs) / 1000).toFixed(0)}s)`,
    `scope ${scopeIds.join(', ')}`,
    `spend: window $${windowUsd.toFixed(4)} · drive total $${wallUsd.toFixed(4)} (incl. pre-window prep)`,
  ].join('\n')
  process.stdout.write(`\n${header}\n\n${captureSummary(calls, dropped, stageOnly)}\n\n`)

  // 5-6. Assemble + report + exit code.
  const rows = scenario.assemble({ run, calls, dropped, stageOnly, manifest })
  process.stdout.write(`${renderReport(rows)}\n`)
  const failed = rows.some((r) => rowStatus(r) === 'FAIL')
  process.exit(failed ? 1 : 0)
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
