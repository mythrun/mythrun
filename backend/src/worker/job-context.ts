// backend/src/worker/job-context.ts
//
// myth-449j: AsyncLocalStorage-propagated context per BullMQ job. The
// process-level unhandledRejection handler reads this to learn which
// job was in flight when a rejection escaped both the local guard
// (streaming-extractor.ts) and the wrapper's repair chain (ai.ts). With
// CONCURRENCY_WORLD_GEN=3 we may have three jobs running concurrently;
// each lives in its own ALS frame, so the handler sees the right one
// for the failing async lineage.

import { AsyncLocalStorage } from 'node:async_hooks'
import type { WorldGenStage } from '../llm/prep/streaming-extractor.js'

export type StageMarker = WorldGenStage | 'pre-stage' | 'post-stage'

export interface JobContext {
  readonly jobId: string
  readonly worldId: string
  readonly campaignId: string
  stage: StageMarker
}

const storage = new AsyncLocalStorage<JobContext>()

export function runWithJobContext<T>(
  ctx: Omit<JobContext, 'stage'>,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ ...ctx, stage: 'pre-stage' }, fn)
}

export function getJobContext(): JobContext | undefined {
  return storage.getStore()
}

export function setStage(stage: StageMarker): void {
  const ctx = storage.getStore()
  if (ctx !== undefined) ctx.stage = stage
}
