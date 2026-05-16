// backend/src/llm/prep/streaming-extractor.ts
//
// myth-exac rewrite. Reusable streaming entity-extraction loop. Used by
// stages 2, 3, and 4.
//
// Emit gate: closed-entry detection. For each configured array path,
// emits at most one `entity-added` / `edge-added` event per synthKey,
// fired when the LLM has finished writing that entry. Detection:
// non-last entries close when `partial.array.length > i + 1`; the last
// entry of each array closes via the post-loop pass that runs after the
// `for await` exits.
//
// Tier filter: entries (and edges) only emit when access_level === 'known'
// (or bypass is on). Discoverable/secret entries persist silently via
// the stage handler — the wire is what's filtered, not the DB.
//
// Edge endpoint tier check uses `endpointTierMap: Map<entityId,
// AccessLevel>` passed in by the stage handler (stage 4 builds the map
// from its entity inventory query).

import type { Job } from 'bullmq'
import type { Redis } from 'ioredis'
import type { AccessLevel } from '../../repo/facts.js'

export type WorldGenStage =
  | 'concept_intake'
  | 'world_and_factions'
  | 'locations_and_npcs'
  | 'entity_relationships'
  | 'starting_situation'
  | 'random_tables'
  | 'coherence_pass'

export interface ArrayConfig {
  readonly path: string
  readonly kind: string
  readonly role: 'entity' | 'edge'
}

export interface StreamingExtractorConfig {
  readonly stage: WorldGenStage
  readonly campaignId: string
  readonly job: Pick<Job, 'updateProgress'>
  readonly redisRealtime: Pick<Redis, 'publish'>
  readonly keyPrefix: string
  readonly arrays: readonly ArrayConfig[]
  readonly bypassAccessFilter: boolean
  readonly endpointTierMap: ReadonlyMap<string, AccessLevel>
  readonly logger?: { warn: (msg: string) => void }
}

export interface StreamingExtractorResult<T> {
  readonly finalTree: T
  readonly emittedSynthKeys: ReadonlySet<string>
}

function isAccessLevel(v: unknown): v is AccessLevel {
  return v === 'known' || v === 'discoverable' || v === 'secret'
}

function hasSubstantiveContent(entry: Record<string, unknown>): boolean {
  // At least one field beyond `name` / `access_level` must be present and
  // non-empty. Guards against the trailing-entry-still-being-written case
  // where only `name` + `access_level` have streamed in at stream-end.
  for (const [k, v] of Object.entries(entry)) {
    if (k === 'name' || k === 'access_level') continue
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    return true
  }
  return false
}

function shouldEmitEntity(
  entry: Record<string, unknown>,
  bypass: boolean,
  logger: { warn: (msg: string) => void } | undefined,
  synthKey: string,
): boolean {
  if (typeof entry.name !== 'string' || entry.name.length === 0) return false
  if (!isAccessLevel(entry.access_level)) {
    logger?.warn(
      `streaming-extractor: closed entry ${synthKey} lacks access_level; skipping emit (Zod will fail stage at validate-time)`,
    )
    return false
  }
  if (!hasSubstantiveContent(entry)) return false
  if (bypass) return true
  return entry.access_level === 'known'
}

function shouldEmitEdge(
  entry: Record<string, unknown>,
  bypass: boolean,
  endpointTierMap: ReadonlyMap<string, AccessLevel>,
): boolean {
  const from = entry.from
  const to = entry.to
  const rel = entry.relationship
  if (typeof from !== 'string' || from.length === 0) return false
  if (typeof to !== 'string' || to.length === 0) return false
  if (typeof rel !== 'string' || rel.length === 0) return false
  if (bypass) return true
  const fromTier = endpointTierMap.get(from)
  const toTier = endpointTierMap.get(to)
  return fromTier === 'known' && toTier === 'known'
}

async function publishEntityAdded(
  config: StreamingExtractorConfig,
  synthKey: string,
  arrayCfg: ArrayConfig,
  entry: Record<string, unknown>,
): Promise<void> {
  const channel = `${config.keyPrefix}pipeline:campaign:${config.campaignId}`
  await config.redisRealtime.publish(
    channel,
    JSON.stringify({
      type: 'entity-added',
      synthKey,
      entityKind: arrayCfg.kind,
      name: entry.name as string,
    }),
  )
}

async function publishEdgeAdded(
  config: StreamingExtractorConfig,
  synthKey: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const channel = `${config.keyPrefix}pipeline:campaign:${config.campaignId}`
  await config.redisRealtime.publish(
    channel,
    JSON.stringify({
      type: 'edge-added',
      synthKey,
      from: entry.from as string,
      to: entry.to as string,
      relationship: entry.relationship as string,
    }),
  )
}

async function maybeEmit(
  config: StreamingExtractorConfig,
  arrayCfg: ArrayConfig,
  entry: Record<string, unknown>,
  synthKey: string,
  emitted: Set<string>,
): Promise<void> {
  if (emitted.has(synthKey)) {
    throw new Error(
      `streaming-extractor: synthKey ${synthKey} already emitted (invariant violation)`,
    )
  }
  if (arrayCfg.role === 'entity') {
    if (shouldEmitEntity(entry, config.bypassAccessFilter, config.logger, synthKey)) {
      await publishEntityAdded(config, synthKey, arrayCfg, entry)
    }
  } else {
    if (shouldEmitEdge(entry, config.bypassAccessFilter, config.endpointTierMap)) {
      await publishEdgeAdded(config, synthKey, entry)
    }
  }
  emitted.add(synthKey)
}

export async function runStreamingStage<T>(
  partialObjectStream: AsyncIterable<T>,
  config: StreamingExtractorConfig,
): Promise<StreamingExtractorResult<T>> {
  const emitted = new Set<string>()
  let finalTree: T | undefined
  let chunkCount = 0

  for await (const partial of partialObjectStream) {
    chunkCount += 1
    finalTree = partial
    const tree = partial as unknown as Record<string, unknown>
    for (const arrayCfg of config.arrays) {
      const arr = tree[arrayCfg.path]
      if (!Array.isArray(arr)) continue
      const entries = arr as unknown[]
      // Process every closed index — all indices except the trailing one
      // (which may still be growing). Multi-step jumps handled.
      for (let i = 0; i < entries.length - 1; i++) {
        const synthKey = `${config.stage}/${arrayCfg.path}/${String(i)}`
        if (emitted.has(synthKey)) continue
        const entry = entries[i]
        if (typeof entry !== 'object' || entry === null) continue
        await maybeEmit(config, arrayCfg, entry as Record<string, unknown>, synthKey, emitted)
      }
    }
    await config.job.updateProgress(chunkCount)
  }

  if (finalTree === undefined) {
    throw new Error('streaming-extractor: partialObjectStream yielded no values')
  }

  // Post-loop pass: trailing entry of each array. Stream-end IS the
  // closure signal for that entry.
  const finalRoot = finalTree as unknown as Record<string, unknown>
  for (const arrayCfg of config.arrays) {
    const arr = finalRoot[arrayCfg.path]
    if (!Array.isArray(arr)) continue
    const entries = arr as unknown[]
    if (entries.length === 0) continue
    const lastIdx = entries.length - 1
    const synthKey = `${config.stage}/${arrayCfg.path}/${String(lastIdx)}`
    if (emitted.has(synthKey)) continue
    const entry = entries[lastIdx]
    if (typeof entry !== 'object' || entry === null) continue
    await maybeEmit(config, arrayCfg, entry as Record<string, unknown>, synthKey, emitted)
  }

  return { finalTree, emittedSynthKeys: emitted }
}
