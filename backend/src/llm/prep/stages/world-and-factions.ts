// backend/src/llm/prep/stages/world-and-factions.ts
//
// Stage 2 (world_and_factions) per design §3.1.
//
// Streams via Vercel SDK streamObject (maxRetries: 0). Iterates
// partialObjectStream via streaming-extractor.ts; emits entity-added /
// entity-updated events live as regions/factions take shape. At stream
// end: validateOrRepair → INSERT on the caller-passed client → return
// `finalizedEvents` for the caller to publish after COMMIT.
//
// Unified dispatch contract (T13 wiring): the handler does NOT manage
// its own transaction and does NOT publish `stage-reset` or `finalized`
// events. The outer scope (runStage in world-gen-processor.ts) owns the
// transaction lifecycle:
//   - On unrecoverable error: this handler throws; outer ROLLBACKs and
//     publishes stage-reset.
//   - On success: this handler returns finalized events in
//     `finalizedEvents`; outer COMMITs and publishes those events.
//
// Streaming events (entity-added / entity-updated / edge-added /
// edge-removed) are still published mid-flight from this handler since
// they fire as the LLM emits — they are not post-commit dependent.
//
// Cost is the sum of (a) the streaming Opus call's usage, plus
// (b) the Haiku repair call's usage if invoked, plus (c) the Sonnet
// repair call's usage if Haiku failed. Returned as a single aggregated
// StageDispatchResult the world-gen processor writes to
// pipeline_runs.cost_usd.

import type { PoolClient } from 'pg'
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
import { runStreamingStage } from '../streaming-extractor.js'
import { repairStructuredOutput } from '../structured-output-repair.js'
import {
  WorldAndFactionsSchema,
  type WorldAndFactionsTree,
} from '../../schemas/world-and-factions.js'
import type { StageDispatchResult } from '../world-gen-processor.js'
import type { PipelineEvent } from '../../../contract/pipeline-events.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/world-and-factions.txt'),
  'utf8',
)

export interface RunWorldAndFactionsArgs {
  readonly world: {
    readonly id: string
    readonly createdBy: string
    readonly name: string
    readonly concept: string
  }
  readonly campaignId: string
  readonly job: Job
  readonly redisRealtime: Redis
  readonly keyPrefix: string
  // myth-exac T13: world-gen-processor threads the per-run flag here.
  // When true, every persisted entity surfaces as a finalized event
  // (used by author/dev tools). When false, only `known`-tier entities
  // emit finalized events; the DB insert always happens regardless.
  readonly bypassAccessFilter: boolean
}

interface FinalizedRow {
  readonly synthKey: string
  readonly entityId: string
}

interface ValidatedWithCost {
  readonly tree: WorldAndFactionsTree
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

// Validate the streamed tree directly; on Zod failure walk the
// Haiku→Sonnet repair chain per design §D3. Returns the validated tree
// plus the accumulated repair-chain cost; throws if the chain exhausts.
// The streamed-call cost is the caller's responsibility. The outer scope
// (runStage) catches the throw, ROLLBACKs, and publishes stage-reset.
async function validateOrRepair(finalTree: unknown): Promise<ValidatedWithCost> {
  const direct = WorldAndFactionsSchema.safeParse(finalTree)
  if (direct.success) {
    return { tree: direct.data, costUsd: 0, inputTokens: 0, outputTokens: 0 }
  }
  const haiku = await repairStructuredOutput({
    tree: finalTree,
    schema: WorldAndFactionsSchema,
    zodErrors: direct.error,
    model: HAIKU,
    stage: 'world_and_factions',
    providerOptions: { mythrun: { stage: 'world_and_factions' } },
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
    schema: WorldAndFactionsSchema,
    zodErrors: haiku.errors,
    model: SONNET,
    stage: 'world_and_factions',
    providerOptions: { mythrun: { stage: 'world_and_factions' } },
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
    throw new Error('world_and_factions: repair chain exhausted')
  }
  return { tree: sonnet.tree, costUsd, inputTokens, outputTokens }
}

interface PersistEntityArgs {
  readonly client: PoolClient
  readonly worldId: string
  readonly entityType: 'location' | 'faction'
  readonly source: readonly WorldAndFactionsTree['regions'][number][]
  readonly synthArrayPath: 'regions' | 'factions'
  readonly out: FinalizedRow[]
  // myth-exac T13: when true, every persisted item surfaces as a
  // finalized event regardless of tier. The DB insert is unaffected.
  readonly bypassAccessFilter: boolean
}

async function persistEntities(args: PersistEntityArgs): Promise<void> {
  for (const [i, item] of args.source.entries()) {
    const entityId = uuidv7()
    await entities.insert(args.client, {
      id: entityId,
      worldId: args.worldId,
      entityType: args.entityType,
      name: item.name,
      // myth-exac T13: thread the LLM-emitted tier into the entity row.
      // T08 made the Zod schema include `access_level`; T05 made the
      // entities.insert require accessLevel. Closing the loop here.
      accessLevel: item.access_level,
    })
    await proseKernels.insert(args.client, { entityId, content: item.prose })
    await facts.insertMany(
      args.client,
      item.facts.map((f) => ({
        entityId,
        topic: f.topic,
        accessLevel: f.access_level,
        content: f.content,
      })),
    )
    // myth-exac T13: gate finalizedEvents (the SSE-emitted entries) by
    // tier. The DB insert above already happened — only the player-
    // visible event is filtered, mirroring streaming-extractor's
    // mid-flight `entity-added` gating. Authors / dev-tool runs pass
    // bypassAccessFilter=true to surface everything.
    if (args.bypassAccessFilter || item.access_level === 'known') {
      args.out.push({
        synthKey: `world_and_factions/${args.synthArrayPath}/${String(i)}`,
        entityId,
      })
    }
  }
}

async function persistTree(
  client: PoolClient,
  worldId: string,
  tree: WorldAndFactionsTree,
  bypassAccessFilter: boolean,
): Promise<readonly FinalizedRow[]> {
  const finalized: FinalizedRow[] = []
  await persistEntities({
    client,
    worldId,
    entityType: 'location',
    source: tree.regions,
    synthArrayPath: 'regions',
    out: finalized,
    bypassAccessFilter,
  })
  await persistEntities({
    client,
    worldId,
    entityType: 'faction',
    source: tree.factions,
    synthArrayPath: 'factions',
    out: finalized,
    bypassAccessFilter,
  })
  // worlds repo is closure-style and can't accept this client; write
  // the one column it needs via inline SQL on the active transaction
  // (owned by the caller).
  await client.query(
    `UPDATE worlds SET world_overview = $1, updated_at = now() WHERE id = $2`,
    [tree.world_overview, worldId],
  )
  return finalized
}

export async function runWorldAndFactionsStage(
  client: PoolClient,
  args: RunWorldAndFactionsArgs,
): Promise<StageDispatchResult> {
  const prompt = PROMPT_TEMPLATE.replace('{{worldName}}', args.world.name).replace(
    '{{concept}}',
    args.world.concept,
  )

  // maxRetries: 0 per design D2 — predictable cost attribution + repair
  // chain owns validation recovery + BullMQ stage retry owns transport
  // recovery. No third hidden retry layer in the SDK.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see top-of-file note
  const result = streamObject({
    model: OPUS,
    schema: WorldAndFactionsSchema,
    prompt,
    temperature: 0.7,
    maxRetries: 0,
    providerOptions: {
      mythrun: {
        worldId: args.world.id,
        campaignId: args.campaignId,
        stage: 'world_and_factions',
      },
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- see top-of-file note
    } as unknown as NonNullable<Parameters<typeof streamObject>[0]['providerOptions']>,
  })

  const { finalTree } = await runStreamingStage<unknown>(result.partialObjectStream, {
    stage: 'world_and_factions',
    campaignId: args.campaignId,
    job: args.job,
    redisRealtime: args.redisRealtime,
    keyPrefix: args.keyPrefix,
    arrays: [
      { path: 'regions', kind: 'location', role: 'entity' },
      { path: 'factions', kind: 'faction', role: 'entity' },
    ],
    // myth-exac T13: stage 2 has no edge endpoints — entities are emitted
    // standalone, so the endpoint-tier map is empty. The bypass flag is
    // threaded from the world-gen-processor.
    bypassAccessFilter: args.bypassAccessFilter,
    endpointTierMap: new Map(),
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

  const validation = await validateOrRepair(finalTree)
  const finalized = await persistTree(
    client,
    args.world.id,
    validation.tree,
    args.bypassAccessFilter,
  )

  const finalizedEvents: readonly PipelineEvent[] = finalized.map((f) => ({
    type: 'finalized' as const,
    synthKey: f.synthKey,
    entityId: f.entityId,
  }))

  return {
    costUsd: opusCostUsd + validation.costUsd,
    inputTokens: opusInputTokens + validation.inputTokens,
    outputTokens: opusOutputTokens + validation.outputTokens,
    finalizedEvents,
    capExhausted: false,
  }
}
