// backend/src/session/__tests__/skill-check.test.ts
//
// MYT-68 Task 10 — the roll_skill_check resolver (Principle #5 / Principle #4
// / fail-soft TOTAL). Mock target is the `'ai'` SDK boundary, NOT the ai.ts
// wrapper: the wrapper's generateObject calls the SDK's generateText with
// Output.object and reads back `result.output`. Mirrors the proven scaffold in
// dm-trigger-classifier.test.ts — wrapper-direct mocks don't intercept under
// this vitest+ESM config.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import {
  resolveSkillCheck,
  type MechanicalReads,
  type SkillCheckDeps,
} from '../skill-check.js'
import { FALLBACK_DC, FALLBACK_OUTCOMES } from '../ft-config.js'
import type { Rng } from '../dice/engine.js'
import type { Character } from '../../repo/types.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

const HAIKU_USAGE = { inputTokens: 400, outputTokens: 50, totalTokens: 450 }

const DC_TABLE = {
  dc: 13,
  outcomes: { fail: 'F', success: 'S', great_success: 'G' },
}

/** A complete Character row. Override per test. */
function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char-1',
    userId: 'user-1',
    entityId: null,
    name: 'Vire',
    level: 3,
    class: 'Rogue',
    species: 'Human',
    background: 'Criminal',
    str: 10,
    dex: 16,
    con: 12,
    int: 13,
    wis: 11,
    cha: 14,
    hitPoints: 20,
    maxHitPoints: 20,
    armorClass: 14,
    proficiencyBonus: 2,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
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

/** A `found` mech stub returning the given character + skills. */
function foundMech(
  character: Character,
  skills: readonly { skill_name: string; proficiency_level: string }[],
): MechanicalReads {
  return {
    findSessionParticipantCharacterByName: vi
      .fn()
      .mockResolvedValue({ outcome: 'found', character, skills }),
  }
}

function makeDeps(
  overrides: Partial<SkillCheckDeps> & { mech: MechanicalReads },
): SkillCheckDeps {
  return {
    sessionId: 'session-1',
    worldTone: 'grim and rain-soaked',
    ...overrides,
  }
}

function mockDcTableOnce(table = DC_TABLE): void {
  mockGenerateText.mockResolvedValueOnce({
    output: table,
    finishReason: 'stop',
    usage: HAIKU_USAGE,
  } as never)
}

describe('resolveSkillCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('happy path: dex-16 + proficient Stealth, roll 12 → success (total 17 ≥ 13)', async () => {
    mockDcTableOnce()
    const character = makeCharacter() // dex 16 → +3
    const mech = foundMech(character, [
      { skill_name: 'Stealth', proficiency_level: 'proficient' }, // PB 2 → +2
    ])
    const deps = makeDeps({ mech, rng: scriptedRng(12) })

    const result = await resolveSkillCheck(deps, {
      character_name: 'Vire',
      skill: 'Stealth',
      context: 'sneaking past the guard',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.payload).toEqual({
      characterName: 'Vire',
      skill: 'Stealth',
      context: 'sneaking past the guard',
      roll: 12,
      roll2: null,
      rollType: 'normal',
      modifier: 5, // +3 dex + 2 prof
      total: 17,
      dc: 13,
      outcomeTier: 'success',
      constraint: 'S',
    })
  })

  it('expertise doubles the proficiency bonus (PB 2 → +4)', async () => {
    mockDcTableOnce()
    const character = makeCharacter() // dex 16 → +3, PB 2
    const mech = foundMech(character, [
      { skill_name: 'Stealth', proficiency_level: 'expertise' },
    ])
    const deps = makeDeps({ mech, rng: scriptedRng(10) })

    const result = await resolveSkillCheck(deps, {
      character_name: 'Vire',
      skill: 'Stealth',
      context: 'vanishing into the crowd',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.payload.modifier).toBe(7) // +3 dex + (2×2) expertise
    expect(result.payload.total).toBe(17) // 10 + 7
  })

  it('absent skill row → no proficiency bonus (+0)', async () => {
    mockDcTableOnce()
    const character = makeCharacter() // dex 16 → +3
    const mech = foundMech(character, [
      { skill_name: 'Perception', proficiency_level: 'proficient' }, // unrelated
    ])
    const deps = makeDeps({ mech, rng: scriptedRng(10) })

    const result = await resolveSkillCheck(deps, {
      character_name: 'Vire',
      skill: 'Stealth',
      context: 'hiding',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.payload.modifier).toBe(3) // +3 dex, no prof
  })

  it('normalizes both sides of the skill join and emits the canonical skill name', async () => {
    mockDcTableOnce()
    const character = makeCharacter() // dex 16 → +3
    const mech = foundMech(character, [
      { skill_name: 'Sleight Of Hand ', proficiency_level: 'proficient' }, // weird casing + trailing space
    ])
    const deps = makeDeps({ mech, rng: scriptedRng(8) })

    const result = await resolveSkillCheck(deps, {
      character_name: 'Vire',
      skill: 'sleight of hand', // lowercase input
      context: 'palming the key',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.payload.skill).toBe('Sleight of Hand') // canonical
    expect(result.payload.modifier).toBe(5) // dex +3, prof +2 (matched despite casing)
  })

  it('advantage + disadvantage cancel → normal roll, roll2 null, one value consumed', async () => {
    mockDcTableOnce()
    const character = makeCharacter()
    const mech = foundMech(character, [
      { skill_name: 'Stealth', proficiency_level: 'proficient' },
    ])
    // Only ONE scripted value: a normal roll consumes exactly one. A second
    // consumption would throw "scriptedRng: exhausted".
    const deps = makeDeps({ mech, rng: scriptedRng(15) })

    const result = await resolveSkillCheck(deps, {
      character_name: 'Vire',
      skill: 'Stealth',
      context: 'creeping',
      advantage: true,
      disadvantage: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.payload.rollType).toBe('normal')
    expect(result.payload.roll).toBe(15)
    expect(result.payload.roll2).toBeNull()
  })

  it('unknown skill → ok:false naming the skill; neither the LLM nor mech is touched', async () => {
    const findSpy = vi
      .fn<MechanicalReads['findSessionParticipantCharacterByName']>()
      .mockResolvedValue({ outcome: 'found', character: makeCharacter(), skills: [] })
    const mech: MechanicalReads = { findSessionParticipantCharacterByName: findSpy }
    const deps = makeDeps({ mech })

    const result = await resolveSkillCheck(deps, {
      character_name: 'Vire',
      skill: 'Basket Weaving',
      context: 'weaving a basket',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected not ok')
    expect(result.errorConstraint).toContain('Basket Weaving')
    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(findSpy).not.toHaveBeenCalled()
  })

  it('not_found roster outcome → ok:false naming the character', async () => {
    const mech: MechanicalReads = {
      findSessionParticipantCharacterByName: vi
        .fn()
        .mockResolvedValue({ outcome: 'not_found' }),
    }
    const deps = makeDeps({ mech })

    const result = await resolveSkillCheck(deps, {
      character_name: 'Ghost',
      skill: 'Stealth',
      context: 'sneaking',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected not ok')
    expect(result.errorConstraint).toContain('Ghost')
    expect(mockGenerateText).not.toHaveBeenCalled()
  })

  it('ambiguous roster outcome → ok:false naming the character', async () => {
    const mech: MechanicalReads = {
      findSessionParticipantCharacterByName: vi
        .fn()
        .mockResolvedValue({ outcome: 'ambiguous' }),
    }
    const deps = makeDeps({ mech })

    const result = await resolveSkillCheck(deps, {
      character_name: 'Twin',
      skill: 'Stealth',
      context: 'sneaking',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected not ok')
    expect(result.errorConstraint).toContain('Twin')
  })

  it('Haiku DC-table failure → fallback table, roll still matched (Principle #5 holds)', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('haiku 529 overloaded'))
    const character = makeCharacter() // dex 16 → +3
    const mech = foundMech(character, [
      { skill_name: 'Stealth', proficiency_level: 'proficient' }, // +2
    ])
    // FALLBACK_DC is 11. roll 20 + modifier 5 = 25 ≥ 11+5 → great_success.
    const deps = makeDeps({ mech, rng: scriptedRng(20) })

    const result = await resolveSkillCheck(deps, {
      character_name: 'Vire',
      skill: 'Stealth',
      context: 'sneaking',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.payload.dc).toBe(FALLBACK_DC)
    expect(result.payload.outcomeTier).toBe('great_success')
    expect(result.payload.constraint).toBe(FALLBACK_OUTCOMES.great_success)
    expect(result.payload.total).toBe(25)
  })

  it('never throws: unknown skill, roster failure, and Haiku failure all RESOLVE', async () => {
    const knownMech = foundMech(makeCharacter(), [])

    // Unknown skill.
    await expect(
      resolveSkillCheck(makeDeps({ mech: knownMech }), {
        character_name: 'Vire',
        skill: 'Underwater Basketry',
        context: 'x',
      }),
    ).resolves.toMatchObject({ ok: false })

    // Roster not_found.
    const notFoundMech: MechanicalReads = {
      findSessionParticipantCharacterByName: vi
        .fn()
        .mockResolvedValue({ outcome: 'not_found' }),
    }
    await expect(
      resolveSkillCheck(makeDeps({ mech: notFoundMech }), {
        character_name: 'Nobody',
        skill: 'Stealth',
        context: 'x',
      }),
    ).resolves.toMatchObject({ ok: false })

    // Haiku failure.
    mockGenerateText.mockRejectedValueOnce(new Error('haiku down'))
    await expect(
      resolveSkillCheck(makeDeps({ mech: foundMech(makeCharacter(), []), rng: scriptedRng(10) }), {
        character_name: 'Vire',
        skill: 'Stealth',
        context: 'x',
      }),
    ).resolves.toMatchObject({ ok: true })
  })

  it('fail tier: roll below the DC → outcomeTier "fail" + the fail constraint', async () => {
    mockDcTableOnce() // dc 13
    const character = makeCharacter() // dex 16 → +3
    const mech = foundMech(character, []) // no proficiency → +3 total
    // roll 5 + modifier 3 = 8 < 13 → fail.
    const deps = makeDeps({ mech, rng: scriptedRng(5) })

    const result = await resolveSkillCheck(deps, {
      character_name: 'Vire',
      skill: 'Stealth',
      context: 'creeping',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.payload.outcomeTier).toBe('fail')
    expect(result.payload.constraint).toBe('F')
    expect(result.payload.total).toBe(8)
  })

  it('logs via the injected logger on unknown skill, roster failure, and Haiku fallback', async () => {
    const warn = vi.fn()
    const logger = { warn }

    // Unknown skill → line 82 warn.
    await resolveSkillCheck(makeDeps({ mech: foundMech(makeCharacter(), []), logger }), {
      character_name: 'Vire',
      skill: 'Underwater Basketry',
      context: 'x',
    })
    expect(warn).toHaveBeenCalledWith({ skill: 'Underwater Basketry' }, 'skill-check: unknown skill')

    // Roster not_found → line 90 warn.
    const notFoundMech: MechanicalReads = {
      findSessionParticipantCharacterByName: vi.fn().mockResolvedValue({ outcome: 'not_found' }),
    }
    await resolveSkillCheck(makeDeps({ mech: notFoundMech, logger }), {
      character_name: 'Nobody',
      skill: 'Stealth',
      context: 'x',
    })
    expect(warn).toHaveBeenCalledWith(
      { characterName: 'Nobody', outcome: 'not_found' },
      'skill-check: roller resolution failed',
    )

    // Haiku DC-table failure → line 172 warn (fallback).
    mockGenerateText.mockRejectedValueOnce(new Error('haiku down'))
    await resolveSkillCheck(
      makeDeps({ mech: foundMech(makeCharacter(), []), rng: scriptedRng(10), logger }),
      { character_name: 'Vire', skill: 'Stealth', context: 'x' },
    )
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ skill: 'Stealth' }),
      'skill-check: DC table failed; using fallback',
    )
  })

  it('threads the prompt vars (character summary + world tone) and the external abort signal to the SDK', async () => {
    mockDcTableOnce()
    const character = makeCharacter({ name: 'Vire', level: 3, class: 'Rogue' })
    const mech = foundMech(character, [
      { skill_name: 'Stealth', proficiency_level: 'proficient' },
    ])
    const controller = new AbortController()
    const deps = makeDeps({
      mech,
      rng: scriptedRng(10),
      abortSignal: controller.signal,
    })

    await resolveSkillCheck(deps, {
      character_name: 'Vire',
      skill: 'Stealth',
      context: 'sneaking past the guard',
    })

    const callOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as {
      prompt: string
      abortSignal: AbortSignal
      providerOptions?: unknown
    }
    expect(callOpts.providerOptions).toMatchObject({
      mythrun: { stage: 'skill_check_dc', sessionId: 'session-1' },
    })
    // Prompt-var contract: the character summary + world tone flowed in.
    expect(callOpts.prompt).toContain('Vire')
    expect(callOpts.prompt).toContain('Rogue')
    expect(callOpts.prompt).toContain('grim and rain-soaked')
    expect(callOpts.prompt).toContain('sneaking past the guard')
    // The SDK received a combined abort signal (wrapper merges external +
    // internal timeout via AbortSignal.any). It is NOT yet aborted...
    expect(callOpts.abortSignal).toBeInstanceOf(AbortSignal)
    expect(callOpts.abortSignal.aborted).toBe(false)
    // ...and aborting the external controller aborts the combined signal.
    controller.abort()
    expect(callOpts.abortSignal.aborted).toBe(true)
  })
})
