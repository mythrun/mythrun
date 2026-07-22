// Split from the original monolithic turn-worker.test.ts along its thematic
// describe/it seams. Shared pure-mock builders live in ./_helpers/turn-worker-
// harness.ts + ./_helpers/turn-worker-deps.ts. No DB / scoped fixtures here (this
// suite is pure in-memory mocks), so the CONVENTIONS.md isolation pattern is N/A.
import { describe, expect, it, vi } from 'vitest'
import type { SessionStateBlob } from '../../redis/session-state.js'
import type { TurnEmitter } from '../tiers/types.js'
import { type TurnWorkerRepo, makeLatchedEmitter, reloadFtContext, resolveWorldId } from '../turn-worker.js'
import { CAMPAIGN, SESSION, fakeRepo, silentLogger } from './_helpers/turn-worker-harness.js'

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn(),
  // The §5 latch-terminal arm throws `UnrecoverableError`; the processor + tests
  // both reference it, so the mock exports a real throwable subclass (not a bare
  // vi.fn) so `instanceof` checks hold. This suite never constructs a Worker/Queue.
  UnrecoverableError: class UnrecoverableError extends Error {},
}))

describe('makeLatchedEmitter', () => {
  it('marks the latch BEFORE the first inner emit, and only once', async () => {
    const order: string[] = []
    const inner: TurnEmitter = {
      emitText: (): Promise<void> => {
        order.push('inner.emitText')
        return Promise.resolve()
      },
      emitSkillCheck: (): Promise<void> => {
        order.push('inner.emitSkillCheck')
        return Promise.resolve()
      },
      emitDiceRoll: (): Promise<void> => {
        order.push('inner.emitDiceRoll')
        return Promise.resolve()
      },
      emitLedgerUpdate: (): Promise<void> => {
        order.push('inner.emitLedgerUpdate')
        return Promise.resolve()
      },
      emitModeChange: (): Promise<void> => Promise.resolve(),
      emitCombatStarted: (): Promise<void> => Promise.resolve(),
      emitCombatResolved: (): Promise<void> => Promise.resolve(),
      emitCorrection: (): Promise<void> => Promise.resolve(),
    }
    const mark = vi.fn((): Promise<void> => {
      order.push('mark')
      return Promise.resolve()
    })

    const latched = makeLatchedEmitter(inner, mark)
    await latched.emitText('a')
    await latched.emitText('b')
    await latched.emitDiceRoll({ count: 1, sides: 6, results: [3], total: 3 })

    // The FIRST emit marks BEFORE publishing; subsequent emits don't re-mark.
    expect(order).toEqual(['mark', 'inner.emitText', 'inner.emitText', 'inner.emitDiceRoll'])
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('marks before the first inner emit when the first frame is a ledger_update', async () => {
    const order: string[] = []
    const inner: TurnEmitter = {
      emitText: (): Promise<void> => Promise.resolve(),
      emitSkillCheck: (): Promise<void> => Promise.resolve(),
      emitDiceRoll: (): Promise<void> => Promise.resolve(),
      emitLedgerUpdate: (): Promise<void> => {
        order.push('inner.emitLedgerUpdate')
        return Promise.resolve()
      },
      emitModeChange: (): Promise<void> => Promise.resolve(),
      emitCombatStarted: (): Promise<void> => Promise.resolve(),
      emitCombatResolved: (): Promise<void> => Promise.resolve(),
      emitCorrection: (): Promise<void> => Promise.resolve(),
    }
    const mark = vi.fn((): Promise<void> => {
      order.push('mark')
      return Promise.resolve()
    })

    const latched = makeLatchedEmitter(inner, mark)
    await latched.emitLedgerUpdate({
      characterName: 'Mara',
      kind: 'gold',
      summary: 'Mara spends 5gp.',
      gold: 42,
    })

    expect(order).toEqual(['mark', 'inner.emitLedgerUpdate'])
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('marks before the first inner emit when the first frame is a skill_check', async () => {
    const order: string[] = []
    const inner: TurnEmitter = {
      emitText: (): Promise<void> => Promise.resolve(),
      emitSkillCheck: (): Promise<void> => {
        order.push('inner.emitSkillCheck')
        return Promise.resolve()
      },
      emitDiceRoll: (): Promise<void> => Promise.resolve(),
      emitLedgerUpdate: (): Promise<void> => Promise.resolve(),
      emitModeChange: (): Promise<void> => Promise.resolve(),
      emitCombatStarted: (): Promise<void> => Promise.resolve(),
      emitCombatResolved: (): Promise<void> => Promise.resolve(),
      emitCorrection: (): Promise<void> => Promise.resolve(),
    }
    const mark = vi.fn((): Promise<void> => {
      order.push('mark')
      return Promise.resolve()
    })

    const latched = makeLatchedEmitter(inner, mark)
    await latched.emitSkillCheck({
      characterName: 'Mara',
      skill: 'Stealth',
      context: 'sneaking',
      roll: 12,
      roll2: null,
      rollType: 'normal',
      modifier: 3,
      total: 15,
      dc: 12,
      outcomeTier: 'success',
      constraint: 'She slips past.',
    })

    expect(order).toEqual(['mark', 'inner.emitSkillCheck'])
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('marks before — and passes through — the combat/mode frame kinds (MYT-75)', async () => {
    // The §combat frame arrows: emitModeChange / emitCombatStarted /
    // emitCombatResolved each await the latch BEFORE the inner publish, then pass
    // their payloads straight through.
    const order: string[] = []
    const seen: { mode?: unknown; started?: unknown; resolved?: unknown } = {}
    const inner: TurnEmitter = {
      emitText: (): Promise<void> => Promise.resolve(),
      emitSkillCheck: (): Promise<void> => Promise.resolve(),
      emitDiceRoll: (): Promise<void> => Promise.resolve(),
      emitLedgerUpdate: (): Promise<void> => Promise.resolve(),
      emitModeChange: (p): Promise<void> => {
        order.push('inner.emitModeChange')
        seen.mode = p
        return Promise.resolve()
      },
      emitCombatStarted: (p): Promise<void> => {
        order.push('inner.emitCombatStarted')
        seen.started = p
        return Promise.resolve()
      },
      emitCombatResolved: (p): Promise<void> => {
        order.push('inner.emitCombatResolved')
        seen.resolved = p
        return Promise.resolve()
      },
      emitCorrection: (): Promise<void> => Promise.resolve(),
    }
    const mark = vi.fn((): Promise<void> => {
      order.push('mark')
      return Promise.resolve()
    })

    const latched = makeLatchedEmitter(inner, mark)
    await latched.emitModeChange({ from: 'exploration', to: 'combat', reason: 'enemies attack' })
    await latched.emitCombatStarted({
      enemies: [{ name: 'Goblin', description: 'a scrawny goblin', count: 1 }],
      initiative: [{ combatant: 'Mara', roll: 14 }],
    })
    await latched.emitCombatResolved({
      narration: 'It is over.',
      outcome: 'victory',
      casualties: [],
      hpChanges: [],
    })

    // The FIRST emit marks; the rest don't re-mark; all three passed through in order.
    expect(order).toEqual([
      'mark',
      'inner.emitModeChange',
      'inner.emitCombatStarted',
      'inner.emitCombatResolved',
    ])
    expect(mark).toHaveBeenCalledTimes(1)
    expect(seen.mode).toEqual({ from: 'exploration', to: 'combat', reason: 'enemies attack' })
    expect((seen.resolved as { outcome: string }).outcome).toBe('victory')
  })

  it('marks before — and passes through — a dm_correction frame (myth-d6knq)', async () => {
    const order: string[] = []
    let seen: unknown
    const inner: TurnEmitter = {
      emitText: (): Promise<void> => Promise.resolve(),
      emitSkillCheck: (): Promise<void> => Promise.resolve(),
      emitDiceRoll: (): Promise<void> => Promise.resolve(),
      emitLedgerUpdate: (): Promise<void> => Promise.resolve(),
      emitModeChange: (): Promise<void> => Promise.resolve(),
      emitCombatStarted: (): Promise<void> => Promise.resolve(),
      emitCombatResolved: (): Promise<void> => Promise.resolve(),
      emitCorrection: (p): Promise<void> => {
        order.push('inner.emitCorrection')
        seen = p
        return Promise.resolve()
      },
    }
    const mark = vi.fn((): Promise<void> => {
      order.push('mark')
      return Promise.resolve()
    })

    const latched = makeLatchedEmitter(inner, mark)
    await latched.emitCorrection({ text: 'Earlier I named the ferryman Coss; it is Trask.' })

    expect(order).toEqual(['mark', 'inner.emitCorrection'])
    expect(mark).toHaveBeenCalledTimes(1)
    expect(seen).toEqual({ text: 'Earlier I named the ferryman Coss; it is Trask.' })
  })
})

describe('reloadFtContext', () => {
  it('reads the session row → prep ftContext when the prep exists', async () => {
    const repo = fakeRepo({ session: { sessionNumber: 2 }, ftContext: 'PREP DOC FROM PG' })
    const result = await reloadFtContext(repo, CAMPAIGN, SESSION, silentLogger)
    expect(result).toBe('PREP DOC FROM PG')
  })

  it('returns "" + warns when the prep row is absent', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    const repo = fakeRepo({ session: { sessionNumber: 2 }, ftContext: null })
    const result = await reloadFtContext(repo, CAMPAIGN, SESSION, logger)
    expect(result).toBe('')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('returns "" + warns when the session row is absent', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    const repo = fakeRepo({ session: null })
    const result = await reloadFtContext(repo, CAMPAIGN, SESSION, logger)
    expect(result).toBe('')
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('resolveWorldId', () => {
  /** A fake SessionState narrowed to getState/setState, backed by a mutable cell
   *  so a back-fill is observable. `getStateSpy`/`setStateSpy` record the calls. */
  function fakeWorldIdState(initial: SessionStateBlob | null) {
    const cell: { blob: SessionStateBlob | null } = { blob: initial }
    const getStateSpy = vi.fn((): Promise<SessionStateBlob | null> => Promise.resolve(cell.blob))
    const setStateSpy = vi.fn((_c: string, s: SessionStateBlob): Promise<void> => {
      cell.blob = s
      return Promise.resolve()
    })
    return {
      sessionState: { getState: getStateSpy, setState: setStateSpy },
      cell,
      getStateSpy,
      setStateSpy,
    }
  }

  function fakeCampaigns(worldId: string | null) {
    return {
      campaigns: { getWorldId: vi.fn((): Promise<string | null> => Promise.resolve(worldId)) },
    }
  }

  it('returns the cached worldId from the blob without reading PG or re-writing the blob', async () => {
    const { sessionState, getStateSpy, setStateSpy } = fakeWorldIdState({
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
      worldId: 'w-cached',
    })
    const repo = fakeCampaigns('w-pg')

    const result = await resolveWorldId({ sessionState, repo }, CAMPAIGN, SESSION)

    expect(result).toBe('w-cached')
    expect(getStateSpy).toHaveBeenCalledTimes(1)
    // A cache hit never touches PG and never re-writes the blob.
    expect(repo.campaigns.getWorldId).not.toHaveBeenCalled()
    expect(setStateSpy).not.toHaveBeenCalled()
  })

  it('on a cache miss reads getWorldId once and back-fills the blob with the merged worldId', async () => {
    const { sessionState, cell, setStateSpy } = fakeWorldIdState({
      participants: ['u1', 'u2'],
      mode: 'exploration',
      status: 'active',
      ftContext: 'PREP',
    })
    const repo = fakeCampaigns('w-resolved')

    const result = await resolveWorldId({ sessionState, repo }, CAMPAIGN, SESSION)

    expect(result).toBe('w-resolved')
    expect(repo.campaigns.getWorldId).toHaveBeenCalledTimes(1)
    expect(repo.campaigns.getWorldId).toHaveBeenCalledWith(CAMPAIGN)
    // The blob was re-written ONCE, merging the resolved worldId onto the prior fields.
    expect(setStateSpy).toHaveBeenCalledTimes(1)
    expect(cell.blob).toEqual({
      participants: ['u1', 'u2'],
      mode: 'exploration',
      status: 'active',
      ftContext: 'PREP',
      worldId: 'w-resolved',
    })
  })

  it('on a null state blob reads getWorldId, returns the value, and does NOT cache', async () => {
    // A null blob means the session is not fully initialized (an edge) — resolve
    // the worldId for this turn but skip the back-fill (nothing to merge onto).
    const { sessionState, setStateSpy } = fakeWorldIdState(null)
    const repo = fakeCampaigns('w-edge')

    const result = await resolveWorldId({ sessionState, repo }, CAMPAIGN, SESSION)

    expect(result).toBe('w-edge')
    expect(repo.campaigns.getWorldId).toHaveBeenCalledTimes(1)
    // No blob to merge onto → no setState.
    expect(setStateSpy).not.toHaveBeenCalled()
  })

  it('returns "" (not null) when the campaign has no world_id, so the lookup deps stay typed', async () => {
    const { sessionState } = fakeWorldIdState({
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
    })
    const repo = fakeCampaigns(null)

    const result = await resolveWorldId({ sessionState, repo }, CAMPAIGN, SESSION)

    // getWorldId → null coalesces to '' (worldId is always a string for the tools).
    expect(result).toBe('')
  })
})

describe('TurnWorkerRepo FT-side boundary', () => {
  it('a sessionPreps.getBy returning only { ftContext } satisfies TurnWorkerRepo (no sdPlaybook leak)', () => {
    // A compile-time assertion: this object is typed as TurnWorkerRepo. If the
    // FT-side surface had been widened to require sdPlaybook, this would fail to
    // type-check (getBy returns no sdPlaybook). The runtime expectation is a
    // formality — the binding is the real test.
    const ftSideRepo: TurnWorkerRepo = fakeRepo({ ftContext: 'PREP DOC' })
    expect(ftSideRepo.sessionPreps).toBeDefined()
  })
})
