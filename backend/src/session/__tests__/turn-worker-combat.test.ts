// Split from the original monolithic turn-worker.test.ts along its thematic
// describe/it seams. Shared pure-mock builders live in ./_helpers/turn-worker-
// harness.ts + ./_helpers/turn-worker-deps.ts. No DB / scoped fixtures here (this
// suite is pure in-memory mocks), so the CONVENTIONS.md isolation pattern is N/A.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { type SessionState, makeSessionState } from '../../redis/session-state.js'
import type { CombatEvent } from '../combat/events.js'
import type { ReconciledCombat } from '../combat/apply.js'
import { StubFastThinker } from '../tiers/stubs.js'
import type { PartyLedgerSnapshot } from '../tiers/types.js'
import { type TriggerState, makeTriggerState } from '../trigger-state.js'
import { type TurnProcessorDeps, processTurnJob } from '../turn-worker.js'
import { CAMPAIGN, KEY_PREFIX, TURN, fakeHandle, newCalls, payload } from './_helpers/turn-worker-harness.js'
import { type CombatLedgerRow, GOBLIN_ENEMIES, combatDeps, combatOutcome, inertCombatLedger, makeCombatLedger } from './_helpers/turn-worker-deps.js'

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn(),
  // The §5 latch-terminal arm throws `UnrecoverableError`; the processor + tests
  // both reference it, so the mock exports a real throwable subclass (not a bare
  // vi.fn) so `instanceof` checks hold. This suite never constructs a Worker/Queue.
  UnrecoverableError: class UnrecoverableError extends Error {},
}))

describe('processTurnJob — combat application', () => {
  let redis: Redis
  let sessionState: SessionState
  let triggerState: TriggerState

  beforeEach(async () => {
    redis = new IoRedisMock()
    await redis.flushall()
    sessionState = makeSessionState(redis, KEY_PREFIX)
    triggerState = makeTriggerState(redis, KEY_PREFIX)
  })
  afterEach(async () => {
    await redis.quit()
    vi.clearAllMocks()
  })

  it('applies combat: reconciled ledger deltas, resolved CombatState, mode flip, combat_resolved', async () => {
    // A turn whose makeTiers records an `initiate` + a `resolve` event. The
    // post-flush block must: apply the FT's reconciled PC damage through the
    // ledger (hpChanges flow into the summary), write the resolved CombatState
    // blob, durably flip mode→combat, and emit combat_resolved.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    // Seed the :state blob so the durable mode flip has something to flip.
    await sessionState.setState(CAMPAIGN, {
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
    })

    // A real in-memory ledger: Mara at 11/14 HP. applyToLedger → resolveAdjustHp
    // writes through it, so the returned hpChanges are real.
    const rows = new Map<string, CombatLedgerRow>([['ch1', { name: 'Mara', hp: 11, maxHp: 14 }]])
    const ledger = makeCombatLedger(rows)

    const reconciled: ReconciledCombat = {
      outcomeKind: 'victory',
      // hpBefore 11, amount 4 → applyToLedger SETS Mara to 11 − 4 = 7 (authoritative).
      pcDamage: [{ characterId: 'ch1', name: 'Mara', amount: 4, hpBefore: 11 }],
      pcCasualties: [],
      enemyCasualties: [{ name: 'Goblin', fate: 'dead' }],
      conditions: [],
    }
    const combatEvents: CombatEvent[] = [
      {
        kind: 'initiate',
        outcome: combatOutcome('costly'),
        enemies: GOBLIN_ENEMIES,
        environment: 'a damp cave mouth',
        surprise: 'none',
        initiative: [{ combatant: 'Mara', roll: 14 }],
      },
      { kind: 'resolve', reconciled, narration: 'Mara stands over the fallen goblin.' },
    ]

    const deps = combatDeps({
      calls,
      handle,
      ledger,
      makeTiers: () => ({ ft: new StubFastThinker(), combatEvents }),
      sessionState,
      triggerState,
    })

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })

    // The resolved CombatState blob was written with the summary.
    const combat = await sessionState.getCombatState(CAMPAIGN)
    expect(combat?.status).toBe('resolved')
    expect(combat?.enemies).toEqual(GOBLIN_ENEMIES)
    expect(combat?.environment).toBe('a damp cave mouth')
    expect(combat?.result?.summary.outcome).toBe('victory')
    // hpChanges flowed from the real ledger write into the summary (11 → 7).
    expect(combat?.result?.summary.hpChanges).toContainEqual({
      combatant: 'Mara',
      hpBefore: 11,
      hpAfter: 7,
      maxHp: 14,
    })
    // The ledger actually moved (the apply path ran, not just the summary).
    expect(rows.get('ch1')?.hp).toBe(7)

    // The durable mode flip landed on the :state blob.
    const state = await sessionState.getState(CAMPAIGN)
    expect(state?.mode).toBe('combat')

    // combat_resolved was emitted (the latched emitter routes it to the publisher).
    expect(calls.order).toContain('combat_resolved')
  })

  it('force-resolves a cap-hit: initiate WITHOUT resolve fills the envelope floors and applies', async () => {
    // The recovery path: the FT initiated combat but its tool loop hit the cap
    // before resolving. With no `resolve` event, the worker reconciles EMPTY FT
    // deltas against the envelope — pyrrhic's floors (minDownedPcs:1 +
    // minAggregateHpLossFraction:0.30) still down a PC and apply HP loss.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    await sessionState.setState(CAMPAIGN, {
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
    })

    // One PC at full HP; pyrrhic forces it down (minDownedPcs:1).
    const rows = new Map<string, CombatLedgerRow>([['ch1', { name: 'Mara', hp: 14, maxHp: 14 }]])
    const ledger = makeCombatLedger(rows)
    // The force-resolve path reconciles EMPTY FT deltas against the per-turn party
    // snapshot — so the worker must read a roster matching the ledger to know whom
    // to down (the snapshot is the fresh-run arm's `readPartyLedgerSnapshot`).
    const partyLedger: PartyLedgerSnapshot = [
      {
        characterId: 'ch1',
        name: 'Mara',
        hitPoints: 14,
        maxHitPoints: 14,
        hitDie: 8,
        hitDiceRemaining: 2,
        level: 3,
        gold: 0,
        slots: [],
        conditions: [],
        trackedFeatures: [],
        spells: [],
        equipment: [],
      },
    ]

    const combatEvents: CombatEvent[] = [
      {
        kind: 'initiate',
        outcome: combatOutcome('pyrrhic'),
        enemies: GOBLIN_ENEMIES,
        environment: 'a damp cave mouth',
        surprise: 'none',
        initiative: [{ combatant: 'Mara', roll: 9 }],
      },
      // No resolve event — the cap-hit case.
    ]

    const deps = combatDeps({
      calls,
      handle,
      ledger,
      partyLedger,
      makeTiers: () => ({ ft: new StubFastThinker(), combatEvents }),
      sessionState,
      triggerState,
    })

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })

    const combat = await sessionState.getCombatState(CAMPAIGN)
    expect(combat?.status).toBe('resolved')
    // The narration fell back to the deterministic tier prose (no FT close-out).
    expect(combat?.result?.summary.outcomeDescription).toBe(combatOutcome('pyrrhic').tierProse)
    // The envelope's minDownedPcs:1 floor downed Mara → 0 HP in the ledger.
    expect(rows.get('ch1')?.hp).toBe(0)
    // The summary lists the downed PC as a casualty.
    expect(combat?.result?.summary.casualties).toContainEqual({
      name: 'Mara',
      type: 'pc',
      fate: 'unconscious',
    })

    const state = await sessionState.getState(CAMPAIGN)
    expect(state?.mode).toBe('combat')
    expect(calls.order).toContain('combat_resolved')
  })

  it('no combat events → none of the combat writes happen', async () => {
    // The exploration-only turn: makeTiers records no combat events, so the
    // post-flush block early-returns — no CombatState blob, no mode flip, no
    // combat_resolved emit.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    await sessionState.setState(CAMPAIGN, {
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
    })

    const deps = combatDeps({
      calls,
      handle,
      // The inert ledger throws on any call — proving the apply path never ran.
      ledger: inertCombatLedger(),
      makeTiers: () => ({ ft: new StubFastThinker(), combatEvents: [] }),
      sessionState,
      triggerState,
    })

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    // No combat blob was written.
    expect(await sessionState.getCombatState(CAMPAIGN)).toBeNull()
    // The :state blob stayed in exploration (no durable flip).
    const state = await sessionState.getState(CAMPAIGN)
    expect(state?.mode).toBe('exploration')
    // No combat_resolved frame.
    expect(calls.order).not.toContain('combat_resolved')
  })

  it('a combat-apply failure is logged but does NOT crash the turn (own try/catch)', async () => {
    // The turn already persisted before applyCombat runs, so a throw there must
    // NOT re-run the turn via BullMQ attempts. Force a throw by making the blob
    // write reject; the catch arm logs and the turn still completes (turn_end).
    const calls = newCalls()
    const errorLogger = { warn: vi.fn(), error: vi.fn() }
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    await sessionState.setState(CAMPAIGN, {
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
    })

    const rows = new Map<string, CombatLedgerRow>([['ch1', { name: 'Mara', hp: 11, maxHp: 14 }]])
    const ledger = makeCombatLedger(rows)
    const combatEvents: CombatEvent[] = [
      {
        kind: 'initiate',
        outcome: combatOutcome('costly'),
        enemies: GOBLIN_ENEMIES,
        environment: 'a damp cave mouth',
        surprise: 'none',
        initiative: [{ combatant: 'Mara', roll: 14 }],
      },
      {
        kind: 'resolve',
        reconciled: {
          outcomeKind: 'victory',
          pcDamage: [],
          pcCasualties: [],
          enemyCasualties: [],
          conditions: [],
        },
        narration: 'It is over.',
      },
    ]

    // Make the durable CombatState write reject — applyCombat throws past the
    // ledger apply, into the worker's combat try/catch.
    const setCombatSpy = vi
      .spyOn(sessionState, 'setCombatState')
      .mockRejectedValue(new Error('redis write failed'))

    const deps: TurnProcessorDeps = {
      ...combatDeps({
        calls,
        handle,
        ledger,
        makeTiers: () => ({ ft: new StubFastThinker(), combatEvents }),
        sessionState,
        triggerState,
      }),
      logger: errorLogger,
    }

    const result = await processTurnJob(deps, payload())

    // The turn still completed (not rethrown) and reached turn_end.
    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    // The failure was logged at error.
    expect(errorLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, turnId: TURN }),
      'failed to apply post-turn combat',
    )

    setCombatSpy.mockRestore()
  })
})
