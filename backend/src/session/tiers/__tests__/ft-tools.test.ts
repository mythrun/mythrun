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
import { z } from 'zod'
import * as ai from 'ai'
import type { ToolExecutionOptions, ToolSet } from 'ai'
import {
  buildFtTools,
  ROLL_DICE_INPUT,
  ROLL_SKILL_CHECK_INPUT,
  CAST_SPELL_INPUT,
  SPEND_RESOURCE_INPUT,
  ACQUIRE_RESOURCE_INPUT,
  ADJUST_HP_INPUT,
  UPDATE_CONDITION_INPUT,
  TAKE_REST_INPUT,
  type FtToolDeps,
} from '../ft-tools.js'
import { STANDARD_DICE } from '../../dice/engine.js'
import { FALLBACK_OUTCOMES } from '../../ft-config.js'
import { MAX_GOLD_TRANSACTION } from '../../ft-config.js'
import type { MechanicalReads } from '../../skill-check.js'
import type { Rng } from '../../dice/engine.js'
import type { Character } from '../../../repo/types.js'
import type { LedgerOps, LedgerTxRunner } from '../../rules-lawyer.js'
import type {
  AdjustHpInput,
  TakeRestInput,
  UpdateConditionInput,
} from '../../rules-lawyer-vitals.ts'
import type {
  AcquireResourceInput,
  CastSpellInput,
  SpendResourceInput,
} from '../../rules-lawyer-resources.ts'

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

/** A fake LedgerOps whose methods throw unless a test overrides them — every
 *  Rules Lawyer registration test stubs only the methods its resolver path
 *  reaches. The registration task tests delegation + schema shape, NOT the
 *  guard predicates (those are T6/T8/T9's real-PG tests). */
function fakeLedger(overrides: Partial<LedgerOps> = {}): LedgerOps {
  const unimplemented =
    (name: string) =>
    (): never => {
      throw new Error(`fakeLedger.${name} not stubbed`)
    }
  return {
    findLedgerCharacterByName: unimplemented('findLedgerCharacterByName'),
    debitGold: unimplemented('debitGold'),
    creditGold: unimplemented('creditGold'),
    debitItem: unimplemented('debitItem'),
    acquireItem: unimplemented('acquireItem'),
    debitFeatureUse: unimplemented('debitFeatureUse'),
    debitSpellSlot: unimplemented('debitSpellSlot'),
    readSpellSlots: unimplemented('readSpellSlots'),
    readCharacterSpells: unimplemented('readCharacterSpells'),
    writeHp: unimplemented('writeHp'),
    applyCondition: unimplemented('applyCondition'),
    clearCondition: unimplemented('clearCondition'),
    shortRest: unimplemented('shortRest'),
    longRest: unimplemented('longRest'),
    readRestParticipants: unimplemented('readRestParticipants'),
    writeLedgerEvent: unimplemented('writeLedgerEvent'),
    findLedgerEvent: unimplemented('findLedgerEvent'),
    readPartyLedgerSnapshot: unimplemented('readPartyLedgerSnapshot'),
    ...overrides,
  }
}

/** A pass-through tx runner: the resolver's `runInTx` hands the same (faked)
 *  LedgerOps to the callback and returns its result. */
function passthroughTx(ledger: LedgerOps): LedgerTxRunner {
  return (fn) => fn(ledger)
}

/** SkillCheckDeps minus abortSignal — buildFtTools threads the SDK signal in.
 *  The Rules Lawyer ledger surface defaults to an all-throwing fake (tests that
 *  exercise a ledger tool pass their own stubbed ledger + tx). */
function makeDeps(
  mech: MechanicalReads,
  ledger: LedgerOps = fakeLedger(),
  runInTx: LedgerTxRunner = passthroughTx(ledger),
): FtToolDeps {
  return { mech, sessionId: 'session-1', worldTone: 'grim and rain-soaked', ledger, runInTx, turnId: 'turn-1' }
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

// ===========================================================================
// MYT-70 §5 — the six Rules Lawyer ledger tools
//
// These tests verify REGISTRATION + delegation + input-schema shape, NOT the
// guard predicates (T6/T8/T9's real-PG tests own those). The resolvers are
// exercised for real against a FAKE LedgerOps whose stubbed methods drive the
// resolver down the path under test.
// ===========================================================================

describe('CAST_SPELL_INPUT schema', () => {
  it('accepts a bare cast, an explicit slot, and a ritual flag', () => {
    expect(CAST_SPELL_INPUT.safeParse({ character_name: 'Vire', spell_name: 'Bless' }).success).toBe(
      true,
    )
    expect(
      CAST_SPELL_INPUT.safeParse({ character_name: 'Vire', spell_name: 'Bless', slot_level: 3 })
        .success,
    ).toBe(true)
    expect(
      CAST_SPELL_INPUT.safeParse({
        character_name: 'Vire',
        spell_name: 'Detect Magic',
        ritual: true,
      }).success,
    ).toBe(true)
  })

  it('rejects slot_level out of 1..9 and an empty name', () => {
    expect(
      CAST_SPELL_INPUT.safeParse({ character_name: 'Vire', spell_name: 'Bless', slot_level: 0 })
        .success,
    ).toBe(false)
    expect(
      CAST_SPELL_INPUT.safeParse({ character_name: 'Vire', spell_name: 'Bless', slot_level: 10 })
        .success,
    ).toBe(false)
    expect(CAST_SPELL_INPUT.safeParse({ character_name: '', spell_name: 'Bless' }).success).toBe(
      false,
    )
  })
})

describe('SPEND_RESOURCE_INPUT schema', () => {
  it('discriminates on kind: gold / item / feature', () => {
    expect(
      SPEND_RESOURCE_INPUT.safeParse({ kind: 'gold', character_name: 'Vire', amount: 50 }).success,
    ).toBe(true)
    expect(
      SPEND_RESOURCE_INPUT.safeParse({ kind: 'item', character_name: 'Vire', name: 'torch' })
        .success,
    ).toBe(true)
    expect(
      SPEND_RESOURCE_INPUT.safeParse({
        kind: 'item',
        character_name: 'Vire',
        name: 'arrow',
        amount: 3,
      }).success,
    ).toBe(true)
    expect(
      SPEND_RESOURCE_INPUT.safeParse({ kind: 'feature', character_name: 'Vire', name: 'Rage' })
        .success,
    ).toBe(true)
  })

  it('caps gold at MAX_GOLD_TRANSACTION and rejects an unknown kind', () => {
    expect(
      SPEND_RESOURCE_INPUT.safeParse({
        kind: 'gold',
        character_name: 'Vire',
        amount: MAX_GOLD_TRANSACTION + 1,
      }).success,
    ).toBe(false)
    expect(
      SPEND_RESOURCE_INPUT.safeParse({ kind: 'mana', character_name: 'Vire', amount: 1 }).success,
    ).toBe(false)
  })
})

describe('ACQUIRE_RESOURCE_INPUT schema', () => {
  it('discriminates gold / item (with consumable) and rejects feature', () => {
    expect(
      ACQUIRE_RESOURCE_INPUT.safeParse({ kind: 'gold', character_name: 'Vire', amount: 25 })
        .success,
    ).toBe(true)
    expect(
      ACQUIRE_RESOURCE_INPUT.safeParse({
        kind: 'item',
        character_name: 'Vire',
        name: 'potion',
        amount: 2,
        consumable: true,
      }).success,
    ).toBe(true)
    expect(
      ACQUIRE_RESOURCE_INPUT.safeParse({ kind: 'feature', character_name: 'Vire', name: 'Rage' })
        .success,
    ).toBe(false)
  })
})

// Regression (MYT-70 smoke): the Anthropic tool API requires every tool's
// `input_schema` to have a root `"type": "object"`. Zod 4's `toJSONSchema`
// emits a `z.discriminatedUnion` as a root `{oneOf: [...]}` with NO top-level
// `type`, which the API rejects ("tools.N.custom.input_schema.type: Field
// required") — caught only at a real LLM call, not by `safeParse` tests. Every
// FT tool input schema MUST therefore be a flat object (kind-as-enum, not a
// root union). This pins that invariant so a future re-introduction of a root
// discriminated union fails here instead of at runtime against Anthropic.
describe('every FT tool input schema serializes with root type:object (Anthropic requirement)', () => {
  it.each([
    ['ROLL_DICE_INPUT', ROLL_DICE_INPUT],
    ['ROLL_SKILL_CHECK_INPUT', ROLL_SKILL_CHECK_INPUT],
    ['CAST_SPELL_INPUT', CAST_SPELL_INPUT],
    ['SPEND_RESOURCE_INPUT', SPEND_RESOURCE_INPUT],
    ['ACQUIRE_RESOURCE_INPUT', ACQUIRE_RESOURCE_INPUT],
    ['ADJUST_HP_INPUT', ADJUST_HP_INPUT],
    ['UPDATE_CONDITION_INPUT', UPDATE_CONDITION_INPUT],
    ['TAKE_REST_INPUT', TAKE_REST_INPUT],
  ])('%s has root type:object', (_name, schema) => {
    const json = z.toJSONSchema(schema) as { type?: unknown }
    expect(json.type).toBe('object')
  })
})

describe('ADJUST_HP_INPUT schema', () => {
  it('accepts amount-only, dice-only (XOR enforced in the resolver)', () => {
    expect(
      ADJUST_HP_INPUT.safeParse({ character_name: 'Vire', kind: 'damage', amount: 7 }).success,
    ).toBe(true)
    expect(
      ADJUST_HP_INPUT.safeParse({ character_name: 'Vire', kind: 'heal', dice: '2d4+2' }).success,
    ).toBe(true)
  })

  it('rejects an unknown kind and a non-integer amount', () => {
    expect(
      ADJUST_HP_INPUT.safeParse({ character_name: 'Vire', kind: 'wound', amount: 1 }).success,
    ).toBe(false)
    expect(
      ADJUST_HP_INPUT.safeParse({ character_name: 'Vire', kind: 'damage', amount: 1.5 }).success,
    ).toBe(false)
  })
})

describe('UPDATE_CONDITION_INPUT schema', () => {
  it('accepts a 5e condition with apply/clear and an exhaustion level', () => {
    expect(
      UPDATE_CONDITION_INPUT.safeParse({
        character_name: 'Vire',
        condition: 'poisoned',
        action: 'apply',
      }).success,
    ).toBe(true)
    expect(
      UPDATE_CONDITION_INPUT.safeParse({
        character_name: 'Vire',
        condition: 'exhaustion',
        action: 'apply',
        level: 2,
      }).success,
    ).toBe(true)
  })

  it('rejects an off-list condition and a level above 6', () => {
    expect(
      UPDATE_CONDITION_INPUT.safeParse({
        character_name: 'Vire',
        condition: 'cursed',
        action: 'apply',
      }).success,
    ).toBe(false)
    expect(
      UPDATE_CONDITION_INPUT.safeParse({
        character_name: 'Vire',
        condition: 'exhaustion',
        action: 'apply',
        level: 7,
      }).success,
    ).toBe(false)
  })
})

describe('TAKE_REST_INPUT schema', () => {
  it('accepts short/long and an optional hit_dice array', () => {
    expect(TAKE_REST_INPUT.safeParse({ type: 'short' }).success).toBe(true)
    expect(
      TAKE_REST_INPUT.safeParse({
        type: 'short',
        hit_dice: [{ character_name: 'Vire', count: 2 }],
      }).success,
    ).toBe(true)
    expect(TAKE_REST_INPUT.safeParse({ type: 'long' }).success).toBe(true)
  })

  it('rejects an unknown rest type and a count out of 1..20', () => {
    expect(TAKE_REST_INPUT.safeParse({ type: 'nap' }).success).toBe(false)
    expect(
      TAKE_REST_INPUT.safeParse({
        type: 'short',
        hit_dice: [{ character_name: 'Vire', count: 21 }],
      }).success,
    ).toBe(false)
  })
})

// --- registration shape (parallel to roll_dice's pure-resolver assertion) ---

describe('Rules Lawyer tool registration', () => {
  it('registers all six tools with the load-bearing description sentences', () => {
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), [])))
    for (const name of [
      'cast_spell',
      'spend_resource',
      'acquire_resource',
      'adjust_hp',
      'update_condition',
      'take_rest',
    ]) {
      const t = tools[name]
      if (t === undefined) throw new Error(`${name} missing`)
      // PURE RESOLVER: SDK-shaped surface only, no emit/publish method.
      for (const k of Object.keys(t)) {
        expect(['description', 'inputSchema', 'execute', 'type']).toContain(k)
      }
      expect(typeof t.execute).toBe('function')
    }
    // Debit tools carry the authoritative-outcome invariant sentence.
    const invariant = 'authoritative outcome — narrate HOW it happens, never whether'
    for (const name of ['cast_spell', 'spend_resource', 'adjust_hp', 'take_rest']) {
      expect(tools[name]?.description).toContain(invariant)
    }
    // spend_resource carries the improvised-object scoping.
    expect(tools.spend_resource?.description).toContain('improvised')
    expect(tools.spend_resource?.description).toMatch(/rock|mug|plank/)
    // cast_spell notes the omitted-slot default.
    expect(tools.cast_spell?.description).toContain('lowest available')
    // adjust_hp mandates dice for variable amounts.
    expect(tools.adjust_hp?.description).toContain('dice')
    // take_rest notes party-wide semantics.
    expect(tools.take_rest?.description).toContain('party')
  })
})

// --- execute delegation + ok:false → { constraint } ---

const CHAR = { id: 'char-1', name: 'Vire' }
const foundChar = (con = 12): Awaited<ReturnType<LedgerOps['findLedgerCharacterByName']>> => ({
  outcome: 'found',
  projection: {
    character: makeCharacter({ con }),
    gold: 100,
    hitDie: 8,
    hitDiceRemaining: 3,
    spellcastingProgression: 'full',
    conMod: Math.floor((con - 10) / 2),
  },
})

describe('cast_spell execute', () => {
  beforeEach(() => vi.clearAllMocks())

  it('delegates with the mapped input, threads toolCallId, and surfaces the ok payload', async () => {
    const findLedgerEvent = vi.fn().mockResolvedValue(false)
    const writeLedgerEvent = vi.fn().mockResolvedValue('evt-1')
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      readCharacterSpells: vi
        .fn()
        .mockResolvedValue([{ name: 'Bless', level: 1, prepared: true, ritual: false }]),
      readSpellSlots: vi.fn().mockResolvedValue([{ slotLevel: 1, slotsMax: 3, slotsRemaining: 2 }]),
      debitSpellSlot: vi.fn().mockResolvedValue({ outcome: 'debited', slotsRemaining: 1 }),
      findLedgerEvent,
      writeLedgerEvent,
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger))
    const exec = requireExecute(tools, 'cast_spell')

    const result = (await exec(
      { character_name: 'Vire', spell_name: 'Bless' } satisfies CastSpellInput,
      callOpts({ toolCallId: 'tc-cast' }),
    )) as { ok: boolean; payload: { kind: string; slotLevel: number; slotsRemaining: number } }

    expect(result.ok).toBe(true)
    expect(result.payload.kind).toBe('spell_slot')
    expect(result.payload.slotsRemaining).toBe(1)
    // toolCallId threaded into the journal idempotency key.
    expect(findLedgerEvent).toHaveBeenCalledWith('turn-1', 'tc-cast', CHAR.id)
    expect(writeLedgerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'tc-cast', tool: 'cast_spell' }),
    )
  })

  it('threads an explicit slot_level + ritual through to the resolver (upcast/ritual arms)', async () => {
    const debitSpellSlot = vi.fn().mockResolvedValue({ outcome: 'debited', slotsRemaining: 0 })
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      readCharacterSpells: vi
        .fn()
        .mockResolvedValue([{ name: 'Bless', level: 1, prepared: true, ritual: true }]),
      readSpellSlots: vi.fn().mockResolvedValue([{ slotLevel: 2, slotsMax: 1, slotsRemaining: 1 }]),
      debitSpellSlot,
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger))
    const exec = requireExecute(tools, 'cast_spell')

    const result = (await exec(
      {
        character_name: 'Vire',
        spell_name: 'Bless',
        slot_level: 2,
        ritual: false,
      } satisfies CastSpellInput,
      callOpts(),
    )) as { ok: boolean }

    expect(result.ok).toBe(true)
  })

  it('ok:false (no castable slot) surfaces as { constraint } without throwing', async () => {
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      readCharacterSpells: vi
        .fn()
        .mockResolvedValue([{ name: 'Bless', level: 1, prepared: true, ritual: false }]),
      readSpellSlots: vi.fn().mockResolvedValue([{ slotLevel: 1, slotsMax: 3, slotsRemaining: 0 }]),
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger))
    const exec = requireExecute(tools, 'cast_spell')

    const result = (await exec(
      { character_name: 'Vire', spell_name: 'Bless' },
      callOpts(),
    )) as { ok: false; binding: boolean; found: boolean; constraint: string }

    expect(result.ok).toBe(false)
    expect(result.binding).toBe(true)
    expect(result.constraint).toContain('no remaining spell slot')
  })
})

describe('spend_resource execute', () => {
  it('gold debit delegates and surfaces the ok payload', async () => {
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      debitGold: vi.fn().mockResolvedValue({ outcome: 'debited', gold: 50 }),
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger))
    const exec = requireExecute(tools, 'spend_resource')

    const result = (await exec(
      { kind: 'gold', character_name: 'Vire', amount: 50 } satisfies SpendResourceInput,
      callOpts(),
    )) as { ok: boolean; payload: { kind: string; gold: number } }

    expect(result.ok).toBe(true)
    expect(result.payload.gold).toBe(50)
  })

  it('insufficient gold surfaces a binding { constraint } without throwing', async () => {
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      debitGold: vi.fn().mockResolvedValue({ outcome: 'insufficient', gold: 10 }),
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger))
    const exec = requireExecute(tools, 'spend_resource')

    const result = (await exec(
      { kind: 'gold', character_name: 'Vire', amount: 50 },
      callOpts(),
    )) as { ok: false; binding: boolean; constraint: string }

    expect(result.ok).toBe(false)
    expect(result.binding).toBe(true)
    expect(result.constraint).toContain('cannot spend')
  })

  it('item debit delegates with the mapped amount and surfaces the ok payload', async () => {
    const debitItem = vi.fn().mockResolvedValue({ outcome: 'debited', quantity: 1 })
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      debitItem,
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger))
    const exec = requireExecute(tools, 'spend_resource')

    const result = (await exec(
      { kind: 'item', character_name: 'Vire', name: 'potion', amount: 2 } satisfies SpendResourceInput,
      callOpts(),
    )) as { ok: boolean; payload: { kind: string; itemName: string; quantity: number } }

    expect(result.ok).toBe(true)
    expect(result.payload.kind).toBe('item')
    expect(result.payload.itemName).toBe('potion')
    expect(debitItem).toHaveBeenCalledWith(CHAR.id, 'potion', 2)
  })

  it('item debit without an explicit amount omits the field (resolver defaults)', async () => {
    const debitItem = vi.fn().mockResolvedValue({ outcome: 'debited', quantity: 0 })
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      debitItem,
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger))
    const exec = requireExecute(tools, 'spend_resource')

    const result = (await exec(
      { kind: 'item', character_name: 'Vire', name: 'torch' } satisfies SpendResourceInput,
      callOpts(),
    )) as { ok: boolean }

    expect(result.ok).toBe(true)
    // The resolver defaults the amount to 1 when the FT omits it.
    expect(debitItem).toHaveBeenCalledWith(CHAR.id, 'torch', 1)
  })

  it('feature use delegates (no amount) and surfaces the ok payload', async () => {
    const debitFeatureUse = vi.fn().mockResolvedValue({ outcome: 'untracked' })
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      debitFeatureUse,
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger))
    const exec = requireExecute(tools, 'spend_resource')

    const result = (await exec(
      { kind: 'feature', character_name: 'Vire', name: 'Second Wind' } satisfies SpendResourceInput,
      callOpts(),
    )) as { ok: boolean; payload: { kind: string; featureName: string } }

    expect(result.ok).toBe(true)
    expect(result.payload.kind).toBe('feature')
    expect(debitFeatureUse).toHaveBeenCalledWith(CHAR.id, 'Second Wind')
  })

  // Flat-schema defensive arms (MYT-70 smoke fix): the model-facing schema marks
  // name/amount optional, so `execute` defends per-kind. A malformed call (gold
  // without amount, item/feature without name) must not throw — it fail-softs to
  // a safe default (amount→1, name→'') and the TOTAL resolver handles it.
  it('gold spend WITHOUT amount defaults to 1 (no throw)', async () => {
    const debitGold = vi.fn().mockResolvedValue({ outcome: 'debited', gold: 9 })
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      debitGold,
    })
    const exec = requireExecute(buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger)), 'spend_resource')
    const result = (await exec({ kind: 'gold', character_name: 'Vire' }, callOpts())) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(debitGold).toHaveBeenCalledWith(CHAR.id, 1)
  })

  it('item spend clamps an over-cap amount to MAX_ITEM_TRANSACTION and defaults a missing name', async () => {
    const debitItem = vi.fn().mockResolvedValue({ outcome: 'absent' })
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      debitItem,
    })
    const exec = requireExecute(buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger)), 'spend_resource')
    // No name (→ ''), amount above the per-call item cap (→ clamped to 99).
    await exec({ kind: 'item', character_name: 'Vire', amount: 5000 }, callOpts())
    expect(debitItem).toHaveBeenCalledWith(CHAR.id, '', 99)
  })

  it('feature spend WITHOUT name defaults to empty (no throw)', async () => {
    const debitFeatureUse = vi.fn().mockResolvedValue({ outcome: 'untracked' })
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      debitFeatureUse,
    })
    const exec = requireExecute(buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger)), 'spend_resource')
    const result = (await exec({ kind: 'feature', character_name: 'Vire' }, callOpts())) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(debitFeatureUse).toHaveBeenCalledWith(CHAR.id, '')
  })
})

describe('acquire_resource execute', () => {
  it('item credit delegates with consumable + amount and surfaces the ok payload', async () => {
    const acquireItem = vi.fn().mockResolvedValue(2)
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      acquireItem,
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger))
    const exec = requireExecute(tools, 'acquire_resource')

    const result = (await exec(
      {
        kind: 'item',
        character_name: 'Vire',
        name: 'potion',
        amount: 2,
        consumable: true,
      } satisfies AcquireResourceInput,
      callOpts(),
    )) as { ok: boolean; payload: { itemName: string; quantity: number } }

    expect(result.ok).toBe(true)
    expect(result.payload.quantity).toBe(2)
    expect(acquireItem).toHaveBeenCalledWith(CHAR.id, 'potion', 2, true)
  })

  it('item credit without amount/consumable omits both (resolver defaults)', async () => {
    const acquireItem = vi.fn().mockResolvedValue(1)
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      acquireItem,
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger))
    const exec = requireExecute(tools, 'acquire_resource')

    const result = (await exec(
      { kind: 'item', character_name: 'Vire', name: 'rope' } satisfies AcquireResourceInput,
      callOpts(),
    )) as { ok: boolean }

    expect(result.ok).toBe(true)
    // Defaults: amount → 1, consumable → false.
    expect(acquireItem).toHaveBeenCalledWith(CHAR.id, 'rope', 1, false)
  })

  it('gold credit delegates and surfaces the ok payload', async () => {
    const creditGold = vi.fn().mockResolvedValue(120)
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      creditGold,
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger))
    const exec = requireExecute(tools, 'acquire_resource')

    const result = (await exec(
      { kind: 'gold', character_name: 'Vire', amount: 100 } satisfies AcquireResourceInput,
      callOpts(),
    )) as { ok: boolean; payload: { kind: string; gold: number } }

    expect(result.ok).toBe(true)
    expect(result.payload.kind).toBe('gold')
    expect(result.payload.gold).toBe(120)
    expect(creditGold).toHaveBeenCalledWith(CHAR.id, 100)
  })

  // Flat-schema defensive arms (MYT-70 smoke fix) — credit side.
  it('gold credit WITHOUT amount defaults to 1', async () => {
    const creditGold = vi.fn().mockResolvedValue(1)
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      creditGold,
    })
    const exec = requireExecute(buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger)), 'acquire_resource')
    await exec({ kind: 'gold', character_name: 'Vire' }, callOpts())
    expect(creditGold).toHaveBeenCalledWith(CHAR.id, 1)
  })

  it('item credit clamps an over-cap amount to MAX_ITEM_TRANSACTION and defaults a missing name', async () => {
    const acquireItem = vi.fn().mockResolvedValue(99)
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      acquireItem,
    })
    const exec = requireExecute(buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger)), 'acquire_resource')
    await exec({ kind: 'item', character_name: 'Vire', amount: 5000 }, callOpts())
    // name → '', amount → clamped to 99, consumable → resolver default (false).
    expect(acquireItem).toHaveBeenCalledWith(CHAR.id, '', 99, false)
  })
})

describe('adjust_hp execute', () => {
  it('a dice expression delegates (the resolver rolls) and surfaces the rolled faces', async () => {
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      readPartyLedgerSnapshot: vi
        .fn()
        .mockResolvedValue([
          { characterId: CHAR.id, name: 'Vire', hitPoints: 20, maxHitPoints: 20 } as never,
        ]),
      writeHp: vi.fn().mockResolvedValue({ hp: 13, maxHp: 20 }),
    })
    // rng scripted so 2d4 rolls [3,2]=5, +2 modifier = 7 damage.
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger), scriptedRng(3, 2))
    const exec = requireExecute(tools, 'adjust_hp')

    const result = (await exec(
      { character_name: 'Vire', kind: 'damage', dice: '2d4+2' } satisfies AdjustHpInput,
      callOpts(),
    )) as { ok: boolean; payload: { hp: number; diceRolled: number[] } }

    expect(result.ok).toBe(true)
    expect(result.payload.hp).toBe(13)
    expect(result.payload.diceRolled).toEqual([3, 2])
  })

  it('a fixed amount delegates without rolling dice (amount arm, no dice)', async () => {
    const writeHp = vi.fn().mockResolvedValue({ hp: 15, maxHp: 20 })
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      readPartyLedgerSnapshot: vi
        .fn()
        .mockResolvedValue([
          { characterId: CHAR.id, name: 'Vire', hitPoints: 10, maxHitPoints: 20 } as never,
        ]),
      writeHp,
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger))
    const exec = requireExecute(tools, 'adjust_hp')

    const result = (await exec(
      { character_name: 'Vire', kind: 'heal', amount: 5 } satisfies AdjustHpInput,
      callOpts(),
    )) as { ok: boolean; payload: { hp: number; diceRolled?: number[] } }

    expect(result.ok).toBe(true)
    expect(result.payload.hp).toBe(15)
    // A fixed amount rolled no dice → the optional diceRolled field is omitted.
    expect(result.payload.diceRolled).toBeUndefined()
  })
})

describe('update_condition execute', () => {
  it('delegates an apply and surfaces the changed payload', async () => {
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      applyCondition: vi.fn().mockResolvedValue({ outcome: 'changed' }),
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger))
    const exec = requireExecute(tools, 'update_condition')

    const result = (await exec(
      { character_name: 'Vire', condition: 'poisoned', action: 'apply' } satisfies UpdateConditionInput,
      callOpts(),
    )) as { ok: boolean; payload: { changed: boolean; condition: string } }

    expect(result.ok).toBe(true)
    expect(result.payload.changed).toBe(true)
    expect(result.payload.condition).toBe('poisoned')
  })

  it('threads an exhaustion level through to the resolver (level arm)', async () => {
    const applyCondition = vi.fn().mockResolvedValue({ outcome: 'changed' })
    const ledger = fakeLedger({
      findLedgerCharacterByName: vi.fn().mockResolvedValue(foundChar()),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      applyCondition,
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger))
    const exec = requireExecute(tools, 'update_condition')

    const result = (await exec(
      {
        character_name: 'Vire',
        condition: 'exhaustion',
        action: 'apply',
        level: 2,
      } satisfies UpdateConditionInput,
      callOpts(),
    )) as { ok: boolean; payload: { condition: string } }

    expect(result.ok).toBe(true)
    expect(result.payload.condition).toBe('exhaustion')
  })
})

describe('take_rest execute', () => {
  it('delegates a short rest and surfaces the per-character ARRAY payload', async () => {
    const ledger = fakeLedger({
      readRestParticipants: vi
        .fn()
        .mockResolvedValue([
          { characterId: CHAR.id, name: 'Vire', hitDie: 8, hitDiceRemaining: 3, conMod: 1 },
        ]),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      shortRest: vi.fn().mockResolvedValue(undefined),
      readPartyLedgerSnapshot: vi
        .fn()
        .mockResolvedValue([
          {
            characterId: CHAR.id,
            name: 'Vire',
            hitPoints: 16,
            maxHitPoints: 20,
            hitDiceRemaining: 1,
          } as never,
        ]),
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger), scriptedRng(5, 6))
    const exec = requireExecute(tools, 'take_rest')

    const result = (await exec(
      {
        type: 'short',
        hit_dice: [{ character_name: 'Vire', count: 2 }],
      } satisfies TakeRestInput,
      callOpts(),
    )) as { ok: boolean; payload: { kind: string }[] }

    expect(result.ok).toBe(true)
    expect(Array.isArray(result.payload)).toBe(true)
    expect(result.payload).toHaveLength(1)
    expect(result.payload[0]?.kind).toBe('rest')
  })

  it('delegates a long rest with no hit_dice (the omitted-hit_dice arm)', async () => {
    const longRest = vi.fn().mockResolvedValue(undefined)
    const ledger = fakeLedger({
      readRestParticipants: vi
        .fn()
        .mockResolvedValue([
          { characterId: CHAR.id, name: 'Vire', hitDie: 8, hitDiceRemaining: 3, conMod: 1 },
        ]),
      findLedgerEvent: vi.fn().mockResolvedValue(false),
      writeLedgerEvent: vi.fn().mockResolvedValue('evt'),
      longRest,
      readPartyLedgerSnapshot: vi
        .fn()
        .mockResolvedValue([
          {
            characterId: CHAR.id,
            name: 'Vire',
            hitPoints: 20,
            maxHitPoints: 20,
            hitDiceRemaining: 3,
          } as never,
        ]),
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger))
    const exec = requireExecute(tools, 'take_rest')

    const result = (await exec(
      { type: 'long' } satisfies TakeRestInput,
      callOpts(),
    )) as { ok: boolean; payload: { kind: string }[] }

    expect(result.ok).toBe(true)
    expect(longRest).toHaveBeenCalledWith('session-1')
  })

  it('an unknown resting character rejects the WHOLE call as { constraint }', async () => {
    const ledger = fakeLedger({
      readRestParticipants: vi
        .fn()
        .mockResolvedValue([
          { characterId: CHAR.id, name: 'Vire', hitDie: 8, hitDiceRemaining: 3, conMod: 1 },
        ]),
    })
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), []), ledger))
    const exec = requireExecute(tools, 'take_rest')

    const result = (await exec(
      { type: 'short', hit_dice: [{ character_name: 'Ghost', count: 1 }] },
      callOpts(),
    )) as { ok: false; constraint: string }

    expect(result.ok).toBe(false)
    expect(result.constraint).toContain('Ghost')
  })
})
