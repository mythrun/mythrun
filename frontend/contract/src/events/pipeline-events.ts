// Declarative list of prep-pipeline SSE event types emitted by the
// worker via redisRealtime and forwarded to clients on the
// /api/campaigns/:campaignId/status/stream route. The ship-gate check
// requires every entry to have corresponding dev-tool coverage (or an
// explicit exempt entry pointing at the downstream issue that lands
// the rendering surface).
//
// MYT-50 lands the 6 lifecycle events (phase, stage-*, cost-update,
// job-failed). MYT-52 lands the 7 entity/edge events listed below: the
// 5 original arms (stage-reset / entity-added / entity-updated /
// edge-added / finalized) plus 2 new arms (entity-removed / edge-removed)
// added during MYT-52 design review to handle repair-chain removals +
// coherence delete_relationship semantics consistently with the
// "client never sees entities disappear" invariant.
//
// myth-t1qz Phase 4: stage-failed gains an OPTIONAL `diagnostic` field
// carrying the wrapper-attached `LlmCallDiagnostic` (call site, schema,
// model, repair outcome, raw-text snippet, Zod issues). Non-LLM failures
// (DB errors, cost-cap, stage-not-implemented) won't have one. The
// `LlmCallDiagnostic` shape is owned by backend/src/llm/ai.ts; we mirror
// it as a structural type here to avoid an import cycle from the
// contract layer into llm/.

export const PIPELINE_SSE_EVENTS: readonly string[] = [
  // Lifecycle (MYT-50 — landed):
  'phase',
  'stage-started',
  'stage-completed',
  'stage-failed',
  'cost-update',
  'job-failed',
  // Character-creation completion (MYT-90) — per-user terminal signal the FE
  // loading beat filters on to swap to the character reveal:
  'character_creation_complete',
  // Entity events (MYT-51+ publishes; MYT-52 renders in dev tool):
  'stage-reset',
  'entity-added',
  'entity-updated',
  'entity-removed',
  'edge-added',
  'edge-removed',
  // Fact events (myth-imxg): per-fact wire updates for coherence
  // add_fact_by_name / delete_fact_by_name / fix_fact_by_name patches.
  'fact-added',
  'fact-removed',
  'fact-updated',
  'finalized',
  // Session-prep phase events (MYT-62) — player-safe, ride pipeline:campaign:
  'prep-started',
  'prep-ready',
  'prep-failed',
] as const

export type PipelineSseEvent = (typeof PIPELINE_SSE_EVENTS)[number]

// Mirror of WrapperDiagnostic from backend/src/llm/ai.ts. Kept structurally
// identical so the canonical type can be re-aliased there as
// `LlmCallDiagnostic = PipelineStageDiagnostic`. The contract layer
// deliberately doesn't import from llm/ to avoid pulling SDK + Anthropic
// transitively into the wire-format module.
export interface PipelineStageDiagnostic {
  readonly callSite: string
  readonly schemaName: string
  readonly modelId: string
  readonly repairStrategy: 'sonnet' | 'haiku-then-sonnet'
  readonly repairAttempted: boolean
  readonly repairOutcome:
    | 'recovered'
    | 'sdk_validated_but_zod_failed'
    | 'repaired_by_haiku'
    | 'repaired_by_sonnet'
    | 'parse_failed'
    | 'haiku_failed'
    | 'sonnet_failed'
    | 'none'
  readonly rawTextSnippet: string | null
  readonly zodIssues: readonly { readonly path: string; readonly message: string }[] | null
}

export type PipelinePhase =
  | 'not_started'
  | 'world_gen'
  | 'world_gen_failed'
  | 'world_snapshot_ready' // myth-exac: stages 1-4 complete; stages 5-7 may still be running
  | 'world_ready'
  | 'character_creation'
  | 'post_creation'
  | 'complete'
  | 'failed'

// Per-stage progress carried by the SSE first-frame snapshot payload (the
// `PhaseAndStages` shape). Mirror of `StageEntry` in
// backend/src/sse/derive-phase.ts — kept structurally identical so the snapshot
// stage array round-trips onto this wire type. `startedAt`/`completedAt` are
// ISO-8601 strings (or null for stages that haven't started/completed);
// `userId` is null for world-scoped stages, set for per-player charcreation
// rows. The generation status card (MYT-89 C4) renders this off
// `useWorldGenStream`.
export interface StageProgress {
  readonly stage: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly userId: string | null
  readonly costUsd: number
  readonly startedAt: string | null
  readonly completedAt: string | null
}

// Discriminated-union of event payload shapes. Field naming uses
// `T | null` (not `T?`) consistently so JSON round-trips don't muddle
// snapshot fields with event payload fields.
export type PipelineEvent =
  | { type: 'phase'; phase: PipelinePhase }
  | { type: 'stage-started'; stage: string; userId: string | null; startedAt: string }
  | {
      type: 'stage-completed'
      stage: string
      userId: string | null
      durationMs: number
      costUsd: number
    }
  | {
      type: 'stage-failed'
      stage: string
      userId: string | null
      errorCode: string
      willRetry: boolean
      // myth-t1qz Phase 4: optional wrapper diagnostic. Present when the
      // failure originated from a schema-validated LLM call where the
      // wrapper attached `.diagnostic` to the rethrown error; absent for
      // non-LLM stage failures (DB errors, cost-cap, stage-not-implemented).
      diagnostic?: PipelineStageDiagnostic
    }
  // cost-update is ABSOLUTE (not delta); emitted only post-COMMIT.
  | { type: 'cost-update'; cumulativeUsd: number }
  | {
      type: 'job-failed'
      jobType: 'world-gen' | 'character-creation' | 'post-creation'
      errorCode: string
    }
  // Character-creation completion (MYT-90) — per-user terminal signal emitted
  // by character-creation-processor once all per-player stages complete. Rides
  // the campaign-scoped pipeline channel; `userId` lets the FE
  // `useCharacterCreationStream` hook filter it to the current player so the
  // loading beat swaps to the character reveal for the right user only.
  | { type: 'character_creation_complete'; userId: string }
  // Entity-event arms — MYT-51+ publishes; MYT-52 renders.
  //
  // The `stage` discriminator is NOT carried on entity/edge events
  // because synthKey is prefixed with `${stage}/` (D7); consumers derive
  // stage by splitting on '/'. This keeps the wire format narrow.
  //
  // `entity-updated.patch` is an RFC 7396 JSON Merge Patch over the
  // prior client-known snapshot. Nested objects/arrays REPLACE
  // wholesale (no per-element diff). Producer (worker) and consumer
  // (FE / dev tool) both follow this contract.
  //
  // `entity-removed` + `edge-removed` (MYT-52) fire when the repair
  // chain or coherence pass deletes an entity/edge the client already
  // saw via entity-added/edge-added. Preserves the "client never sees
  // entities disappear silently" invariant by making the disappearance
  // explicit.
  | { type: 'stage-reset'; stage: string }
  | {
      type: 'entity-added'
      synthKey: string
      entityKind: string
      name: string
      /** Stage 4b ghost entity reconciliation key. The frontend's buffered
       *  placeholder edges resolve via this field. Absent for stages 2-3
       *  entities (they have no placeholder antecedent). */
      placeholderId?: string
    }
  | { type: 'entity-updated'; synthKey: string; patch: Record<string, unknown> }
  | { type: 'entity-removed'; synthKey: string; reason: 'repair_dropped' | 'coherence_removed' }
  | {
      type: 'edge-added'
      synthKey: string
      /** Real UUID or placeholder ID `new-NNN`. Edges with placeholder
       *  endpoints buffer client-side until the matching entity-added
       *  arrives carrying the same placeholderId. */
      from: string
      to: string
      relationship: string
    }
  | { type: 'edge-removed'; synthKey: string; reason: 'repair_dropped' | 'coherence_deleted' }
  // myth-imxg: per-fact wire events. Symmetric with entity/edge add/remove.
  // entitySynthKey is the owning entity's synthKey (same map the
  // entity-updated event uses); factId is the row's UUID; topic/content/
  // accessLevel snapshot the new shape. fact-updated carries the new
  // content + topic; the FE replaces its prior fact row of the same id.
  | {
      type: 'fact-added'
      entitySynthKey: string
      factId: string
      topic: string
      content: string
      accessLevel: 'known' | 'discoverable' | 'secret'
    }
  | { type: 'fact-removed'; entitySynthKey: string; factId: string }
  | {
      type: 'fact-updated'
      entitySynthKey: string
      factId: string
      topic: string
      content: string
      accessLevel: 'known' | 'discoverable' | 'secret'
    }
  | { type: 'finalized'; synthKey: string; entityId: string }
  // Session-prep phase events (MYT-62) — player-safe, ride pipeline:campaign:
  | { type: 'prep-started'; sessionNumber: number }
  | { type: 'prep-ready'; sessionNumber: number; costUsd: number }
  | { type: 'prep-failed'; sessionNumber: number; terminal: boolean }

// Prose events (MYT-62) — dev-only, ride the SEPARATE prep:campaign: channel.
// Deliberately NOT in PipelineEvent / PIPELINE_SSE_EVENTS: prep-delta carries
// sd_playbook prose (may contain secrets) and must never type-check onto the
// player-facing pipeline channel. publishProse accepts ProseEvent; publishEvent
// accepts PipelineEvent — so publishEvent(campaignId, prepDelta) is a compile error.
export const PROSE_SSE_EVENTS: readonly string[] = ['prep-delta'] as const
export type ProseSseEvent = (typeof PROSE_SSE_EVENTS)[number]

export interface ProseEvent {
  type: 'prep-delta'
  field: 'ft_context' | 'sd_playbook'
  text: string
}
