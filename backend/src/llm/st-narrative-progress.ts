// backend/src/llm/st-narrative-progress.ts
//
// myth-3jna1 — the narrative-progress judgment. "How far through the prep's
// intended arc is this session?" is a JUDGMENT over prose, so per ZFC it is a
// model call, never a beat count or a keyword scan in code. Cheap and
// classification-shaped → Haiku, same tier as the ST gate. Repair
// 'haiku-then-sonnet' like its siblings; errors PROPAGATE — the worker's
// fail-posture (no converge steer this cycle, wind-down remains the backstop)
// is the caller's call to make, not this module's.
//
// The call holds the FULL sd_playbook — it cannot judge arc position without
// the goals and the revelation list. That is legal because the output is
// consumed by CODE only: converge-policy turns the fraction into a boolean, and
// the boolean reaches the Fast Thinker only as the ST's own craft-phrased
// standing direction. No text from this call ever crosses the boundary.
//
// The probe is deliberately NOT told how much budget remains. The whole point
// of the steer is comparing two INDEPENDENT axes — story delivered vs session
// spent. A probe that could see the clock would anchor to it, and the
// comparison would degenerate into a number checked against itself.

import { generateObject, type LanguageModelUsage } from './ai.js'
import { loadPrompt } from './prompts.js'
import {
  StNarrativeProgressResultSchema,
  type StNarrativeProgressResult,
} from './schemas/st-narrative-progress.js'
import { ST_PROGRESS_MODEL, ST_PROGRESS_TIMEOUT_MS } from '../session/st-config.js'

export interface StNarrativeProgressInput {
  /** The FULL secret-bearing playbook — ST-side infrastructure, same posture as
   *  the gate. No code-side goal extraction (that would be ZFC-violating string
   *  intelligence over a document an LLM wrote). */
  readonly sdPlaybook: string
  readonly runningSummary: string
  readonly recentExchanges: string
}

export interface StNarrativeProgressOutput {
  readonly result: StNarrativeProgressResult
  readonly usage: LanguageModelUsage
}

export async function runStNarrativeProgress(
  input: StNarrativeProgressInput,
): Promise<StNarrativeProgressOutput> {
  const r = await generateObject({
    model: ST_PROGRESS_MODEL,
    schema: StNarrativeProgressResultSchema,
    schemaName: 'StNarrativeProgressResultSchema',
    prompt: loadPrompt('session', 'st-narrative-progress', {
      sd_playbook: input.sdPlaybook,
      running_summary: input.runningSummary,
      recent_exchanges: input.recentExchanges,
    }),
    callSite: 'st-narrative-progress',
    providerOptions: { mythrun: { stage: 'st_narrative_progress' } },
    repairStrategy: 'haiku-then-sonnet',
    timeoutMs: ST_PROGRESS_TIMEOUT_MS,
  })
  return { result: r.output, usage: r.usage }
}
