// backend/src/worker/__tests__/job-context.test.ts
import { describe, it, expect } from 'vitest'
import { runWithJobContext, getJobContext, setStage } from '../job-context.js'

describe('job-context (AsyncLocalStorage)', () => {
  it('returns undefined outside a runWithJobContext frame', () => {
    expect(getJobContext()).toBeUndefined()
  })

  it('propagates context through awaits inside the frame', async () => {
    await runWithJobContext(
      { jobId: 'j1', worldId: 'w1', campaignId: 'c1' },
      async () => {
        expect(getJobContext()).toMatchObject({
          jobId: 'j1', worldId: 'w1', campaignId: 'c1', stage: 'pre-stage',
        })
        await Promise.resolve()
        expect(getJobContext()).toMatchObject({ jobId: 'j1', stage: 'pre-stage' })
      },
    )
  })

  it('setStage updates the active context in place', async () => {
    await runWithJobContext(
      { jobId: 'j2', worldId: 'w2', campaignId: 'c2' },
      async () => {
        setStage('world_and_factions')
        expect(getJobContext()?.stage).toBe('world_and_factions')
        setStage('post-stage')
        expect(getJobContext()?.stage).toBe('post-stage')
        await Promise.resolve()
      },
    )
  })

  it('isolates context across two concurrent frames', async () => {
    const seenA: (string | undefined)[] = []
    const seenB: (string | undefined)[] = []
    const jobA = runWithJobContext(
      { jobId: 'A', worldId: 'wA', campaignId: 'cA' },
      async () => {
        seenA.push(getJobContext()?.jobId)
        await new Promise((r) => setTimeout(r, 10))
        seenA.push(getJobContext()?.jobId)
      },
    )
    const jobB = runWithJobContext(
      { jobId: 'B', worldId: 'wB', campaignId: 'cB' },
      async () => {
        seenB.push(getJobContext()?.jobId)
        await new Promise((r) => setTimeout(r, 10))
        seenB.push(getJobContext()?.jobId)
      },
    )
    await Promise.all([jobA, jobB])
    expect(seenA).toEqual(['A', 'A'])
    expect(seenB).toEqual(['B', 'B'])
  })

  it('setStage outside a frame is a no-op (does not throw)', () => {
    expect(() => {
      setStage('world_and_factions')
    }).not.toThrow()
    expect(getJobContext()).toBeUndefined()
  })
})
