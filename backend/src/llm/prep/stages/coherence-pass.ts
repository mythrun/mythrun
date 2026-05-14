// backend/src/llm/prep/stages/coherence-pass.ts
//
// Stage 7 of world gen — coherence pass. Per MYT-52 design §3.6 + §D5.
//
// Non-streaming Sonnet call: reads full world state, identifies
// contradictions / typos / role conflicts / dangling references, emits
// a list of patches keyed by REAL UUID. The patch list parses + validates
// BEFORE the BEGIN; the apply path inside the transaction is purely
// mechanical (no LLM nondeterminism after BEGIN).
//
// Cap-fire exception (§D5): unlike stages 1-6 where cap-fire means refund
// + world_gen_failed, cap-fire at stage 7 means the world is functionally
// complete — coherence is best-effort polish. We mark `worlds.status =
// 'complete'`, emit `phase: complete`, log skipped coherence at WARN, do
// NOT refund. The world ships with whatever incoherences the prep
// generation produced.
//
// Apply-time skipping (§3.6): if a patch references a UUID that doesn't
// exist (LLM hallucinated an ID), the patch is logged at WARN and skipped
// — the world isn't broken, the LLM was just imprecise. Other patches in
// the same batch still apply.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import type { Redis } from 'ioredis'
import type pino from 'pino'
import { generateText, Output } from 'ai'
import { SONNET } from '../../models.js'
import {
  CoherenceOutputSchema,
  type CoherenceOutput,
  type CoherencePatch,
} from '../../schemas/coherence-output.js'
import { entities } from '../../../repo/entities.js'
import { proseKernels } from '../../../repo/prose-kernels.js'
import { facts } from '../../../repo/facts.js'
import { relationships } from '../../../repo/relationships.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import { readCostCap, sumCompletedStageCosts } from '../cost-cap.js'

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
  readonly pool: Pool
  readonly redisRealtime: Pick<Redis, 'publish'>
  readonly logger: Pick<pino.Logger, 'warn' | 'info'>
  readonly worldId: string
  readonly campaignId: string
  readonly userId: string
  readonly keyPrefix: string
  // Map from real entity/relationship UUID → synthKey assigned by stages
  // 2/3/4. Stage 7's `entity-updated` / `edge-removed` / `edge-added`
  // events reference synthKey on the wire (§3.6); the handler looks up
  // each patch's UUID against this map before publishing.
  readonly synthKeyByEntityId: Readonly<Record<string, string>>
}

export interface CoherencePassResult {
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
  // True when the pre-stage cap check fired. The processor uses this to
  // skip its post-stage cap-and-refund branch (§D5 exception).
  readonly capExhausted: boolean
}

// Internal in-memory inventory of the world's UUIDs at stage-7 entry.
// Used both for (a) the world dump rendered into the prompt, and (b) the
// unknown-ID skip filter applied to LLM-emitted patches.
interface WorldInventory {
  readonly entitiesById: Map<string, { id: string; name: string; entityType: string }>
  readonly proseByEntityId: Map<string, string>
  readonly factsById: Map<string, { id: string; entityId: string; content: string; topic: string; accessLevel: string }>
  readonly relationshipsById: Map<
    string,
    {
      id: string
      sourceEntityId: string
      targetEntityId: string
      relationshipType: string
      description: string
    }
  >
}

async function loadWorldInventory(client: PoolClient, worldId: string): Promise<WorldInventory> {
  const entityRows = await entities.listByWorld(client, worldId)
  const entitiesById = new Map(
    entityRows.map((e) => [e.id, { id: e.id, name: e.name, entityType: e.entityType }]),
  )

  const proseResult = await client.query<{ entity_id: string; content: string }>(
    `SELECT pk.entity_id, pk.content
       FROM prose_kernels pk
       JOIN entities e ON e.id = pk.entity_id
      WHERE e.world_id = $1`,
    [worldId],
  )
  const proseByEntityId = new Map<string, string>()
  for (const row of proseResult.rows) {
    proseByEntityId.set(row.entity_id, row.content)
  }

  const factResult = await client.query<{
    id: string
    entity_id: string
    topic: string
    access_level: string
    content: string
  }>(
    `SELECT f.id, f.entity_id, f.topic, f.access_level, f.content
       FROM facts f
       JOIN entities e ON e.id = f.entity_id
      WHERE e.world_id = $1`,
    [worldId],
  )
  const factsById = new Map<
    string,
    { id: string; entityId: string; content: string; topic: string; accessLevel: string }
  >()
  for (const row of factResult.rows) {
    factsById.set(row.id, {
      id: row.id,
      entityId: row.entity_id,
      topic: row.topic,
      accessLevel: row.access_level,
      content: row.content,
    })
  }

  const relRows = await relationships.listByWorld(client, worldId)
  const relationshipsById = new Map(relRows.map((r) => [r.id, r]))

  return { entitiesById, proseByEntityId, factsById, relationshipsById }
}

// Render the inventory into a deterministic textual block. The LLM gets
// every entity's UUID + name + entity_type, then its prose kernel, then
// its facts, then its outgoing relationships — in that order, grouped by
// entity. Relationships are listed once per source entity (the target's
// UUID is included so the LLM has both ends).
function renderWorldDump(inv: WorldInventory): string {
  const lines: string[] = []
  for (const entity of inv.entitiesById.values()) {
    lines.push(`## Entity ${entity.id} (${entity.entityType}): ${entity.name}`)
    const prose = inv.proseByEntityId.get(entity.id)
    if (prose !== undefined) {
      lines.push(`### Prose kernel`)
      lines.push(prose)
    }
    const ownFacts = Array.from(inv.factsById.values()).filter((f) => f.entityId === entity.id)
    if (ownFacts.length > 0) {
      lines.push(`### Facts`)
      for (const fact of ownFacts) {
        lines.push(
          `- Fact ${fact.id} [${fact.topic}, ${fact.accessLevel}]: ${fact.content}`,
        )
      }
    }
    const outgoing = Array.from(inv.relationshipsById.values()).filter(
      (r) => r.sourceEntityId === entity.id,
    )
    if (outgoing.length > 0) {
      lines.push(`### Relationships (outgoing)`)
      for (const rel of outgoing) {
        lines.push(
          `- Relationship ${rel.id} → target ${rel.targetEntityId} [${rel.relationshipType}]: ${rel.description}`,
        )
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

interface ApplyContext {
  readonly inv: WorldInventory
  readonly logger: Pick<pino.Logger, 'warn' | 'info'>
  readonly stage: 'coherence_pass'
}

interface ApplyResult {
  readonly events: Record<string, unknown>[]
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
  patch: Extract<CoherencePatch, { kind: 'fix_fact' }>,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  if (!ctx.inv.factsById.has(patch.factId)) {
    warnUnknown(ctx, patch.kind, 'factId', patch.factId)
    return { events: [] }
  }
  await facts.updateContentById(client, patch.factId, { content: patch.newContent })
  // fix_fact emits NO SSE event per §3.6 — facts are not exposed as
  // standalone client-side entities; the FE re-reads them on next entity
  // query.
  return { events: [] }
}

async function applyFixProse(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'fix_prose' }>,
  ctx: ApplyContext,
  synthKeyByEntityId: SynthKeyMap,
): Promise<ApplyResult> {
  if (!ctx.inv.entitiesById.has(patch.entityId)) {
    warnUnknown(ctx, patch.kind, 'entityId', patch.entityId)
    return { events: [] }
  }
  await proseKernels.updateByEntityId(client, patch.entityId, { content: patch.newProse })
  const synthKey = synthKeyByEntityId[patch.entityId]
  /* c8 ignore start — defense-in-depth: in T13's integration the synthKey
   * map is always populated for every UUID; tests exercise the populated
   * path. The patch persisted but we can't address the entity on the wire
   * (no synthKey in the map) — log + drop the event; the DB is still
   * consistent. */
  if (synthKey === undefined) {
    warnUnknown(ctx, patch.kind, 'entityId', patch.entityId)
    return { events: [] }
  }
  /* c8 ignore stop */
  return {
    events: [{ type: 'entity-updated', synthKey, patch: { prose: patch.newProse } }],
  }
}

async function applyRenameEntity(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'rename_entity' }>,
  ctx: ApplyContext,
  synthKeyByEntityId: SynthKeyMap,
): Promise<ApplyResult> {
  if (!ctx.inv.entitiesById.has(patch.entityId)) {
    warnUnknown(ctx, patch.kind, 'entityId', patch.entityId)
    return { events: [] }
  }
  await client.query(`UPDATE entities SET name = $1 WHERE id = $2`, [
    patch.newName,
    patch.entityId,
  ])
  const synthKey = synthKeyByEntityId[patch.entityId]
  /* c8 ignore start — defense-in-depth: see applyFixProse comment. */
  if (synthKey === undefined) {
    warnUnknown(ctx, patch.kind, 'entityId', patch.entityId)
    return { events: [] }
  }
  /* c8 ignore stop */
  return {
    events: [{ type: 'entity-updated', synthKey, patch: { name: patch.newName } }],
  }
}

async function applyFixRelationship(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'fix_relationship' }>,
  ctx: ApplyContext,
  synthKeyByEntityId: SynthKeyMap,
): Promise<ApplyResult> {
  const existing = ctx.inv.relationshipsById.get(patch.relationshipId)
  if (existing === undefined) {
    warnUnknown(ctx, patch.kind, 'relationshipId', patch.relationshipId)
    return { events: [] }
  }
  // Per §3.6: fix_relationship emits edge-removed + edge-added on a NEW
  // synthKey (the edge entity is logically replaced).
  await relationships.deleteById(client, patch.relationshipId)
  const newRelationshipType = patch.newType ?? existing.relationshipType
  const newDescription = patch.newDescription ?? existing.description
  const newId = uuidv7()
  await client.query(
    `INSERT INTO relationships
       (id, source_entity_id, target_entity_id, relationship_type, description)
     VALUES ($1, $2, $3, $4, $5)`,
    [newId, existing.sourceEntityId, existing.targetEntityId, newRelationshipType, newDescription],
  )
  const oldSynthKey = synthKeyByEntityId[patch.relationshipId]
  const newSynthKey = `coherence_pass/edges/${newId}`
  const events: Record<string, unknown>[] = []
  if (oldSynthKey !== undefined) {
    events.push({ type: 'edge-removed', synthKey: oldSynthKey, reason: 'coherence_deleted' })
    /* c8 ignore start — defense-in-depth: the `else` arm (missing synthKey
     * for an existing relationship) is not reachable under T13's
     * integration. */
  } else {
    warnUnknown(ctx, patch.kind, 'relationshipId', patch.relationshipId)
  }
  /* c8 ignore stop */
  events.push({
    type: 'edge-added',
    synthKey: newSynthKey,
    from: existing.sourceEntityId,
    to: existing.targetEntityId,
    relationship: newRelationshipType,
    description: newDescription,
  })
  return { events }
}

async function applyDeleteRelationship(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'delete_relationship' }>,
  ctx: ApplyContext,
  synthKeyByEntityId: SynthKeyMap,
): Promise<ApplyResult> {
  if (!ctx.inv.relationshipsById.has(patch.relationshipId)) {
    warnUnknown(ctx, patch.kind, 'relationshipId', patch.relationshipId)
    return { events: [] }
  }
  await relationships.deleteById(client, patch.relationshipId)
  const synthKey = synthKeyByEntityId[patch.relationshipId]
  /* c8 ignore start — defense-in-depth: see applyFixProse comment. */
  if (synthKey === undefined) {
    warnUnknown(ctx, patch.kind, 'relationshipId', patch.relationshipId)
    return { events: [] }
  }
  /* c8 ignore stop */
  return {
    events: [{ type: 'edge-removed', synthKey, reason: 'coherence_deleted' }],
  }
}

// Apply one patch against the in-flight transaction. Returns 0..N SSE
// event payloads (queued for post-COMMIT publish). Patches that reference
// unknown UUIDs are silently skipped + logged at WARN per §3.6.
async function applyPatch(
  client: PoolClient,
  patch: CoherencePatch,
  ctx: ApplyContext,
  synthKeyByEntityId: SynthKeyMap,
): Promise<ApplyResult> {
  switch (patch.kind) {
    case 'fix_fact':
      return applyFixFact(client, patch, ctx)
    case 'fix_prose':
      return applyFixProse(client, patch, ctx, synthKeyByEntityId)
    case 'rename_entity':
      return applyRenameEntity(client, patch, ctx, synthKeyByEntityId)
    case 'fix_relationship':
      return applyFixRelationship(client, patch, ctx, synthKeyByEntityId)
    case 'delete_relationship':
      return applyDeleteRelationship(client, patch, ctx, synthKeyByEntityId)
  }
}

async function publishEvent(
  redisRealtime: Pick<Redis, 'publish'>,
  keyPrefix: string,
  campaignId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const channel = `${keyPrefix}pipeline:campaign:${campaignId}`
  await redisRealtime.publish(channel, JSON.stringify(payload))
}

/**
 * Run stage 7 — coherence pass.
 *
 * Pre-stage cap check: if cumulative cost from stages 1-6 already exceeds
 * the cap, mark world `complete`, emit `phase: complete`, log WARN, return
 * `{ capExhausted: true }`. The processor uses this signal to skip its
 * own cap-and-refund branch (§D5).
 *
 * Happy path: load full world state → LLM call → validate output → BEGIN
 * → apply each patch (unknown IDs logged + skipped) → COMMIT → publish
 * per-patch SSE events. Returns real cost.
 */
export async function runCoherencePassStage(
  args: CoherencePassArgs,
): Promise<CoherencePassResult> {
  const capUsd = await readCostCap(args.pool)
  const completedCostUsd = await sumCompletedStageCosts(args.pool, args.worldId)
  if (completedCostUsd > capUsd) {
    // §D5 cap-fire exception: world is functionally complete; coherence
    // is best-effort polish. Skip the LLM, mark world complete, do NOT
    // refund.
    await args.pool.query(`UPDATE worlds SET status = 'complete' WHERE id = $1`, [args.worldId])
    await publishEvent(args.redisRealtime, args.keyPrefix, args.campaignId, {
      type: 'phase',
      phase: 'complete',
    })
    args.logger.warn(
      {
        stage: 'coherence_pass',
        worldId: args.worldId,
        completedCostUsd,
        capUsd,
      },
      'coherence_pass: cost cap exhausted pre-stage; skipping coherence pass and marking world complete',
    )
    return { costUsd: 0, inputTokens: 0, outputTokens: 0, capExhausted: true }
  }

  // LLM call completes ENTIRELY before BEGIN (§D5). We need a client for
  // the world-inventory SELECTs; using a non-transactional client is
  // fine because the read is at a single point-in-time (the LLM is
  // about to be invoked, so any concurrent writer is a bug).
  const client = await args.pool.connect()
  let inventory: WorldInventory
  try {
    inventory = await loadWorldInventory(client, args.worldId)
  } finally {
    client.release()
  }

  const worldDump = renderWorldDump(inventory)
  const prompt = PROMPT_TEMPLATE.replaceAll('{{worldDump}}', worldDump)

  const result = await generateText({
    model: SONNET,
    output: Output.object({ schema: CoherenceOutputSchema }),
    prompt,
    temperature: 0.4,
    maxRetries: 1,
  })

  const output: CoherenceOutput = result.output

  // BEGIN/COMMIT scope: apply every patch in order. Unknown-ID skips are
  // logged + dropped without aborting the transaction. Each successful
  // patch contributes 0..N event payloads to a post-COMMIT publish list.
  const applyClient = await args.pool.connect()
  const pendingEvents: Record<string, unknown>[] = []
  try {
    await applyClient.query('BEGIN')
    for (const patch of output.patches) {
      const { events } = await applyPatch(
        applyClient,
        patch,
        { inv: inventory, logger: args.logger, stage: 'coherence_pass' },
        args.synthKeyByEntityId,
      )
      pendingEvents.push(...events)
    }
    await applyClient.query('COMMIT')
    /* c8 ignore start — ROLLBACK path: applyPatch + COMMIT do not throw
     * under any tested fixture (the mock client succeeds on all writes).
     * The catch branch exists for real-pg connection-drop / serialization
     * errors that are exercised by the integration tests in T13. */
  } catch (err) {
    await applyClient.query('ROLLBACK')
    throw err
  } finally {
    applyClient.release()
  }
  /* c8 ignore stop */

  // Publish events ONLY after COMMIT — if COMMIT failed, the wire would
  // otherwise tell the client about state that doesn't exist in the DB.
  for (const event of pendingEvents) {
    await publishEvent(args.redisRealtime, args.keyPrefix, args.campaignId, event)
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
  }
  /* c8 ignore stop */
}
