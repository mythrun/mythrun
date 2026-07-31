// backend/src/sse/derive-phase.ts
//
// Pure phase-derivation function. Reads from snapshot row shapes (no I/O).
// The repo helper `listLatestForCampaign` returns at most one row per
// (stage, user_id) — already DISTINCT ON'd — so this function doesn't
// need to dedupe.

import { WORLD_GEN_STAGES } from '@mythrun/contract/events'
import { PARK_BUDGET_MS } from '../repo/resume-stamps.js'

export type PipelinePhase =
  | 'not_started'
  | 'world_gen'
  | 'world_gen_failed'
  | 'world_snapshot_ready'
  | 'world_ready'
  | 'character_creation'
  | 'post_creation'
  | 'complete'
  | 'failed'

export interface CampaignRow {
  readonly id: string
  readonly status: 'setup' | 'active' | 'archived' | 'failed'
  readonly world_id: string
}

export interface WorldRow {
  readonly id: string
  readonly status: 'generating' | 'complete' | 'failed'
}

export interface PipelineRunRow {
  readonly stage: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly user_id: string | null
  readonly world_id: string | null
  readonly campaign_id: string | null
  readonly started_at: Date | null
  readonly completed_at: Date | null
  readonly cost_usd: number
}

// llm-outage-resilience §3: the parked-run resume stamp, as this module needs
// it — a structural mirror of `ResumeStamp` (repo/resume-stamps.ts) minus the
// (pipeline, entityId) key, following the row-shape pattern above. `null`
// nextResumeAt = claimed/in-flight (the claim cleared it); a non-null value in
// the future = armed for a wake.
export interface ResumeStampView {
  readonly resumeAttempt: number
  readonly nextResumeAt: Date | null
  readonly parkConsumedMs: number
  readonly lastErrorClass: 'connectivity' | 'rate-limit'
}

// §3.2 overdue arm: a wake that never claimed within this grace past its
// scheduled resume is treated as lost — the derivation falls back to the
// failed/retryable surface. Pure row predicate; no queue I/O.
const PARK_OVERDUE_GRACE_MS = 5 * 60_000

// §3.3: `resuming` while the stamp exists, unexhausted, not overdue. An
// in-flight stamp (nextResumeAt NULL) cannot be overdue — the claim that
// cleared it IS the stage start the overdue predicate waits for.
// Exported (Task 9): the session-prep and character-creation status
// derivations apply the same armed/overdue arms to their own snapshots.
export function isResumingStamp(stamp: ResumeStampView | null, now: Date): boolean {
  if (stamp === null) return false
  if (stamp.parkConsumedMs >= PARK_BUDGET_MS) return false
  if (
    stamp.nextResumeAt !== null &&
    now.getTime() > stamp.nextResumeAt.getTime() + PARK_OVERDUE_GRACE_MS
  ) {
    return false
  }
  return true
}

interface StageEntry {
  readonly stage: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly userId: string | null
  readonly costUsd: number
  // myth-zeiw: per-stage timing for the dev-tool status panel.
  // ISO-8601 strings on the wire — `Date` values from pg.query are
  // serialized through `reply.send` (which calls toJSON on Date),
  // producing the same shape. `null` for stages that haven't started
  // (pending) or haven't completed (running). Duration is computed
  // client-side so the panel can render a live count-up for running
  // stages without re-fetching.
  readonly startedAt: string | null
  readonly completedAt: string | null
}

export interface PhaseAndStages {
  readonly phase: PipelinePhase
  readonly stages: readonly StageEntry[]
  readonly cumulativeCostUsd: number
  // llm-outage-resilience §3.4 (additive): present iff a resume stamp exists
  // for the world_gen pipeline. The hold copy keys off the class via the
  // snapshot derivation (never only the live SSE event — the class must
  // re-derive on every (re)connect). Absent = no park episode in progress.
  readonly lastErrorClass?: 'connectivity' | 'rate-limit'
  readonly resumeAttempt?: number
}

// Stage taxonomy — order-preserving for the snapshot display.
// Worldgen stages run on the world; charcreation stages run per-player;
// post-creation stages are campaign-scoped (campaign_id set, user_id null).
//
// MYT-89 audit ③: the world-gen list is the canonical WORLD_GEN_STAGES from
// @mythrun/contract/events. This module used to carry a hand-maintained
// 10-stage copy that had DRIFTED — it omitted `entity_consolidation` (stage
// 4b), so an entity_consolidation pipeline_runs row fell through stageScope()
// to the 'unknown' bucket (invisible to phase computation, sorted first). The
// aliased canonical list fixes that. computePhase's phase-map semantics are
// UNCHANGED: it keys on specific stage names (a legitimate subset), not the
// full list, so widening the list from 10→11 only corrects bucketing/order.
export const WORLDGEN_STAGES = WORLD_GEN_STAGES

export const CHARCREATION_STAGES = [
  'location_selection',
  'character_concept',
  'character_sheet',
] as const

export const POSTCREATION_STAGES = ['character_integration'] as const

const STAGE_ORDER: readonly string[] = [
  ...WORLDGEN_STAGES,
  ...CHARCREATION_STAGES,
  ...POSTCREATION_STAGES,
]

function stageScope(stage: string): 'worldgen' | 'charcreation' | 'postcreation' | 'unknown' {
  if ((WORLDGEN_STAGES as readonly string[]).includes(stage)) return 'worldgen'
  if ((CHARCREATION_STAGES as readonly string[]).includes(stage)) return 'charcreation'
  if ((POSTCREATION_STAGES as readonly string[]).includes(stage)) return 'postcreation'
  return 'unknown'
}

export function derivePhase(input: {
  readonly campaign: CampaignRow
  readonly world: WorldRow
  readonly runs: readonly PipelineRunRow[]
  /** llm-outage-resilience §3: the world_gen resume stamp, when one exists.
   *  Loaded by the caller's existing data path (no queue I/O here). */
  readonly resumeStamp?: ResumeStampView | null
  /** Clock injection for the overdue predicate; production omits it. */
  readonly now?: Date
}): PhaseAndStages {
  const { campaign, world, runs } = input
  const resumeStamp = input.resumeStamp ?? null
  const resuming = isResumingStamp(resumeStamp, input.now ?? new Date())

  // Bucket runs by scope.
  const worldgen = runs.filter((r) => stageScope(r.stage) === 'worldgen')
  const charcreation = runs.filter((r) => stageScope(r.stage) === 'charcreation')
  const postcreation = runs.filter((r) => stageScope(r.stage) === 'postcreation')

  // Sort stages by taxonomy order, then by user_id (null first) for per-player stability.
  const stages: StageEntry[] = [...runs]
    .sort((a, b) => {
      const ai = STAGE_ORDER.indexOf(a.stage)
      const bi = STAGE_ORDER.indexOf(b.stage)
      if (ai !== bi) return ai - bi
      /* c8 ignore start — `?? ''` falsy arms only fire on the
       * stage-rows that carry a non-null user_id (character-creation
       * per-player rows); tests stage worldgen + post-creation rows
       * which are user_id null on both sides of the comparison. */
      const au = a.user_id ?? ''
      const bu = b.user_id ?? ''
      /* c8 ignore stop */
      return au.localeCompare(bu)
    })
    .map((r) => ({
      stage: r.stage,
      status: r.status,
      userId: r.user_id,
      costUsd: r.cost_usd,
      startedAt: r.started_at === null ? null : r.started_at.toISOString(),
      completedAt: r.completed_at === null ? null : r.completed_at.toISOString(),
    }))

  const cumulativeCostUsd = runs.reduce((acc, r) => acc + r.cost_usd, 0)

  const phase = computePhase({
    campaign,
    world,
    worldgen,
    charcreation,
    postcreation,
    resuming,
  })

  return {
    phase,
    stages,
    cumulativeCostUsd,
    // Surfaced whenever a stamp exists (armed, in-flight, overdue, or
    // exhausted) — the parked hold copy AND the retryable view both key off
    // the class. Spread keeps the wire shape byte-identical when absent.
    ...(resumeStamp !== null
      ? { lastErrorClass: resumeStamp.lastErrorClass, resumeAttempt: resumeStamp.resumeAttempt }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// MYT-87 T10: viewer-relative hub `cardPhase`.
//
// `derivePhase` above is the *global* pipeline phase — the same for every
// member. The campaign-hub card needs a *per-viewer* projection: it answers
// "what does THIS player's card say right now?", which depends on whether the
// viewer has made a character and whether the whole party is ready. This is a
// pure projection (no I/O); the caller resolves `viewerHasCharacter` /
// `partyAllReady` / `sessionCount` from the repo and hands them in.
// ---------------------------------------------------------------------------
export type CardPhase =
  | 'generating'
  | 'failed'
  | 'needs-character'
  | 'waiting-for-players'
  | 'not-played'
  | 'played'

export function deriveCardPhase(input: {
  readonly campaign: { readonly status: CampaignRow['status']; readonly sessionCount: number }
  readonly world: { readonly status: WorldRow['status'] }
  readonly viewerHasCharacter: boolean
  readonly partyAllReady: boolean
}): CardPhase {
  const { campaign, world, viewerHasCharacter, partyAllReady } = input

  // Terminal/in-flight gates win over every viewer-relative branch.
  if (world.status === 'failed') return 'failed'
  if (campaign.status === 'failed') return 'failed' // character-integration exhausted (MYT-56)
  if (world.status === 'generating') return 'generating'

  // World complete below.
  // The character-creation window is campaign.status === 'setup' — a campaign
  // flips to 'active' only as the FINAL write of character-integration, once
  // every PC is woven in (repo/campaigns.ts:302 setActive). So the
  // viewer-relative states fire during 'setup', NOT 'active'.
  if (campaign.status === 'setup') {
    if (!viewerHasCharacter) return 'needs-character'
    if (!partyAllReady) return 'waiting-for-players'
    return 'not-played' // all ready, pre-active transient
  }

  // campaign 'active' — all PCs integrated, world playable.
  if (campaign.sessionCount === 0) return 'not-played'
  return 'played'
}

function computePhase(input: {
  readonly campaign: CampaignRow
  readonly world: WorldRow
  readonly worldgen: readonly PipelineRunRow[]
  readonly charcreation: readonly PipelineRunRow[]
  readonly postcreation: readonly PipelineRunRow[]
  readonly resuming: boolean
}): PipelinePhase {
  const { campaign, world, worldgen, charcreation, postcreation, resuming } = input

  // Active campaign overrides everything.
  if (campaign.status === 'active') return 'complete'

  // Failed campaign — explicit terminal state set by the character-integration
  // processor (MYT-56) when its repair chain exhausts. Surfaces here so the
  // bare GET /api/campaigns row, the SSE phase, and the smoke all agree.
  if (campaign.status === 'failed') return 'failed'

  // Empty: nothing has started.
  if (worldgen.length === 0 && charcreation.length === 0 && postcreation.length === 0) {
    return 'not_started'
  }

  // Worldgen failure surfaces if the world is failed AND no later-stage runs have made progress.
  if (world.status === 'failed') {
    return 'world_gen_failed'
  }

  // Snapshot-ready: world_introduction (the reveal boundary, myth-zaqxh) has
  // committed but the world is still generating (the silent tail —
  // entity_consolidation → embed_world — is still pending/running). The SSE
  // initial frame surfaces this so mid-window subscribers learn the snapshot
  // (which now carries the intro page) is fetchable even though worlds.status
  // hasn't flipped yet. Must precede the `world_gen` running check, otherwise a
  // running tail-stage row would shadow this branch.
  if (
    world.status === 'generating' &&
    worldgen.some((r) => r.stage === 'world_introduction' && r.status === 'completed')
  ) {
    return 'world_snapshot_ready'
  }

  // myth-0qw7k: BOTH worldgen-derived branches below are gated on the world
  // not being complete. worlds.status is the OUTCOME; pipeline_runs rows are
  // telemetry. A worker killed in the seam between finishing a stage's work
  // and stamping its row leaves that row 'running' (or a retried attempt's
  // leftover at 'failed') FOREVER — the job completes, so no resume ever
  // revisits it — and before this guard a single orphaned row wedged the
  // whole flow at "the table is still being set" with no player-visible
  // recovery. Observed live (coherence_pass) on the 2026-07-29 walk; any
  // hard worker death mid-deploy can reproduce it, so this is the safety
  // net, not dev-only hygiene.
  if (world.status !== 'complete') {
    // Worldgen running.
    if (worldgen.some((r) => r.status === 'running' || r.status === 'pending')) {
      return 'world_gen'
    }

    // Worldgen failed but not world-status-failed. A PARK is exactly this
    // shape (llm-outage-resilience §3.1: the stage row fails so the wake can
    // claim it, but worlds.status never flips) — while the stamp is live
    // (unexhausted, not overdue) the phase stays generating-shaped; the
    // stamp, not the row, distinguishes parked from genuinely failed. The
    // entity-level `world.status === 'failed'` check above is NOT gated on
    // the stamp: only genuine failure paths flip it.
    if (worldgen.some((r) => r.status === 'failed')) {
      return resuming ? 'world_gen' : 'world_gen_failed'
    }
  }

  // Post-creation running.
  /* c8 ignore next 3 — post-creation phase isn't exercised in the
   * MYT-51 stage tests; the worker emits these rows only after
   * character creation, which lands in MYT-52. */
  if (postcreation.some((r) => r.status === 'running' || r.status === 'pending')) {
    return 'post_creation'
  }

  // Charcreation running.
  if (charcreation.some((r) => r.status === 'running' || r.status === 'pending')) {
    return 'character_creation'
  }

  // Charcreation failure → failed (post-worldgen).
  if (
    charcreation.some((r) => r.status === 'failed') ||
    postcreation.some((r) => r.status === 'failed')
  ) {
    return 'failed'
  }

  // World complete, no later activity → world_ready.
  if (world.status === 'complete') return 'world_ready'

  // Default safety net.
  return 'not_started'
}
