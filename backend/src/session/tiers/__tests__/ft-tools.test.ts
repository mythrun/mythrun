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
  SEARCH_LORE_INPUT,
  CHARACTERS_KNOWN_TO_INPUT,
  FACTION_TREE_INPUT,
  type FtToolDeps,
} from '../ft-tools.js'
import { STANDARD_DICE } from '../../dice/engine.js'
import { FALLBACK_OUTCOMES } from '../../ft-config.js'
import { MAX_GOLD_TRANSACTION } from '../../ft-config.js'
import type { MechanicalReads } from '../../skill-check.js'
import type { Rng } from '../../dice/engine.js'
import type { Character } from '../../../repo/types.js'
import type { LedgerOps, LedgerTxRunner } from '../../rules-lawyer.js'
import * as worldFactLookup from '../../world-fact-lookup.js'
import type {
  SubstrateResolver,
  WorldFactLookupVet,
  WorldFactLookupResult,
} from '../../world-fact-lookup.js'
import type { SearchResolvers } from '../../../world/retrieval/search.js'
import type { GraphDeps } from '../../../world/retrieval/graph.js'
import { GRAPH_MAX_DEPTH } from '../../../world/retrieval/config.js'
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

// MYT-72: stub the orchestrator spine so the lookup-tool tests exercise the
// TOOL's wiring (asker resolution, gate/closure construction, result shaping)
// without the gate/resolve/vet flow — that flow is world-fact-lookup.ts's own
// tested unit. We assert the closure the tool HANDS to runWorldFactLookup and
// the tool's mapping of the orchestrator's return into the reserved-keys shape.
vi.mock('../../world-fact-lookup.js', async () => {
  const actual = await vi.importActual<typeof import('../../world-fact-lookup.js')>(
    '../../world-fact-lookup.js',
  )
  return { ...actual, runWorldFactLookup: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)
const mockRunWorldFactLookup = vi.mocked(worldFactLookup.runWorldFactLookup)

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

/** A fake SearchResolvers whose searchLore returns a canned hit set (overridable
 *  per test). findSimilarEntities is unused by the lookup tools. */
function fakeSearch(overrides: Partial<SearchResolvers> = {}): SearchResolvers {
  return {
    searchLore: vi.fn().mockResolvedValue({ hits: [], queryVec: [] }),
    findSimilarEntities: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

/** A fake GraphDeps — the lookup tools call charactersKnownTo/factionTree
 *  (which read graph.repo.worldRetrieval). Methods throw unless a test stubs
 *  them; the lookup tests mock runWorldFactLookup so the closure is only invoked
 *  when a test explicitly drives it. */
function fakeGraph(
  overrides: Partial<GraphDeps['repo']['worldRetrieval']> = {},
): GraphDeps {
  const unimplemented =
    (name: string) =>
    (): never => {
      throw new Error(`fakeGraph.${name} not stubbed`)
    }
  return {
    repo: {
      worldRetrieval: {
        charactersKnownTo: vi.fn(unimplemented('charactersKnownTo')),
        factionTree: vi.fn(unimplemented('factionTree')),
        searchFacts: vi.fn(unimplemented('searchFacts')),
        searchEntities: vi.fn(unimplemented('searchEntities')),
        ...overrides,
      },
    },
  } as GraphDeps
}

/** A no-op opaque vet closure — the lookup tools never call it directly (the
 *  orchestrator does), and runWorldFactLookup is mocked, so this is only a
 *  type-level placeholder proving FtToolDeps carries an OPAQUE vet, never a raw
 *  sd_playbook string. */
const fakeVet: WorldFactLookupVet = vi
  .fn()
  .mockResolvedValue({ mode: 'relay', text: '', repairAttempted: false })

/** The MYT-72 lookup surface added to FtToolDeps. Overridable per test. */
interface LookupSurface {
  worldId: string
  search: SearchResolvers
  graph: GraphDeps
  resolveEntityId: (name: string) => Promise<string | null>
  recentNarrative: () => string
  vet: WorldFactLookupVet
  askerSummary: FtToolDeps['askerSummary']
}

function makeLookupSurface(overrides: Partial<LookupSurface> = {}): LookupSurface {
  return {
    worldId: 'world-1',
    search: fakeSearch(),
    graph: fakeGraph(),
    resolveEntityId: vi.fn().mockResolvedValue('ent-1'),
    recentNarrative: vi.fn().mockReturnValue('the recent narration'),
    vet: fakeVet,
    askerSummary: vi.fn().mockResolvedValue('a public asker summary'),
    ...overrides,
  }
}

/** SkillCheckDeps minus abortSignal — buildFtTools threads the SDK signal in.
 *  The Rules Lawyer ledger surface defaults to an all-throwing fake (tests that
 *  exercise a ledger tool pass their own stubbed ledger + tx). The MYT-72 lookup
 *  surface defaults to harmless fakes; lookup-tool tests override per case. */
function makeDeps(
  mech: MechanicalReads,
  ledger: LedgerOps = fakeLedger(),
  runInTx: LedgerTxRunner = passthroughTx(ledger),
  lookup: LookupSurface = makeLookupSurface(),
): FtToolDeps {
  return {
    mech,
    sessionId: 'session-1',
    worldTone: 'grim and rain-soaked',
    ledger,
    runInTx,
    turnId: 'turn-1',
    ...lookup,
  }
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
    ['SEARCH_LORE_INPUT', SEARCH_LORE_INPUT],
    ['CHARACTERS_KNOWN_TO_INPUT', CHARACTERS_KNOWN_TO_INPUT],
    ['FACTION_TREE_INPUT', FACTION_TREE_INPUT],
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

// ===========================================================================
// MYT-72 §17 — the three world-knowledge lookup tools (search_lore /
// characters_known_to / faction_tree). These tests verify the TOOL's wiring:
// asker resolution (DM PC / NPC entity), the per-substrate `resolve` closure it
// hands the orchestrator, the data-only reserved-keys result shape, and the
// structural enforced-ignorance posture. `runWorldFactLookup` is mocked — the
// gate/resolve/vet flow is its own tested unit (world-fact-lookup.test.ts).
// ===========================================================================

const RELAY: WorldFactLookupResult = {
  relayText: 'You recall the Ashen Compact once held this valley.',
  skillGateFrame: {
    characterName: 'Vire',
    skill: 'History',
    context: 'the Ashen Compact',
    roll: 14,
    roll2: null,
    rollType: 'normal',
    modifier: 3,
    total: 17,
    dc: 13,
    outcomeTier: 'success',
    constraint: 'You recall what you know of it.',
  },
  rollHidden: false,
}

/** A relay with NO skill-gate frame — drives `toToolResult`'s `?? null` arm
 *  (the npc-channel relay carries no skill check, so `skillGateFrame` is
 *  undefined and the tool result's `skill_gate` is null). */
const RELAY_NO_FRAME: WorldFactLookupResult = {
  relayText: 'The Steward inclines their head, recalling the old road.',
  rollHidden: true,
}

/** A spy logger (warn only — the surface the lookup code touches) plus a deps
 *  factory that attaches it, so the `deps.logger?.warn(...)` truthy arms and the
 *  `...(deps.logger !== undefined ? {logger} : {})` present arms are exercised. */
function spyLogger(): { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() }
}

/** Resolve the SubstrateResolver the tool handed to the mocked orchestrator, for
 *  the Nth (default last) runWorldFactLookup call. */
function capturedResolve(callIndex = -1): SubstrateResolver {
  const calls = mockRunWorldFactLookup.mock.calls
  const call = calls.at(callIndex)
  if (call === undefined) throw new Error('runWorldFactLookup not called')
  return call[1].resolve
}

function capturedInput(callIndex = -1): Parameters<typeof worldFactLookup.runWorldFactLookup>[1] {
  const call = mockRunWorldFactLookup.mock.calls.at(callIndex)
  if (call === undefined) throw new Error('runWorldFactLookup not called')
  return call[1]
}

function capturedDeps(callIndex = -1): Parameters<typeof worldFactLookup.runWorldFactLookup>[0] {
  const call = mockRunWorldFactLookup.mock.calls.at(callIndex)
  if (call === undefined) throw new Error('runWorldFactLookup not called')
  return call[0]
}

describe('lookup tool input schemas', () => {
  it('SEARCH_LORE_INPUT constrains skill to the knowledge enum (rejects an action skill)', () => {
    expect(
      SEARCH_LORE_INPUT.safeParse({ channel: 'dm', topic: 'x', skill: 'history' }).success,
    ).toBe(true)
    // athletics is a real 5e skill but NOT a knowledge skill — rejected.
    expect(
      SEARCH_LORE_INPUT.safeParse({ channel: 'dm', topic: 'x', skill: 'athletics' }).success,
    ).toBe(false)
  })

  it('accepts the npc channel with asker_name and rejects an empty topic', () => {
    expect(
      SEARCH_LORE_INPUT.safeParse({ channel: 'npc', topic: 'x', asker_name: 'The Steward' }).success,
    ).toBe(true)
    expect(SEARCH_LORE_INPUT.safeParse({ channel: 'dm', topic: '' }).success).toBe(false)
  })

  it('CHARACTERS_KNOWN_TO_INPUT / FACTION_TREE_INPUT require their subject', () => {
    expect(
      CHARACTERS_KNOWN_TO_INPUT.safeParse({ channel: 'dm', character: 'Vire' }).success,
    ).toBe(true)
    expect(CHARACTERS_KNOWN_TO_INPUT.safeParse({ channel: 'dm' }).success).toBe(false)
    expect(FACTION_TREE_INPUT.safeParse({ channel: 'dm', faction: 'The Compact' }).success).toBe(
      true,
    )
    expect(FACTION_TREE_INPUT.safeParse({ channel: 'dm' }).success).toBe(false)
  })
})

describe('search_lore execute', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dm channel: resolves the PC, builds a search closure, returns the reserved-keys relay', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const searchLore = vi.fn().mockResolvedValue({
      hits: [
        { source: 'fact', entityId: 'e1', entityName: 'Ashen Compact', content: 'A pact.', accessLevel: 'known', score: 0.9 },
      ],
      queryVec: [],
    })
    const character = makeCharacter()
    const mech = foundMech(character, [{ skill_name: 'History', proficiency_level: 'proficient' }])
    const deps = makeDeps(mech, fakeLedger(), undefined, makeLookupSurface({ search: fakeSearch({ searchLore }) }))
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    const result = (await exec(
      { channel: 'dm', topic: 'the Ashen Compact', skill: 'history', asker_name: 'Vire' },
      callOpts(),
    )) as { result: string; skill_gate: unknown; roll_hidden: boolean }

    // Data-only reserved-keys shape; `result` is the relay text VERBATIM (never
    // the over-pulled results block).
    expect(result.result).toBe(RELAY.relayText)
    expect(result.skill_gate).toEqual(RELAY.skillGateFrame)
    expect(result.roll_hidden).toBe(false)

    // The tool handed the orchestrator a DM gate with the resolved PC + skill.
    const gate = capturedInput().gate
    expect(gate.channel).toBe('dm')
    if (gate.channel !== 'dm') throw new Error('expected dm gate')
    expect(gate.dm.character.name).toBe('Vire')
    expect(gate.dm.skill).toBe('history')
    expect(gate.topic).toBe('the Ashen Compact')

    // Invoke the captured resolve closure → it calls searchLore(worldId, topic, {}).
    const resolved = await capturedResolve()()
    expect(searchLore).toHaveBeenCalledWith('world-1', 'the Ashen Compact', {})
    expect(resolved.results).toContain('[tier=known] Ashen Compact: A pact.')
    expect(resolved.degraded).toBe(false)
    expect(resolved.empty).toBe(false)
  })

  it('npc channel: resolves the NPC entity, sets npcFraming, recentNarrative threaded', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const resolveEntityId = vi.fn().mockResolvedValue('npc-7')
    const askerSummary = vi.fn().mockResolvedValue('The Steward, a household servant')
    const deps = makeDeps(
      foundMech(makeCharacter(), []),
      fakeLedger(),
      undefined,
      makeLookupSurface({ resolveEntityId, askerSummary, recentNarrative: () => 'narration tail' }),
    )
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    await exec({ channel: 'npc', topic: 'the old road', asker_name: 'The Steward' }, callOpts())

    expect(resolveEntityId).toHaveBeenCalledWith('The Steward')
    const input = capturedInput()
    expect(input.gate.channel).toBe('npc')
    // npcFraming === the asker summary on the NPC channel (empty on DM).
    expect(input.npcFraming).toBe('The Steward, a household servant')
    expect(input.recentNarrative).toBe('narration tail')
  })

  it('dm channel without a skill → clean fail-soft relay, orchestrator NOT called', async () => {
    const deps = makeDeps(foundMech(makeCharacter(), []))
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    const result = (await exec(
      { channel: 'dm', topic: 'x', asker_name: 'Vire' },
      callOpts(),
    )) as { result: string; skill_gate: null; roll_hidden: boolean }

    expect(result.skill_gate).toBeNull()
    expect(result.roll_hidden).toBe(false)
    expect(result.result).toBe("You can't quite bring it to mind.")
    expect(mockRunWorldFactLookup).not.toHaveBeenCalled()
  })

  it('dm channel with an unknown PC → clean fail-soft relay, orchestrator NOT called', async () => {
    const mech: MechanicalReads = {
      findSessionParticipantCharacterByName: vi.fn().mockResolvedValue({ outcome: 'not_found' }),
    }
    const exec = requireExecute(buildFtTools(makeDeps(mech)), 'search_lore')

    const result = (await exec(
      { channel: 'dm', topic: 'x', skill: 'history', asker_name: 'Ghost' },
      callOpts(),
    )) as { result: string }

    expect(result.result).toBe("You can't quite bring it to mind.")
    expect(mockRunWorldFactLookup).not.toHaveBeenCalled()
  })

  it('npc channel with an unresolvable NPC → clean fail-soft relay, orchestrator NOT called', async () => {
    const resolveEntityId = vi.fn().mockResolvedValue(null)
    const deps = makeDeps(foundMech(makeCharacter(), []), fakeLedger(), undefined, makeLookupSurface({ resolveEntityId }))
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    const result = (await exec(
      { channel: 'npc', topic: 'x', asker_name: 'Nobody' },
      callOpts(),
    )) as { result: string }

    expect(result.result).toBe("They don't seem to know.")
    expect(mockRunWorldFactLookup).not.toHaveBeenCalled()
  })

  it('search closure surfaces an EMPTY pull with degraded:false (v1 search-channel asymmetry)', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const searchLore = vi.fn().mockResolvedValue({ hits: [], queryVec: [] }) // total-swallow can't report degraded
    const mech = foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }])
    const deps = makeDeps(mech, fakeLedger(), undefined, makeLookupSurface({ search: fakeSearch({ searchLore }) }))
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    await exec({ channel: 'dm', topic: 'x', skill: 'history', asker_name: 'Vire' }, callOpts())

    const resolved = await capturedResolve()()
    expect(resolved.empty).toBe(true)
    expect(resolved.degraded).toBe(false)
  })

  // A relay with no skill-gate frame (the npc channel runs no skill check) →
  // toToolResult's `out.skillGateFrame ?? null` falls to the null arm.
  it('a frame-less relay maps skill_gate to null and surfaces roll_hidden', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY_NO_FRAME)
    const resolveEntityId = vi.fn().mockResolvedValue('npc-7')
    const deps = makeDeps(
      foundMech(makeCharacter(), []),
      fakeLedger(),
      undefined,
      makeLookupSurface({ resolveEntityId }),
    )
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    const result = (await exec(
      { channel: 'npc', topic: 'the old road', asker_name: 'The Steward' },
      callOpts(),
    )) as { result: string; skill_gate: unknown; roll_hidden: boolean }

    expect(result.result).toBe(RELAY_NO_FRAME.relayText)
    expect(result.skill_gate).toBeNull()
    expect(result.roll_hidden).toBe(true)
  })

  // The runLookup gateDeps spreads (rng / abortSignal / logger) + the
  // runWorldFactLookup logger spread: a call that PROVIDES all three drives the
  // present arms of every `...(x !== undefined ? {x} : {})` + the logger-bearing
  // run, complementing the existing logger-less tests (the absent arms).
  it('threads rng, abortSignal, and logger into the orchestrator deps (present arms)', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const logger = spyLogger()
    const controller = new AbortController()
    const mech = foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }])
    const deps: FtToolDeps = { ...makeDeps(mech), logger }
    const exec = requireExecute(buildFtTools(deps, scriptedRng(1)), 'search_lore')

    await exec(
      { channel: 'dm', topic: 'x', skill: 'history', asker_name: 'Vire' },
      callOpts({ abortSignal: controller.signal }),
    )

    const orchestratorDeps = capturedDeps()
    expect(orchestratorDeps.logger).toBe(logger)
    expect(orchestratorDeps.gateDeps.rng).toBeDefined()
    expect(orchestratorDeps.gateDeps.abortSignal).toBe(controller.signal)
    expect(orchestratorDeps.gateDeps.logger).toBe(logger)
  })

  // npc channel WITHOUT asker_name: a flat schema can't mark it required-per-
  // channel, so resolveAsker fail-softs (vet NOT run). Also drives the askerName-
  // absent arm of runLookup's resolveAsker spread.
  it('npc channel without asker_name → clean fail-soft relay, orchestrator NOT called', async () => {
    const deps = makeDeps(foundMech(makeCharacter(), []))
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    const result = (await exec(
      { channel: 'npc', topic: 'the old road' },
      callOpts(),
    )) as { result: string; skill_gate: null }

    expect(result.result).toBe("They don't seem to know.")
    expect(result.skill_gate).toBeNull()
    expect(mockRunWorldFactLookup).not.toHaveBeenCalled()
  })

  // dm asker resolution failure WITH a logger present → the warn truthy arm fires
  // (the existing not_found test omits the logger, covering the falsy arm).
  it('dm asker not_found WITH a logger logs the failed resolution', async () => {
    const mech: MechanicalReads = {
      findSessionParticipantCharacterByName: vi.fn().mockResolvedValue({ outcome: 'not_found' }),
    }
    const logger = spyLogger()
    const deps: FtToolDeps = { ...makeDeps(mech), logger }
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    await exec({ channel: 'dm', topic: 'x', skill: 'history', asker_name: 'Ghost' }, callOpts())

    expect(logger.warn).toHaveBeenCalledWith(
      { characterName: 'Ghost', outcome: 'not_found' },
      'world-lookup: dm asker resolution failed',
    )
    expect(mockRunWorldFactLookup).not.toHaveBeenCalled()
  })

  // npc asker unresolvable WITH a logger present → the warn truthy arm fires.
  it('npc asker not found WITH a logger logs the missing NPC', async () => {
    const resolveEntityId = vi.fn().mockResolvedValue(null)
    const logger = spyLogger()
    const deps: FtToolDeps = {
      ...makeDeps(foundMech(makeCharacter(), []), fakeLedger(), undefined, makeLookupSurface({ resolveEntityId })),
      logger,
    }
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    await exec({ channel: 'npc', topic: 'x', asker_name: 'Nobody' }, callOpts())

    expect(logger.warn).toHaveBeenCalledWith({ npcName: 'Nobody' }, 'world-lookup: npc asker not found')
    expect(mockRunWorldFactLookup).not.toHaveBeenCalled()
  })
})

describe('characters_known_to execute', () => {
  beforeEach(() => vi.clearAllMocks())

  it('resolves the subject name → id and builds a graph closure rendering tier lines', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const resolveEntityId = vi.fn().mockResolvedValue('subj-1')
    const charactersKnownTo = vi
      .fn()
      .mockResolvedValue([
        { entity_id: 'k1', name: 'Mara', entity_type: 'npc', access_level: 'discoverable', depth: 1 },
      ])
    const deps = makeDeps(
      foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }]),
      fakeLedger(),
      undefined,
      makeLookupSurface({ resolveEntityId, graph: fakeGraph({ charactersKnownTo }) }),
    )
    const exec = requireExecute(buildFtTools(deps), 'characters_known_to')

    const result = (await exec(
      { channel: 'dm', character: 'The Spymaster', skill: 'history', asker_name: 'Vire' },
      callOpts(),
    )) as { result: string }

    expect(resolveEntityId).toHaveBeenCalledWith('The Spymaster')
    expect(result.result).toBe(RELAY.relayText)
    // Question framing names the subject.
    expect(capturedInput().question).toBe('Who is known to The Spymaster?')

    const resolved = await capturedResolve()()
    expect(charactersKnownTo).toHaveBeenCalledWith('subj-1', expect.any(Number))
    expect(resolved.results).toContain('[tier=discoverable] Mara (depth 1)')
    expect(resolved.degraded).toBe(false)
  })

  it('a subject that resolves to null → clean "no such character" relay, orchestrator NOT called', async () => {
    const resolveEntityId = vi.fn().mockResolvedValue(null)
    const deps = makeDeps(foundMech(makeCharacter(), []), fakeLedger(), undefined, makeLookupSurface({ resolveEntityId }))
    const exec = requireExecute(buildFtTools(deps), 'characters_known_to')

    const result = (await exec(
      { channel: 'dm', character: 'Nobody', skill: 'history', asker_name: 'Vire' },
      callOpts(),
    )) as { result: string }

    expect(result.result).toBe("You can't quite bring it to mind.")
    expect(mockRunWorldFactLookup).not.toHaveBeenCalled()
  })

  it('a graph-walk throw inside the closure → DEGRADED empty (the real resolver_degraded signal)', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const charactersKnownTo = vi.fn().mockRejectedValue(new Error('db blip'))
    const deps = makeDeps(
      foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }]),
      fakeLedger(),
      undefined,
      makeLookupSurface({ graph: fakeGraph({ charactersKnownTo }) }),
    )
    const exec = requireExecute(buildFtTools(deps), 'characters_known_to')

    await exec({ channel: 'dm', character: 'X', skill: 'history', asker_name: 'Vire' }, callOpts())

    const resolved = await capturedResolve()()
    expect(resolved.degraded).toBe(true)
    expect(resolved.empty).toBe(true)
    expect(resolved.results).toBe('')
  })

  it('applies an optional name filter (the post-filter narrows the rendered set)', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const resolveEntityId = vi.fn().mockResolvedValue('subj-1')
    // The real graph.charactersKnownTo applies the nameFilter as a normalized JS
    // post-filter over the binder rows; we drive the binder with two rows and
    // assert only the filtered one renders.
    const charactersKnownTo = vi.fn().mockResolvedValue([
      { entity_id: 'k1', name: 'Mara', entity_type: 'npc', access_level: 'known', depth: 1 },
      { entity_id: 'k2', name: 'Doran', entity_type: 'npc', access_level: 'known', depth: 1 },
    ])
    const deps = makeDeps(
      foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }]),
      fakeLedger(),
      undefined,
      makeLookupSurface({ resolveEntityId, graph: fakeGraph({ charactersKnownTo }) }),
    )
    const exec = requireExecute(buildFtTools(deps), 'characters_known_to')

    await exec(
      { channel: 'dm', character: 'X', name: 'Mara', skill: 'history', asker_name: 'Vire' },
      callOpts(),
    )
    const resolved = await capturedResolve()()
    expect(charactersKnownTo).toHaveBeenCalledWith('subj-1', expect.any(Number))
    expect(resolved.results).toContain('Mara')
    expect(resolved.results).not.toContain('Doran')
  })

  // Subject resolves to null WITH a logger present → the warn truthy arm fires
  // (the existing null-subject test omits the logger, covering the falsy arm).
  it('a null subject WITH a logger logs "subject not found"', async () => {
    const resolveEntityId = vi.fn().mockResolvedValue(null)
    const logger = spyLogger()
    const deps: FtToolDeps = {
      ...makeDeps(foundMech(makeCharacter(), []), fakeLedger(), undefined, makeLookupSurface({ resolveEntityId })),
      logger,
    }
    const exec = requireExecute(buildFtTools(deps), 'characters_known_to')

    await exec({ channel: 'dm', character: 'Nobody', skill: 'history', asker_name: 'Vire' }, callOpts())

    expect(logger.warn).toHaveBeenCalledWith(
      { character: 'Nobody' },
      'characters_known_to: subject not found',
    )
    expect(mockRunWorldFactLookup).not.toHaveBeenCalled()
  })

  // A graph-walk throw WITH a logger present → the degrade-warn truthy arm fires
  // (the existing throw test omits the logger, covering the falsy arm).
  it('a graph-walk throw WITH a logger logs the degrade', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const charactersKnownTo = vi.fn().mockRejectedValue(new Error('db blip'))
    const logger = spyLogger()
    const deps: FtToolDeps = {
      ...makeDeps(
        foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }]),
        fakeLedger(),
        undefined,
        makeLookupSurface({ resolveEntityId: vi.fn().mockResolvedValue('subj-1'), graph: fakeGraph({ charactersKnownTo }) }),
      ),
      logger,
    }
    const exec = requireExecute(buildFtTools(deps), 'characters_known_to')

    await exec({ channel: 'dm', character: 'X', skill: 'history', asker_name: 'Vire' }, callOpts())

    const resolved = await capturedResolve()()
    expect(resolved.degraded).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown, entityId: 'subj-1' }),
      'characters_known_to: graph walk failed; degrading',
    )
  })

  // npc channel WITHOUT skill or asker_name: drives both absent-arm spreads in
  // the runLookup call (the subject still resolves, so runLookup IS reached;
  // resolveAsker then fail-softs on the missing npc asker_name).
  it('npc channel without skill/asker_name reaches runLookup then fail-softs', async () => {
    const resolveEntityId = vi.fn().mockResolvedValue('subj-1')
    const deps = makeDeps(foundMech(makeCharacter(), []), fakeLedger(), undefined, makeLookupSurface({ resolveEntityId }))
    const exec = requireExecute(buildFtTools(deps), 'characters_known_to')

    const result = (await exec(
      { channel: 'npc', character: 'The Spymaster' },
      callOpts(),
    )) as { result: string }

    // Subject resolved (so runLookup ran with skill+asker_name omitted), but the
    // npc asker_name is missing → resolveAsker fail-softs, vet never runs.
    expect(resolveEntityId).toHaveBeenCalledWith('The Spymaster')
    expect(result.result).toBe("They don't seem to know.")
    expect(mockRunWorldFactLookup).not.toHaveBeenCalled()
  })
})

describe('faction_tree execute', () => {
  beforeEach(() => vi.clearAllMocks())

  it('resolves the faction name → id and builds a factionTree closure', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const resolveEntityId = vi.fn().mockResolvedValue('fac-1')
    const factionTree = vi.fn().mockResolvedValue([
      { entity_id: 'fac-1', name: 'The Compact', entity_type: 'faction', access_level: 'known', parent_id: null, depth: 0 },
      { entity_id: 'fac-2', name: 'Inner Circle', entity_type: 'faction', access_level: 'secret', parent_id: 'fac-1', depth: 1 },
    ])
    const deps = makeDeps(
      foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }]),
      fakeLedger(),
      undefined,
      makeLookupSurface({ resolveEntityId, graph: fakeGraph({ factionTree }) }),
    )
    const exec = requireExecute(buildFtTools(deps), 'faction_tree')

    const result = (await exec(
      { channel: 'dm', faction: 'The Compact', skill: 'history', asker_name: 'Vire' },
      callOpts(),
    )) as { result: string }

    expect(resolveEntityId).toHaveBeenCalledWith('The Compact')
    expect(result.result).toBe(RELAY.relayText)
    expect(capturedInput().question).toBe('What is the structure of The Compact?')

    const resolved = await capturedResolve()()
    expect(factionTree).toHaveBeenCalledWith('fac-1', expect.any(Number))
    expect(resolved.results).toContain('[tier=known] The Compact (parent root, depth 0)')
    expect(resolved.results).toContain('[tier=secret] Inner Circle (parent fac-1, depth 1)')
  })

  it('a faction that resolves to null → clean fail-soft relay, orchestrator NOT called', async () => {
    const resolveEntityId = vi.fn().mockResolvedValue(null)
    const deps = makeDeps(foundMech(makeCharacter(), []), fakeLedger(), undefined, makeLookupSurface({ resolveEntityId }))
    const exec = requireExecute(buildFtTools(deps), 'faction_tree')

    const result = (await exec(
      { channel: 'npc', faction: 'Nobody', asker_name: 'The Steward' },
      callOpts(),
    )) as { result: string }

    expect(result.result).toBe("They don't seem to know.")
    expect(mockRunWorldFactLookup).not.toHaveBeenCalled()
  })

  it('a factionTree throw inside the closure → DEGRADED empty', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const factionTree = vi.fn().mockRejectedValue(new Error('db blip'))
    const deps = makeDeps(
      foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }]),
      fakeLedger(),
      undefined,
      makeLookupSurface({ graph: fakeGraph({ factionTree }) }),
    )
    const exec = requireExecute(buildFtTools(deps), 'faction_tree')

    await exec({ channel: 'dm', faction: 'X', skill: 'history', asker_name: 'Vire' }, callOpts())

    const resolved = await capturedResolve()()
    expect(resolved.degraded).toBe(true)
    expect(resolved.empty).toBe(true)
  })

  // A node sitting at exactly GRAPH_MAX_DEPTH makes the real graph.factionTree
  // set truncated:true → renderFactionNodes appends the truncation note.
  it('renders the truncation note when the hierarchy hits the depth cap', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const factionTree = vi.fn().mockResolvedValue([
      { entity_id: 'fac-1', name: 'The Compact', entity_type: 'faction', access_level: 'known', parent_id: null, depth: 0 },
      { entity_id: 'fac-deep', name: 'Deep Cell', entity_type: 'faction', access_level: 'secret', parent_id: 'fac-1', depth: GRAPH_MAX_DEPTH },
    ])
    const deps = makeDeps(
      foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }]),
      fakeLedger(),
      undefined,
      makeLookupSurface({ resolveEntityId: vi.fn().mockResolvedValue('fac-1'), graph: fakeGraph({ factionTree }) }),
    )
    const exec = requireExecute(buildFtTools(deps), 'faction_tree')

    await exec({ channel: 'dm', faction: 'The Compact', skill: 'history', asker_name: 'Vire' }, callOpts())

    const resolved = await capturedResolve()()
    expect(resolved.results).toContain('[note] hierarchy truncated at the depth cap; deeper nodes omitted.')
  })

  // Faction resolves to null WITH a logger present → the warn truthy arm fires.
  it('a null faction WITH a logger logs "subject not found"', async () => {
    const resolveEntityId = vi.fn().mockResolvedValue(null)
    const logger = spyLogger()
    const deps: FtToolDeps = {
      ...makeDeps(foundMech(makeCharacter(), []), fakeLedger(), undefined, makeLookupSurface({ resolveEntityId })),
      logger,
    }
    const exec = requireExecute(buildFtTools(deps), 'faction_tree')

    await exec({ channel: 'dm', faction: 'Nobody', skill: 'history', asker_name: 'Vire' }, callOpts())

    expect(logger.warn).toHaveBeenCalledWith({ faction: 'Nobody' }, 'faction_tree: subject not found')
    expect(mockRunWorldFactLookup).not.toHaveBeenCalled()
  })

  // A factionTree throw WITH a logger present → the degrade-warn truthy arm fires.
  it('a factionTree throw WITH a logger logs the degrade', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const factionTree = vi.fn().mockRejectedValue(new Error('db blip'))
    const logger = spyLogger()
    const deps: FtToolDeps = {
      ...makeDeps(
        foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }]),
        fakeLedger(),
        undefined,
        makeLookupSurface({ resolveEntityId: vi.fn().mockResolvedValue('fac-1'), graph: fakeGraph({ factionTree }) }),
      ),
      logger,
    }
    const exec = requireExecute(buildFtTools(deps), 'faction_tree')

    await exec({ channel: 'dm', faction: 'X', skill: 'history', asker_name: 'Vire' }, callOpts())

    const resolved = await capturedResolve()()
    expect(resolved.degraded).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown, entityId: 'fac-1' }),
      'faction_tree: graph walk failed; degrading',
    )
  })

  // npc channel WITHOUT skill or asker_name: drives both absent-arm spreads in
  // faction_tree's runLookup call (subject resolves so runLookup IS reached).
  it('npc channel without skill/asker_name reaches runLookup then fail-softs', async () => {
    const resolveEntityId = vi.fn().mockResolvedValue('fac-1')
    const deps = makeDeps(foundMech(makeCharacter(), []), fakeLedger(), undefined, makeLookupSurface({ resolveEntityId }))
    const exec = requireExecute(buildFtTools(deps), 'faction_tree')

    const result = (await exec(
      { channel: 'npc', faction: 'The Compact' },
      callOpts(),
    )) as { result: string }

    expect(resolveEntityId).toHaveBeenCalledWith('The Compact')
    expect(result.result).toBe("They don't seem to know.")
    expect(mockRunWorldFactLookup).not.toHaveBeenCalled()
  })
})

describe('lookup tools — structural enforced ignorance + registration', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes the OPAQUE vet closure through to the orchestrator (never a raw sd_playbook)', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const vet: WorldFactLookupVet = vi
      .fn()
      .mockResolvedValue({ mode: 'relay', text: 't', repairAttempted: false })
    const deps = makeDeps(
      foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }]),
      fakeLedger(),
      undefined,
      makeLookupSurface({ vet }),
    )
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    await exec({ channel: 'dm', topic: 'x', skill: 'history', asker_name: 'Vire' }, callOpts())

    // The deps the tool handed the orchestrator carry the SAME opaque vet — the
    // tool never holds, renders, or forwards a raw playbook string.
    expect(capturedDeps().vet).toBe(vet)
    // FtToolDeps has NO sdPlaybook field (structural: the key cannot exist).
    expect('sdPlaybook' in deps).toBe(false)
  })

  it('the tool result equals the relay text — never the over-pulled results block', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    // searchLore returns a SECRET-tier line; if the tool leaked the results block
    // the assertion below would catch it. The tool only ever returns out.relayText.
    const searchLore = vi.fn().mockResolvedValue({
      hits: [
        { source: 'fact', entityId: 'e', entityName: 'X', content: 'A SECRET FACT', accessLevel: 'secret', score: 1 },
      ],
      queryVec: [],
    })
    const mech = foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }])
    const deps = makeDeps(mech, fakeLedger(), undefined, makeLookupSurface({ search: fakeSearch({ searchLore }) }))
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    const result = (await exec(
      { channel: 'dm', topic: 'x', skill: 'history', asker_name: 'Vire' },
      callOpts(),
    )) as { result: string }

    expect(result.result).toBe(RELAY.relayText)
    expect(result.result).not.toContain('SECRET FACT')
  })

  it('registers all three lookup tools as pure resolvers (SDK-shaped surface only)', () => {
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), [])))
    for (const name of ['search_lore', 'characters_known_to', 'faction_tree']) {
      const t = tools[name]
      if (t === undefined) throw new Error(`${name} missing`)
      for (const k of Object.keys(t)) {
        expect(['description', 'inputSchema', 'execute', 'type']).toContain(k)
      }
      expect(typeof t.execute).toBe('function')
      // Each description teaches the dm/npc channel + the "narrate from it" rule.
      expect(t.description).toContain('channel')
      expect(t.description).toContain('narrate from it')
    }
  })
})
