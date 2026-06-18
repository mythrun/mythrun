// backend/src/session/combat/__tests__/outcome.test.ts
//
// MYT-75 §4 — the combat resolver (a whole fight as one big skill check;
// Principle #5 / Principle #4 / §4 fail-soft). Mock target is the `'ai'` SDK
// boundary, NOT the ai.ts wrapper: the wrapper's generateObject calls the SDK's
// generateText with Output.object and reads back `result.output`. Mirrors the
// proven scaffold in skill-check.test.ts — wrapper-direct mocks don't intercept
// under this vitest+ESM config.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import {
  partyCapability,
  selectTier,
  resolveCombat,
  type CombatEnemy,
  type PartyMember,
  type ResolveCombatDeps,
} from '../outcome.js'
import type { Rng } from '../../dice/engine.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

const HAIKU_USAGE = { inputTokens: 400, outputTokens: 80, totalTokens: 480 }

const OUTCOME_TABLE = {
  dc: 15,
  outcomes: {
    routed: 'The party is overwhelmed and driven from the field, but survives.',
    pyrrhic: 'The party wins, but a comrade is downed and bleeding in the dirt.',
    costly: 'The party wins the fight, bloodied and low on resources.',
    decisive: 'The party wins cleanly, the enemy broken before them.',
  },
}

/** A scripted RNG that yields the queued values in order. crypto.randomInt
 *  signature `(min, maxExclusive)` — the dice engine calls rng(1, 21). */
function scriptedRng(...values: number[]): Rng {
  const queue = [...values]
  return () => {
    const next = queue.shift()
    if (next === undefined) throw new Error('scriptedRng: exhausted')
    return next
  }
}

function makeDeps(overrides: Partial<ResolveCombatDeps> = {}): ResolveCombatDeps {
  return { worldTone: 'grim and rain-soaked', ...overrides }
}

const ENEMIES: readonly CombatEnemy[] = [
  { name: 'Goblin', description: 'scrawny raider', count: 4 },
]

function mockTableOnce(table = OUTCOME_TABLE): void {
  mockGenerateText.mockResolvedValueOnce({
    output: table,
    finishReason: 'stop',
    usage: HAIKU_USAGE,
  } as never)
}

describe('partyCapability', () => {
  it('is bounded 0..12 and applies a wounded malus', () => {
    expect(partyCapability([{ level: 5, hp: 40, maxHp: 40 }])).toBe(5)
    expect(
      partyCapability([
        { level: 20, hp: 1, maxHp: 200 },
        { level: 20, hp: 1, maxHp: 200 },
      ]),
    ).toBeLessThanOrEqual(12)
    expect(partyCapability([{ level: 5, hp: 10, maxHp: 100 }])).toBeLessThan(5) // wounded malus
  })

  it('empty party → 0', () => {
    expect(partyCapability([])).toBe(0)
  })

  it('size bonus: +1 at 3-4 members, +2 at 5+', () => {
    const lvl3 = (n: number): readonly PartyMember[] =>
      Array.from({ length: n }, () => ({ level: 3, hp: 30, maxHp: 30 }))
    expect(partyCapability(lvl3(2))).toBe(3) // avg 3, no size bonus
    expect(partyCapability(lvl3(3))).toBe(4) // +1
    expect(partyCapability(lvl3(5))).toBe(5) // +2
  })

  it('floors at 0 (wounded malus cannot push it negative)', () => {
    expect(partyCapability([{ level: 1, hp: 1, maxHp: 100 }])).toBe(0) // 1 - 2 → clamped to 0
  })
})

describe('selectTier', () => {
  it('maps total vs dc to the 4 tiers', () => {
    expect(selectTier(25, 15)).toBe('decisive') // >= dc+7
    expect(selectTier(15, 15)).toBe('costly') // [dc, dc+7)
    expect(selectTier(10, 15)).toBe('pyrrhic') // [dc-7, dc)
    expect(selectTier(5, 15)).toBe('routed') // < dc-7
  })

  it('boundaries: dc+7 is decisive, dc is costly, dc-7 is pyrrhic', () => {
    expect(selectTier(22, 15)).toBe('decisive') // exactly dc+7
    expect(selectTier(21, 15)).toBe('costly') // one below dc+7
    expect(selectTier(8, 15)).toBe('pyrrhic') // exactly dc-7
    expect(selectTier(7, 15)).toBe('routed') // one below dc-7
  })
})

describe('resolveCombat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns a CombatOutcome whose tier matches selectTier(capability+roll, dc) and whose envelope matches', async () => {
    mockTableOnce() // dc 15
    const party: readonly PartyMember[] = [{ level: 5, hp: 40, maxHp: 40 }] // capability 5
    // roll 14 + capability 5 = 19 ≥ dc(15) but < dc+7(22) → costly.
    const deps = makeDeps({ rng: scriptedRng(14) })

    const outcome = await resolveCombat(deps, ENEMIES, party)

    expect(outcome.tier).toBe('costly')
    expect(outcome.tier).toBe(selectTier(19, 15))
    expect(outcome.dc).toBe(15)
    expect(outcome.roll).toBe(14)
    expect(outcome.total).toBe(19)
    expect(outcome.tierProse).toBe(OUTCOME_TABLE.outcomes.costly)
    expect(outcome.envelope).toEqual({
      partyWins: true,
      minDownedPcs: 0,
      minAggregateHpLossFraction: 0.30,
      allowPcDeathNarration: false,
    })
  })

  it('decisive: high roll + capability ≥ dc+7 → clean-win envelope', async () => {
    mockTableOnce() // dc 15
    const party: readonly PartyMember[] = [{ level: 5, hp: 40, maxHp: 40 }] // capability 5
    // roll 18 + 5 = 23 ≥ dc+7(22) → decisive.
    const outcome = await resolveCombat(makeDeps({ rng: scriptedRng(18) }), ENEMIES, party)

    expect(outcome.tier).toBe('decisive')
    expect(outcome.total).toBe(23)
    expect(outcome.tierProse).toBe(OUTCOME_TABLE.outcomes.decisive)
    expect(outcome.envelope.partyWins).toBe(true)
    expect(outcome.envelope.allowPcDeathNarration).toBe(false)
  })

  it('routed: low roll + capability < dc-7 → loss envelope (PC death narration allowed)', async () => {
    mockTableOnce() // dc 15
    const party: readonly PartyMember[] = [{ level: 3, hp: 30, maxHp: 30 }] // capability 3
    // roll 4 + 3 = 7 < dc-7(8) → routed.
    const outcome = await resolveCombat(makeDeps({ rng: scriptedRng(4) }), ENEMIES, party)

    expect(outcome.tier).toBe('routed')
    expect(outcome.total).toBe(7)
    expect(outcome.tierProse).toBe(OUTCOME_TABLE.outcomes.routed)
    expect(outcome.envelope.partyWins).toBe(false)
    expect(outcome.envelope.allowPcDeathNarration).toBe(true)
  })

  it('pyrrhic: roll within 7 below dc → downed-PC envelope', async () => {
    mockTableOnce() // dc 15
    const party: readonly PartyMember[] = [{ level: 5, hp: 40, maxHp: 40 }] // capability 5
    // roll 6 + 5 = 11; dc-7(8) ≤ 11 < dc(15) → pyrrhic.
    const outcome = await resolveCombat(makeDeps({ rng: scriptedRng(6) }), ENEMIES, party)

    expect(outcome.tier).toBe('pyrrhic')
    expect(outcome.total).toBe(11)
    expect(outcome.envelope.partyWins).toBe(true)
    expect(outcome.envelope.minDownedPcs).toBe(1)
  })

  it('§4 fail-soft: Haiku failure → fallback DC 15, roll still matched (Principle #5 holds)', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('haiku 529 overloaded'))
    const party: readonly PartyMember[] = [{ level: 5, hp: 40, maxHp: 40 }] // capability 5
    // FALLBACK_COMBAT_DC is 15. roll 18 + 5 = 23 ≥ 15+7 → decisive.
    const outcome = await resolveCombat(makeDeps({ rng: scriptedRng(18) }), ENEMIES, party)

    expect(outcome.dc).toBe(15)
    expect(outcome.tier).toBe('decisive')
    expect(outcome.total).toBe(23)
    // Fallback prose is the generic-but-distinct decisive string.
    expect(outcome.tierProse).toContain('cleanly')
  })

  it('fail-soft logs via the injected logger', async () => {
    const warn = vi.fn<(o: unknown, m: string) => void>()
    mockGenerateText.mockRejectedValueOnce(new Error('haiku down'))
    await resolveCombat(
      makeDeps({ rng: scriptedRng(10), logger: { warn } }),
      ENEMIES,
      [{ level: 3, hp: 30, maxHp: 30 }],
    )
    expect(warn).toHaveBeenCalledWith(
      { err: new Error('haiku down') },
      'combat-outcome: DC table failed; using fallback',
    )
  })

  it('threads the prompt vars (public party projection + world tone) and the abort signal to the SDK', async () => {
    mockTableOnce()
    const controller = new AbortController()
    const deps = makeDeps({
      rng: scriptedRng(10),
      abortSignal: controller.signal,
    })

    await resolveCombat(deps, ENEMIES, [{ level: 7, hp: 50, maxHp: 60 }])

    const callOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as {
      prompt: string
      abortSignal: AbortSignal
    }
    // Prompt-var contract: the enemy roster, public party projection, and world
    // tone flowed in. Public projection is ONLY level + HP (no secret fields).
    expect(callOpts.prompt).toContain('Goblin')
    expect(callOpts.prompt).toContain('Level 7')
    expect(callOpts.prompt).toContain('50/60 HP')
    expect(callOpts.prompt).toContain('grim and rain-soaked')
    // Combined abort signal: not yet aborted; aborting the external controller
    // aborts the combined signal.
    expect(callOpts.abortSignal).toBeInstanceOf(AbortSignal)
    expect(callOpts.abortSignal.aborted).toBe(false)
    controller.abort()
    expect(callOpts.abortSignal.aborted).toBe(true)
  })

  it('empty enemies / empty party thread the no-* placeholders into the prompt', async () => {
    mockTableOnce()
    await resolveCombat(makeDeps({ rng: scriptedRng(10) }), [], [])
    const prompt = (mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }).prompt
    expect(prompt).toContain('no enemies')
    expect(prompt).toContain('no party members')
  })
})
