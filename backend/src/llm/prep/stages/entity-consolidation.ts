// backend/src/llm/prep/stages/entity-consolidation.ts
//
// Stage 4b (`entity_consolidation`). Per myth-pfke design §3.4 + P4.3 + P4.4.
//
// Reads `worlds.entity_consolidation_pending` (populated by stage 4 with any
// placeholder-endpoint relationships + their associated declarations). If the
// declarations array is empty, this is the SKIP PATH — most worlds finish
// stage 4 with no phantoms, so the cheapest behavior is a zero-cost
// StageDispatchResult and an early return.
//
// When phantoms ARE present (P4.4):
//   1. Idempotency-wipe prior consolidation ghosts (created_in='stage:entity_consolidation').
//      CASCADE FKs clear their facts / prose_kernels / relationships rows.
//   2. Read the entity inventory; render the prompt with the pending
//      declarations + their incoming relationships.
//   3. Sonnet generateObject → EntityConsolidationOutput (ghost_entities[]).
//   4. Reconcile vs declarations: drop ghosts whose placeholder_id wasn't
//      declared (log + continue; do not fail the stage).
//   5. Persist surviving ghosts → entities + prose_kernels + facts +
//      (locations only) entity_hierarchy. Build placeholderId→UUID map.
//   6. Resolve pending placeholder-touching relationships using the map and
//      persist via relationships.insertMany.
//   7. Clear worlds.entity_consolidation_pending to empty arrays.

import type { PoolClient } from 'pg'
import type { Redis } from 'ioredis'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { generateObject } from '../../ai.js'
import { SONNET } from '../../models.js'
import { logger } from '../../logger.js'
import {
  EntityConsolidationSchema,
  type EntityConsolidationOutput,
  type GhostEntity,
} from '../../schemas/entity-consolidation.js'
import { renderVocabularyRegistry } from '../vocabulary-renderer.js'
import { entities } from '../../../repo/entities.js'
import { relationships } from '../../../repo/relationships.js'
import { facts } from '../../../repo/facts.js'
import { proseKernels } from '../../../repo/prose-kernels.js'
import { entityHierarchy } from '../../../repo/entity-hierarchy.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import type { StageDispatchResult } from '../world-gen-processor.js'
import type { VocabularyRegistry } from '../../schemas/vocabulary-registry.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/entity-consolidation.txt'),
  'utf8',
)

// Anthropic Sonnet pricing per https://www.anthropic.com/pricing. Held
// local to the stage so a per-stage tier change is one-file scoped.
const SONNET_INPUT_PER_MTOK = 3.0
const SONNET_OUTPUT_PER_MTOK = 15.0

function computeCostUsd(usage: { inputTokens: number; outputTokens: number }): number {
  return (
    (usage.inputTokens / 1_000_000) * SONNET_INPUT_PER_MTOK +
    (usage.outputTokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK
  )
}

export interface EntityConsolidationArgs {
  readonly campaignId: string
  readonly worldId: string
  readonly worldName: string
  readonly tone: string
  readonly themes: string
  readonly keyTensions: string
  readonly vocabularyRegistry: VocabularyRegistry
  readonly bypassAccessFilter: boolean
  // myth-pfke P5.2: per-ghost `entity-added` (with `placeholderId`) and
  // per-resolved-relationship `edge-added` events publish to Redis Pub/Sub
  // for the dev-tool / FE stream consumers. Channel pattern mirrors
  // streaming-extractor.ts: `${keyPrefix}pipeline:campaign:${campaignId}`.
  readonly redisRealtime: Pick<Redis, 'publish'>
  readonly keyPrefix: string
}

// Mirrors the JSON shape stage 4 writes into `worlds.entity_consolidation_pending`.
// camelCase here because we deserialize via JSON.parse; the column itself is
// JSONB so node-postgres hands us a parsed object directly.
interface PendingDeclaration {
  readonly placeholderId: string
  readonly name: string
  readonly entityType: 'faction' | 'location' | 'npc'
}
interface PendingRelationship {
  readonly from: string
  readonly to: string
  readonly relationship: string
  readonly description: string
}
interface PendingState {
  readonly declarations: readonly PendingDeclaration[]
  readonly relationships: readonly PendingRelationship[]
}

const EMPTY_PENDING: PendingState = { declarations: [], relationships: [] }

function buildPhantomBlock(pending: PendingState): string {
  return pending.declarations
    .map((d) => {
      const relsForPhantom = pending.relationships.filter(
        (r) => r.from === d.placeholderId || r.to === d.placeholderId,
      )
      const relsRendered = relsForPhantom
        .map((r) => `  - ${r.from}  ${r.relationship}  ${r.to}: ${r.description}`)
        .join('\n')
      return `### ${d.placeholderId}  [${d.entityType}]  ${d.name}\n${
        relsRendered || '  (no incoming relationships)'
      }\n`
    })
    .join('\n')
}

function isPlaceholder(id: string): boolean {
  return id.startsWith('new-')
}

export async function runEntityConsolidationStage(
  client: PoolClient,
  args: EntityConsolidationArgs,
): Promise<StageDispatchResult> {
  // 1. Read pending state written by stage 4. JSONB is parsed by node-postgres.
  const pendingRes = await client.query<{ entity_consolidation_pending: PendingState | null }>(
    `SELECT entity_consolidation_pending FROM worlds WHERE id = $1`,
    [args.worldId],
  )
  const pending = pendingRes.rows[0]?.entity_consolidation_pending ?? EMPTY_PENDING

  // 2. Skip path: no phantoms declared by stage 4 → zero-cost early return.
  if (pending.declarations.length === 0) {
    return {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      finalizedEvents: [],
      capExhausted: false,
    }
  }

  // 3. Idempotency wipe — clear any prior stage-4b ghosts so a retry starts
  // from a known-empty surface. CASCADE FKs on entities → facts / prose_kernels
  // / relationships handle the dependent rows.
  await client.query(
    `DELETE FROM entities WHERE world_id = $1 AND created_in = 'stage:entity_consolidation'`,
    [args.worldId],
  )

  // 4. Assemble prompt context. The LLM operates on REAL UUIDs from the
  // entity inventory + the placeholder IDs from pending declarations.
  const inventory = await entities.listByWorld(client, args.worldId)
  const inventoryBlock = inventory
    .map((e) => `- ${e.id}  [${e.entityType}]  ${e.name}`)
    .join('\n')
  const phantomBlock = buildPhantomBlock(pending)

  const prompt = PROMPT_TEMPLATE.replace('{{worldName}}', args.worldName)
    .replace('{{tone}}', args.tone)
    .replace('{{themes}}', args.themes)
    .replace('{{keyTensions}}', args.keyTensions)
    .replace('{{vocabularyRegistry}}', renderVocabularyRegistry(args.vocabularyRegistry))
    .replace('{{entityInventory}}', inventoryBlock)
    .replace('{{phantomBlock}}', phantomBlock)

  // 5. Sonnet generateObject. The wrapper runs the Haiku→Sonnet repair
  // chain on LlmStructuredOutputError; on terminal failure the outer
  // `runStage` dispatcher catches + publishes stage-reset.
  const result = await generateObject({
    model: SONNET,
    schema: EntityConsolidationSchema,
    schemaName: 'EntityConsolidationSchema',
    prompt,
    temperature: 0.4,
    maxRetries: 0,
    callSite: 'entity-consolidation',
    repairStrategy: 'haiku-then-sonnet',
    providerOptions: { mythrun: { stage: 'entity_consolidation' } },
  })
  const validatedTree: EntityConsolidationOutput = result.output

  // 6. Reconcile output vs declarations. The LLM occasionally hallucinates
  // a ghost whose placeholder_id isn't in the declaration map (or omits one
  // that was declared) — log + drop the extras; declared-but-missing
  // placeholders are simply not persisted. Per the plan, this is a WARN
  // log, not a stage failure: schema repair handles the catastrophic case.
  const declarationMap = new Map(pending.declarations.map((d) => [d.placeholderId, d]))
  const surviving: GhostEntity[] = validatedTree.ghost_entities.filter((g) =>
    declarationMap.has(g.placeholder_id),
  )
  if (surviving.length !== validatedTree.ghost_entities.length) {
    logger.warn(
      {
        stage: 'entity_consolidation',
        worldId: args.worldId,
        emitted: validatedTree.ghost_entities.length,
        survived: surviving.length,
        reason: 'undeclared_placeholder_id',
      },
      'entity_consolidation: dropped LLM ghost_entities with undeclared placeholder_id',
    )
  }
  const declaredIds = new Set(pending.declarations.map((d) => d.placeholderId))
  const generatedIds = new Set(surviving.map((g) => g.placeholder_id))
  const missingIds = [...declaredIds].filter((id) => !generatedIds.has(id))
  if (missingIds.length > 0) {
    logger.warn(
      {
        stage: 'entity_consolidation',
        worldId: args.worldId,
        missingPlaceholders: missingIds,
        reason: 'declaration_unfulfilled',
      },
      'entity_consolidation: LLM did not emit ghost_entities for some declared placeholders',
    )
  }

  // 7. Persist surviving ghosts. UUIDv7 per ghost gives time-ordered IDs;
  // we cache the placeholder→UUID mapping so step 8 can resolve pending
  // relationships.
  const channel = `${args.keyPrefix}pipeline:campaign:${args.campaignId}`
  const placeholderToUuid = new Map<string, string>()
  for (const [i, ghost] of surviving.entries()) {
    const ghostId = uuidv7()
    placeholderToUuid.set(ghost.placeholder_id, ghostId)
    await entities.insert(client, {
      id: ghostId,
      worldId: args.worldId,
      entityType: ghost.entity_type,
      name: ghost.name,
      accessLevel: ghost.access_level,
      createdIn: 'stage:entity_consolidation',
    })
    await proseKernels.insert(client, { entityId: ghostId, content: ghost.prose })
    await facts.insertMany(
      client,
      ghost.facts.map((f) => ({
        entityId: ghostId,
        topic: f.topic,
        content: f.content,
        accessLevel: f.access_level,
      })),
    )
    if (ghost.entity_type === 'location' && ghost.parent_location_id !== null) {
      await entityHierarchy.insert(client, {
        parentEntityId: ghost.parent_location_id,
        childEntityId: ghostId,
      })
    }
    // myth-pfke P5.2: per-ghost `entity-added` event carrying the
    // `placeholderId` so any client-buffered placeholder-endpoint edges
    // (emitted earlier by stage 4 via streaming-extractor) can now
    // resolve against the real ghost UUID.
    await args.redisRealtime.publish(
      channel,
      JSON.stringify({
        type: 'entity-added',
        synthKey: `entity_consolidation/ghosts/${String(i)}`,
        entityKind: ghost.entity_type,
        name: ghost.name,
        placeholderId: ghost.placeholder_id,
      }),
    )
  }

  // 8. Resolve pending placeholder-touching relationships using the
  // placeholder→UUID map. Drop any whose placeholder side didn't survive
  // reconciliation (e.g. the LLM omitted that declaration). Real-UUID
  // endpoints pass through unchanged.
  const resolveEndpoint = (id: string): string | undefined => {
    return isPlaceholder(id) ? placeholderToUuid.get(id) : id
  }
  interface ResolvedRel {
    readonly sourceEntityId: string
    readonly targetEntityId: string
    readonly relationshipType: string
    readonly description: string
  }
  const resolvedRels: ResolvedRel[] = []
  for (const r of pending.relationships) {
    const source = resolveEndpoint(r.from)
    const target = resolveEndpoint(r.to)
    if (source === undefined || target === undefined) continue
    resolvedRels.push({
      sourceEntityId: source,
      targetEntityId: target,
      relationshipType: r.relationship,
      description: r.description,
    })
  }
  if (resolvedRels.length > 0) {
    // myth-imxg.5: stamp each row with the same synth_key the post-INSERT
    // `edge-added` event publishes below. The `i` index here MUST match the
    // `i` used by the event-emission loop — they're keyed off the same
    // resolvedRels array, in the same order — so stage 7 can later address
    // these rows on the wire by their established identity.
    const resolvedRelsWithKeys = resolvedRels.map((rel, i) => ({
      ...rel,
      synthKey: `entity_consolidation/relationships/${String(i)}`,
    }))
    await relationships.insertMany(client, resolvedRelsWithKeys)
    // myth-pfke P5.2: per-resolved-relationship `edge-added` event.
    // Endpoints are REAL UUIDs at this point (resolved via
    // placeholderToUuid above); the FE buffered-edges UX only needs to
    // handle placeholder-endpoint edges from stage 4 (entity_relationships),
    // not these.
    for (const [i, rel] of resolvedRels.entries()) {
      await args.redisRealtime.publish(
        channel,
        JSON.stringify({
          type: 'edge-added',
          synthKey: `entity_consolidation/relationships/${String(i)}`,
          from: rel.sourceEntityId,
          to: rel.targetEntityId,
          relationship: rel.relationshipType,
        }),
      )
    }
  }

  // 9. Clear the pending-state column. Stage 4b is the only consumer of
  // this column; emptying it after a successful run means a subsequent
  // stage-4 retry sees a clean slate even before the stage-4 wipe runs.
  await client.query(
    `UPDATE worlds SET entity_consolidation_pending = '{"declarations": [], "relationships": []}'::jsonb WHERE id = $1`,
    [args.worldId],
  )

  /* c8 ignore start — `?? 0` defensive: Anthropic populates usage on every
   * generateObject call; the optional-chain narrowing is defense-in-depth. */
  const inputTokens = result.usage.inputTokens ?? 0
  const outputTokens = result.usage.outputTokens ?? 0
  /* c8 ignore stop */
  return {
    costUsd: computeCostUsd({ inputTokens, outputTokens }),
    inputTokens,
    outputTokens,
    // Stage 4b doesn't emit per-entity `finalized` events — the wave-4
    // wrapper in world-gen-processor (P4.5) will translate ghost inserts
    // into the appropriate events when it adopts this handler.
    finalizedEvents: [],
    capExhausted: false,
  }
}
