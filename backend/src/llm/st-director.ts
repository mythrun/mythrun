// backend/src/llm/st-director.ts
//
// MYT-69 §4 — the Opus ST evaluation. generateObject through the canonical
// ai.ts wrapper, repair 'haiku-then-sonnet'. CRITICAL: the wrapper's
// repairAttempted flag is surfaced UNCHANGED — the worker discards the entire
// result when it is true (a repaired `direction` is text the ST did not
// author; the single-gate argument requires it). maxOutputTokens is set
// explicitly (reasoning + direction + a full summary rewrite is long).

import { randomUUID } from 'node:crypto'
import { generateObject, type LanguageModelUsage, type PromptBlocks } from './ai.js'
import { loadPrompt } from './prompts.js'
import { StDirectorResultSchema, type StDirectorResult } from './schemas/st-director.js'
import {
  ST_EVAL_MAX_OUTPUT_TOKENS,
  ST_EVAL_TIMEOUT_MS,
  ST_MODEL,
  ST_SUMMARY_TARGET_WORDS,
} from '../session/st-config.js'

const WIND_DOWN_INSTRUCTION =
  'WIND-DOWN MODE IS ACTIVE: the session is near its token budget. Set a STANDING directive that steers toward a natural close (resolve the current scene, open no new threads or NPCs), and keep directing toward closure on subsequent evaluations.'

// myth-3jna1 — the stage BEFORE wind-down. Not "close now" but "start drawing
// toward somewhere this can rest", issued while there is still session left to
// land in. Deliberately carries NO number and NO arc position: the ST is told
// the mode, never the measurement, and the last clause is what keeps the
// resulting standing text craft-only when it crosses to the blind narrator.
const CONVERGE_INSTRUCTION =
  'CONVERGENCE MODE IS ACTIVE: more of this session has been spent than the story has delivered. Fold a STANDING steer into the standing directive that starts drawing the table toward a resting point — land the beats that still matter, bring the live thread somewhere it can be set down, and open nothing that would need another session to finish. Phrase it as CRAFT ONLY: the narrator must never learn why it is converging, and the steer must carry no reason, no arc position, and no mention of a session ending.'

export interface StDirectorInput {
  readonly partyRoster: string
  readonly sdPlaybook: string
  readonly runningSummary: string
  readonly currentStandingDirective: string
  readonly pendingOneShot: string
  readonly recentExchanges: string
  readonly windDown: boolean
  /** myth-3jna1 — the convergence steer. A BOOLEAN, never the narrative-progress
   *  fraction it was derived from: the ST already holds the playbook, so the
   *  mode is all it needs, and keeping the number out of the prompt keeps the
   *  measurement on the code side where it can never be paraphrased into a
   *  direction. Mutually exclusive with `windDown` by construction — the
   *  worker never probes for convergence once wind-down is active. */
  readonly converge: boolean
  /** Cost-harness scope id (cost wave 1 §1.0) — rides providerOptions.mythrun
   *  only, NEVER the prompt. */
  readonly sessionId: string
}

export interface StDirectorOutput {
  readonly result: StDirectorResult
  readonly usage: LanguageModelUsage
  readonly repairAttempted: boolean
}

// OPT-1 (cost wave 1 §3) — stable-first blocks. The template is ONE file in
// model-visible order with two {{block_boundary}} markers; it renders once,
// splits into [system head | stable span | volatile tail], and rides the ai.ts
// blocks seam. Breakpoints: the head (static instructions — the span is shared
// across sessions) and the stable-span end (roster + playbook — per-session
// stable), so every eval after a session's first reads head+roster+playbook
// from cache. The marker interpolates to a per-process random sentinel BEFORE
// the split: interpolation is a single pass over the TEMPLATE, values are
// never re-scanned, so a literal "{{block_boundary}}" typed into player chat
// renders verbatim and can never mint a boundary.
export const BLOCK_BOUNDARY_SENTINEL = `<<st-eval-block-boundary ${randomUUID()}>>`

/** Splits a RENDERED st-evaluation template on the boundary sentinel. Exactly
 *  two markers, so exactly three parts: fewer means template drift, more would
 *  move a cache breakpoint silently. Exported for the marker-validation tests
 *  (the drifted templates never reach disk) — same shape as the gate and
 *  tripwire splitters. */
export function splitStEvaluationTemplate(rendered: string): {
  head: string
  stable: string
  volatileTail: string
} {
  const [head, stable, volatileTail, ...rest] = rendered.split(BLOCK_BOUNDARY_SENTINEL)
  if (head === undefined || stable === undefined || volatileTail === undefined) {
    throw new Error(
      'st-evaluation template must carry exactly two {{block_boundary}} markers (found too few) — template drifted; re-derive the cache breakpoints (cost-wave1 §3)',
    )
  }
  if (rest.length > 0) {
    throw new Error(
      `st-evaluation template must carry exactly two {{block_boundary}} markers (found ${String(rest.length + 2)}) — the cut points are ambiguous; re-derive the cache breakpoints (cost-wave1 §3)`,
    )
  }
  return { head, stable, volatileTail }
}

function stEvaluationBlocks(input: StDirectorInput): PromptBlocks {
  const rendered = loadPrompt('session', 'st-evaluation', {
    block_boundary: BLOCK_BOUNDARY_SENTINEL,
    party_roster: input.partyRoster,
    sd_playbook: input.sdPlaybook,
    running_summary: input.runningSummary,
    current_standing_directive: input.currentStandingDirective,
    pending_one_shot: input.pendingOneShot,
    recent_exchanges: input.recentExchanges,
    wind_down: input.windDown ? WIND_DOWN_INSTRUCTION : '',
    converge: input.converge ? CONVERGE_INSTRUCTION : '',
    summary_target_words: String(ST_SUMMARY_TARGET_WORDS),
  })
  const { head, stable, volatileTail } = splitStEvaluationTemplate(rendered)
  return [
    { role: 'system', text: head.trim(), cacheBreakpoint: true },
    { role: 'user', text: stable.trim(), cacheBreakpoint: true },
    { role: 'user', text: volatileTail.trim() },
  ]
}

export async function runStDirector(input: StDirectorInput): Promise<StDirectorOutput> {
  const r = await generateObject({
    model: ST_MODEL,
    schema: StDirectorResultSchema,
    schemaName: 'StDirectorResultSchema',
    blocks: stEvaluationBlocks(input),
    callSite: 'st-director',
    providerOptions: { mythrun: { stage: 'st_eval', sessionId: input.sessionId } },
    repairStrategy: 'haiku-then-sonnet',
    timeoutMs: ST_EVAL_TIMEOUT_MS,
    maxOutputTokens: ST_EVAL_MAX_OUTPUT_TOKENS,
  })
  return { result: r.output, usage: r.usage, repairAttempted: r.repairAttempted }
}
