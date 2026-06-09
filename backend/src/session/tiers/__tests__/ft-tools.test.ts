// backend/src/session/tiers/__tests__/ft-tools.test.ts
//
// MYT-68 Task 11 — the FT tool registry. Tools are PURE RESOLVERS: `execute`
// returns data only and NEVER emits frames (§3.2/§3.3). These tests verify the
// two launch tools' input schemas, their resolver outputs, and that the SDK's
// ToolExecutionOptions abortSignal threads down into roll_skill_check's nested
// Haiku call.
//
// Mock target is the `'ai'` SDK boundary, NOT the ai.ts wrapper or the
// first-party skill-check.ts resolver: the wrapper's generateObject calls the
// SDK's generateText with Output.object and reads back `result.output`. This
// mirrors the proven scaffold in src/session/__tests__/skill-check.test.ts —
// wrapper-direct / first-party mocks don't intercept under this vitest+ESM
// config, and skill-check.ts is first-party so we exercise it for real.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import type { ToolExecutionOptions, ToolSet } from 'ai'
import { buildFtTools, ROLL_DICE_INPUT, ROLL_SKILL_CHECK_INPUT } from '../ft-tools.js'
import { STANDARD_DICE } from '../../dice/engine.js'
import { FALLBACK_OUTCOMES } from '../../ft-config.js'
import type { MechanicalReads, SkillCheckDeps } from '../../skill-check.js'
import type { Rng } from '../../dice/engine.js'
import type { Character } from '../../../repo/types.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

const HAIKU_USAGE = { inputTokens: 400, outputTokens: 50, totalTokens: 450 }
const DC_TABLE = { dc: 13, outcomes: { fail: 'F', success: 'S', great_success: 'G' } }

function mockDcTableOnce(table = DC_TABLE): void {
  mockGenerateText.mockResolvedValueOnce({
    output: table,
    finishReason: 'stop',
    usage: HAIKU_USAGE,
  } as never)
}

/** A scripted RNG yielding queued values in order (crypto.randomInt signature). */
function scriptedRng(...values: number[]): Rng {
  const queue = [...values]
  return () => {
    const next = queue.shift()
    if (next === undefined) throw new Error('scriptedRng: exhausted')
    return next
  }
}

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

/** SkillCheckDeps minus abortSignal — buildFtTools threads the SDK signal in. */
function makeDeps(mech: MechanicalReads): Omit<SkillCheckDeps, 'abortSignal'> {
  return { mech, sessionId: 'session-1', worldTone: 'grim and rain-soaked' }
}

/** Minimal SDK ToolExecutionOptions for invoking execute() the way the loop does. */
function callOpts(overrides: Partial<ToolExecutionOptions> = {}): ToolExecutionOptions {
  return { toolCallId: 'c1', messages: [], ...overrides }
}

/** Guarded execute accessor: ToolSet indexes as `Tool | undefined` and
 *  `execute` is optional on the Tool type. Guard-and-throw once here instead
 *  of non-null asserting at every call site (`no-non-null-assertion` is
 *  error-level repo-wide with no test override). The widened
 *  `(unknown, opts) => unknown` signature also keeps the SDK's any-generic
 *  execute type from leaking `any` into test assignments. */
function requireExecute(
  tools: ToolSet,
  name: string,
): (input: unknown, opts: ToolExecutionOptions) => unknown {
  const exec = tools[name]?.execute
  if (exec === undefined) throw new Error(`${name}.execute missing`)
  return exec
}

describe('ROLL_DICE_INPUT', () => {
  it('rejects count below 1, above MAX, and non-integer', () => {
    expect(ROLL_DICE_INPUT.safeParse({ count: 0, sides: 6 }).success).toBe(false)
    expect(ROLL_DICE_INPUT.safeParse({ count: 101, sides: 6 }).success).toBe(false)
    expect(ROLL_DICE_INPUT.safeParse({ count: 2.5, sides: 6 }).success).toBe(false)
  })

  it('rejects a non-standard die', () => {
    expect(ROLL_DICE_INPUT.safeParse({ count: 1, sides: 7 }).success).toBe(false)
  })

  it('accepts a normal roll and every standard die', () => {
    expect(ROLL_DICE_INPUT.safeParse({ count: 3, sides: 6 }).success).toBe(true)
    for (const sides of STANDARD_DICE) {
      expect(ROLL_DICE_INPUT.safeParse({ count: 1, sides }).success).toBe(true)
    }
  })
})

describe('ROLL_SKILL_CHECK_INPUT', () => {
  it('rejects empty strings', () => {
    expect(
      ROLL_SKILL_CHECK_INPUT.safeParse({ character_name: '', skill: 'Stealth', context: 'x' })
        .success,
    ).toBe(false)
    expect(
      ROLL_SKILL_CHECK_INPUT.safeParse({ character_name: 'Vire', skill: '', context: 'x' }).success,
    ).toBe(false)
    expect(
      ROLL_SKILL_CHECK_INPUT.safeParse({ character_name: 'Vire', skill: 'Stealth', context: '' })
        .success,
    ).toBe(false)
  })

  it('accepts with and without advantage/disadvantage', () => {
    expect(
      ROLL_SKILL_CHECK_INPUT.safeParse({ character_name: 'Vire', skill: 'Stealth', context: 'x' })
        .success,
    ).toBe(true)
    expect(
      ROLL_SKILL_CHECK_INPUT.safeParse({
        character_name: 'Vire',
        skill: 'Stealth',
        context: 'x',
        advantage: true,
        disadvantage: false,
      }).success,
    ).toBe(true)
  })
})

describe('roll_dice tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('execute returns {count, sides, results, total} from the injected RNG', async () => {
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), [])), scriptedRng(3, 5, 1))
    const exec = requireExecute(tools, 'roll_dice')
    const result = await exec({ count: 3, sides: 6 }, callOpts())
    expect(result).toEqual({ count: 3, sides: 6, results: [3, 5, 1], total: 9 })
  })

  it('is a pure resolver — the tool object exposes only SDK fields, no emit surface', () => {
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), [])))
    const rollDiceTool = tools.roll_dice
    if (rollDiceTool === undefined) throw new Error('roll_dice missing')
    // The tool surface is SDK-shaped: description + inputSchema + execute. There
    // is no emit/publish/frame method a resolver could use to race the consumer.
    for (const k of Object.keys(rollDiceTool)) {
      expect(['description', 'inputSchema', 'execute', 'type']).toContain(k)
    }
    expect(typeof rollDiceTool.execute).toBe('function')
  })
})

describe('roll_skill_check tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ok resolution → snake_case output with all 11 fields', async () => {
    mockDcTableOnce()
    const character = makeCharacter() // dex 16 → +3
    const mech = foundMech(character, [
      { skill_name: 'Stealth', proficiency_level: 'proficient' }, // +2
    ])
    const tools = buildFtTools(makeDeps(mech), scriptedRng(12))
    const exec = requireExecute(tools, 'roll_skill_check')

    const result = await exec(
      { character_name: 'Vire', skill: 'Stealth', context: 'sneaking past the guard' },
      callOpts(),
    )

    expect(result).toEqual({
      character_name: 'Vire',
      skill: 'Stealth',
      outcome_tier: 'success',
      constraint: 'S',
      roll: 12,
      roll2: null,
      roll_type: 'normal',
      modifier: 5, // +3 dex + 2 prof
      total: 17,
      dc: 13,
      context: 'sneaking past the guard',
    })
  })

  it('not_found roster → {error} constraint, no roll narrated', async () => {
    const mech: MechanicalReads = {
      findSessionParticipantCharacterByName: vi
        .fn()
        .mockResolvedValue({ outcome: 'not_found' }),
    }
    const tools = buildFtTools(makeDeps(mech))
    const exec = requireExecute(tools, 'roll_skill_check')

    const result = (await exec(
      { character_name: 'Ghost', skill: 'Stealth', context: 'sneaking' },
      callOpts(),
    )) as { error: string }

    expect(result.error).toContain('Ghost')
    expect(mockGenerateText).not.toHaveBeenCalled()
  })

  it('Haiku DC-table failure → fallback constraint, roll still matched', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('haiku 529 overloaded'))
    const character = makeCharacter() // dex 16 → +3
    const mech = foundMech(character, [
      { skill_name: 'Stealth', proficiency_level: 'proficient' }, // +2
    ])
    // FALLBACK_DC 11; roll 20 + modifier 5 = 25 ≥ 11+5 → great_success.
    const tools = buildFtTools(makeDeps(mech), scriptedRng(20))
    const exec = requireExecute(tools, 'roll_skill_check')

    const result = (await exec(
      { character_name: 'Vire', skill: 'Stealth', context: 'sneaking' },
      callOpts(),
    )) as { outcome_tier: string; constraint: string; total: number }

    expect(result.outcome_tier).toBe('great_success')
    expect(result.constraint).toBe(FALLBACK_OUTCOMES.great_success)
    expect(result.total).toBe(25)
  })

  it('forwards advantage + disadvantage flags through the conditional spreads', async () => {
    mockDcTableOnce()
    const character = makeCharacter()
    const mech = foundMech(character, [
      { skill_name: 'Stealth', proficiency_level: 'proficient' },
    ])
    // advantage + disadvantage cancel → normal roll, one value consumed.
    const tools = buildFtTools(makeDeps(mech), scriptedRng(15))
    const exec = requireExecute(tools, 'roll_skill_check')

    const result = (await exec(
      {
        character_name: 'Vire',
        skill: 'Stealth',
        context: 'creeping',
        advantage: true,
        disadvantage: true,
      },
      callOpts(),
    )) as { roll_type: string; roll: number; roll2: number | null }

    // Both flags reached the resolver (cancelled to a normal roll).
    expect(result.roll_type).toBe('normal')
    expect(result.roll).toBe(15)
    expect(result.roll2).toBeNull()
  })

  it("threads the SDK's abortSignal into the nested Haiku call", async () => {
    mockDcTableOnce()
    const character = makeCharacter()
    const mech = foundMech(character, [
      { skill_name: 'Stealth', proficiency_level: 'proficient' },
    ])
    const controller = new AbortController()
    const tools = buildFtTools(makeDeps(mech), scriptedRng(10))
    const exec = requireExecute(tools, 'roll_skill_check')

    await exec(
      { character_name: 'Vire', skill: 'Stealth', context: 'sneaking' },
      callOpts({ abortSignal: controller.signal }),
    )

    const sdkOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as { abortSignal: AbortSignal }
    // The wrapper merges external + internal timeout via AbortSignal.any; the
    // combined signal is not yet aborted...
    expect(sdkOpts.abortSignal).toBeInstanceOf(AbortSignal)
    expect(sdkOpts.abortSignal.aborted).toBe(false)
    // ...and aborting the SDK-provided controller aborts the combined signal.
    controller.abort()
    expect(sdkOpts.abortSignal.aborted).toBe(true)
  })
})
