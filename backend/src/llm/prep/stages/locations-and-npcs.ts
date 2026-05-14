// backend/src/llm/prep/stages/locations-and-npcs.ts
//
// Stage 3 (locations_and_npcs) per design §3.2 + §D8.
//
// Streams via Vercel SDK streamObject (maxRetries: 0). Iterates
// partialObjectStream via streaming-extractor.ts; emits entity-added /
// entity-updated events live as locations/NPCs take shape. At stream
// end: validateOrRepair → BEGIN/INSERT/COMMIT in a three-pass
// resolver:
//
//   Pass 1: insert all locations + NPCs (entities + prose + facts) in
//           a single transaction.
//   Pass 2: query entities.listByWorld(), filter to entity_type='location'
//           (per §D8 kind-filter rule), build a name → entityId map. When
//           multiple locations share a name (e.g. a stage-2 region named
//           the same as a stage-3 city), prefer the OLDER (lowest UUIDv7)
//           entity — stage 2 wins per §D8 name-collision rule.
//   Pass 3: for each stage-3 location with a non-null parent_location,
//           look up the name in the map. If unresolvable, log + publish
//           `entity-updated { synthKey, patch: { parent_location: null } }`
//           to sync the client view (it received the original name via
//           `entity-added`) and persist the location parentless. If
//           resolvable, INSERT entity_hierarchy { parent, child }.
//
// On repair-chain exhaustion OR COMMIT failure: publish
// `stage-reset { stage }` and rethrow so BullMQ retries the stage.
//
// NPC `home_location` is a narrative reference only — not persisted to
// entity_hierarchy per design §3.2.
//
// Cost is the sum of the streaming Opus call + (optional) Haiku repair +
// (optional) Sonnet repair, returned as a single StageCost.

import type { Pool, PoolClient } from 'pg'
import type { Redis } from 'ioredis'
import type { Job } from 'bullmq'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
// Vercel SDK v6 flags streamObject deprecated in favor of streamText +
// output, but the streaming-stages design (§D1) explicitly mandates
// streamObject because streamText's output mode doesn't expose
// partialObjectStream. Migration tracked as a future SDK-upgrade ticket.
import { streamObject } from 'ai'
import { OPUS, HAIKU, SONNET } from '../../models.js'
import { computeCostUsd } from '../../../billing/model-pricing.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import { entities } from '../../../repo/entities.js'
import { proseKernels } from '../../../repo/prose-kernels.js'
import { facts } from '../../../repo/facts.js'
import { entityHierarchy } from '../../../repo/entity-hierarchy.js'
import { runStreamingStage } from '../streaming-extractor.js'
import { repairStructuredOutput } from '../structured-output-repair.js'
import {
  LocationsAndNpcsSchema,
  type LocationsAndNpcsTree,
  type LocationEntry,
  type NpcEntry,
} from '../../schemas/locations-and-npcs.js'
import type { StageCost } from '../world-gen-processor.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/locations-and-npcs.txt'),
  'utf8',
)

export interface RunLocationsAndNpcsInput {
  readonly pool: Pool
  readonly world: {
    readonly id: string
    readonly createdBy: string
    readonly name: string
    readonly concept: string
    readonly tone: string
    readonly themes: string
    readonly era: string
    readonly worldOverview: string
    readonly regionsSummary: string
    readonly factionsSummary: string
  }
  readonly campaignId: string
  readonly job: Job
  readonly redisRealtime: Redis
  readonly keyPrefix: string
}

interface FinalizedRow {
  readonly synthKey: string
  readonly entityId: string
}

interface UnresolvedRef {
  readonly synthKey: string
  readonly childEntityId: string
  readonly parentName: string
}

interface ValidatedWithCost {
  readonly tree: LocationsAndNpcsTree
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

async function publishStageReset(
  input: Pick<RunLocationsAndNpcsInput, 'redisRealtime' | 'keyPrefix' | 'campaignId'>,
): Promise<void> {
  await input.redisRealtime.publish(
    `${input.keyPrefix}pipeline:campaign:${input.campaignId}`,
    JSON.stringify({ type: 'stage-reset', stage: 'locations_and_npcs' }),
  )
}

async function publishParentClearedPatch(
  input: Pick<RunLocationsAndNpcsInput, 'redisRealtime' | 'keyPrefix' | 'campaignId'>,
  synthKey: string,
): Promise<void> {
  await input.redisRealtime.publish(
    `${input.keyPrefix}pipeline:campaign:${input.campaignId}`,
    JSON.stringify({
      type: 'entity-updated',
      synthKey,
      patch: { parent_location: null },
    }),
  )
}

// Validate the streamed tree directly; on Zod failure walk the
// Haiku→Sonnet repair chain per design §D3. Returns the validated tree
// plus the accumulated repair-chain cost; throws if the chain exhausts.
// The streamed-call cost is the caller's responsibility.
async function validateOrRepair(
  finalTree: unknown,
  input: Pick<RunLocationsAndNpcsInput, 'redisRealtime' | 'keyPrefix' | 'campaignId'>,
): Promise<ValidatedWithCost> {
  const direct = LocationsAndNpcsSchema.safeParse(finalTree)
  if (direct.success) {
    return { tree: direct.data, costUsd: 0, inputTokens: 0, outputTokens: 0 }
  }
  const haiku = await repairStructuredOutput({
    tree: finalTree,
    schema: LocationsAndNpcsSchema,
    zodErrors: direct.error,
    model: HAIKU,
    stage: 'locations_and_npcs',
    providerOptions: { mythrun: { stage: 'locations_and_npcs' } },
  })
  /* c8 ignore start — `?? 0` falsy arms: structured-output-repair always
   * returns a populated usage object (its underlying generateText call
   * returns a numeric token tally on every successful response).
   * Defensive fallback for malformed SDK responses. */
  const haikuInput = haiku.usage.inputTokens ?? 0
  const haikuOutput = haiku.usage.outputTokens ?? 0
  /* c8 ignore stop */
  let costUsd = computeCostUsd('claude-haiku-4-5-20251001', {
    inputTokens: haikuInput,
    outputTokens: haikuOutput,
  })
  let inputTokens = haikuInput
  let outputTokens = haikuOutput
  if (haiku.ok) {
    return { tree: haiku.tree, costUsd, inputTokens, outputTokens }
  }
  const sonnet = await repairStructuredOutput({
    tree: finalTree,
    schema: LocationsAndNpcsSchema,
    zodErrors: haiku.errors,
    model: SONNET,
    stage: 'locations_and_npcs',
    providerOptions: { mythrun: { stage: 'locations_and_npcs' } },
  })
  /* c8 ignore start — `?? 0` falsy arms (see above). */
  const sonnetInput = sonnet.usage.inputTokens ?? 0
  const sonnetOutput = sonnet.usage.outputTokens ?? 0
  /* c8 ignore stop */
  costUsd += computeCostUsd('claude-sonnet-4-6', {
    inputTokens: sonnetInput,
    outputTokens: sonnetOutput,
  })
  inputTokens += sonnetInput
  outputTokens += sonnetOutput
  if (!sonnet.ok) {
    await publishStageReset(input)
    throw new Error('locations_and_npcs: repair chain exhausted')
  }
  return { tree: sonnet.tree, costUsd, inputTokens, outputTokens }
}

// Pass 1: insert each location's entity + prose + facts. Returns the
// list of (synthKey, entityId) finalized rows plus a list of unresolved
// parent_location references the pass-3 resolver will work through.
async function persistLocations(
  client: PoolClient,
  worldId: string,
  locations: readonly LocationEntry[],
  finalized: FinalizedRow[],
  unresolved: UnresolvedRef[],
): Promise<void> {
  for (const [i, loc] of locations.entries()) {
    const entityId = uuidv7()
    await entities.insert(client, {
      id: entityId,
      worldId,
      entityType: 'location',
      name: loc.name,
    })
    await proseKernels.insert(client, { entityId, content: loc.prose })
    await facts.insertMany(
      client,
      loc.facts.map((f) => ({
        entityId,
        topic: f.topic,
        accessLevel: f.access_level,
        content: f.content,
      })),
    )
    const synthKey = `locations_and_npcs/locations/${String(i)}`
    finalized.push({ synthKey, entityId })
    if (loc.parent_location !== null) {
      unresolved.push({ synthKey, childEntityId: entityId, parentName: loc.parent_location })
    }
  }
}

// Pass 1 (continued): insert each NPC's entity + prose + facts. NPC
// `home_location` is a narrative reference; never written to
// entity_hierarchy per design §3.2.
async function persistNpcs(
  client: PoolClient,
  worldId: string,
  npcs: readonly NpcEntry[],
  finalized: FinalizedRow[],
): Promise<void> {
  for (const [i, npc] of npcs.entries()) {
    const entityId = uuidv7()
    await entities.insert(client, {
      id: entityId,
      worldId,
      entityType: 'npc',
      name: npc.name,
    })
    await proseKernels.insert(client, { entityId, content: npc.prose })
    await facts.insertMany(
      client,
      npc.facts.map((f) => ({
        entityId,
        topic: f.topic,
        accessLevel: f.access_level,
        content: f.content,
      })),
    )
    finalized.push({ synthKey: `locations_and_npcs/npcs/${String(i)}`, entityId })
  }
}

// Pass 2: build name → entityId map over ALL location-type entities
// for the world (stage-2 regions + stage-3 locations, fresh from the
// same transaction). On name collision, prefer the OLDER (lowest
// UUIDv7) entity per §D8 — UUIDv7 is time-ordered, so the smaller
// id is the earlier insert.
async function buildNameToIdMap(
  client: PoolClient,
  worldId: string,
): Promise<Map<string, string>> {
  const allLocations = (await entities.listByWorld(client, worldId)).filter(
    (e) => e.entityType === 'location',
  )
  const nameToId = new Map<string, string>()
  for (const e of allLocations) {
    const existing = nameToId.get(e.name)
    if (existing === undefined || e.id < existing) {
      nameToId.set(e.name, e.id)
    }
  }
  return nameToId
}

// Pass 3: for each unresolved ref, resolve via the map or treat as
// unresolvable. Resolvable rows go into entity_hierarchy; unresolvable
// rows have their synthKey collected for a post-COMMIT entity-updated
// `parent_location: null` patch (deferred — only published after the
// transaction commits, so the client doesn't see the patch unless the
// row actually landed).
async function resolveAndPersistHierarchy(
  client: PoolClient,
  unresolved: readonly UnresolvedRef[],
  nameToId: ReadonlyMap<string, string>,
  parentClearedSynthKeys: string[],
): Promise<void> {
  for (const ref of unresolved) {
    const parentId = nameToId.get(ref.parentName)
    /* c8 ignore next — `parentId === ref.childEntityId` defensive arm:
     * a stage-3 location whose `parent_location` matches its OWN name
     * AND has no older same-named entity in stage 2 would self-reference
     * if we inserted. The table FK allows this (no CHECK on parent !=
     * child), so application code must reject. The name-collision test
     * exercises the older-stage-2-wins side of the OR; this side is
     * exercised only by a degenerate LLM emission with no prior-stage
     * disambiguator. */
    if (parentId === undefined || parentId === ref.childEntityId) {
      parentClearedSynthKeys.push(ref.synthKey)
      continue
    }
    await entityHierarchy.insert(client, {
      parentEntityId: parentId,
      childEntityId: ref.childEntityId,
    })
  }
}

async function persistAndPublishFinalized(
  input: RunLocationsAndNpcsInput,
  tree: LocationsAndNpcsTree,
): Promise<void> {
  const client = await input.pool.connect()
  try {
    await client.query('BEGIN')
    const finalized: FinalizedRow[] = []
    const unresolved: UnresolvedRef[] = []
    await persistLocations(client, input.world.id, tree.locations, finalized, unresolved)
    await persistNpcs(client, input.world.id, tree.npcs, finalized)

    const nameToId = await buildNameToIdMap(client, input.world.id)
    const parentClearedSynthKeys: string[] = []
    await resolveAndPersistHierarchy(client, unresolved, nameToId, parentClearedSynthKeys)

    await client.query('COMMIT')

    // Post-commit publish: finalized for every entity, then parent-cleared
    // patches for unresolvable references.
    for (const f of finalized) {
      await input.redisRealtime.publish(
        `${input.keyPrefix}pipeline:campaign:${input.campaignId}`,
        JSON.stringify({ type: 'finalized', synthKey: f.synthKey, entityId: f.entityId }),
      )
    }
    for (const synthKey of parentClearedSynthKeys) {
      await publishParentClearedPatch(input, synthKey)
    }
  } catch (err) {
    try {
      await client.query('ROLLBACK')
      /* c8 ignore start — ROLLBACK-failure catch arm: protects against
       * the rare case where the connection was already terminated by the
       * prior failure (pg's "current transaction is aborted" cascade).
       * The happy ROLLBACK path IS tested (COMMIT-failure test); this
       * defensive branch never fires under the standard pg client. */
    } catch {
      /* swallow */
    }
    /* c8 ignore stop */
    await publishStageReset(input)
    throw err
  } finally {
    client.release()
  }
}

export async function runLocationsAndNpcsStage(
  input: RunLocationsAndNpcsInput,
): Promise<StageCost> {
  const prompt = PROMPT_TEMPLATE.replace('{{worldName}}', input.world.name)
    .replace('{{tone}}', input.world.tone)
    .replace('{{themes}}', input.world.themes)
    .replace('{{era}}', input.world.era)
    .replace('{{worldOverview}}', input.world.worldOverview)
    .replace('{{regionsSummary}}', input.world.regionsSummary)
    .replace('{{factionsSummary}}', input.world.factionsSummary)

  // maxRetries: 0 per design D2 — predictable cost attribution + repair
  // chain owns validation recovery + BullMQ stage retry owns transport
  // recovery. No third hidden retry layer in the SDK.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see top-of-file note
  const result = streamObject({
    model: OPUS,
    schema: LocationsAndNpcsSchema,
    prompt,
    temperature: 0.7,
    maxRetries: 0,
    providerOptions: {
      mythrun: {
        worldId: input.world.id,
        campaignId: input.campaignId,
        stage: 'locations_and_npcs',
      },
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- see top-of-file note
    } as unknown as NonNullable<Parameters<typeof streamObject>[0]['providerOptions']>,
  })

  const { finalTree } = await runStreamingStage<unknown>(result.partialObjectStream, {
    stage: 'locations_and_npcs',
    campaignId: input.campaignId,
    job: input.job,
    redisRealtime: input.redisRealtime,
    keyPrefix: input.keyPrefix,
    arrays: [
      { path: 'locations', kind: 'location', role: 'entity' },
      { path: 'npcs', kind: 'npc', role: 'entity' },
    ],
  })

  // Cost: primary Opus stream usage first; repair-chain usage layered on
  // top per design §D3's mechanical cost-attribution rule.
  const usage = await result.usage
  /* c8 ignore start — `?? 0` falsy arms: the Vercel SDK populates these
   * counters on every successful stream end; tests always provide a
   * non-undefined usage object. Defensive fallback for malformed SDK
   * responses. */
  const opusInputTokens = usage.inputTokens ?? 0
  const opusOutputTokens = usage.outputTokens ?? 0
  /* c8 ignore stop */
  const opusCostUsd = computeCostUsd('claude-opus-4-7', {
    inputTokens: opusInputTokens,
    outputTokens: opusOutputTokens,
  })

  const validation = await validateOrRepair(finalTree, input)
  await persistAndPublishFinalized(input, validation.tree)

  return {
    costUsd: opusCostUsd + validation.costUsd,
    inputTokens: opusInputTokens + validation.inputTokens,
    outputTokens: opusOutputTokens + validation.outputTokens,
  }
}
