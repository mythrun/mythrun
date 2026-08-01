// backend/scripts/cost/scenarios/registry.ts
//
// The scenario registry: the runner's pure dispatch surface (id parsing,
// scope-id derivation, required-manifest-key pre-check lists, assembly
// delegation). Driving (the live execute step) lives in the CLI + driver
// modules — this module stays pure and unit-testable.
//
// Scope-id routing (Wave-1 reviews): S-1/S-2 scope by BOTH sessionId AND
// campaignId — FT lines carry campaignId only, so session-only scoping
// would silently exclude the FT (and campaign-only scoping would miss the
// sessionId-only Haiku lines). S-4/S-5 scope by campaignId. The
// window+stage-scoped `stageOnly` capture covers in-request calls that run
// before any campaign row exists (input gate, preview-time concept_intake);
// S-4's tripwire entry is belt-and-braces only — at HEAD (749b3d65) the
// session-prep vetOpening tripwire stamps campaignId and arrives id-scoped.

import type { LlmCallLine } from '../lib/extract.js'
import type { CostEntry } from '../lib/manifest.js'
import type { ComponentRow } from '../lib/report.js'
import type { CapturedRun } from '../run-state.js'
import {
  assembleS1,
  assembleS2,
  S1_REQUIRED_KEYS,
  S2_REQUIRED_KEYS,
} from './assemble-session.js'
import { assemblePrep } from './assemble-prep.js'

export type ScenarioId = 's1' | 's2' | 's4' | 's5'

export interface AssembleContext {
  readonly run: CapturedRun
  readonly calls: LlmCallLine[]
  readonly dropped: LlmCallLine[]
  /** Id-less lines captured window+stage-scoped (S-4/S-5 tripwire arm). */
  readonly stageOnly: LlmCallLine[]
  readonly manifest: Record<string, CostEntry>
}

export interface ScenarioSpec {
  readonly id: ScenarioId
  readonly description: string
  /** Checked against the manifest BEFORE driving — money is spent only when
   *  every static expectation exists (dynamic per-group keys are checked at
   *  assembly, equally loudly). */
  readonly requiredManifestKeys: readonly string[]
  /** Stages captured id-less via extractStageOnlyCalls. */
  readonly stageOnlyStages: readonly string[]
  scopeIds(run: CapturedRun): string[]
  assemble(ctx: AssembleContext): ComponentRow[]
}

function requireId(run: CapturedRun, field: 'sessionId' | 'campaignId'): string {
  const value = run[field]
  if (value === undefined) {
    throw new Error(`scenario ${run.scenario}: saved run is missing ${field}`)
  }
  return value
}

function requireTurns(run: CapturedRun): number {
  if (run.turns === undefined) {
    throw new Error(`scenario ${run.scenario}: saved run is missing turns`)
  }
  return run.turns
}

const sessionScope = (run: CapturedRun): string[] => [
  requireId(run, 'sessionId'),
  requireId(run, 'campaignId'),
]

const campaignScope = (run: CapturedRun): string[] => [requireId(run, 'campaignId')]

export const SCENARIOS: Record<ScenarioId, ScenarioSpec> = {
  s1: {
    id: 's1',
    description: 'scripted 12-turn WS session — FT $/turn, ST $/eval + count',
    requiredManifestKeys: S1_REQUIRED_KEYS,
    stageOnlyStages: [],
    scopeIds: sessionScope,
    assemble: (ctx) =>
      assembleS1({
        calls: ctx.calls,
        dropped: ctx.dropped,
        manifest: ctx.manifest,
        turns: requireTurns(ctx.run),
      }),
  },
  s2: {
    id: 's2',
    description: "S-1's window re-asserted for cache health (turns 2+)",
    requiredManifestKeys: S2_REQUIRED_KEYS,
    stageOnlyStages: [],
    scopeIds: sessionScope,
    assemble: (ctx) =>
      assembleS2({
        calls: ctx.calls,
        dropped: ctx.dropped,
        manifest: ctx.manifest,
        turns: requireTurns(ctx.run),
      }),
  },
  s4: {
    id: 's4',
    description: 'character finalize → session-prep pipeline — prep $ ≤ manifest',
    requiredManifestKeys: ['s4.total_usd'],
    stageOnlyStages: ['secret_tripwire'],
    scopeIds: campaignScope,
    assemble: (ctx) =>
      assemblePrep({
        prefix: 's4',
        calls: ctx.calls,
        stageOnly: ctx.stageOnly,
        dropped: ctx.dropped,
        manifest: ctx.manifest,
      }),
  },
  s5: {
    id: 's5',
    description: 'full prep-engine world-gen run — per-stage $ ≤ manifest',
    requiredManifestKeys: ['s5.total_usd'],
    // In-request calls that run BEFORE the campaign row exists carry stage
    // but no ids: the input gate always; concept_intake on the preview-time
    // synthesize/revise paths (structural — the worker-side concept-intake
    // stage and paint-job-validator are id-stamped as of 749b3d65).
    stageOnlyStages: ['input_gate', 'concept_intake'],
    scopeIds: campaignScope,
    assemble: (ctx) =>
      assemblePrep({
        prefix: 's5',
        calls: ctx.calls,
        stageOnly: ctx.stageOnly,
        dropped: ctx.dropped,
        manifest: ctx.manifest,
      }),
  },
}

export function parseScenarioId(raw: string | undefined): ScenarioId {
  if (raw === 's1' || raw === 's2' || raw === 's4' || raw === 's5') return raw
  throw new Error(
    `usage: cost-smoke.ts <s1|s2|s4|s5> — got ${raw === undefined ? '(nothing)' : `"${raw}"`}`,
  )
}
