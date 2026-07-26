// backend/src/session/st-converge-probe.ts
//
// myth-3jna1 — the convergence probe: the ST pipeline's one call to the
// narrative-progress judgment, plus the fail-quiet posture around it.
//
// Split out of st-evaluation-worker.ts so the worker stays a readable ordered
// shell (and under the module cap). The DETERMINISTIC comparison lives in
// converge-policy.ts, the JUDGMENT lives in llm/st-narrative-progress.ts, and
// this module is the seam that joins them and decides what happens when the
// judgment is unavailable.
//
// SECRET-SIDE. The probe reads the whole sd_playbook — arc position is not
// judgeable without the session goals and the revelation list. The ONLY value
// that leaves this module is a boolean plus a token count. The fraction is
// logged (a number carries no secret, and tuning the thresholds needs it); the
// model's `basis` — secret-aware prose ABOUT the playbook — is deliberately not
// logged and has no consumer anywhere. Nothing here can reach a Fast Thinker
// call or a client channel: its caller turns the boolean into a flag on the ST
// director's prompt, and the ST writes the actual direction in its own words.

import type { runStNarrativeProgress } from '../llm/st-narrative-progress.js'
import { isConverging } from './converge-policy.js'
import { usageTokens } from './st-usage.js'

interface ProbeLogger {
  info: (o: Record<string, unknown> | string, m?: string) => void
  warn: (o: Record<string, unknown> | string, m?: string) => void
}

export interface ConvergeProbeDeps {
  runNarrativeProgress: typeof runStNarrativeProgress
  readonly logger: ProbeLogger
}

export interface ConvergeProbeResult {
  /** True iff the story is behind the spend by more than the lag margin. */
  readonly converge: boolean
  /** Tokens this probe spent, for the `:usage:st` accumulator. */
  readonly tokens: number
}

/** The out-of-window (and probe-failure) result: no steer, nothing spent. */
export const NO_CONVERGE: ConvergeProbeResult = { converge: false, tokens: 0 }

export interface ConvergeProbeContext {
  readonly sdPlaybook: string
  readonly runningSummary: string
  readonly recentExchanges: string
}

/**
 * Ask how far through the prep's intended arc the table actually is, and
 * compare that against how much of the session has been spent.
 *
 * FAIL-QUIET. A probe failure returns `converge:false`, so the cycle degrades
 * to EXACTLY the pre-steer behaviour — the Haiku gate decides whether the ST
 * runs, and the wind-down arm remains the backstop — rather than to a spurious
 * early steer that would eat paid session on no information at all.
 */
export async function probeConvergence(
  deps: ConvergeProbeDeps,
  campaignId: string,
  mechanical: number,
  ctx: ConvergeProbeContext,
): Promise<ConvergeProbeResult> {
  try {
    const probe = await deps.runNarrativeProgress({
      sdPlaybook: ctx.sdPlaybook,
      runningSummary: ctx.runningSummary,
      recentExchanges: ctx.recentExchanges,
    })
    const converge = isConverging(mechanical, probe.result.progress)
    deps.logger.info(
      { campaignId, mechanical, narrative: probe.result.progress, converge },
      'st-eval convergence probe',
    )
    return { converge, tokens: usageTokens(probe.usage) }
  } catch (err) {
    deps.logger.warn(
      { err, campaignId },
      'st-eval: convergence probe failed; no converge steer this cycle',
    )
    return NO_CONVERGE
  }
}
