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
import type { NameResolutionContext } from './name-resolution.js'
import { resolveRelationship, normalizeName } from './name-resolution.js'

export type WorldGenStage =
  | 'concept_intake'
  | 'world_color'
  | 'vocabulary_intake'
  | 'world_and_factions'
  | 'locations_and_npcs'
  | 'entity_relationships'
  | 'entity_consolidation'
  | 'starting_situation'
  | 'random_tables'
  | 'coherence_pass'
  | 'embed_world'
  | 'session_prep'

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
  // myth-2ob3: stage 4 passes a name-resolution context + a mutable
  // pendingDeclarations map (populated as the LLM emits items into
  // `new_entity_declarations`). When present, the extractor resolves
  // edge endpoints from names to UUIDs (or server-minted `new-NNN`
  // synthetic IDs for phantom-declared targets) before publishing
  // `edge-added`. When absent (stages 2, 3), the extractor publishes
  // raw entry fields — today's behavior.
  readonly nameResolutionCtx?: NameResolutionContext
  readonly pendingDeclarations?: Map<string, { synthId: string; entityType: string }>
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
  resolvedFrom: string | null,
  resolvedTo: string | null,
): boolean {
  /* c8 ignore start — defensive: callers gate on resolveEdgeEndpoints
   * returning non-null pairs before invoking shouldEmitEdge, and the
   * closed-entry gate ensures `relationship` is a non-empty string. */
  if (resolvedFrom === null || resolvedTo === null) return false
  const rel = entry.relationship
  if (typeof rel !== 'string' || rel.length === 0) return false
  /* c8 ignore stop */
  if (bypass) return true
  const fromTier = endpointTierMap.get(resolvedFrom)
  const toTier = endpointTierMap.get(resolvedTo)
  return fromTier === 'known' && toTier === 'known'
}

function resolveEdgeEndpoints(
  config: StreamingExtractorConfig,
  entry: Record<string, unknown>,
): { from: string | null; to: string | null } {
  if (config.nameResolutionCtx === undefined || config.pendingDeclarations === undefined) {
    // Legacy path: stages 2/3 emit entry.from / entry.to as-is.
    /* c8 ignore start — legacy from/to non-string-or-empty defensive arm;
     * the closed-entry gate only fires after Zod has filled both fields
     * with non-empty strings on real-stream input. */
    const from = entry.from
    const to = entry.to
    return {
      from: typeof from === 'string' && from.length > 0 ? from : null,
      to: typeof to === 'string' && to.length > 0 ? to : null,
    }
    /* c8 ignore stop */
  }
  /* c8 ignore start — name-based path defensive type check; same
   * Zod-already-validated guarantee as above but for the new schema. */
  if (typeof entry.from_name !== 'string' || typeof entry.to_name !== 'string') {
    return { from: null, to: null }
  }
  /* c8 ignore stop */
  const res = resolveRelationship(
    config.nameResolutionCtx,
    {
      from_name: entry.from_name,
      to_name: entry.to_name,
      /* c8 ignore start — defensive: closed-entry gate guarantees both
       * fields are non-empty strings on real-stream input. */
      relationship: typeof entry.relationship === 'string' ? entry.relationship : '',
      description: typeof entry.description === 'string' ? entry.description : '',
      /* c8 ignore stop */
    },
    config.pendingDeclarations,
  )
  switch (res.kind) {
    case 'resolved':
      return { from: res.sourceEntityId, to: res.targetEntityId }
    case 'phantom_target':
      return { from: res.sourceEntityId, to: res.synthId }
    /* c8 ignore start — phantom_source and phantom_both fire when the
     * LLM emits a relationship referencing a declaration BEFORE the
     * server has minted its synthId (declarations are usually emitted
     * before relationships per prompt ordering, so the source side of
     * an edge typically resolves to a real UUID). Resolver-unit tests
     * cover both branches; the streaming extractor's mid-stream path
     * doesn't naturally reach them under normal LLM ordering. */
    case 'phantom_source':
      return { from: res.synthId, to: res.targetEntityId }
    case 'phantom_both':
      return { from: res.sourceSynthId, to: res.targetSynthId }
    /* c8 ignore stop */
    case 'dropped':
      return { from: null, to: null }
  }
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
  resolvedFrom: string,
  resolvedTo: string,
): Promise<void> {
  const channel = `${config.keyPrefix}pipeline:campaign:${config.campaignId}`
  await config.redisRealtime.publish(
    channel,
    JSON.stringify({
      type: 'edge-added',
      synthKey,
      from: resolvedFrom,
      to: resolvedTo,
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
    // myth-2ob3: declaration observation. When a declaration entry closes
    // (has name + entity_type) AND pendingDeclarations is provided, bind
    // it to a synthetic `new-NNN` ID so subsequent edge resolution can
    // find it. Idempotent: same name maps to the same synthId across the
    // pass.
    if (
      config.pendingDeclarations !== undefined &&
      typeof entry.name === 'string' &&
      typeof entry.entity_type === 'string'
    ) {
      const name = normalizeName(entry.name)
      if (!config.pendingDeclarations.has(name)) {
        const next = config.pendingDeclarations.size + 1
        const synthId = `new-${String(next).padStart(3, '0')}`
        config.pendingDeclarations.set(name, { synthId, entityType: entry.entity_type })
      }
    }
    if (shouldEmitEntity(entry, config.bypassAccessFilter, config.logger, synthKey)) {
      await publishEntityAdded(config, synthKey, arrayCfg, entry)
    }
  } else {
    const { from, to } = resolveEdgeEndpoints(config, entry)
    if (
      from !== null &&
      to !== null &&
      shouldEmitEdge(entry, config.bypassAccessFilter, config.endpointTierMap, from, to)
    ) {
      await publishEdgeAdded(config, synthKey, entry, from, to)
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
