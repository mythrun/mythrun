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

import type { Repo } from '../../../repo/index.js'
import type { AccessLevel } from '../../../repo/facts.js'
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
  // MYT-89 Phase A: the relationship tier stage 4 stamped into the buffer;
  // carried into relationships.access_level when the phantom edge materializes.
  readonly accessLevel: AccessLevel
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
  repo: Repo,
  args: EntityConsolidationArgs,
): Promise<StageDispatchResult> {
  // 1. Read pending state written by stage 4. JSONB is parsed by node-postgres.
  // Pool-bound read OUTSIDE the persist tx (precedes the LLM call), as before.
  const pending =
    (await repo.worlds.getEntityConsolidationPending<PendingState>(args.worldId)) ?? EMPTY_PENDING

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

  // 3. Assemble prompt context. The LLM operates on REAL UUIDs from the
  // entity inventory + the placeholder IDs from pending declarations.
  // (Idempotency wipe of prior stage-4b ghosts is folded into the
  // post-LLM transaction below so the BEGIN doesn't wrap the LLM call —
  // see backend/src/db/transaction.ts on why.)
  // Pool-bound read OUTSIDE the persist tx (precedes the LLM call), as before.
  const inventory = await repo.entities.listByWorld(args.worldId)
  const inventoryBlock = inventory
    .map((e) => `- ${e.id}  [${e.entityType}]  ${e.name}`)
    .join('\n')
  const phantomBlock = buildPhantomBlock(pending)

  // Function replacers: every value is user/LLM-derived, so a `$&`/`$'`-style
  // sequence must splice in literally rather than being read as a special
  // replacement pattern.
  const prompt = PROMPT_TEMPLATE.replace('{{worldName}}', () => args.worldName)
    .replace('{{tone}}', () => args.tone)
    .replace('{{themes}}', () => args.themes)
    .replace('{{keyTensions}}', () => args.keyTensions)
    .replace('{{vocabularyRegistry}}', () => renderVocabularyRegistry(args.vocabularyRegistry))
    .replace('{{entityInventory}}', () => inventoryBlock)
    .replace('{{phantomBlock}}', () => phantomBlock)

  // 5. Sonnet generateObject. The wrapper runs the Haiku→Sonnet repair
  // chain on LlmStructuredOutputError; on terminal failure the outer
  // `runStage` dispatcher catches + publishes stage-reset.
  const result = await generateObject({
    model: SONNET,
    schema: EntityConsolidationSchema,
    schemaName: 'EntityConsolidationSchema',
    prompt,
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

  // 7-9. Persist everything atomically. Order within the transaction:
  //   a) idempotency wipe of prior stage-4b ghosts (cascade-clears facts /
  //      prose_kernels / relationships via FK)
  //   b) insert surviving ghosts + their prose / facts / hierarchy
  //   c) resolve placeholder relationships and insert them
  //   d) clear entity_consolidation_pending
  // Redis publishes happen AFTER commit so consumers don't see references
  // to data that hasn't materialized.
  interface ResolvedRel {
    readonly sourceEntityId: string
    readonly targetEntityId: string
    readonly relationshipType: string
    readonly description: string
    readonly accessLevel: AccessLevel
  }
  interface GhostPublish {
    readonly index: number
    readonly entityType: string
    readonly name: string
    readonly placeholderId: string
    // myth-09jy8: the ghost's own tier, gating its entity-added publish.
    readonly accessLevel: AccessLevel
  }
  const placeholderToUuid = new Map<string, string>()
  const ghostPublishes: GhostPublish[] = []
  const persistedRels: ResolvedRel[] = []
  // myth-09jy8: endpoint-tier map for the post-COMMIT edge-added gate. Real
  // entities come from the inventory read above (Entity carries accessLevel);
  // ghost entities are added as they're minted in the transaction below.
  const endpointTierById = new Map<string, AccessLevel>(
    inventory.map((e) => [e.id, e.accessLevel]),
  )
  // Writes only (LLM done — MYT-55); SQL byte-identical, relocated into the
  // entities/proseKernels/facts/entityHierarchy/relationships/worlds binders,
  // composed over the tx client.
  await repo.transaction(async (tx) => {
    // (a) wipe
    await tx.entities.deleteByWorldAndCreatedIn(args.worldId, 'stage:entity_consolidation')
    // (b) ghosts
    for (const [i, ghost] of surviving.entries()) {
      const ghostId = uuidv7()
      placeholderToUuid.set(ghost.placeholder_id, ghostId)
      await tx.entities.insert({
        id: ghostId,
        worldId: args.worldId,
        entityType: ghost.entity_type,
        name: ghost.name,
        accessLevel: ghost.access_level,
        createdIn: 'stage:entity_consolidation',
      })
      await tx.proseKernels.insert({ entityId: ghostId, content: ghost.prose })
      await tx.facts.insertMany(
        ghost.facts.map((f) => ({
          entityId: ghostId,
          topic: f.topic,
          content: f.content,
          accessLevel: f.access_level,
        })),
      )
      if (ghost.entity_type === 'location' && ghost.parent_location_id !== null) {
        await tx.entityHierarchy.insert({
          parentEntityId: ghost.parent_location_id,
          childEntityId: ghostId,
        })
      }
      endpointTierById.set(ghostId, ghost.access_level)
      ghostPublishes.push({
        index: i,
        entityType: ghost.entity_type,
        name: ghost.name,
        placeholderId: ghost.placeholder_id,
        accessLevel: ghost.access_level,
      })
    }
    // (c) placeholder-touching relationships
    const resolveEndpoint = (id: string): string | undefined => {
      return isPlaceholder(id) ? placeholderToUuid.get(id) : id
    }
    for (const r of pending.relationships) {
      const source = resolveEndpoint(r.from)
      const target = resolveEndpoint(r.to)
      if (source === undefined || target === undefined) continue
      persistedRels.push({
        sourceEntityId: source,
        targetEntityId: target,
        relationshipType: r.relationship,
        description: r.description,
        accessLevel: r.accessLevel,
      })
    }
    if (persistedRels.length > 0) {
      // myth-imxg.5: stamp each row with the same synth_key the post-COMMIT
      // `edge-added` event publishes below. The `i` index here MUST match
      // the `i` used by the event-emission loop — same array, same order —
      // so stage 7 can later address these rows on the wire by their
      // established identity.
      const withKeys = persistedRels.map((rel, i) => ({
        ...rel,
        synthKey: `entity_consolidation/relationships/${String(i)}`,
      }))
      await tx.relationships.insertMany(withKeys)
    }
    // (d) clear pending
    await tx.worlds.clearEntityConsolidationPending(args.worldId)
  })
  // Post-COMMIT publishes — myth-pfke P5.2 buffered-edge resolution. Each
  // ghost gets an `entity-added` event carrying its placeholderId so
  // client-buffered placeholder-endpoint edges (emitted earlier by stage 4
  // via the streaming extractor) can now resolve against the real ghost
  // UUID. Each persisted relationship gets an `edge-added`. Endpoints are
  // REAL UUIDs at this point.
  //
  // myth-09jy8 (P1 enforced-ignorance, discovered-from myth-pq0ug): both
  // loops are tier-gated. The channel is player-facing, so a non-known ghost
  // never emits entity-added, and an edge emits only when its OWN tier AND
  // both endpoint tiers are `known` — the same triple gate as stage 4's
  // shouldEmitEdge / finalized loop and stage 7's shouldEmitEdgeEvent.
  // Fail-closed (a missing endpoint tier suppresses). bypassAccessFilter
  // (dev-tool / author mode) widens to everything, mirroring the other
  // stages. DB persistence above is unaffected. Suppression never shifts
  // synthKey indices — they're minted from insert order, not publish order.
  const channel = `${args.keyPrefix}pipeline:campaign:${args.campaignId}`
  for (const g of ghostPublishes) {
    if (!args.bypassAccessFilter && g.accessLevel !== 'known') continue
    await args.redisRealtime.publish(
      channel,
      JSON.stringify({
        type: 'entity-added',
        synthKey: `entity_consolidation/ghosts/${String(g.index)}`,
        entityKind: g.entityType,
        name: g.name,
        placeholderId: g.placeholderId,
      }),
    )
  }
  for (const [i, rel] of persistedRels.entries()) {
    const edgeVisible =
      args.bypassAccessFilter ||
      (rel.accessLevel === 'known' &&
        endpointTierById.get(rel.sourceEntityId) === 'known' &&
        endpointTierById.get(rel.targetEntityId) === 'known')
    if (!edgeVisible) continue
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
