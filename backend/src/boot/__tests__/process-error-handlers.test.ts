// backend/src/boot/__tests__/process-error-handlers.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import pino from 'pino'
import { installProcessErrorHandlers } from '../process-error-handlers.js'
import { runWithJobContext } from '../../worker/job-context.js'

interface PoolStub {
  readonly query: ReturnType<typeof vi.fn>
}
interface RedisStub {
  readonly publish: ReturnType<typeof vi.fn>
}

function makeDeps(opts: { now?: () => number } = {}): {
  pool: PoolStub
  redisRealtime: RedisStub
  exit: ReturnType<typeof vi.fn>
  install: () => { uninstall: () => void }
} {
  const pool: PoolStub = { query: vi.fn().mockResolvedValue({ rows: [] }) }
  const redisRealtime: RedisStub = { publish: vi.fn().mockResolvedValue(1) }
  const exit = vi.fn()
  const logger = pino({ level: 'silent' })
  const install = () =>
    installProcessErrorHandlers({
      /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
      pool: pool as any,
      redisRealtime: redisRealtime,
      /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
      redisKeyPrefix: 'test:',
      logger,
      exit,
      now: opts.now ?? Date.now,
    })
  return { pool, redisRealtime, exit, install }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('installProcessErrorHandlers', () => {
  let installed: { uninstall: () => void } | null = null
  beforeEach(() => {
    installed = null
  })
  afterEach(() => {
    installed?.uninstall()
  })

  it('rejection inside ALS context marks the right world failed and does not exit', async () => {
    const { pool, redisRealtime, exit, install } = makeDeps()
    installed = install()
    await runWithJobContext(
      { jobId: 'j1', worldId: 'w1', campaignId: 'c1' },
      async () => {
        process.emit('unhandledRejection', new Error('boom'), Promise.resolve())
        await flushMicrotasks()
      },
    )
    expect(pool.query).toHaveBeenCalledWith(
      `UPDATE worlds SET status = 'failed' WHERE id = $1`,
      ['w1'],
    )
    expect(redisRealtime.publish).toHaveBeenCalledWith(
      'test:pipeline:campaign:c1',
      JSON.stringify({ type: 'phase', phase: 'world_gen_failed' }),
    )
    expect(exit).not.toHaveBeenCalled()
  })

  it('5 rejections within 5 minutes triggers exit(1)', async () => {
    let t = 1_000_000
    const { exit, install } = makeDeps({ now: () => t })
    installed = install()
    for (let i = 0; i < 5; i++) {
      await runWithJobContext(
        { jobId: `j${String(i)}`, worldId: `w${String(i)}`, campaignId: `c${String(i)}` },
        async () => {
          process.emit('unhandledRejection', new Error(`boom-${String(i)}`), Promise.resolve())
          await flushMicrotasks()
        },
      )
      t += 1000
    }
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('5 rejections spread across 6+ minutes does NOT trigger exit', async () => {
    let t = 1_000_000
    const { exit, install } = makeDeps({ now: () => t })
    installed = install()
    for (let i = 0; i < 5; i++) {
      await runWithJobContext(
        { jobId: `j${String(i)}`, worldId: `w${String(i)}`, campaignId: `c${String(i)}` },
        async () => {
          process.emit('unhandledRejection', new Error(`boom-${String(i)}`), Promise.resolve())
          await flushMicrotasks()
        },
      )
      t += 91 * 1000
    }
    expect(exit).not.toHaveBeenCalled()
  })

  it('rejection outside ALS context logs but does not mark any world failed', async () => {
    const { pool, redisRealtime, exit, install } = makeDeps()
    installed = install()
    process.emit('unhandledRejection', new Error('top-level boom'), Promise.resolve())
    await flushMicrotasks()
    expect(pool.query).not.toHaveBeenCalled()
    expect(redisRealtime.publish).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('concurrent jobs: rejection inside job A marks A failed, not B', async () => {
    const { pool, install } = makeDeps()
    installed = install()
    const seenWorldIds: string[] = []
    pool.query.mockImplementation((_sql: string, params: unknown[]) => {
      seenWorldIds.push(params[0] as string)
      return Promise.resolve({ rows: [] })
    })
    const jobA = runWithJobContext(
      { jobId: 'A', worldId: 'wA', campaignId: 'cA' },
      async () => {
        await new Promise((r) => setTimeout(r, 5))
        process.emit('unhandledRejection', new Error('A boom'), Promise.resolve())
        await flushMicrotasks()
      },
    )
    const jobB = runWithJobContext(
      { jobId: 'B', worldId: 'wB', campaignId: 'cB' },
      async () => {
        await new Promise((r) => setTimeout(r, 20))
      },
    )
    await Promise.all([jobA, jobB])
    expect(seenWorldIds).toEqual(['wA'])
  })
})
