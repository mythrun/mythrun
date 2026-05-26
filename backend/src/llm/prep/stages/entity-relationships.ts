// backend/src/llm/prep/stages/entity-relationships.ts
//
// Stage 4 of world-gen — NEW stage introduced by MYT-52 (design §3.3 + §D9).
//
// Streams structured relationships via `streamObject` on Sonnet. Reads the
// entity inventory at the start (so the LLM operates on real UUIDs, not
// names — design §D9), publishes `edge-added` events as the stream
// progresses, then validates the final tree with the repair chain
// (Haiku → Sonnet → BullMQ retry).
//
// Idempotency: the first DB action is `relationships.deleteByWorld` so a
// retry after a partially-completed run lands in a clean state (design §D9).
//
// Hallucinated UUIDs: the persister builds a `Set<entityId>` from the
// inventory and pre-filters every relationship row + hierarchy straggler
// against that set BEFORE the INSERT. Invalid rows are WARN-logged but
// not thrown — they're a known LLM failure mode and dropping them doesn't
// corrupt the world. This avoids letting an FK violation reach Postgres
// (which would abort the entire stage transaction).
//
// Hierarchy stragglers: stage 4's stragglers are a fallback for stage 3's
// misses. We pre-filter against the existing `entity_hierarchy` rows so
// stage 3's links always win (design §D9: "stage 3 wins" on collisions).

import type { PoolClient } from 'pg'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
// Routes through the canonical streaming wrapper (myth-t1qz). The
// wrapper preserves partialObjectStream + usage + textStream and replaces
// `object` with a repair-aware promise that runs the Haiku→Sonnet repair
// chain on LlmStructuredOutputError from the underlying SDK call.
import { streamObject } from '../../ai.js'
import type { Job } from 'bullmq'
import type { Redis } from 'ioredis'
import { SONNET } from '../../models.js'
import { logger } from '../../logger.js'
import {
  EntityRelationshipsSchema,
  declarationItemSchema,
  relationshipItemSchema,
  type EntityRelationshipsOutput,
} from '../../schemas/entity-relationships.js'
import { runStreamingStage } from '../streaming-extractor.js'
import type { StageDispatchResult } from '../world-gen-processor.js'
import { relationships } from '../../../repo/relationships.js'
import { entityHierarchy } from '../../../repo/entity-hierarchy.js'
import type { AccessLevel } from '../../../repo/facts.js'
import type { PipelineEvent } from '../../../contract/pipeline-events.js'
import { renderVocabularyRegistry } from '../vocabulary-renderer.js'
import type { VocabularyRegistry } from '../../schemas/vocabulary-registry.js'
import { loadWorldInventory } from '../world-dump.js'
import {
  buildResolutionContext,
  resolveRelationship,
  resolveProseTarget,
  type NameResolutionContext,
} from '../name-resolution.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/entity-relationships.txt'),
  'utf8',
)

const SONNET_INPUT_PER_MTOK = 3.0
const SONNET_OUTPUT_PER_MTOK = 15.0

function computeCostUsd(usage: { inputTokens: number; outputTokens: number }): number {
  return (
    (usage.inputTokens / 1_000_000) * SONNET_INPUT_PER_MTOK +
    (usage.outputTokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK
  )
}

export interface EntityRelationshipsArgs {
  readonly campaignId: string
  readonly worldId: string
  readonly worldName: string
  readonly tone: string
  readonly themes: string
  readonly keyTensions: string
  readonly vocabularyRegistry: VocabularyRegistry
  readonly job: Pick<Job, 'updateProgress'>
  readonly redisRealtime: Pick<Redis, 'publish'>
  readonly keyPrefix: string
  // myth-exac T15: when true, every persisted relationship surfaces as a
  // `finalized` event regardless of endpoint tier. The DB insert and the
  // streaming `edge-added` emission are both gated by the same flag.
  // Authors / dev-tool runs pass true to see every edge in the wire feed.
  readonly bypassAccessFilter: boolean
}

interface InventoryEntry {
  readonly id: string
  readonly entityType: string
  readonly name: string
  readonly accessLevel: AccessLevel
}

function renderInventory(inv: readonly InventoryEntry[]): string {
  // Name-based inventory: one entity per line. The LLM uses these names
  // verbatim in from_name/to_name fields; the server resolves names →
  // UUIDs at persist time.
  return inv.map((e) => `- ${e.name}  [${e.entityType}]`).join('\n')
}

function buildPrompt(args: EntityRelationshipsArgs, inventory: readonly InventoryEntry[]): string {
  return PROMPT_TEMPLATE.replace('{{worldName}}', args.worldName)
    .replace('{{tone}}', args.tone)
    .replace('{{themes}}', args.themes)
    .replace('{{keyTensions}}', args.keyTensions)
    .replace('{{entityInventory}}', renderInventory(inventory))
    .replace('{{vocabularyRegistry}}', renderVocabularyRegistry(args.vocabularyRegistry))
}

interface AcceptedRow {
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly relationshipType: string
  readonly description: string
  // myth-exac T15: the source-array index from the LLM stream. Carried
  // forward so the post-commit `finalized` synthKey matches the streaming
  // extractor's mid-flight `edge-added` synthKey
  // (`entity_relationships/relationships/${sourceIndex}`).
  readonly sourceIndex: number
}

// myth-pfke P3.3: phantom-reference reconciliation. Stage 4's schema (P3.1)
// now accepts placeholder endpoints (`new-NNN`) plus a `new_entity_declarations`
// list. The partitioner splits the LLM tree into three buckets:
//   1. realRelationships — both endpoints are inventory UUIDs → INSERT now.
//   2. placeholderRelationships — at least one endpoint is a placeholder
//      with a matching declaration → write to `worlds.entity_consolidation_pending`
//      for stage 4b to materialize.
//   3. dropped — orphan placeholders (no matching declaration) or
//      hallucinated UUIDs on the real side. WARN-logged, never thrown.
interface PlaceholderRelationshipRow {
  readonly from: string
  readonly to: string
  readonly relationship: string
  readonly description: string
}

interface ValidDeclaration {
  readonly placeholderId: string
  readonly name: string
  readonly entityType: 'faction' | 'location' | 'npc'
}

interface PartitionedByNames {
  readonly realRelationships: AcceptedRow[]
  readonly placeholderRelationships: PlaceholderRelationshipRow[]
  readonly validDeclarations: ValidDeclaration[]
  readonly droppedHallucinatedCount: number
  readonly droppedOrphanPlaceholderCount: number
}

function partitionByNames(
  tree: EntityRelationshipsOutput,
  ctx: NameResolutionContext,
  pendingDeclarations: ReadonlyMap<string, { synthId: string; entityType: string }>,
): PartitionedByNames {
  const realRelationships: AcceptedRow[] = []
  const placeholderRelationships: PlaceholderRelationshipRow[] = []
  let droppedHallucinatedCount = 0
  let droppedOrphanPlaceholderCount = 0

  for (const [i, r] of tree.relationships.entries()) {
    const res = resolveRelationship(ctx, r, pendingDeclarations)
    switch (res.kind) {
      case 'resolved':
        realRelationships.push({
          sourceEntityId: res.sourceEntityId,
          targetEntityId: res.targetEntityId,
          relationshipType: res.relationshipType,
          description: res.description,
          sourceIndex: i,
        })
        break
      case 'phantom_target':
        placeholderRelationships.push({
          from: res.sourceEntityId,
          to: res.synthId,
          relationship: res.relationshipType,
          description: res.description,
        })
        break
      case 'phantom_source':
        placeholderRelationships.push({
          from: res.synthId,
          to: res.targetEntityId,
          relationship: res.relationshipType,
          description: res.description,
        })
        break
      case 'phantom_both':
        placeholderRelationships.push({
          from: res.sourceSynthId,
          to: res.targetSynthId,
          relationship: res.relationshipType,
          description: res.description,
        })
        break
      case 'dropped':
        // ambiguous_source / ambiguous_target / unknown_* — all surface as
        // drop with reason WARN at the call-site (the run loop logs the
        // aggregate count below).
        if (
          res.reason === 'unknown_source' ||
          res.reason === 'unknown_target' ||
          res.reason === 'unknown_both'
        ) {
          droppedHallucinatedCount += 1
        } else {
          droppedOrphanPlaceholderCount += 1
        }
        break
    }
  }

  // Mint validDeclarations from the pending map (which the streaming
  // extractor populated as the LLM emitted items). Each declaration's
  // synthId is server-side stable; downstream stage 4b reads
  // placeholderId from the same field name.
  const validDeclarations: ValidDeclaration[] = Array.from(pendingDeclarations.entries()).map(
    ([name, p]) => ({
      placeholderId: p.synthId,
      name,
      // Cast preserves the {'faction' | 'location' | 'npc'} narrowing — the
      // extractor only mints synthIds for entries whose entity_type is one of
      // those three (declarationItemSchema enforces this at Zod-validate time).
      entityType: p.entityType as 'faction' | 'location' | 'npc',
    }),
  )

  return {
    realRelationships,
    placeholderRelationships,
    validDeclarations,
    droppedHallucinatedCount,
    droppedOrphanPlaceholderCount,
  }
}

async function persistStragglers(
  client: PoolClient,
  tree: EntityRelationshipsOutput,
  worldId: string,
  ctx: NameResolutionContext,
): Promise<void> {
  if (tree.hierarchy_stragglers.length === 0) return

  // Resolve parent_name + child_name to entity UUIDs. Drop rows where
  // either endpoint doesn't resolve (unknown_entity / ambiguous_entity).
  interface ResolvedStraggler {
    parentEntityId: string
    childEntityId: string
  }
  const resolved: ResolvedStraggler[] = []
  for (const s of tree.hierarchy_stragglers) {
    const parent = resolveProseTarget(ctx, { entity_name: s.parent_name })
    const child = resolveProseTarget(ctx, { entity_name: s.child_name })
    if (parent.kind !== 'resolved' || child.kind !== 'resolved') {
      logger.warn(
        {
          stage: 'entity_relationships',
          parent_name: s.parent_name,
          child_name: s.child_name,
          reason:
            parent.kind === 'dropped'
              ? `parent_${parent.reason}`
              : `child_${child.kind === 'dropped' ? child.reason : 'unknown'}`,
        },
        'entity_relationships: hierarchy straggler dropped — name unresolvable',
      )
      continue
    }
    resolved.push({ parentEntityId: parent.entityId, childEntityId: child.entityId })
  }
  if (resolved.length === 0) return

  // Pre-filter against existing entity_hierarchy rows — stage 3 wins (design §D9).
  const childIds = resolved.map((s) => s.childEntityId)
  const existing = await client.query<{ child_entity_id: string }>(
    `SELECT child_entity_id FROM entity_hierarchy
       WHERE child_entity_id = ANY($1::uuid[])
         AND child_entity_id IN (SELECT id FROM entities WHERE world_id = $2)`,
    [childIds, worldId],
  )
  const existingSet = new Set(existing.rows.map((r) => r.child_entity_id))

  for (const s of resolved) {
    if (existingSet.has(s.childEntityId)) {
      logger.warn(
        {
          stage: 'entity_relationships',
          parent: s.parentEntityId,
          child: s.childEntityId,
          reason: 'hierarchy_collision_stage3_wins',
        },
        'entity_relationships: hierarchy straggler dropped — child already has a parent from stage 3',
      )
      continue
    }
    await entityHierarchy.insert(client, {
      parentEntityId: s.parentEntityId,
      childEntityId: s.childEntityId,
    })
  }
}

export async function runEntityRelationshipsStage(
  client: PoolClient,
  args: EntityRelationshipsArgs,
): Promise<StageDispatchResult> {
  // 1. Load the FULL world inventory (entities + prose + facts + relationships).
  // The full shape is needed by buildResolutionContext + by the renderer.
  // myth-2ob3: stage 4 operates on entity NAMES (not UUIDs); the resolver
  // maps names → UUIDs at persist time.
  const fullInventory = await loadWorldInventory(client, args.worldId)
  const inventory: readonly InventoryEntry[] = Array.from(fullInventory.entitiesById.values())
  const nameResolutionCtx = buildResolutionContext(fullInventory)
  const pendingDeclarations = new Map<string, { synthId: string; entityType: string }>()
  // myth-exac T15: endpoint-tier map for stage 4 — the streaming extractor
  // gates mid-flight `edge-added` events on whether BOTH endpoints are
  // `known`. The post-commit `finalized` events are gated by the same
  // check. Stage 4 is the only world-gen stage with edges, so it's the
  // only stage that builds a non-empty map.
  const endpointTierMap = new Map<string, AccessLevel>(
    inventory.map((e) => [e.id, e.accessLevel]),
  )

  // 2. Idempotency wipe — clear any prior stage-4 output before re-writing.
  await relationships.deleteByWorld(client, args.worldId)

  // myth-tt2g: stage 4 retry must also cascade-clear prior stage-4b
  // ghosts. Otherwise a stage-4 retry leaves orphan ghosts whose
  // declarations the new stage-4 attempt may not match. Stage 4 + 4b
  // are a single retry unit from the durability standpoint.
  await client.query(
    `DELETE FROM entities WHERE world_id = $1 AND created_in = 'stage:entity_consolidation'`,
    [args.worldId],
  )

  // 3. Stream the relationships via Sonnet + streamObject. The wrapper
  // (myth-t1qz) drives the Haiku→Sonnet repair chain inside
  // `await stream.object` on LlmStructuredOutputError.
  const prompt = buildPrompt(args, inventory)
  const stream = streamObject({
    model: SONNET,
    schema: EntityRelationshipsSchema,
    prompt,
    temperature: 0.4,
    maxRetries: 0,
    callSite: 'entity-relationships',
    schemaName: 'EntityRelationshipsSchema',
    repairStrategy: 'haiku-then-sonnet',
    providerOptions: { mythrun: { stage: 'entity_relationships' } },
  })

  await runStreamingStage<unknown>(stream.partialObjectStream, {
    stage: 'entity_relationships',
    campaignId: args.campaignId,
    job: args.job,
    redisRealtime: args.redisRealtime,
    keyPrefix: args.keyPrefix,
    arrays: [
      // Declarations stream FIRST (schema field order is declarations →
      // relationships → hierarchy). Per myth-2ob3 §5: the streaming-extractor
      // mints `new-NNN` synthIds into pendingDeclarations as it sees
      // declaration entries close; downstream relationship entries
      // reference those synthIds via the resolver.
      {
        path: 'new_entity_declarations',
        kind: 'declaration',
        role: 'entity',
        sub_schema: declarationItemSchema,
      },
      { path: 'relationships', kind: 'edge', role: 'edge', sub_schema: relationshipItemSchema },
    ],
    bypassAccessFilter: args.bypassAccessFilter,
    endpointTierMap,
    nameResolutionCtx,
    pendingDeclarations,
  })

  // 4. The wrapper's `object` promise resolves to the validated tree (or
  // a repaired tree when the SDK threw a structured-output error and
  // the Haiku→Sonnet chain recovered). If the chain exhausts the wrapper
  // rethrows the original LlmStructuredOutputError; the outer dispatcher
  // (`runStage` in world-gen-processor) is responsible for ROLLBACK +
  // publishing `stage-reset` (design §7.2 + §7.3). BullMQ retry
  // recreates the stage.
  const validatedTree: EntityRelationshipsOutput = await stream.object

  // 5. Pre-filter hallucinated UUIDs + route placeholder-touching rows
  // (myth-pfke P3.3). Design §D9: never let an FK violation reach Postgres.
  // Real→real rows persist into `relationships`; placeholder-touching rows
  // (with matching declarations) are buffered into
  // `worlds.entity_consolidation_pending` for stage 4b to materialize.
  const partitioned = partitionByNames(validatedTree, nameResolutionCtx, pendingDeclarations)
  if (partitioned.droppedHallucinatedCount > 0) {
    logger.warn(
      {
        stage: 'entity_relationships',
        worldId: args.worldId,
        dropped: partitioned.droppedHallucinatedCount,
        reason: 'unknown_entity_uuid',
      },
      'entity_relationships: dropped LLM-emitted rows referencing unknown entity UUIDs',
    )
  }
  if (partitioned.droppedOrphanPlaceholderCount > 0) {
    logger.warn(
      {
        stage: 'entity_relationships',
        worldId: args.worldId,
        dropped: partitioned.droppedOrphanPlaceholderCount,
        reason: 'orphan_placeholder',
      },
      'entity_relationships: dropped LLM-emitted rows referencing placeholders not in new_entity_declarations',
    )
  }
  const accepted = partitioned.realRelationships

  // 6. Persist relationships + hierarchy stragglers (caller pre-filters
  // stragglers against existing entity_hierarchy rows; stage 3 wins).
  // myth-exac T15: insertMany returns the generated UUIDv7 ids in row
  // order so we can emit a `finalized` event per tier-passing edge.
  const relationshipIds = await relationships.insertMany(
    client,
    accepted.map((a) => ({
      sourceEntityId: a.sourceEntityId,
      targetEntityId: a.targetEntityId,
      relationshipType: a.relationshipType,
      description: a.description,
    })),
  )
  await persistStragglers(client, validatedTree, args.worldId, nameResolutionCtx)

  // 6b. Persist phantom declarations + placeholder relationships to the
  // pending-state column for stage 4b to consume (myth-pfke P3.3). Always
  // write — stage 4b reads a known shape regardless of declaration count.
  await client.query(
    `UPDATE worlds SET entity_consolidation_pending = $1::jsonb WHERE id = $2`,
    [
      JSON.stringify({
        declarations: partitioned.validDeclarations,
        relationships: partitioned.placeholderRelationships,
      }),
      args.worldId,
    ],
  )

  // myth-exac T15: tier-gate `finalized` events for relationships. The DB
  // insert above is unaffected — every accepted (non-hallucinated) row
  // persists. Only the wire surfacing is filtered: an edge surfaces post-
  // commit only when BOTH endpoints are `known` (or bypass is on). This
  // mirrors the streaming-extractor's mid-flight `edge-added` gating so
  // the wire feed stays internally consistent.
  const finalizedEvents: PipelineEvent[] = []
  for (const [i, row] of accepted.entries()) {
    const fromTier = endpointTierMap.get(row.sourceEntityId)
    const toTier = endpointTierMap.get(row.targetEntityId)
    const shouldFinalize =
      args.bypassAccessFilter || (fromTier === 'known' && toTier === 'known')
    if (!shouldFinalize) continue
    const relationshipId = relationshipIds[i]
    /* c8 ignore next 3 — defensive: insertMany returns one id per input row.
     * The arms only fire if the repo contract is violated. */
    if (relationshipId === undefined) continue
    finalizedEvents.push({
      type: 'finalized',
      synthKey: `entity_relationships/relationships/${String(row.sourceIndex)}`,
      entityId: relationshipId,
    })
  }

  // 7. Compute cost: streamObject usage. Repair-chain usage (when fired)
  // is folded inside the wrapper and not separately attributed here —
  // see ai.ts header on cost-accounting boundaries.
  const streamUsage = await stream.usage
  /* c8 ignore start — `?? 0` defensive: Anthropic SDK populates usage on the
   * final usage emission; the optional-chain narrowing is defense-in-depth. */
  const inputTokens = streamUsage.inputTokens ?? 0
  const outputTokens = streamUsage.outputTokens ?? 0
  /* c8 ignore stop */
  return {
    costUsd: computeCostUsd({ inputTokens, outputTokens }),
    inputTokens,
    outputTokens,
    finalizedEvents,
    // Stage 4 does not consult the campaign cost cap — it can't cap-fire.
    capExhausted: false,
  }
}
