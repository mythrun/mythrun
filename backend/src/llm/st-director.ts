// backend/src/llm/st-director.ts
//
// MYT-69 §4 — the Opus ST evaluation. generateObject through the canonical
// ai.ts wrapper, repair 'haiku-then-sonnet'. CRITICAL: the wrapper's
// repairAttempted flag is surfaced UNCHANGED — the worker discards the entire
// result when it is true (a repaired `direction` is text the ST did not
// author; the single-gate argument requires it). maxOutputTokens is set
// explicitly (reasoning + direction + a full summary rewrite is long).

import { generateObject, type LanguageModelUsage } from './ai.js'
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
}

export interface StDirectorOutput {
  readonly result: StDirectorResult
  readonly usage: LanguageModelUsage
  readonly repairAttempted: boolean
}

export async function runStDirector(input: StDirectorInput): Promise<StDirectorOutput> {
  const r = await generateObject({
    model: ST_MODEL,
    schema: StDirectorResultSchema,
    schemaName: 'StDirectorResultSchema',
    prompt: loadPrompt('session', 'st-evaluation', {
      party_roster: input.partyRoster,
      sd_playbook: input.sdPlaybook,
      running_summary: input.runningSummary,
      current_standing_directive: input.currentStandingDirective,
      pending_one_shot: input.pendingOneShot,
      recent_exchanges: input.recentExchanges,
      wind_down: input.windDown ? WIND_DOWN_INSTRUCTION : '',
      converge: input.converge ? CONVERGE_INSTRUCTION : '',
      summary_target_words: String(ST_SUMMARY_TARGET_WORDS),
    }),
    callSite: 'st-director',
    repairStrategy: 'haiku-then-sonnet',
    timeoutMs: ST_EVAL_TIMEOUT_MS,
    maxOutputTokens: ST_EVAL_MAX_OUTPUT_TOKENS,
  })
  return { result: r.output, usage: r.usage, repairAttempted: r.repairAttempted }
}
