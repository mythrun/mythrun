// backend/scripts/cost/liveness.ts
//
// The runner's liveness precondition (cost-wave1 spec §1.1(1)): the runner
// targets the RUNNING local stack and refuses to boot its own; the
// precondition includes "expected log files present and fresh".
//
// "Fresh" is verified END-TO-END, not by mtime alone: the serving process on
// :3030 must be a process whose stdout lands in the dev log files. The
// observed failure mode this closes (2026-07-31): a raw `tsx watch` stack
// served :3030 while `pnpm dev`'s logging wrapper wasn't running — health
// checks passed, every llm.call line went to a terminal, and a capture
// window over the log files came back empty. The probe hits /health
// (request logging is on in dev) and requires the API leg to GROW within a
// few seconds in TODAY'S or YESTERDAY'S file — yesterday counts because a
// long-lived process appends to its boot-date file across midnight, and
// logPathsForWindow always includes the previous date's files.

import { statSync } from 'node:fs'
import { join } from 'node:path'

export interface LivenessOpts {
  readonly baseUrl: string
  readonly workerHealthUrl: string
  readonly logDir: string
}

const GROW_PROBE_TIMEOUT_MS = 5_000
const GROW_PROBE_POLL_MS = 250

function localDateStr(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${String(d.getFullYear())}-${mm}-${dd}`
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return -1
  }
}

async function checkHealth(url: string, what: string): Promise<void> {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(3_000) })
  } catch (err) {
    throw new Error(
      `${what} health check failed (${url}) — the runner refuses to boot its own stack; start it with \`pnpm dev\` from backend/`,
      { cause: err },
    )
  }
  if (!res.ok) {
    throw new Error(`${what} health check returned ${String(res.status)} (${url})`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Assert the live stack is up AND logging to today's dev log files. */
export async function assertLiveStack(opts: LivenessOpts): Promise<void> {
  await checkHealth(`${opts.baseUrl}/health`, 'API')
  await checkHealth(opts.workerHealthUrl, 'worker')

  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const todayLog = join(opts.logDir, `dev-${localDateStr(now)}.log`)
  const yesterdayLog = join(opts.logDir, `dev-${localDateStr(yesterday)}.log`)
  const todayBefore = fileSize(todayLog)
  const yesterdayBefore = fileSize(yesterdayLog)

  // Trigger a request-log line, then require the API leg to grow in TODAY'S
  // or YESTERDAY'S file. Yesterday counts as fresh: a long-lived process
  // keeps appending to its boot-date file across midnight, and
  // logPathsForWindow always includes the previous date's files — so a
  // boot-date writer is a fully captured configuration, not a failure.
  await checkHealth(`${opts.baseUrl}/health`, 'API')
  const deadline = Date.now() + GROW_PROBE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (fileSize(todayLog) > todayBefore) return
    if (fileSize(yesterdayLog) > yesterdayBefore) return
    await sleep(GROW_PROBE_POLL_MS)
  }
  throw new Error(
    `API on ${opts.baseUrl} is serving but nothing landed in ${todayLog} (or ${yesterdayLog}) — the stack's stdout is not reaching the log files, so llm.call lines are unreachable. Restart the stack with per-leg logging (pnpm dev or the hardened redirect shape).`,
  )
}
