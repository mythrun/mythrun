// backend/src/llm/prep/stages/coherence-pass.ts
//
// Stage 7 of world gen — coherence pass. Per MYT-52 design §3.6 + §D5.
//
// Non-streaming Sonnet call: reads full world state, identifies
// contradictions / typos / role conflicts / dangling references, emits
// a list of patches keyed by REAL UUID. The patch list parses + validates
// before any client writes; the apply path is purely mechanical (no LLM
// nondeterminism after the model returns).
//
// Unified dispatch contract (T13 wiring): the handler does NOT manage its
// own transaction and does NOT publish events directly. The outer scope
// (runStage in world-gen-processor.ts) owns the transaction lifecycle:
//   - On unrecoverable error: this handler throws; outer ROLLBACKs.
//   - On success: this handler returns finalized events in
//     `finalizedEvents`; outer COMMITs and publishes those events.
//
// LLM-before-BEGIN trade-off (§D5 intent): the original design had the
// LLM call complete BEFORE the txn opened so a slow model call wouldn't
// hold a DB connection in a transaction. The unified contract opens the
// txn in the outer scope before dispatching to this handler, so the LLM
// call now runs UNDER the outer txn (Option B in the T12 refactor brief).
// This is a deliberate trade against §D5's "LLM not under txn" intent in
// exchange for a uniform per-stage contract. The controller may revisit
// (Option A: per-stage flag that defers BEGIN for stage 7) if connection
// hold time during stage 7 becomes a real operational concern.
//
// Cap-fire exception (§D5): unlike stages 1-6 where cap-fire means refund
// + world_gen_failed, cap-fire at stage 7 means the world is functionally
// complete — coherence is best-effort polish. The handler signals this to
// the caller by returning `{ capExhausted: true, finalizedEvents: [{
// type: 'phase', phase: 'complete' }] }` and zero cost. The outer scope
// is responsible for marking worlds.status = 'complete' and publishing
// the phase event after its COMMIT.
//
// Apply-time skipping (§3.6): if a patch references a UUID that doesn't
// exist (LLM hallucinated an ID), the patch is logged at WARN and skipped
// — the world isn't broken, the LLM was just imprecise. Other patches in
// the same batch still apply.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import type { PoolClient } from 'pg'
import type pino from 'pino'
import { generateObject } from '../../ai.js'
import { SONNET } from '../../models.js'
import {
  CoherenceOutputSchema,
  type CoherenceOutput,
  type CoherencePatch,
} from '../../schemas/coherence-output.js'
import { proseKernels } from '../../../repo/prose-kernels.js'
import { facts } from '../../../repo/facts.js'
import { relationships } from '../../../repo/relationships.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import { readCostCap, sumCompletedStageCosts } from '../cost-cap.js'
import type { PipelineEvent } from '../../../contract/pipeline-events.js'
import type { StageDispatchResult } from '../world-gen-processor.js'
import { renderVocabularyRegistry } from '../vocabulary-renderer.js'
import type { VocabularyRegistry } from '../../schemas/vocabulary-registry.js'
import {
  loadWorldInventory,
  renderWorldDump,
  type WorldInventory,
} from '../world-dump.js'
import {
  buildResolutionContext,
  resolveFact,
  resolveProseTarget,
  resolveRename,
  resolveFixRelationship,
  resolveDeleteRelationship,
  type NameResolutionContext,
} from '../name-resolution.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/coherence-pass.txt'),
  'utf8',
)

// Anthropic Sonnet 4.6 pricing — $3/MTok input, $15/MTok output. Held
// local to the stage per the pattern from starting-situation.ts.
const SONNET_INPUT_PER_MTOK = 3.0
const SONNET_OUTPUT_PER_MTOK = 15.0

function computeCostUsd(usage: { inputTokens: number; outputTokens: number }): number {
  return (
    (usage.inputTokens / 1_000_000) * SONNET_INPUT_PER_MTOK +
    (usage.outputTokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK
  )
}

export interface CoherencePassArgs {
  readonly logger: Pick<pino.Logger, 'warn' | 'info'>
  readonly worldId: string
  readonly vocabularyRegistry: VocabularyRegistry
  // Map from real entity/relationship UUID → synthKey assigned by stages
  // 2/3/4. Stage 7's `entity-updated` / `edge-removed` / `edge-added`
  // events reference synthKey on the wire (§3.6); the handler looks up
  // each patch's UUID against this map before publishing.
  readonly synthKeyByEntityId: Readonly<Record<string, string>>
  // myth-exac T16: when false (production), stage 7 only emits SSE
  // events for patches targeting known-tier entities (edges require BOTH
  // endpoints known). The DB writes still happen for non-known entities
  // — coherence repairs them — but the FT client wouldn't have those
  // entities in its snapshot, so surfacing entity-updated for them
  // would hit a missing-key in the inspector's apply-patch code. The
  // dev tool sets bypass=true to observe everything.
  readonly bypassAccessFilter: boolean
}

interface ApplyContext {
  readonly inv: WorldInventory
  readonly resolver: NameResolutionContext
  readonly logger: Pick<pino.Logger, 'warn' | 'info'>
  readonly stage: 'coherence_pass'
  // myth-exac T16: when true, every patch's SSE event surfaces in
  // finalizedEvents regardless of tier. When false (production), only
  // patches targeting known-tier entities surface events; non-known
  // patches still persist to the DB but do NOT emit (the FT snapshot
  // wouldn't contain them).
  readonly bypassAccessFilter: boolean
}

// myth-exac T16: emit gates for stage-7 SSE events. DB writes happen
// unconditionally upstream of these — the gates only decide whether
// the corresponding event surfaces to the outer scope for publish.
function shouldEmitEntityEvent(ctx: ApplyContext, entityId: string): boolean {
  if (ctx.bypassAccessFilter) return true
  return ctx.inv.entitiesById.get(entityId)?.accessLevel === 'known'
}

function shouldEmitEdgeEvent(ctx: ApplyContext, fromId: string, toId: string): boolean {
  if (ctx.bypassAccessFilter) return true
  const fromTier = ctx.inv.entitiesById.get(fromId)?.accessLevel
  const toTier = ctx.inv.entitiesById.get(toId)?.accessLevel
  return fromTier === 'known' && toTier === 'known'
}

interface ApplyResult {
  readonly events: PipelineEvent[]
}

type SynthKeyMap = Readonly<Record<string, string>>

function warnUnknown(
  ctx: ApplyContext,
  kind: CoherencePatch['kind'],
  idField: string,
  id: string,
): void {
  ctx.logger.warn(
    { stage: ctx.stage, kind, [idField]: id },
    `coherence_pass: patch references unknown ${idField}; skipping`,
  )
}

async function applyFixFact(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'fix_fact_by_name' }>,
  factId: string,
): Promise<ApplyResult> {
  await facts.updateContentById(client, factId, { content: patch.new_content })
  // fix_fact emits NO SSE event per §3.6 — facts are not exposed as
  // standalone client-side entities; the FE re-reads them on next entity
  // query.
  return { events: [] }
}

async function applyFixProse(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'fix_prose_by_name' }>,
  entityId: string,
  ctx: ApplyContext,
  synthKeyByEntityId: SynthKeyMap,
): Promise<ApplyResult> {
  // DB write happens unconditionally — coherence repairs every tier.
  await proseKernels.updateByEntityId(client, entityId, { content: patch.new_prose })
  // myth-exac T16: SSE event only when target is known-tier (or bypass).
  if (!shouldEmitEntityEvent(ctx, entityId)) {
    return { events: [] }
  }
  const synthKey = synthKeyByEntityId[entityId]
  /* c8 ignore start — defense-in-depth: in T13's integration the synthKey
   * map is always populated for every UUID; tests exercise the populated
   * path. The patch persisted but we can't address the entity on the wire
   * (no synthKey in the map) — log + drop the event; the DB is still
   * consistent. */
  if (synthKey === undefined) {
    warnUnknown(ctx, patch.kind, 'entityId', entityId)
    return { events: [] }
  }
  /* c8 ignore stop */
  return {
    events: [{ type: 'entity-updated', synthKey, patch: { prose: patch.new_prose } }],
  }
}

async function applyRenameEntity(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'rename_entity_by_name' }>,
  entityId: string,
  ctx: ApplyContext,
  synthKeyByEntityId: SynthKeyMap,
): Promise<ApplyResult> {
  // DB write happens unconditionally — coherence repairs every tier.
  await client.query(`UPDATE entities SET name = $1 WHERE id = $2`, [
    patch.new_name,
    entityId,
  ])
  // myth-exac T16: SSE event only when target is known-tier (or bypass).
  if (!shouldEmitEntityEvent(ctx, entityId)) {
    return { events: [] }
  }
  const synthKey = synthKeyByEntityId[entityId]
  /* c8 ignore start — defense-in-depth: see applyFixProse comment. */
  if (synthKey === undefined) {
    warnUnknown(ctx, patch.kind, 'entityId', entityId)
    return { events: [] }
  }
  /* c8 ignore stop */
  return {
    events: [{ type: 'entity-updated', synthKey, patch: { name: patch.new_name } }],
  }
}

async function applyFixRelationship(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'fix_relationship_by_name' }>,
  relationshipId: string,
  ctx: ApplyContext,
  synthKeyByEntityId: SynthKeyMap,
): Promise<ApplyResult> {
  // The resolver guarantees the relationshipId exists in inventory.
  /* c8 ignore start — defense-in-depth: the resolver only returns
   * `resolved` when the triple was found in inv.relationshipsById, so
   * the lookup is guaranteed to succeed here. */
  const existing = ctx.inv.relationshipsById.get(relationshipId)
  if (existing === undefined) {
    warnUnknown(ctx, patch.kind, 'relationshipId', relationshipId)
    return { events: [] }
  }
  /* c8 ignore stop */
  // Per §3.6: fix_relationship emits edge-removed + edge-added on a NEW
  // synthKey (the edge entity is logically replaced). DB writes happen
  // unconditionally — myth-exac T16 only gates the SSE emit.
  await relationships.deleteById(client, relationshipId)
  const newRelationshipType = patch.newType ?? existing.relationshipType
  const newDescription = patch.newDescription ?? existing.description
  const newId = uuidv7()
  await client.query(
    `INSERT INTO relationships
       (id, source_entity_id, target_entity_id, relationship_type, description)
     VALUES ($1, $2, $3, $4, $5)`,
    [newId, existing.sourceEntityId, existing.targetEntityId, newRelationshipType, newDescription],
  )
  // myth-exac T16: SSE event only when BOTH endpoints are known-tier
  // (or bypass on). When either side isn't known the FT client wouldn't
  // have that endpoint in its snapshot, so dropping the edge there is
  // intentional — the inspector reads the underlying DB if it needs to
  // surface the repair to the slow thinker.
  if (!shouldEmitEdgeEvent(ctx, existing.sourceEntityId, existing.targetEntityId)) {
    return { events: [] }
  }
  const oldSynthKey = synthKeyByEntityId[relationshipId]
  const newSynthKey = `coherence_pass/edges/${newId}`
  const events: PipelineEvent[] = []
  if (oldSynthKey !== undefined) {
    events.push({ type: 'edge-removed', synthKey: oldSynthKey, reason: 'coherence_deleted' })
    /* c8 ignore start — defense-in-depth: the `else` arm (missing synthKey
     * for an existing relationship) is not reachable under T13's
     * integration. */
  } else {
    warnUnknown(ctx, patch.kind, 'relationshipId', relationshipId)
  }
  /* c8 ignore stop */
  events.push({
    type: 'edge-added',
    synthKey: newSynthKey,
    from: existing.sourceEntityId,
    to: existing.targetEntityId,
    relationship: newRelationshipType,
  })
  return { events }
}

async function applyDeleteRelationship(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'delete_relationship_by_name' }>,
  relationshipId: string,
  ctx: ApplyContext,
  synthKeyByEntityId: SynthKeyMap,
): Promise<ApplyResult> {
  /* c8 ignore start — defense-in-depth: resolver guarantees existence. */
  const existing = ctx.inv.relationshipsById.get(relationshipId)
  if (existing === undefined) {
    warnUnknown(ctx, patch.kind, 'relationshipId', relationshipId)
    return { events: [] }
  }
  /* c8 ignore stop */
  // DB write happens unconditionally — coherence repairs every tier.
  await relationships.deleteById(client, relationshipId)
  // myth-exac T16: SSE event only when BOTH endpoints are known-tier
  // (or bypass on).
  if (!shouldEmitEdgeEvent(ctx, existing.sourceEntityId, existing.targetEntityId)) {
    return { events: [] }
  }
  const synthKey = synthKeyByEntityId[relationshipId]
  /* c8 ignore start — defense-in-depth: see applyFixProse comment. */
  if (synthKey === undefined) {
    warnUnknown(ctx, patch.kind, 'relationshipId', relationshipId)
    return { events: [] }
  }
  /* c8 ignore stop */
  return {
    events: [{ type: 'edge-removed', synthKey, reason: 'coherence_deleted' }],
  }
}

// Apply one patch against the in-flight transaction. Returns 0..N event
// payloads (queued for post-COMMIT publish by the outer scope). Patches
// whose name-based identifiers don't resolve against the per-pass
// inventory snapshot are silently skipped + logged at WARN per §3.6.
async function applyPatch(
  client: PoolClient,
  patch: CoherencePatch,
  ctx: ApplyContext,
  synthKeyByEntityId: SynthKeyMap,
): Promise<ApplyResult> {
  switch (patch.kind) {
    case 'fix_fact_by_name': {
      const res = resolveFact(ctx.resolver, patch)
      if (res.kind === 'dropped') {
        ctx.logger.warn(
          {
            stage: ctx.stage,
            kind: patch.kind,
            reason: res.reason,
            entity_name: patch.entity_name,
            fact_topic: patch.fact_topic,
          },
          'coherence_pass: patch references unknown entity+topic; skipping',
        )
        return { events: [] }
      }
      return applyFixFact(client, patch, res.factId)
    }
    case 'fix_prose_by_name': {
      const res = resolveProseTarget(ctx.resolver, patch)
      if (res.kind === 'dropped') {
        ctx.logger.warn(
          {
            stage: ctx.stage,
            kind: patch.kind,
            reason: res.reason,
            entity_name: patch.entity_name,
          },
          'coherence_pass: patch references unknown entity; skipping',
        )
        return { events: [] }
      }
      return applyFixProse(client, patch, res.entityId, ctx, synthKeyByEntityId)
    }
    case 'rename_entity_by_name': {
      const res = resolveRename(ctx.resolver, patch)
      if (res.kind === 'dropped') {
        ctx.logger.warn(
          {
            stage: ctx.stage,
            kind: patch.kind,
            reason: res.reason,
            old_name: patch.old_name,
          },
          'coherence_pass: rename patch references unknown entity; skipping',
        )
        return { events: [] }
      }
      return applyRenameEntity(client, patch, res.entityId, ctx, synthKeyByEntityId)
    }
    case 'fix_relationship_by_name': {
      const res = resolveFixRelationship(ctx.resolver, patch)
      if (res.kind === 'dropped') {
        ctx.logger.warn(
          {
            stage: ctx.stage,
            kind: patch.kind,
            reason: res.reason,
            source: patch.source_name,
            target: patch.target_name,
            type: patch.current_type,
          },
          'coherence_pass: patch references unknown relationship triple; skipping',
        )
        return { events: [] }
      }
      return applyFixRelationship(client, patch, res.relationshipId, ctx, synthKeyByEntityId)
    }
    case 'delete_relationship_by_name': {
      const res = resolveDeleteRelationship(ctx.resolver, patch)
      if (res.kind === 'dropped') {
        ctx.logger.warn(
          {
            stage: ctx.stage,
            kind: patch.kind,
            reason: res.reason,
            source: patch.source_name,
            target: patch.target_name,
            type: patch.current_type,
          },
          'coherence_pass: delete patch references unknown relationship; skipping',
        )
        return { events: [] }
      }
      return applyDeleteRelationship(client, patch, res.relationshipId, ctx, synthKeyByEntityId)
    }
  }
}

/**
 * Run stage 7 — coherence pass.
 *
 * The caller (runStage in world-gen-processor.ts) opens a client and has
 * already issued BEGIN before invoking this handler. The handler:
 *
 *   1. Pre-stage cap check: if cumulative cost from stages 1-6 already
 *      exceeds the cap, return `{ capExhausted: true, finalizedEvents:
 *      [{ type: 'phase', phase: 'complete' }] }` with zero cost. The
 *      outer scope marks worlds.status='complete' and publishes the
 *      phase event after COMMIT (§D5 exception).
 *
 *   2. Happy path: load full world state on the client → LLM call →
 *      validate output → apply each patch on the client (unknown IDs
 *      logged + skipped) → return the per-patch events in
 *      `finalizedEvents` for the outer scope to publish post-COMMIT.
 *
 * Note: the LLM call runs UNDER the outer transaction (Option B in the
 * T12 refactor). See the file header for the §D5 trade-off rationale.
 */
export async function runCoherencePassStage(
  client: PoolClient,
  args: CoherencePassArgs,
): Promise<StageDispatchResult> {
  const capUsd = await readCostCap(client)
  const completedCostUsd = await sumCompletedStageCosts(client, args.worldId)
  if (completedCostUsd > capUsd) {
    // §D5 cap-fire exception: world is functionally complete; coherence
    // is best-effort polish. Skip the LLM, do NOT refund. The outer
    // scope marks worlds.status='complete' and publishes phase:complete
    // after COMMIT.
    args.logger.warn(
      {
        stage: 'coherence_pass',
        worldId: args.worldId,
        completedCostUsd,
        capUsd,
      },
      'coherence_pass: cost cap exhausted pre-stage; skipping coherence pass and marking world complete',
    )
    return {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      capExhausted: true,
      finalizedEvents: [{ type: 'phase', phase: 'complete' }],
    }
  }

  const inventory = await loadWorldInventory(client, args.worldId)

  const worldDump = renderWorldDump(inventory)
  const prompt = PROMPT_TEMPLATE.replaceAll('{{worldDump}}', worldDump).replace(
    '{{vocabularyRegistry}}',
    renderVocabularyRegistry(args.vocabularyRegistry),
  )

  const result = await generateObject({
    model: SONNET,
    schema: CoherenceOutputSchema,
    prompt,
    temperature: 0.4,
    maxRetries: 1,
    callSite: 'coherence-pass',
    schemaName: 'CoherenceOutputSchema',
  })

  const output: CoherenceOutput = result.output

  // Build the per-pass resolver from the inventory snapshot. Per
  // myth-2ob3 §4.1, rename patches apply LAST so every other patch's
  // name-based identifiers resolve against the pre-rename world. The
  // resolver itself is never mutated mid-pass.
  const applyCtx: ApplyContext = {
    inv: inventory,
    resolver: buildResolutionContext(inventory),
    logger: args.logger,
    stage: 'coherence_pass',
    bypassAccessFilter: args.bypassAccessFilter,
  }

  const renamePatches: CoherencePatch[] = []
  const otherPatches: CoherencePatch[] = []
  for (const p of output.patches) {
    if (p.kind === 'rename_entity_by_name') renamePatches.push(p)
    else otherPatches.push(p)
  }

  // Apply every patch on the caller-owned transaction. Renames run
  // LAST so prose/fact/relationship patches resolve against the pre-
  // rename context. Unknown-name skips are logged + dropped without
  // aborting. Each successful patch contributes 0..N event payloads
  // that the outer scope publishes after its own COMMIT.
  const finalizedEvents: PipelineEvent[] = []
  for (const patch of [...otherPatches, ...renamePatches]) {
    const { events } = await applyPatch(
      client,
      patch,
      applyCtx,
      args.synthKeyByEntityId,
    )
    finalizedEvents.push(...events)
  }

  /* c8 ignore start — `?? 0` fallbacks: the Anthropic SDK always
   * populates inputTokens/outputTokens on the final usage emission;
   * the optional-chain narrowing is defense-in-depth. */
  return {
    costUsd: computeCostUsd({
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    }),
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    capExhausted: false,
    finalizedEvents,
  }
  /* c8 ignore stop */
}
