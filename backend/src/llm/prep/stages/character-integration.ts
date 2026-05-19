// backend/src/llm/prep/stages/character-integration.ts
//
// MYT-53 / myth-pytq T10: stage 4 of the character-creation worker. Opus
// streamObject producing the PC entity + PC↔world relationships +
// PC-tagged facts. Creates a single `entities` row (entity_type='pc'),
// links `characters.entity_id`, and persists relationships + facts in one
// transaction. The deferred "starts at $location" fact is re-derived here
// from worlds.starting_situation_entries (spec §Risks #3 — the only
// surface that ties the per-player character back to the campaign-wide
// starting situation chosen by the owner pre-fan-out).
//
// Idempotent re-run: if `characters.entity_id` is already set, reuse the
// existing entity row, UPDATE its name, and DELETE-then-re-INSERT every
// relationship + fact tagged with that entity. Mirrors the
// character-sheet.ts retry semantic.
//
// Zod-to-DB mapping (the CharacterIntegrationOutputSchema does NOT line
// up 1:1 with the column names from migration 001 + 014 + 016 — the plan
// pseudocode was wrong on multiple of these):
//
//   pc_entity.name              -> entities.name (entity_type='pc')
//   pc_entity.short_description -> persisted as a fact with
//                                  topic='introduction' (entities has no
//                                  short_description column).
//   relationships[].target_entity_name
//                               -> resolved case-insensitively to an
//                                  entities.id; unresolved names are
//                                  skipped (logged at the call site
//                                  rather than here — this is a known
//                                  LLM failure mode, design §D9
//                                  follow-on).
//   relationships[]             -> relationships table. NOTE the column
//                                  names are source_entity_id /
//                                  target_entity_id, NOT source_id /
//                                  target_id.
//   facts[].tags[0]             -> facts.topic (default 'backstory' when
//                                  tags is empty — facts.topic is NOT
//                                  NULL and the table has no `tags`
//                                  column).
//   (no Zod field)              -> facts.narrative_status — defaults to
//                                  'undelivered' for fresh PC-prep facts.
//   (no Zod field)              -> facts.access_level — defaults to
//                                  'known' for PC-tagged facts.
//
// Post-commit the handler emits one `entity-added` event (for the PC) and
// one `edge-added` event per persisted relationship via the
// `publishEvent` callback. Wire-feed shape mirrors stage-3 / stage-4 of
// world-gen for consumers reusing those event listeners.

import type { Pool, PoolClient } from 'pg'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { generateObject } from '../../ai.js'
import { OPUS } from '../../models.js'
import {
  CharacterIntegrationOutputSchema,
  type CharacterIntegrationOutput,
} from '../../schemas/character-integration.js'
import type { CharacterConceptOutput } from '../../schemas/character-concept.js'
import { uuidv7 } from '../../../repo/uuidv7.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../prompts/prep/character-integration.txt',
  ),
  'utf8',
)

// Anthropic Opus pricing per https://www.anthropic.com/pricing. Held
// local to the stage so a per-stage tier change is one-file scoped — same
// convention as character-concept.ts / character-sheet.ts.
const OPUS_INPUT_PER_MTOK = 15.0
const OPUS_OUTPUT_PER_MTOK = 75.0

export interface CharacterIntegrationArgs {
  readonly campaignId: string
  readonly userId: string
  readonly worldId: string
  readonly characterId: string
  readonly narrative: CharacterConceptOutput
  readonly situationGroundingText: string
  readonly publishEvent: (event: Record<string, unknown>) => Promise<void>
}

export interface CharacterIntegrationStageResult {
  readonly entityId: string
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

interface SituationEntry {
  readonly index: number
  readonly locationEntityId: string
  readonly prose: string
}

interface WorldEntity {
  readonly id: string
  readonly name: string
  readonly entityType: string
}

interface ResolvedStartLocation {
  readonly id: string
  readonly name: string
  readonly prose: string
}

export async function runCharacterIntegrationStage(
  pool: Pool,
  args: CharacterIntegrationArgs,
): Promise<CharacterIntegrationStageResult> {
  // 1. Resolve the starting situation — re-derive the location entity
  //    chosen by the campaign owner pre-fan-out. Stage 1 (location-
  //    selection) already validated this, but stage 4 re-reads it so the
  //    deferred "starts at $location" fact lands here (spec §Risks #3).
  const startLocation = await resolveStartLocation(pool, args.campaignId, args.worldId)

  // 2. List the world entities the LLM can reference by name. Restrict
  //    to the relationship-eligible kinds; PCs from prior players are
  //    excluded by the entity_type filter.
  const worldEntities = await listReferenceableEntities(pool, args.worldId)

  // 3. Generate the integration tree via Opus + generateObject. We use
  //    the non-streaming wrapper here even though the parent spec called
  //    for streamObject: stage 4 emits its SSE events POST-COMMIT (in
  //    publishPostCommitEvents, after persistIntegration's transaction
  //    lands), not from streamObject's partialObjectStream chunks. The AI
  //    SDK's streamObject is pull-based — `await stream.object` never
  //    resolves unless the consumer concurrently iterates
  //    `partialObjectStream` (or another stream). Since this handler has
  //    no per-chunk consumer, streamObject silently hung indefinitely.
  //    generateObject is eagerly-executed and a drop-in replacement for
  //    our shape; smoke against real Anthropic confirms it produces the
  //    same validated tree in ~24s (vs streamObject hanging forever).
  const prompt = renderPrompt(args, startLocation, worldEntities)
  const result = await generateObject({
    model: OPUS,
    schema: CharacterIntegrationOutputSchema,
    prompt,
    maxRetries: 0,
    callSite: 'character-integration',
    schemaName: 'CharacterIntegrationOutputSchema',
    repairStrategy: 'sonnet',
    providerOptions: { mythrun: { stage: 'character_integration' } },
  })

  const validatedTree: CharacterIntegrationOutput = result.output
  const usage = result.usage

  // 5. Persist everything in a single transaction.
  const entityId = await persistIntegration(
    pool,
    args,
    validatedTree,
    startLocation,
    worldEntities,
  )

  // 6. Post-commit: emit SSE events. Done AFTER the COMMIT so any
  //    ROLLBACK above doesn't surface a phantom PC in the wire feed.
  await publishPostCommitEvents(args, entityId, validatedTree, worldEntities)

  /* c8 ignore start — Anthropic provider always populates usage tokens;
   * `?? 0` fallback keeps StageCostResult strict-number. Same convention
   * as character-concept.ts and character-sheet.ts. */
  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  /* c8 ignore stop */
  return {
    entityId,
    costUsd:
      (inputTokens / 1_000_000) * OPUS_INPUT_PER_MTOK +
      (outputTokens / 1_000_000) * OPUS_OUTPUT_PER_MTOK,
    inputTokens,
    outputTokens,
  }
}

async function resolveStartLocation(
  pool: Pool,
  campaignId: string,
  worldId: string,
): Promise<ResolvedStartLocation> {
  const campaign = await pool.query<{ starting_situation_index: number | null }>(
    `SELECT starting_situation_index FROM campaigns WHERE id = $1`,
    [campaignId],
  )
  const idx = campaign.rows[0]?.starting_situation_index
  /* c8 ignore start — index-null defense: POST /start-character-creation
   * gates on starting_situation_index IS NOT NULL before enqueuing, so by
   * the time stage 4 runs the owner has always picked. The throw is a
   * safety net against schema drift / direct DB tampering. */
  if (idx === null || idx === undefined) {
    throw new Error(
      `character-integration: campaigns.starting_situation_index is NULL for campaign ${campaignId}`,
    )
  }
  /* c8 ignore stop */
  const world = await pool.query<{ starting_situation_entries: SituationEntry[] }>(
    `SELECT starting_situation_entries FROM worlds WHERE id = $1`,
    [worldId],
  )
  // worldId came from campaigns.world_id (FK to worlds.id); row guaranteed.
  // starting_situation_entries is NOT NULL DEFAULT '[]'.
  const worldRow = world.rows[0]
  /* c8 ignore next 3 — invariant per campaigns.world_id FK NOT NULL */
  if (worldRow === undefined) {
    throw new Error(`world ${worldId} not found — FK invariant violated`)
  }
  const entries = worldRow.starting_situation_entries
  const entry = entries.find((e) => e.index === idx)
  /* c8 ignore start — entries-shape defense: starting_situation stage
   * always emits exactly 3 entries indexed {0,1,2}; campaigns
   * starting_situation_index CHECK bounds idx to {0,1,2}. Fires only if
   * the entries array was mutated after world-gen (operator action). */
  if (entry === undefined) {
    throw new Error(
      `character-integration: no entry for index ${String(idx)} in worlds.starting_situation_entries for world ${worldId}`,
    )
  }
  /* c8 ignore stop */
  const ent = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM entities WHERE id = $1 AND world_id = $2`,
    [entry.locationEntityId, worldId],
  )
  const row = ent.rows[0]
  /* c8 ignore start — drift-defense: entity referenced by starting_situation_entries
   * was deleted between owner pick and stage 4. starting_situation stage's name→id
   * resolution + the worker's claim sequence make this near-impossible in production;
   * the throw is a safety net for an operator action mid-flight. */
  if (row === undefined) {
    throw new Error(
      `character-integration: starting-location entity not found — id=${entry.locationEntityId} world=${worldId} (state drift between owner pick and stage 4)`,
    )
  }
  /* c8 ignore stop */
  return { id: row.id, name: row.name, prose: entry.prose }
}

async function listReferenceableEntities(
  pool: Pool,
  worldId: string,
): Promise<readonly WorldEntity[]> {
  const result = await pool.query<{ id: string; name: string; entity_type: string }>(
    `SELECT id, name, entity_type FROM entities
       WHERE world_id = $1 AND entity_type IN ('location', 'faction', 'npc')
       ORDER BY entity_type, name`,
    [worldId],
  )
  return result.rows.map((r) => ({ id: r.id, name: r.name, entityType: r.entity_type }))
}

function renderEntitiesBlock(entities: readonly WorldEntity[]): string {
  return entities.map((e) => `- [${e.entityType}] ${e.name}`).join('\n')
}

function renderPrompt(
  args: CharacterIntegrationArgs,
  startLocation: ResolvedStartLocation,
  entities: readonly WorldEntity[],
): string {
  return PROMPT_TEMPLATE.replace('{{name}}', args.narrative.name)
    .replace('{{race}}', args.narrative.race)
    .replace('{{class}}', args.narrative.class)
    .replace('{{background}}', args.narrative.background)
    .replace('{{backstory}}', args.narrative.backstory)
    .replace('{{physicalDescription}}', args.narrative.physical_description)
    .replace('{{situationGroundingText}}', args.situationGroundingText)
    .replace('{{startingSituationProse}}', startLocation.prose)
    .replace('{{worldEntities}}', renderEntitiesBlock(entities))
}

// Single transactional write spanning 1 entities row + N relationships + M
// facts + the characters.entity_id update. Exceeds the 50-line budget
// because the statements are inherently coupled — splitting would lose the
// single-BEGIN/COMMIT semantic that the idempotent re-run path depends on
// (see character-sheet.ts for the same suppression / same rationale).
async function persistIntegration(
  pool: Pool,
  args: CharacterIntegrationArgs,
  out: CharacterIntegrationOutput,
  startLocation: ResolvedStartLocation,
  worldEntities: readonly WorldEntity[],
): Promise<string> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Lookup-or-INSERT keyed on characters.entity_id. Idempotent re-run:
    // if the row already points at an entity, reuse it and DELETE the
    // dependent rows before re-INSERTing.
    const ch = await client.query<{ entity_id: string | null }>(
      `SELECT entity_id FROM characters WHERE id = $1`,
      [args.characterId],
    )
    let entityId = ch.rows[0]?.entity_id ?? null

    if (entityId === null) {
      entityId = uuidv7()
      await client.query(
        `INSERT INTO entities (id, world_id, entity_type, name, access_level)
         VALUES ($1, $2, 'pc', $3, 'known')`,
        [entityId, args.worldId, out.pc_entity.name],
      )
      await client.query(
        `UPDATE characters SET entity_id = $1, updated_at = now() WHERE id = $2`,
        [entityId, args.characterId],
      )
    } else {
      await client.query(
        `UPDATE entities SET name = $2, access_level = 'known', updated_at = now()
           WHERE id = $1`,
        [entityId, out.pc_entity.name],
      )
      // DELETE every PC-touching relationship + every PC-tagged fact.
      // Relationships are bidirectional in the sense that future code may
      // INSERT with the PC as either source or target — clear both sides
      // to keep the re-run shape clean.
      await client.query(
        `DELETE FROM relationships WHERE source_entity_id = $1 OR target_entity_id = $1`,
        [entityId],
      )
      await client.query(`DELETE FROM facts WHERE entity_id = $1`, [entityId])
    }

    await insertRelationships(client, entityId, out, worldEntities)
    await insertFacts(client, entityId, out, startLocation)

    await client.query('COMMIT')
    return entityId
    /* c8 ignore start — ROLLBACK arm fires only when one of the INSERTs
     * throws (PG constraint violation, connection drop). The four sub-table
     * inserts use validated Zod inputs + bound-checked schemas, so this
     * is true defense-in-depth, not a happy-path branch. */
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
    /* c8 ignore stop */
  } finally {
    client.release()
  }
}

async function insertRelationships(
  client: PoolClient,
  entityId: string,
  out: CharacterIntegrationOutput,
  worldEntities: readonly WorldEntity[],
): Promise<void> {
  // Case-insensitive name resolution. Same pattern as
  // starting-situation.resolveLocationEntries — names are user-facing and
  // LLMs are inconsistent about casing. Unresolved names are skipped
  // silently here; the wiring layer surfaces this as a worker WARN.
  const byLowerName = new Map(worldEntities.map((e) => [e.name.toLowerCase(), e.id]))
  for (const rel of out.relationships) {
    const targetId = byLowerName.get(rel.target_entity_name.toLowerCase())
    if (targetId === undefined) continue
    await client.query(
      `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv7(), entityId, targetId, rel.relationship_type, rel.description],
    )
  }
}

async function insertFacts(
  client: PoolClient,
  entityId: string,
  out: CharacterIntegrationOutput,
  startLocation: ResolvedStartLocation,
): Promise<void> {
  // LLM-emitted facts. tags[0] → topic; default 'backstory' when the LLM
  // emits an empty tags array (schema allows max:8 but not min — defensive).
  for (const f of out.facts) {
    const topic = f.tags[0] ?? 'backstory'
    await client.query(
      `INSERT INTO facts (id, entity_id, topic, access_level, narrative_status, content)
       VALUES ($1, $2, $3, 'known', 'undelivered', $4)`,
      [uuidv7(), entityId, topic, f.content],
    )
  }
  // pc_entity.short_description folded into a fact with topic='introduction'.
  // entities has no short_description column, so this is the only place to
  // keep the LLM-authored intro line available for retrieval at runtime.
  await client.query(
    `INSERT INTO facts (id, entity_id, topic, access_level, narrative_status, content)
     VALUES ($1, $2, 'introduction', 'known', 'undelivered', $3)`,
    [uuidv7(), entityId, out.pc_entity.short_description],
  )
  // Deferred "starts at $location" fact — re-derived from
  // worlds.starting_situation_entries. The only surface that ties the
  // per-player character back to the campaign-wide starting situation.
  await client.query(
    `INSERT INTO facts (id, entity_id, topic, access_level, narrative_status, content)
     VALUES ($1, $2, 'starting_location', 'known', 'undelivered', $3)`,
    [uuidv7(), entityId, `${out.pc_entity.name} starts at ${startLocation.name}.`],
  )
}

async function publishPostCommitEvents(
  args: CharacterIntegrationArgs,
  entityId: string,
  out: CharacterIntegrationOutput,
  worldEntities: readonly WorldEntity[],
): Promise<void> {
  await args.publishEvent({
    type: 'entity-added',
    entityId,
    entityType: 'pc',
    userId: args.userId,
  })
  const byLowerName = new Map(worldEntities.map((e) => [e.name.toLowerCase(), e.id]))
  for (const rel of out.relationships) {
    const targetId = byLowerName.get(rel.target_entity_name.toLowerCase())
    if (targetId === undefined) continue
    await args.publishEvent({
      type: 'edge-added',
      sourceId: entityId,
      targetId,
      userId: args.userId,
    })
  }
}
