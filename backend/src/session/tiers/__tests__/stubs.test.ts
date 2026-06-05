// MYT-66 Task 4 — tier stub tests.
//
// Pure in-memory exercise of the placeholder tier implementations that stand in
// for the real Fast/Slow Thinker + Scribe until MYT-68/69 land. No DB, no Redis,
// no Anthropic — these stubs are deterministic, so the suite just asserts the
// seam contract: ST doesn't intervene, FT emits exactly one canned delta and
// returns a canned assistant line, Scribe is a no-op. The `ctx` is the minimal
// public-by-construction `FtTurnContext` every tier reads.

import { describe, expect, it } from 'vitest'
import type { FtTurnContext } from '../types.js'
import { StubFastThinker, StubScribe, StubSlowThinker } from '../stubs.js'

const ctx: FtTurnContext = {
  campaignId: 'c',
  triggerMessages: [],
  ftHistory: [],
  runningSummary: '',
  participants: [],
  usage: { input: 0, output: 0 },
  workingSet: [],
}

describe('tier stubs', () => {
  it('StubSlowThinker does not intervene', async () => {
    expect(await new StubSlowThinker().evaluate(ctx)).toEqual({ intervene: false })
  })

  it('StubFastThinker emits one delta and returns a canned line', async () => {
    const emitted: string[] = []
    const msg = await new StubFastThinker().render(ctx, (t) => {
      emitted.push(t)
      return Promise.resolve()
    })
    expect(emitted).toEqual(['(the DM considers the scene…)'])
    expect(msg).toMatchObject({ role: 'assistant' })
    expect(typeof msg.content).toBe('string')
  })

  it('StubScribe is a no-op returning empty deltas', async () => {
    expect(await new StubScribe().extract(ctx)).toEqual({ workingSetDeltas: [] })
  })
})
