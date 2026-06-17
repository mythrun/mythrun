// MYT-69 Task 10 — `processStEvalJob` failure-isolation + formatExchanges arms.
//
// Split from the main pipeline suite (st-evaluation-worker.test.ts) so each file
// stays under the 400-line cap; both share the `makeHarness` fixtures in
// st-evaluation-worker-harness.ts. These cases pin the guarded-write catch arms
// (each individual slot write / usage incr / re-arm-check failure is isolated —
// the world keeps turning, a warn fires, nothing throws out), the formatExchanges
// rendering of each role/part shape, and the zero-usage accounting arm.

import type { SessionMessage } from '../../repo/types.js'
import { describe, expect, it } from 'vitest'
import { processStEvalJob } from '../st-evaluation-worker.js'
import {
  CAMPAIGN,
  defaultDirectorResult,
  emptyUsage,
  job,
  makeHarness,
  SESSION,
} from './st-evaluation-worker-harness.js'

describe('processStEvalJob — formatExchanges rendering (§ step 3 input)', () => {
  it('non-empty history renders each role/part shape into the gate recentExchanges', async () => {
    // userId 'u1' is in the harness's participant-characters map → 'Mara'; a null
    // userId misses the map → the codec's 'Player' fallback. A dm_text → DM: text;
    // a dice_roll → a tool_call+tool_result pair → '[tool_call] [tool_result]'.
    const mkRow = (
      p: Partial<SessionMessage> & { seq: number; messageType: string; content: string },
    ): SessionMessage => ({
      id: `m-${String(p.seq)}`,
      sessionId: SESSION,
      userId: p.userId ?? null,
      turnId: p.turnId ?? null,
      turnOrdinal: p.turnOrdinal ?? null,
      triggerKind: p.triggerKind ?? null,
      createdAt: new Date(0),
      ...p,
    })
    const rows: readonly SessionMessage[] = [
      mkRow({ seq: 1, userId: 'u1', messageType: 'player_message', content: 'I search' }),
      mkRow({ seq: 2, userId: null, messageType: 'player_message', content: 'so do I' }),
      mkRow({ seq: 3, turnId: 't1', turnOrdinal: 0, messageType: 'dm_text', content: 'You find a door.' }),
      mkRow({
        seq: 4,
        turnId: 't1',
        turnOrdinal: 1,
        messageType: 'dice_roll',
        content: JSON.stringify({ toolCallId: 'tc1', input: { sides: 20 }, output: { total: 14 } }),
      }),
    ]
    const { deps, rec } = makeHarness({ rows })
    await processStEvalJob(deps, job)

    expect(rec.gateInputs).toHaveLength(1)
    expect(rec.gateInputs[0]?.recentExchanges).toBe(
      ['Mara: I search', 'Player: so do I', 'DM: You find a door. [tool_call] [tool_result]'].join('\n'),
    )
  })
})

describe('processStEvalJob — guarded-write failure isolation (§ steps 5-6)', () => {
  it('one-shot write throws → warn, but standing + summary + usage still written (each guard isolated)', async () => {
    const { deps, rec } = makeHarness({ throwOneShotWrite: true })
    await expect(processStEvalJob(deps, job)).resolves.toBeUndefined()
    expect(rec.setOneShot).toHaveLength(0)
    // Subsequent guarded writes still ran — the failure was isolated.
    expect(rec.setStanding).toEqual(['S'])
    expect(rec.setSummary).toEqual(['updated running summary'])
    expect(rec.incrUsage).toEqual([110])
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN }),
      'st-eval: one-shot write failed',
    )
  })

  it('standing write throws → warn, but the summary + usage writes still run', async () => {
    const { deps, rec } = makeHarness({ throwStandingWrite: true })
    await expect(processStEvalJob(deps, job)).resolves.toBeUndefined()
    expect(rec.setStanding).toHaveLength(0)
    // The one-shot (before) and summary (after) still landed.
    expect(rec.setOneShot).toEqual(['D'])
    expect(rec.setSummary).toEqual(['updated running summary'])
    expect(rec.incrUsage).toEqual([110])
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN }),
      'st-eval: standing write failed',
    )
  })

  it('summary write throws → warn, but the one-shot + standing writes + usage still ran', async () => {
    const { deps, rec } = makeHarness({ throwSummaryWrite: true })
    await expect(processStEvalJob(deps, job)).resolves.toBeUndefined()
    expect(rec.setSummary).toHaveLength(0)
    expect(rec.setOneShot).toEqual(['D'])
    expect(rec.setStanding).toEqual(['S'])
    expect(rec.incrUsage).toEqual([110])
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN }),
      'st-eval: summary write failed',
    )
  })

  it('incrUsageSt throws → warn, no throw out (the channel writes still landed)', async () => {
    const { deps, rec } = makeHarness({ throwIncrUsage: true })
    await expect(processStEvalJob(deps, job)).resolves.toBeUndefined()
    expect(rec.incrUsage).toHaveLength(0)
    // The guarded usage failure didn't roll back the direction writes.
    expect(rec.setOneShot).toEqual(['D'])
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN }),
      'st-eval: usage:st incr failed',
    )
  })

  it('re-arm-check read throws → warn, no throw out', async () => {
    // The watermark would have advanced (start 5 → end 8), so the re-arm branch
    // is reached — but the respondedSeq read itself throws and is swallowed.
    const { deps, rec } = makeHarness({ startWatermark: 5, endWatermark: 8, throwReArmCheck: true })
    await expect(processStEvalJob(deps, job)).resolves.toBeUndefined()
    expect(rec.reArmCalls).toHaveLength(0)
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN }),
      'st-eval: re-arm check failed',
    )
  })

  it('usage with neither totalTokens nor input/output → both ?? 0 arms → 0 tokens, no INCRBY', async () => {
    const { deps, rec } = makeHarness({
      gate: { result: { needed: true, confidence: 0.5, reason: 'fire' }, usage: emptyUsage() },
      director: { result: defaultDirectorResult(), usage: emptyUsage(), repairAttempted: false },
    })
    await processStEvalJob(deps, job)
    // gate (0) + director (0) → usageToWrite is 0, so incrUsageSt is never called.
    expect(rec.incrUsage).toHaveLength(0)
    // The director still ran and its outputs were written (usage being 0 is orthogonal).
    expect(rec.setSummary).toEqual(['updated running summary'])
  })
})
