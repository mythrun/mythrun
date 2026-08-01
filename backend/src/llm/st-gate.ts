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

import { generateObject, type LanguageModelUsage, type PromptBlocks } from './ai.js'
import { loadPrompt } from './prompts.js'
import { StGateResultSchema, type StGateResult } from './schemas/st-gate.js'
import { ST_GATE_MODEL, ST_GATE_TIMEOUT_MS } from '../session/st-config.js'

export interface StGateInput {
  /** The FULL secret-bearing playbook — ST-side infrastructure. No code-side
   *  trigger extraction (that would be ZFC-violating string intelligence). */
  readonly sdPlaybook: string
  readonly runningSummary: string
  readonly recentExchanges: string
  /** Cost-harness scope id (cost wave 1 §1.0) — rides providerOptions.mythrun
   *  only, NEVER the prompt. */
  readonly sessionId: string
}

export interface StGateOutput {
  readonly result: StGateResult
  readonly usage: LanguageModelUsage
}

// Cost-wave1 §3 — gate caching, annotation only. st-gate.txt is already
// stable-first (instruction head + full sd_playbook above; per-turn
// summary/exchanges below), so the assembly cuts the RAW template at the
// volatile marker — variable content can never move the boundary — and pins
// the cache breakpoint on the stable block. The two blocks re-concatenate to
// the exact legacy rendered prompt (pinned in st-gate.test.ts): zero template
// byte changes. NOTE (spec §3): the measured stable span on the lean fixture
// is 4,753 tokens — only ~650 above Haiku's 4,096 cacheable minimum. Below
// the minimum the provider silently ignores the breakpoint (no write, no
// read), so a leaner playbook degrades to uncached, never to an error; the
// cost harness's S-2 arm is span-conditional for the same reason.
const GATE_VOLATILE_MARKER = '## Running summary'

/** `{{var}}` interpolation over one template span — same semantics as
 *  prompts.ts (single pass, unmatched placeholders left as-is, replacement
 *  content never rescanned). Local because the split must interpolate each
 *  half independently and prompts.ts only renders whole templates. */
function fill(span: string, vars: Record<string, string>): string {
  return span.replace(/\{\{(\w+)\}\}/g, (match: string, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return match
    return vars[key] ?? match
  })
}

/** Cuts the raw template at the volatile marker, which must appear EXACTLY
 *  once: zero is template drift, and a second occurrence would make a
 *  first-occurrence cut silently move the cache breakpoint. Exported for the
 *  marker-validation tests (the drifted templates never reach disk). */
export function splitGateTemplate(template: string): { head: string; tail: string } {
  const cut = template.indexOf(GATE_VOLATILE_MARKER)
  if (cut === -1) {
    throw new Error(
      `st-gate.txt: volatile marker ${JSON.stringify(GATE_VOLATILE_MARKER)} not found — template drifted; re-derive the cache breakpoint (cost-wave1 §3)`,
    )
  }
  if (template.includes(GATE_VOLATILE_MARKER, cut + GATE_VOLATILE_MARKER.length)) {
    throw new Error(
      `st-gate.txt: volatile marker ${JSON.stringify(GATE_VOLATILE_MARKER)} appears more than once — the cut point is ambiguous; re-derive the cache breakpoint (cost-wave1 §3)`,
    )
  }
  return { head: template.slice(0, cut), tail: template.slice(cut) }
}

function gateBlocks(input: StGateInput): PromptBlocks {
  const { head, tail } = splitGateTemplate(loadPrompt('session', 'st-gate'))
  const vars = {
    sd_playbook: input.sdPlaybook,
    running_summary: input.runningSummary,
    recent_exchanges: input.recentExchanges,
  }
  return [
    { role: 'user', text: fill(head, vars), cacheBreakpoint: true },
    { role: 'user', text: fill(tail, vars) },
  ]
}

export async function runStGate(input: StGateInput): Promise<StGateOutput> {
  const r = await generateObject({
    model: ST_GATE_MODEL,
    schema: StGateResultSchema,
    schemaName: 'StGateResultSchema',
    blocks: gateBlocks(input),
    callSite: 'st-gate',
    providerOptions: { mythrun: { stage: 'st_gate', sessionId: input.sessionId } },
    repairStrategy: 'haiku-then-sonnet',
    timeoutMs: ST_GATE_TIMEOUT_MS,
  })
  return { result: r.output, usage: r.usage }
}
