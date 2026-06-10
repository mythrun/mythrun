// backend/src/llm/st-gate.ts
//
// MYT-69 §3 — the Haiku gate. One cheap generateObject through the canonical
// ai.ts wrapper. The gate may hold secrets freely (ST-side infrastructure whose
// output is consumed by code only). Repair 'haiku-then-sonnet'. The SKIP rule
// (`!needed && confidence ≥ floor`) is the WORKER's policy, not this call's.
// Errors propagate — the worker's fail-posture (skip this cycle, the floor
// guarantees eventual oversight) is the caller's job.
//
// GATE INDEPENDENCE: the verdict/reason produced here is NEVER fed to the ST.
// Biasing the ST with a possibly-wrong gate verdict is forbidden — the gate
// only decides whether the Opus call happens, never what it concludes.

import { generateObject, type LanguageModelUsage } from './ai.js'
import { loadPrompt } from './prompts.js'
import { StGateResultSchema, type StGateResult } from './schemas/st-gate.js'
import { ST_GATE_MODEL, ST_GATE_TIMEOUT_MS } from '../session/st-config.js'

export interface StGateInput {
  /** The FULL secret-bearing playbook — ST-side infrastructure. No code-side
   *  trigger extraction (that would be ZFC-violating string intelligence). */
  readonly sdPlaybook: string
  readonly runningSummary: string
  readonly recentExchanges: string
}

export interface StGateOutput {
  readonly result: StGateResult
  readonly usage: LanguageModelUsage
}

export async function runStGate(input: StGateInput): Promise<StGateOutput> {
  const r = await generateObject({
    model: ST_GATE_MODEL,
    schema: StGateResultSchema,
    schemaName: 'StGateResultSchema',
    prompt: loadPrompt('session', 'st-gate', {
      sd_playbook: input.sdPlaybook,
      running_summary: input.runningSummary,
      recent_exchanges: input.recentExchanges,
    }),
    callSite: 'st-gate',
    repairStrategy: 'haiku-then-sonnet',
    timeoutMs: ST_GATE_TIMEOUT_MS,
  })
  return { result: r.output, usage: r.usage }
}
