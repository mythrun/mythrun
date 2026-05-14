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
import { streamObject } from 'ai'
import type { Job } from 'bullmq'
import type { Redis } from 'ioredis'
import { SONNET, HAIKU } from '../../models.js'
import { logger } from '../../logger.js'
import { LlmStructuredOutputError } from '../../errors.js'
import {
  EntityRelationshipsSchema,
  type EntityRelationshipsOutput,
} from '../../schemas/entity-relationships.js'
import { runStreamingStage } from '../streaming-extractor.js'
import { repairStructuredOutput } from '../structured-output-repair.js'
import type { StageCost } from '../world-gen-processor.js'
import { entities } from '../../../repo/entities.js'
import { relationships } from '../../../repo/relationships.js'
import { entityHierarchy } from '../../../repo/entity-hierarchy.js'

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
  readonly job: Pick<Job, 'updateProgress'>
  readonly redisRealtime: Pick<Redis, 'publish'>
  readonly redisKeyPrefix: string
}

interface InventoryEntry {
  readonly id: string
  readonly entityType: string
  readonly name: string
}

function renderInventory(inv: readonly InventoryEntry[]): string {
  // Compact reference block: one entity per line, "UUID  [kind]  Name".
  // Kept terse so the prompt token budget stays tight.
  return inv.map((e) => `- ${e.id}  [${e.entityType}]  ${e.name}`).join('\n')
}

function buildPrompt(args: EntityRelationshipsArgs, inventory: readonly InventoryEntry[]): string {
  return PROMPT_TEMPLATE.replace('{{worldName}}', args.worldName)
    .replace('{{tone}}', args.tone)
    .replace('{{themes}}', args.themes)
    .replace('{{keyTensions}}', args.keyTensions)
    .replace('{{entityInventory}}', renderInventory(inventory))
}

async function publishEvent(
  args: EntityRelationshipsArgs,
  payload: Record<string, unknown>,
): Promise<void> {
  const channel = `${args.redisKeyPrefix}pipeline:campaign:${args.campaignId}`
  await args.redisRealtime.publish(channel, JSON.stringify(payload))
}

async function validateOrRepair(
  tree: unknown,
): Promise<{ tree: EntityRelationshipsOutput; repairUsage: { inputTokens: number; outputTokens: number } }> {
  const direct = EntityRelationshipsSchema.safeParse(tree)
  if (direct.success) {
    return { tree: direct.data, repairUsage: { inputTokens: 0, outputTokens: 0 } }
  }

  const haiku = await repairStructuredOutput({
    tree,
    schema: EntityRelationshipsSchema,
    zodErrors: direct.error,
    model: HAIKU,
    stage: 'entity_relationships',
    providerOptions: { mythrun: { stage: 'entity_relationships' } },
  })
  if (haiku.ok) {
    return {
      tree: haiku.tree,
      repairUsage: {
        /* c8 ignore next 2 — `?? 0` defensive: Anthropic SDK always populates usage. */
        inputTokens: haiku.usage.inputTokens ?? 0,
        outputTokens: haiku.usage.outputTokens ?? 0,
      },
    }
  }

  const sonnet = await repairStructuredOutput({
    tree,
    schema: EntityRelationshipsSchema,
    zodErrors: haiku.errors,
    model: SONNET,
    stage: 'entity_relationships',
    providerOptions: { mythrun: { stage: 'entity_relationships' } },
  })
  if (sonnet.ok) {
    return {
      tree: sonnet.tree,
      repairUsage: {
        /* c8 ignore next 4 — `?? 0` defensive on both repair attempts' usage. */
        inputTokens: (haiku.usage.inputTokens ?? 0) + (sonnet.usage.inputTokens ?? 0),
        outputTokens: (haiku.usage.outputTokens ?? 0) + (sonnet.usage.outputTokens ?? 0),
      },
    }
  }

  throw new LlmStructuredOutputError(
    'entity_relationships: repair chain exhausted; falling back to BullMQ retry',
  )
}

interface AcceptedRow {
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly relationshipType: string
  readonly description: string
}

interface PartitionedRows {
  readonly accepted: AcceptedRow[]
  readonly droppedCount: number
}

function partitionRelationships(
  tree: EntityRelationshipsOutput,
  entityIds: ReadonlySet<string>,
): PartitionedRows {
  const accepted: AcceptedRow[] = []
  let droppedCount = 0
  for (const r of tree.relationships) {
    if (!entityIds.has(r.from) || !entityIds.has(r.to)) {
      droppedCount += 1
      continue
    }
    accepted.push({
      sourceEntityId: r.from,
      targetEntityId: r.to,
      relationshipType: r.relationship,
      description: r.description,
    })
  }
  return { accepted, droppedCount }
}

async function persistStragglers(
  client: PoolClient,
  tree: EntityRelationshipsOutput,
  worldId: string,
  entityIds: ReadonlySet<string>,
): Promise<void> {
  if (tree.hierarchy_stragglers.length === 0) return

  // Filter against entity inventory first.
  const inventoryFiltered = tree.hierarchy_stragglers.filter(
    (s) => entityIds.has(s.parent_entity_id) && entityIds.has(s.child_entity_id),
  )
  if (inventoryFiltered.length === 0) return

  // Pre-filter against existing entity_hierarchy rows — stage 3 wins (design §D9).
  const childIds = inventoryFiltered.map((s) => s.child_entity_id)
  const existing = await client.query<{ child_entity_id: string }>(
    `SELECT child_entity_id FROM entity_hierarchy
       WHERE child_entity_id = ANY($1::uuid[])
         AND child_entity_id IN (SELECT id FROM entities WHERE world_id = $2)`,
    [childIds, worldId],
  )
  const existingSet = new Set(existing.rows.map((r) => r.child_entity_id))

  for (const s of inventoryFiltered) {
    if (existingSet.has(s.child_entity_id)) {
      logger.warn(
        {
          stage: 'entity_relationships',
          parent: s.parent_entity_id,
          child: s.child_entity_id,
          reason: 'hierarchy_collision_stage3_wins',
        },
        'entity_relationships: hierarchy straggler dropped — child already has a parent from stage 3',
      )
      continue
    }
    await entityHierarchy.insert(client, {
      parentEntityId: s.parent_entity_id,
      childEntityId: s.child_entity_id,
    })
  }
}

export async function runEntityRelationshipsStage(
  client: PoolClient,
  args: EntityRelationshipsArgs,
): Promise<StageCost> {
  // 1. Read entity inventory — the LLM operates on real UUIDs (design §D9).
  const inventory = await entities.listByWorld(client, args.worldId)
  const entityIds = new Set(inventory.map((e) => e.id))

  // 2. Idempotency wipe — clear any prior stage-4 output before re-writing.
  await relationships.deleteByWorld(client, args.worldId)

  // 3. Stream the relationships via Sonnet + streamObject.
  const prompt = buildPrompt(args, inventory)
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- design §4.1 mandates streamObject for streaming stages
  const stream = streamObject({
    model: SONNET,
    schema: EntityRelationshipsSchema,
    prompt,
    temperature: 0.4,
    maxRetries: 0,
  })

  const { finalTree } = await runStreamingStage<unknown>(stream.partialObjectStream, {
    stage: 'entity_relationships',
    campaignId: args.campaignId,
    job: args.job,
    redisRealtime: args.redisRealtime,
    keyPrefix: args.redisKeyPrefix,
    arrays: [{ path: 'relationships', kind: 'edge', role: 'edge' }],
  })

  // 4. Validate + repair-chain.
  let validatedTree: EntityRelationshipsOutput
  let repairUsage: { inputTokens: number; outputTokens: number }
  try {
    const result = await validateOrRepair(finalTree)
    validatedTree = result.tree
    repairUsage = result.repairUsage
  } catch (err) {
    // Repair chain exhausted — publish stage-reset BEFORE re-throwing so the
    // client knows to drop any partial entity/edge state for this stage
    // (design §7.2 + §7.3). BullMQ retry recreates the stage.
    await publishEvent(args, { type: 'stage-reset', stage: 'entity_relationships' })
    throw err
  }

  // 5. Pre-filter hallucinated UUIDs (design §D9 — never let an FK violation
  // reach Postgres).
  const { accepted, droppedCount } = partitionRelationships(validatedTree, entityIds)
  if (droppedCount > 0) {
    logger.warn(
      {
        stage: 'entity_relationships',
        worldId: args.worldId,
        dropped: droppedCount,
        reason: 'unknown_entity_uuid',
      },
      'entity_relationships: dropped LLM-emitted rows referencing unknown entity UUIDs',
    )
  }

  // 6. Persist relationships + hierarchy stragglers (caller pre-filters
  // stragglers against existing entity_hierarchy rows; stage 3 wins).
  await relationships.insertMany(client, accepted)
  await persistStragglers(client, validatedTree, args.worldId, entityIds)

  // 7. Compute cost: streamObject usage + repair-chain usage.
  const streamUsage = await stream.usage
  /* c8 ignore start — `?? 0` defensive: Anthropic SDK populates usage on the
   * final usage emission; the optional-chain narrowing is defense-in-depth. */
  const inputTokens = (streamUsage.inputTokens ?? 0) + repairUsage.inputTokens
  const outputTokens = (streamUsage.outputTokens ?? 0) + repairUsage.outputTokens
  /* c8 ignore stop */
  return {
    costUsd: computeCostUsd({ inputTokens, outputTokens }),
    inputTokens,
    outputTokens,
  }
}
