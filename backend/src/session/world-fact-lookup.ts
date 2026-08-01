// backend/src/session/world-fact-lookup.ts
//
// MYT-72 T5 — the shared world-fact-lookup ORCHESTRATOR spine. The three
// Fast-Thinker world-knowledge lookup tools each call this with a per-substrate
// resolver closure; this file owns the gate → resolve → ST-vet → relay flow and
// EVERY fail-soft arm.
//
// Cross-cutting invariants:
//   • ST-gated flow: the orchestrator returns ONLY the ST-vet's relay text. The
//     FT narrates from that relay; it never learns an ST ran.
//   • TOTAL / fail-soft: runWorldFactLookup NEVER throws. Every failure arm (gate
//     outage handled inside the gate; resolver throw; vet error/repairAttempted)
//     degrades to a channel-appropriate fail-soft relay — never a raw error,
//     never an unvetted/over-pulled result, never repair-authored text.
//   • Discard-on-repair: vet.repairAttempted === true is a fail-soft (a repaired
//     tree's prose was re-authored by a different model — never surface it).
//   • Enforced ignorance is STRUCTURAL: the orchestrator NEVER sees the raw
//     sd_playbook. The vet arrives as an OPAQUE closure whose input is
//     Omit<StLookupVetInput, 'sdPlaybook'> — the closure (built in a later task)
//     captures the playbook. There is no sdPlaybook anywhere in this file.

import {
  resolveWorldLookupGate,
  type WorldLookupGateInput,
  type WorldLookupGateDeps,
} from './world-lookup-gate.js'
import type { StLookupVetInput } from '../llm/st-lookup-vet.js'
import type { AccessLevel } from '../repo/facts.js'
import type { SkillCheckFramePayload } from './tiers/types.js'

/** A per-substrate resolver closure: over-pull the store and report whether the
 *  pull was DEGRADED (an infra blip swallowed to empty) vs genuinely empty.
 *  The `results` string is the tier-annotated, pre-rendered block the ST-vet reads. */
export interface ResolverResult {
  readonly results: string
  readonly degraded: boolean
  readonly empty: boolean
}
export type SubstrateResolver = () => Promise<ResolverResult>

/** The vet-bound context the orchestrator needs (the opaque vet closure captures
 *  sdPlaybook; the orchestrator never sees the raw playbook). `tier` is the ST's
 *  provenance tag for the relayed/invented content — surfaced out so MYT-73's
 *  recordInjection can stamp the working-set fact with the right access level. */
export type WorldFactLookupVet = (
  input: Omit<StLookupVetInput, 'sdPlaybook' | 'sessionId'>,
) => Promise<{
  mode: 'relay' | 'none' | 'invent'
  text: string
  tier: AccessLevel
  repairAttempted: boolean
}>

export interface WorldFactLookupInput {
  readonly gate: WorldLookupGateInput
  readonly question: string
  readonly recentNarrative: string
  readonly npcFraming: string
  readonly resolve: SubstrateResolver
}

export interface WorldFactLookupDeps {
  readonly gateDeps: WorldLookupGateDeps
  readonly vet: WorldFactLookupVet
  readonly worldTone: string
  readonly logger?: { warn: (o: Record<string, unknown>, m: string) => void }
}

export interface WorldFactLookupResult {
  readonly relayText: string
  readonly skillGateFrame?: SkillCheckFramePayload
  readonly rollHidden: boolean
  /** The ST-vet's verdict mode for this relay (MYT-73): `relay`/`invent` records
   *  a working-set injection; `none` records nothing. Every fail-soft arm (gate
   *  fail, vet error/timeout, discard-on-repair) collapses to `fail_soft` →
   *  nothing is recorded (the surfaced text is the orchestrator's blank, never a
   *  vetted fact). */
  readonly vetMode: 'relay' | 'none' | 'invent' | 'fail_soft'
  /** The ST's access-level tag for the relayed/invented content; `null` on the
   *  `none`/`fail_soft` arms (no fact to stamp). */
  readonly vetTier: AccessLevel | null
}

/** Channel-appropriate fail-soft relay — degrade WITHOUT leaking a raw error,
 *  an unvetted result, or repair-authored prose. NPC and DM voices differ so a
 *  failure reads in-fiction for whichever asker. */
function failSoftRelay(channel: 'dm' | 'npc'): string {
  return channel === 'npc' ? "They don't seem to know." : "You can't quite bring it to mind."
}

export async function runWorldFactLookup(
  deps: WorldFactLookupDeps,
  input: WorldFactLookupInput,
): Promise<WorldFactLookupResult> {
  const gate = await resolveWorldLookupGate(deps.gateDeps, input.gate)

  // A failed gate skips the resolver + vet cost: surface the gate's fail
  // constraint as the relay (it IS the in-fiction "you don't recall" prose).
  // No vet ran → fail-soft for MYT-73 (nothing recorded).
  if (gate.outcome === 'fail') {
    return {
      relayText: gate.failConstraint,
      skillGateFrame: gate.frame,
      rollHidden: gate.rollHidden,
      vetMode: 'fail_soft',
      vetTier: null,
    }
  }

  // auto_success → no roll happened, nothing to hide, no frame.
  // pass → carry the gate's frame + rollHidden through to the player.
  const skillGateFrame = gate.outcome === 'pass' ? gate.frame : undefined
  const rollHidden = gate.outcome === 'pass' ? gate.rollHidden : false

  // Resolve the substrate. A throw is an infra blip → treat as a DEGRADED empty
  // pull (the vet is told resolverDegraded:true and reasons accordingly). We
  // never surface an unvetted result, so an empty results block is safe.
  let resolved: ResolverResult
  try {
    resolved = await input.resolve()
  } catch (err) {
    deps.logger?.warn({ err, channel: input.gate.channel }, 'world-fact-lookup: resolver failed; degrading to empty')
    resolved = { results: '', degraded: true, empty: true }
  }

  // ST-vet — the ONE tier-safety gate. A throw degrades to a fail-soft relay.
  let vetOut: { mode: 'relay' | 'none' | 'invent'; text: string; tier: AccessLevel; repairAttempted: boolean }
  try {
    vetOut = await deps.vet({
      question: input.question,
      recentNarrative: input.recentNarrative,
      channel: input.gate.channel,
      npcFraming: input.npcFraming,
      results: resolved.results,
      resolverDegraded: resolved.degraded,
      worldTone: deps.worldTone,
    })
  } catch (err) {
    deps.logger?.warn({ err, channel: input.gate.channel }, 'world-fact-lookup: ST-vet failed; fail-soft relay')
    return buildResult(failSoftRelay(input.gate.channel), skillGateFrame, rollHidden, 'fail_soft', null)
  }

  // Discard-on-repair: a repaired vet tree's prose was re-authored by a different
  // model — never surface it. Degrade to the fail-soft relay.
  if (vetOut.repairAttempted) {
    deps.logger?.warn({ channel: input.gate.channel }, 'world-fact-lookup: ST-vet repairAttempted; fail-soft relay')
    return buildResult(failSoftRelay(input.gate.channel), skillGateFrame, rollHidden, 'fail_soft', null)
  }

  // The vet's text is authoritative for ALL modes (relay/invent/none) — the
  // orchestrator surfaces it verbatim, never re-authoring. vetMode/vetTier carry
  // the ST's verdict out so the tool layer (MYT-73) can record a working-set
  // injection on relay/invent. `none` carries no fact → vetTier is null.
  return buildResult(
    vetOut.text,
    skillGateFrame,
    rollHidden,
    vetOut.mode,
    vetOut.mode === 'none' ? null : vetOut.tier,
  )
}

/** Build a result, attaching skillGateFrame only when present
 *  (exactOptionalPropertyTypes: absent must be truly absent, never `undefined`). */
function buildResult(
  relayText: string,
  skillGateFrame: SkillCheckFramePayload | undefined,
  rollHidden: boolean,
  vetMode: 'relay' | 'none' | 'invent' | 'fail_soft',
  vetTier: AccessLevel | null,
): WorldFactLookupResult {
  return { relayText, ...(skillGateFrame ? { skillGateFrame } : {}), rollHidden, vetMode, vetTier }
}
