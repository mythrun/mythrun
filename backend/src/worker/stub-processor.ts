// Stub job processor — logs the receipt + marks progress complete, no real
// work. Real stage logic lands in MYT-51 (world gen non-streaming),
// MYT-52 (world gen streaming + entity events), MYT-53 (per-player
// character creation), MYT-54 (post-creation + barrier).
//
// Returning normally marks the BullMQ job 'completed'. Throwing would
// move it to 'failed'. We return; stubs should never fail.

import type { Job } from 'bullmq'
import type { Logger } from 'pino'

export function makeStubProcessor(logger: Logger): (job: Job) => Promise<void> {
  return async function stubProcessor(job: Job): Promise<void> {
    const dataType =
      typeof job.data === 'object' && job.data !== null && 'type' in job.data
        ? (job.data as { type: unknown }).type
        : undefined
    logger.info(
      {
        event: 'worker.job.received',
        queue: job.queueName,
        jobId: job.id,
        type: dataType,
      },
      'stub processor — real stage logic lands in MYT-51 onward',
    )
    await job.updateProgress(100)
  }
}
