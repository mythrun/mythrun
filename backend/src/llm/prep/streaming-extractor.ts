// backend/src/llm/prep/streaming-extractor.ts
//
// Reusable streaming entity-extraction loop. Used by stages 2, 3, and 4.
// Per design §4.1 + §D7.
//
// Iterates a partialObjectStream-shaped async iterable. For each
// configured array path, emits entity-added / entity-updated /
// edge-added events as entries cross the "name field closed" boundary
// (predicate: non-empty name + at least one other field present).

import type { Job } from 'bullmq'
import type { Redis } from 'ioredis'

export type WorldGenStage =
  | 'concept_intake'
  | 'world_and_factions'
  | 'locations_and_npcs'
  | 'entity_relationships'
  | 'starting_situation'
  | 'random_tables'
  | 'coherence_pass'

export interface ArrayConfig {
  readonly path: string // top-level array key
  readonly kind: string // entityKind or relationship-kind passed through
  readonly role: 'entity' | 'edge'
}

export interface StreamingExtractorConfig {
  readonly stage: WorldGenStage
  readonly campaignId: string
  readonly job: Pick<Job, 'updateProgress'>
  readonly redisRealtime: Pick<Redis, 'publish'>
  readonly keyPrefix: string
  readonly arrays: readonly ArrayConfig[]
}

export interface StreamingExtractorResult<T> {
  readonly finalTree: T
  readonly emittedSnapshots: Map<string, unknown>
}

function isEmittableEntity(entry: Record<string, unknown>): boolean {
  if (typeof entry.name !== 'string' || entry.name.length === 0) return false
  // At least one OTHER field has begun (non-empty).
  for (const [k, v] of Object.entries(entry)) {
    if (k === 'name') continue
    if (v !== undefined && v !== null && v !== '') return true
  }
  return false
}

function isEmittableEdge(entry: Record<string, unknown>): boolean {
  // Edge entries are emittable once both endpoints are non-empty AND the
  // relationship type field is non-empty.
  const from = entry.from
  const to = entry.to
  const rel = entry.relationship
  return (
    typeof from === 'string' &&
    from.length > 0 &&
    typeof to === 'string' &&
    to.length > 0 &&
    typeof rel === 'string' &&
    rel.length > 0
  )
}

function diffPatch(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}
  let changed = false
  for (const [k, v] of Object.entries(next)) {
    if (prev[k] !== v) {
      patch[k] = v
      changed = true
    }
  }
  return changed ? patch : null
}

async function publishEvent(
  config: StreamingExtractorConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const channel = `${config.keyPrefix}pipeline:campaign:${config.campaignId}`
  await config.redisRealtime.publish(channel, JSON.stringify(payload))
}

export async function runStreamingStage<T>(
  partialObjectStream: AsyncIterable<T>,
  config: StreamingExtractorConfig,
): Promise<StreamingExtractorResult<T>> {
  const emittedSnapshots = new Map<string, Record<string, unknown>>()
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
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        if (typeof entry !== 'object' || entry === null) continue
        const entryObj = entry as Record<string, unknown>
        const synthKey = `${config.stage}/${arrayCfg.path}/${String(i)}`

        const isEmittable =
          arrayCfg.role === 'entity' ? isEmittableEntity(entryObj) : isEmittableEdge(entryObj)

        const prevSnapshot = emittedSnapshots.get(synthKey)
        if (prevSnapshot === undefined) {
          if (!isEmittable) continue
          if (arrayCfg.role === 'entity') {
            await publishEvent(config, {
              type: 'entity-added',
              synthKey,
              entityKind: arrayCfg.kind,
              data: { ...entryObj },
            })
          } else {
            await publishEvent(config, {
              type: 'edge-added',
              synthKey,
              from: entryObj.from,
              to: entryObj.to,
              relationship: entryObj.relationship,
              description: entryObj.description,
            })
          }
          emittedSnapshots.set(synthKey, { ...entryObj })
        } else {
          const patch = diffPatch(prevSnapshot, entryObj)
          if (patch !== null) {
            await publishEvent(
              config,
              arrayCfg.role === 'entity'
                ? { type: 'entity-updated', synthKey, patch }
                : {
                    type: 'edge-added',
                    synthKey,
                    from: entryObj.from,
                    to: entryObj.to,
                    relationship: entryObj.relationship,
                    description: entryObj.description,
                  },
            )
            emittedSnapshots.set(synthKey, { ...entryObj })
          }
        }
      }
    }

    await config.job.updateProgress(chunkCount)
  }

  if (finalTree === undefined) {
    throw new Error('streaming-extractor: partialObjectStream yielded no values')
  }
  return { finalTree, emittedSnapshots }
}
