// backend/src/llm/prep/stages/world-and-factions.ts
//
// Stage 2 (world_and_factions) per design §3.1.
//
// Streams via Vercel SDK streamObject (maxRetries: 0). Iterates
// partialObjectStream via streaming-extractor.ts; emits entity-added /
// entity-updated events live as regions/factions take shape. At stream
// end: validateOrRepair → BEGIN/INSERT/COMMIT → publish `finalized` per
// entity. On repair-chain exhaustion or COMMIT failure: publish
// `stage-reset { stage }` and rethrow so BullMQ retries the stage.
//
// Cost is the sum of (a) the streaming Opus call's usage, plus
// (b) the Haiku repair call's usage if invoked, plus (c) the Sonnet
// repair call's usage if Haiku failed. Returned as a single aggregated
// StageCost the world-gen processor writes to pipeline_runs.cost_usd.

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
import { runStreamingStage } from '../streaming-extractor.js'
import { repairStructuredOutput } from '../structured-output-repair.js'
import {
  WorldAndFactionsSchema,
  type WorldAndFactionsTree,
} from '../../schemas/world-and-factions.js'
import type { StageCost } from '../world-gen-processor.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/world-and-factions.txt'),
  'utf8',
)

export interface RunWorldAndFactionsInput {
  readonly pool: Pool
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
}

interface FinalizedRow {
  readonly synthKey: string
  readonly entityId: string
}

async function publishStageReset(
  input: Pick<RunWorldAndFactionsInput, 'redisRealtime' | 'keyPrefix' | 'campaignId'>,
): Promise<void> {
  await input.redisRealtime.publish(
    `${input.keyPrefix}pipeline:campaign:${input.campaignId}`,
    JSON.stringify({ type: 'stage-reset', stage: 'world_and_factions' }),
  )
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
// The streamed-call cost is the caller's responsibility.
async function validateOrRepair(
  finalTree: unknown,
  input: Pick<RunWorldAndFactionsInput, 'redisRealtime' | 'keyPrefix' | 'campaignId'>,
): Promise<ValidatedWithCost> {
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
    await publishStageReset(input)
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
}

async function persistEntities(args: PersistEntityArgs): Promise<void> {
  for (const [i, item] of args.source.entries()) {
    const entityId = uuidv7()
    await entities.insert(args.client, {
      id: entityId,
      worldId: args.worldId,
      entityType: args.entityType,
      name: item.name,
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
    args.out.push({
      synthKey: `world_and_factions/${args.synthArrayPath}/${String(i)}`,
      entityId,
    })
  }
}

async function persistAndPublishFinalized(
  input: RunWorldAndFactionsInput,
  tree: WorldAndFactionsTree,
): Promise<void> {
  const client = await input.pool.connect()
  try {
    await client.query('BEGIN')
    const finalized: FinalizedRow[] = []
    await persistEntities({
      client,
      worldId: input.world.id,
      entityType: 'location',
      source: tree.regions,
      synthArrayPath: 'regions',
      out: finalized,
    })
    await persistEntities({
      client,
      worldId: input.world.id,
      entityType: 'faction',
      source: tree.factions,
      synthArrayPath: 'factions',
      out: finalized,
    })
    // worlds repo is closure-style and can't accept this client; write
    // the one column it needs via inline SQL on the active transaction.
    await client.query(
      `UPDATE worlds SET world_overview = $1, updated_at = now() WHERE id = $2`,
      [tree.world_overview, input.world.id],
    )
    await client.query('COMMIT')

    for (const f of finalized) {
      await input.redisRealtime.publish(
        `${input.keyPrefix}pipeline:campaign:${input.campaignId}`,
        JSON.stringify({ type: 'finalized', synthKey: f.synthKey, entityId: f.entityId }),
      )
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

export async function runWorldAndFactionsStage(
  input: RunWorldAndFactionsInput,
): Promise<StageCost> {
  const prompt = PROMPT_TEMPLATE.replace('{{worldName}}', input.world.name).replace(
    '{{concept}}',
    input.world.concept,
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
        worldId: input.world.id,
        campaignId: input.campaignId,
        stage: 'world_and_factions',
      },
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- see top-of-file note
    } as unknown as NonNullable<Parameters<typeof streamObject>[0]['providerOptions']>,
  })

  const { finalTree } = await runStreamingStage<unknown>(result.partialObjectStream, {
    stage: 'world_and_factions',
    campaignId: input.campaignId,
    job: input.job,
    redisRealtime: input.redisRealtime,
    keyPrefix: input.keyPrefix,
    arrays: [
      { path: 'regions', kind: 'location', role: 'entity' },
      { path: 'factions', kind: 'faction', role: 'entity' },
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
