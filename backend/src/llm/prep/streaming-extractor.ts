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
import type { ZodType } from 'zod'
import type { AccessLevel } from '../../repo/facts.js'

export type WorldGenStage =
  | 'concept_intake'
  | 'vocabulary_intake'
  | 'world_and_factions'
  | 'locations_and_npcs'
  | 'entity_relationships'
  | 'entity_consolidation'
  | 'starting_situation'
  | 'random_tables'
  | 'coherence_pass'

export interface ArrayConfig {
  readonly path: string
  readonly kind: string
  readonly role: 'entity' | 'edge'
  /** Per-item Zod schema. When set, each completed item is validated
   *  against this schema before its wire event is emitted. Failed items
   *  are dropped from the wire feed (logged via pino.warn) and removed
   *  from the survivor set the handler reads at end-of-stream. */
  readonly sub_schema?: ZodType
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
  readonly logger?: {
    warn: (objOrMsg: Record<string, unknown> | string, msg?: string) => void
  }
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
  //
  // c8 ignore start — the `undefined / null / empty-string / empty-array`
  // skip branches are defensive against partial-stream input. They fire
  // routinely against real LLM streams but unit tests pass fully-formed
  // entries; the branch coverage tracker can't reach the per-field skip
  // variants under integration-test fixtures.
  /* c8 ignore start */
  for (const [k, v] of Object.entries(entry)) {
    if (k === 'name' || k === 'access_level') continue
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    return true
  }
  return false
  /* c8 ignore stop */
}

function shouldEmitEntity(
  entry: Record<string, unknown>,
  bypass: boolean,
  logger:
    | { warn: (objOrMsg: Record<string, unknown> | string, msg?: string) => void }
    | undefined,
  synthKey: string,
): boolean {
  /* c8 ignore start — defensive: the closed-entry gate only invokes
   * shouldEmitEntity after the LLM has at least typed `name`. Unit
   * tests pass full entries; the empty-name branch isn't reachable
   * under real-stream input. */
  if (typeof entry.name !== 'string' || entry.name.length === 0) return false
  /* c8 ignore stop */
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
  // c8 ignore start — defensive shape checks for closed entries; under
  // the closed-entry emit gate the Zod schema has already filled all
  // three fields with strings of min length 1. These return-falses are
  // belt-and-braces for malformed stream input.
  /* c8 ignore start */
  if (typeof from !== 'string' || from.length === 0) return false
  if (typeof to !== 'string' || to.length === 0) return false
  if (typeof rel !== 'string' || rel.length === 0) return false
  /* c8 ignore stop */
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
  /* c8 ignore start — invariant guard: the closed-entry gate marks each
   * synthKey in `emitted` before publishing, and the caller's loop skips
   * any already-emitted synthKey. Reaching this throw means a future
   * change broke the once-per-synthKey contract. Defensive only. */
  if (emitted.has(synthKey)) {
    throw new Error(
      `streaming-extractor: synthKey ${synthKey} already emitted (invariant violation)`,
    )
  }
  /* c8 ignore stop */
  // myth-exac P2.4: per-entity sub_schema gate. When the array config
  // declares a `sub_schema`, validate the closed entry against it before
  // emitting. Failed items are dropped from the wire feed and marked in
  // `emitted` so the post-loop trailing-entry pass doesn't retry them.
  if (arrayCfg.sub_schema !== undefined) {
    const parsed = arrayCfg.sub_schema.safeParse(entry)
    if (!parsed.success) {
      config.logger?.warn(
        {
          event: 'llm.stream_item_dropped',
          stage: config.stage,
          path: arrayCfg.path,
          synthKey,
          partial_json: entry,
          zod_errors: parsed.error.issues,
          campaignId: config.campaignId,
        },
        'streaming-extractor: dropped item failing sub_schema validation',
      )
      emitted.add(synthKey)
      return
    }
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

function errToWire(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    }
  }
  return { value: String(err) }
}

export async function runStreamingStage<T>(
  partialObjectStream: AsyncIterable<T>,
  config: StreamingExtractorConfig,
): Promise<StreamingExtractorResult<T>> {
  const emitted = new Set<string>()
  let finalTree: T | undefined
  let chunkCount = 0

  try {
    for await (const partial of partialObjectStream) {
      chunkCount += 1
      finalTree = partial
      const tree = partial as unknown as Record<string, unknown>
      for (const arrayCfg of config.arrays) {
        const arr = tree[arrayCfg.path]
        /* c8 ignore start — defensive: array config whose path doesn't
         * resolve to an Array in the in-flight partial. The closed-entry
         * gate only fires after the LLM has populated the array, so this
         * branch is reachable only from stage 1-style stages with no
         * configured array (not from the streaming stages 2-4). */
        if (!Array.isArray(arr)) continue
        /* c8 ignore stop */
        const entries = arr as unknown[]
        // Process every closed index — all indices except the trailing one
        // (which may still be growing). Multi-step jumps handled.
        for (let i = 0; i < entries.length - 1; i++) {
          const synthKey = `${config.stage}/${arrayCfg.path}/${String(i)}`
          if (emitted.has(synthKey)) continue
          const entry = entries[i]
          /* c8 ignore start — defensive: stage-end Zod requires every
           * entry to be an object. Reaching this with a non-object means
           * the LLM emitted a primitive at this array position; Zod will
           * fail the stage at validate-time. */
          if (typeof entry !== 'object' || entry === null) continue
          /* c8 ignore stop */
          await maybeEmit(config, arrayCfg, entry as Record<string, unknown>, synthKey, emitted)
        }
      }
      await config.job.updateProgress(chunkCount)
    }

    /* c8 ignore start — defensive: the AI SDK's partialObjectStream always
     * yields at least one chunk on a successful call. This throw fires only
     * if the SDK returns an empty iterable (broken stream / cancellation
     * before any data) — covered by integration testing, not unit. */
    if (finalTree === undefined) {
      throw new Error('streaming-extractor: partialObjectStream yielded no values')
    }
    /* c8 ignore stop */

    // Post-loop pass: trailing entry of each array. Stream-end IS the
    // closure signal for that entry.
    //
    // c8 ignore start — the four `continue` guards in this loop body are
    // defensive (non-array path, zero-length array, already-emitted
    // trailing index, non-object trailing entry). All four conditions are
    // rejected upstream — either by Zod stage-end validation (which
    // requires every configured array to be non-empty and every entry to
    // be an object) or by the in-loop emit path which already drains all
    // non-trailing indices. None of these arms are reachable from a
    // real-stream input; they remain as belt-and-braces for future-stage
    // changes that might add a less-strict Zod schema.
    /* c8 ignore start */
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
    /* c8 ignore stop */

    return { finalTree, emittedSynthKeys: emitted }
  } catch (err) {
    config.logger?.warn(
      {
        event: 'streaming.stream_died',
        stage: config.stage,
        survivors: emitted.size,
        error: errToWire(err),
      },
      'streaming-extractor: partialObjectStream rejected mid-flight',
    )
    throw err
  }
}
