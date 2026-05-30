// backend/src/llm/prep/stages/locations-and-npcs.ts
//
// Stage 3 (locations_and_npcs) per design §3.2 + §D8.
//
// Streams via Vercel SDK streamObject (maxRetries: 0). Iterates
// partialObjectStream via streaming-extractor.ts; emits entity-added /
// entity-updated events live as locations/NPCs take shape. At stream
// end: validateOrRepair → INSERT in a three-pass resolver against the
// caller-owned client:
//
//   Pass 1: insert all locations + NPCs (entities + prose + facts)
//           against the caller's PoolClient (BEGIN is the caller's
//           responsibility — see world-gen-processor.ts `runStage`).
//   Pass 2: query entities.listByWorld(), filter to entity_type='location'
//           (per §D8 kind-filter rule), build a name → entityId map. When
//           multiple locations share a name (e.g. a stage-2 region named
//           the same as a stage-3 city), prefer the OLDER (lowest UUIDv7)
//           entity — stage 2 wins per §D8 name-collision rule.
//   Pass 3: for each stage-3 location with a non-null parent_location,
//           look up the name in the map. If unresolvable, accumulate an
//           `entity-updated { synthKey, patch: { parent_location: null } }`
//           into the returned `finalizedEvents` (deferred — the caller
//           publishes only after its COMMIT lands, so the client never
//           observes a parent-cleared patch for a row that didn't
//           persist) and persist the location parentless. If resolvable,
//           INSERT entity_hierarchy { parent, child }.
//
// Unified pipeline contract (T13):
//   - Caller owns BEGIN/COMMIT/ROLLBACK on the passed `client`.
//   - On unrecoverable error (repair-chain exhaustion, write failure),
//     the handler throws. The caller ROLLBACKs and publishes the
//     `stage-reset` event.
//   - On success the handler returns a StageDispatchResult containing
//     the StageCost plus the post-COMMIT events (`finalized` per
//     persisted entity, plus `entity-updated{parent_location:null}` for
//     unresolved-parent rows). Mid-stream `entity-added` /
//     `entity-updated` events are published live by the streaming
//     extractor; only post-COMMIT events are deferred to the caller.
//   - `capExhausted` is unused for stage 3 (stage-7 concern) and is
//     always `false`.
//
// NPC `home_location` is a narrative reference only — not persisted to
// entity_hierarchy per design §3.2.
//
// Cost is the sum of the streaming Opus call + (optional) Haiku repair +
// (optional) Sonnet repair, returned as part of StageDispatchResult.

import { type Repo, type TxRepo, expectCommitted } from '../../../repo/index.js'
import type { Redis } from 'ioredis'
import type { Job } from 'bullmq'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
// Routes through the canonical streaming wrapper (myth-t1qz). The
// wrapper preserves partialObjectStream + usage + textStream and replaces
// `object` with a repair-aware promise that runs the Haiku→Sonnet repair
// chain on LlmStructuredOutputError from the underlying SDK call.
import { streamObject } from '../../ai.js'
import { OPUS } from '../../models.js'
import { computeCostUsd } from '../../../billing/model-pricing.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import { runStreamingStage } from '../streaming-extractor.js'
import {
  LocationsAndNpcsSchema,
  locationItemSchema,
  npcItemSchema,
  type LocationsAndNpcsTree,
  type LocationEntry,
  type NpcEntry,
} from '../../schemas/locations-and-npcs.js'
import type { PipelineEvent } from '../../../contract/pipeline-events.js'
import type { StageDispatchResult } from '../world-gen-processor.js'
import { renderVocabularyRegistry } from '../vocabulary-renderer.js'
import type { VocabularyRegistry } from '../../schemas/vocabulary-registry.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/locations-and-npcs.txt'),
  'utf8',
)

export interface RunLocationsAndNpcsArgs {
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
  readonly vocabularyRegistry: VocabularyRegistry
  readonly campaignId: string
  readonly job: Job
  readonly redisRealtime: Redis
  readonly keyPrefix: string
  // When true, the wire-tier filter is bypassed: all entities (regardless
  // of access_level) are emitted as `entity-added` / surfaced in
  // finalizedEvents. DB persistence is unaffected. Set true for dev-tool
  // / debug runs that need to observe non-known entities; false for
  // player-facing campaigns.
  readonly bypassAccessFilter: boolean
}

interface FinalizedRow {
  readonly synthKey: string
  readonly entityId: string
  // Carried so the post-COMMIT event push can apply the tier filter:
  // DB insert always happens, but only `known` rows (or all when
  // bypassed) become `finalized` events on the wire.
  readonly accessLevel: 'known' | 'discoverable' | 'secret'
}

interface UnresolvedRef {
  readonly synthKey: string
  readonly childEntityId: string
  readonly parentName: string
}

// Pass 1: insert each location's entity + prose + facts. Returns the
// list of (synthKey, entityId) finalized rows plus a list of unresolved
// parent_location references the pass-3 resolver will work through.
async function persistLocations(
  tx: TxRepo,
  worldId: string,
  locations: readonly LocationEntry[],
  finalized: FinalizedRow[],
  unresolved: UnresolvedRef[],
): Promise<void> {
  for (const [i, loc] of locations.entries()) {
    const entityId = uuidv7()
    await tx.entities.insert({
      id: entityId,
      worldId,
      entityType: 'location',
      name: loc.name,
      accessLevel: loc.access_level,
      createdIn: 'stage:locations_and_npcs',
    })
    await tx.proseKernels.insert({ entityId, content: loc.prose })
    await tx.facts.insertMany(
      loc.facts.map((f) => ({
        entityId,
        topic: f.topic,
        accessLevel: f.access_level,
        content: f.content,
      })),
    )
    const synthKey = `locations_and_npcs/locations/${String(i)}`
    finalized.push({ synthKey, entityId, accessLevel: loc.access_level })
    if (loc.parent_location !== null) {
      unresolved.push({ synthKey, childEntityId: entityId, parentName: loc.parent_location })
    }
  }
}

// Pass 1 (continued): insert each NPC's entity + prose + facts. NPC
// `home_location` is a narrative reference; never written to
// entity_hierarchy per design §3.2.
async function persistNpcs(
  tx: TxRepo,
  worldId: string,
  npcs: readonly NpcEntry[],
  finalized: FinalizedRow[],
): Promise<void> {
  for (const [i, npc] of npcs.entries()) {
    const entityId = uuidv7()
    await tx.entities.insert({
      id: entityId,
      worldId,
      entityType: 'npc',
      name: npc.name,
      accessLevel: npc.access_level,
      createdIn: 'stage:locations_and_npcs',
    })
    await tx.proseKernels.insert({ entityId, content: npc.prose })
    await tx.facts.insertMany(
      npc.facts.map((f) => ({
        entityId,
        topic: f.topic,
        accessLevel: f.access_level,
        content: f.content,
      })),
    )
    finalized.push({
      synthKey: `locations_and_npcs/npcs/${String(i)}`,
      entityId,
      accessLevel: npc.access_level,
    })
  }
}

// Pass 2: build name → entityId map over ALL location-type entities
// for the world (stage-2 regions + stage-3 locations, fresh from the
// same transaction). On name collision, prefer the OLDER (lowest
// UUIDv7) entity per §D8 — UUIDv7 is time-ordered, so the smaller
// id is the earlier insert.
async function buildNameToIdMap(
  tx: TxRepo,
  worldId: string,
): Promise<Map<string, string>> {
  const allLocations = (await tx.entities.listByWorld(worldId)).filter(
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
// `parent_location: null` patch (returned to the caller — only published
// after the transaction commits, so the client doesn't see the patch
// unless the row actually landed).
async function resolveAndPersistHierarchy(
  tx: TxRepo,
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
    await tx.entityHierarchy.insert({
      parentEntityId: parentId,
      childEntityId: ref.childEntityId,
    })
  }
}

// Pass 1-3 driver: runs entirely against the caller-passed client. The
// caller owns transaction lifecycle; this function only INSERTs.
// Returns the post-COMMIT events the caller will publish after its
// COMMIT lands.
async function persistAndCollectEvents(
  tx: TxRepo,
  worldId: string,
  tree: LocationsAndNpcsTree,
  bypassAccessFilter: boolean,
): Promise<readonly PipelineEvent[]> {
  const finalized: FinalizedRow[] = []
  const unresolved: UnresolvedRef[] = []
  await persistLocations(tx, worldId, tree.locations, finalized, unresolved)
  await persistNpcs(tx, worldId, tree.npcs, finalized)

  const nameToId = await buildNameToIdMap(tx, worldId)
  const parentClearedSynthKeys: string[] = []
  await resolveAndPersistHierarchy(tx, unresolved, nameToId, parentClearedSynthKeys)

  // Compose deferred post-COMMIT events: `finalized` per persisted
  // entity (tier-filtered: only `known` rows surface on the wire unless
  // bypassed), then `entity-updated{parent_location:null}` for
  // unresolved refs. Caller publishes after its COMMIT. DB persistence
  // already happened for every row above regardless of tier.
  const events: PipelineEvent[] = finalized
    .filter((f) => bypassAccessFilter || f.accessLevel === 'known')
    .map(
      (f): PipelineEvent => ({
        type: 'finalized',
        synthKey: f.synthKey,
        entityId: f.entityId,
      }),
    )
  for (const synthKey of parentClearedSynthKeys) {
    events.push({
      type: 'entity-updated',
      synthKey,
      patch: { parent_location: null },
    })
  }
  return events
}

export async function runLocationsAndNpcsStage(
  repo: Repo,
  args: RunLocationsAndNpcsArgs,
): Promise<StageDispatchResult> {
  const prompt = PROMPT_TEMPLATE.replace('{{worldName}}', args.world.name)
    .replace('{{tone}}', args.world.tone)
    .replace('{{themes}}', args.world.themes)
    .replace('{{era}}', args.world.era)
    .replace('{{worldOverview}}', args.world.worldOverview)
    .replace('{{regionsSummary}}', args.world.regionsSummary)
    .replace('{{factionsSummary}}', args.world.factionsSummary)
    .replace('{{vocabularyRegistry}}', renderVocabularyRegistry(args.vocabularyRegistry))

  // maxRetries: 0 per design D2 — predictable cost attribution + repair
  // chain owns validation recovery + BullMQ stage retry owns transport
  // recovery. No third hidden retry layer in the SDK. The wrapper
  // (myth-t1qz) drives the Haiku→Sonnet repair chain inside
  // `await result.object` on LlmStructuredOutputError.
  const result = streamObject({
    model: OPUS,
    schema: LocationsAndNpcsSchema,
    prompt,
    temperature: 0.7,
    maxRetries: 0,
    callSite: 'locations-and-npcs',
    schemaName: 'LocationsAndNpcsSchema',
    repairStrategy: 'haiku-then-sonnet',
    providerOptions: {
      mythrun: {
        worldId: args.world.id,
        campaignId: args.campaignId,
        stage: 'locations_and_npcs',
      },
    },
  })

  await runStreamingStage<unknown>(result.partialObjectStream, {
    stage: 'locations_and_npcs',
    campaignId: args.campaignId,
    job: args.job,
    redisRealtime: args.redisRealtime,
    keyPrefix: args.keyPrefix,
    arrays: [
      { path: 'locations', kind: 'location', role: 'entity', sub_schema: locationItemSchema },
      { path: 'npcs', kind: 'npc', role: 'entity', sub_schema: npcItemSchema },
    ],
    bypassAccessFilter: args.bypassAccessFilter,
    // Stage 3 has no edges — endpointTierMap is unused by the extractor
    // for entity-only arrays, but the config requires it. Pass an empty
    // map for type-conformance.
    endpointTierMap: new Map(),
  })

  // The wrapper's `object` promise resolves to the validated tree (or
  // a repaired tree when the SDK threw a structured-output error and
  // the Haiku→Sonnet chain recovered). If the chain exhausts the wrapper
  // rethrows; the outer scope catches and publishes stage-reset.
  const validatedTree = await result.object

  // Cost: primary Opus stream usage. Repair-chain usage (when fired) is
  // folded inside the wrapper and not separately attributed here — see
  // ai.ts header on cost-accounting boundaries.
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

  // Persist in a short transaction (writes + same-tx reads only; LLM done —
  // MYT-55). SQL byte-identical, relocated into the entities/proseKernels/
  // facts/entityHierarchy binders, composed over the tx client.
  const finalizedEvents = expectCommitted(
    await repo.transaction((tx) =>
      persistAndCollectEvents(tx, args.world.id, validatedTree, args.bypassAccessFilter),
    ),
  )

  return {
    costUsd: opusCostUsd,
    inputTokens: opusInputTokens,
    outputTokens: opusOutputTokens,
    finalizedEvents,
    capExhausted: false,
  }
}
