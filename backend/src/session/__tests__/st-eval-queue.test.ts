import { describe, expect, it, vi } from 'vitest'
import { enqueueStEval, stEvalDedupId, QUEUE_ST_EVAL, type StEvalPayload } from '../st-eval-queue.js'

describe('st-eval-queue', () => {
  it('dedup id is stable per campaign', () => {
    expect(stEvalDedupId('c1')).toBe('st-eval:c1')
  })
  it('enqueueStEval adds with the dedup id and NO ttl/delay', async () => {
    const add = vi.fn().mockResolvedValue(undefined)
    await enqueueStEval({ add }, { campaignId: 'c1', sessionId: 's1' })
    const [name, data, opts] = add.mock.calls[0] as [string, StEvalPayload, Record<string, unknown>]
    expect(name).toBe(QUEUE_ST_EVAL)
    expect(data).toEqual({ campaignId: 'c1', sessionId: 's1' })
    expect(opts.deduplication).toEqual({ id: 'st-eval:c1' })
    expect(opts.delay).toBeUndefined()
    expect((opts.deduplication as { ttl?: number }).ttl).toBeUndefined()
  })
})
