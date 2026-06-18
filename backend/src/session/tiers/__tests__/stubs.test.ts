// MYT-66 Task 4 — tier stub tests.
//
// Pure in-memory exercise of the remaining placeholder tier implementation. No
// DB, no Redis, no Anthropic — the stub is deterministic, so the suite just
// asserts the seam contract: the FT emits exactly one canned delta and returns a
// canned assistant line. (The on-path ST + Scribe seams were retired in
// MYT-69/MYT-73, so only the FT stub remains.) The `ctx` is the minimal
// public-by-construction `FtTurnContext` the tier reads.

import { describe, expect, it, vi } from 'vitest'
import type { FtTurnContext, TurnEmitter } from '../types.js'
import { StubFastThinker } from '../stubs.js'

const ctx: FtTurnContext = {
  campaignId: 'c',
  ftContext: '',
  ftHistory: [],
  participants: [],
  usage: { input: 0, output: 0 },
  workingSet: [],
}

describe('tier stubs', () => {
  it('StubFastThinker emits one delta and returns a canned line', async () => {
    const emitted: string[] = []
    const emit: TurnEmitter = {
      emitText: (t) => {
        emitted.push(t)
        return Promise.resolve()
      },
      emitSkillCheck: vi.fn(() => Promise.resolve()),
      emitDiceRoll: vi.fn(() => Promise.resolve()),
      emitLedgerUpdate: vi.fn(() => Promise.resolve()),
      emitModeChange: vi.fn(() => Promise.resolve()),
      emitCombatStarted: vi.fn(() => Promise.resolve()),
      emitCombatResolved: vi.fn(() => Promise.resolve()),
    }
    const msg = await new StubFastThinker().render(ctx, emit)
    expect(emitted).toEqual(['(the DM considers the scene…)'])
    expect(msg).toMatchObject({ role: 'assistant' })
    expect(msg.parts).toEqual([{ kind: 'text', text: '(the DM responds.)' }])
  })
})
