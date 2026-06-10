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

export interface StDirectorInput {
  readonly partyRoster: string
  readonly sdPlaybook: string
  readonly runningSummary: string
  readonly currentStandingDirective: string
  readonly pendingOneShot: string
  readonly recentExchanges: string
  readonly windDown: boolean
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
      summary_target_words: String(ST_SUMMARY_TARGET_WORDS),
    }),
    callSite: 'st-director',
    repairStrategy: 'haiku-then-sonnet',
    timeoutMs: ST_EVAL_TIMEOUT_MS,
    maxOutputTokens: ST_EVAL_MAX_OUTPUT_TOKENS,
  })
  return { result: r.output, usage: r.usage, repairAttempted: r.repairAttempted }
}
