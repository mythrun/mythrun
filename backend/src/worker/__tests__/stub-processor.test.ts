import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from 'pino'
import type { Job } from 'bullmq'
import { makeStubProcessor } from '../stub-processor.js'

function mockLogger(): Logger {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger
}

function mockJob(overrides: Partial<Job> = {}): {
  job: Job
  updateProgress: ReturnType<typeof vi.fn>
} {
  const updateProgress = vi.fn().mockResolvedValue(undefined)
  const job = {
    id: 'job-123',
    queueName: 'world-gen',
    data: { type: 'world-gen' },
    updateProgress,
    ...overrides,
  } as unknown as Job
  return { job, updateProgress }
}

describe('makeStubProcessor', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('logs worker.job.received and marks progress 100', async () => {
    const logger = mockLogger()
    const { job, updateProgress } = mockJob()
    const infoMock = logger.info as ReturnType<typeof vi.fn>
    const processor = makeStubProcessor(logger)

    await processor(job)

    expect(infoMock).toHaveBeenCalledOnce()
    expect(infoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'worker.job.received',
        queue: 'world-gen',
        jobId: 'job-123',
        type: 'world-gen',
      }),
      expect.stringContaining('stub processor'),
    )
    expect(updateProgress).toHaveBeenCalledWith(100)
  })

  it('handles a job with non-object data without crashing', async () => {
    const logger = mockLogger()
    const { job } = mockJob({ data: 'string-payload' })
    const infoMock = logger.info as ReturnType<typeof vi.fn>
    const processor = makeStubProcessor(logger)

    await processor(job)

    expect(infoMock).toHaveBeenCalledOnce()
    const firstCall = infoMock.mock.calls[0]
    expect(firstCall?.[0]).toMatchObject({ type: undefined })
  })
})
