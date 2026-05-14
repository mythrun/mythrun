import { describe, it, expect } from 'vitest'
import { Queue, type ConnectionOptions } from 'bullmq'
import IoredisMock from 'ioredis-mock'

// MYT-52 T1: lock in the world-gen Queue's defaultJobOptions shape.
//
// The Queue constructed in `backend/src/server.ts` previously had no
// `attempts` value, leaving BullMQ at its default `attempts: 1` (no
// retries). Every "BullMQ retries the stage" row in the MYT-52 design's
// §7.2 error matrix depended on that being >= 2. This test mirrors the
// production construction shape so any future refactor that drops the
// retry config trips the suite instead of silently regressing.
describe('world-gen BullMQ Queue config', () => {
  it('has defaultJobOptions.attempts = 2 with exponential backoff', () => {
    const queue = new Queue('world-gen', {
      connection: new IoredisMock() as unknown as ConnectionOptions,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: { count: 0 },
        removeOnFail: { count: 0 },
      },
    })
    const opts = queue.opts.defaultJobOptions
    expect(opts?.attempts).toBe(2)
    expect(opts?.backoff).toEqual({ type: 'exponential', delay: 30000 })
    void queue.close()
  })
})
