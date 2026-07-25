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
  INITIATE_COMBAT_INPUT,
  RESOLVE_COMBAT_INPUT,
  ISSUE_CORRECTION_INPUT,
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
import type { CombatEvent, CombatPartyMember, InitiateCombatEvent } from '../../combat/events.js'
import type { SearchResolvers } from '../../../world/retrieval/search.js'
import type { GraphDeps } from '../../../world/retrieval/graph.js'
import type { WorkingSetItem } from '../../working-set/types.js'
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
    readConditions: () => Promise.resolve([]),
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
  .mockResolvedValue({ mode: 'relay', text: '', tier: 'known', repairAttempted: false })

/** The MYT-72 lookup surface added to FtToolDeps. Overridable per test. The
 *  MYT-73 `recordInjection` sink defaults to a fresh spy per surface so tests can
 *  assert what the tool recorded. */
interface LookupSurface {
  worldId: string
  search: SearchResolvers
  graph: GraphDeps
  resolveEntityId: (name: string) => Promise<string | null>
  recentNarrative: () => string
  vet: WorldFactLookupVet
  askerSummary: FtToolDeps['askerSummary']
  recordInjection: FtToolDeps['recordInjection']
  workingSet: FtToolDeps['workingSet']
  cosine: FtToolDeps['cosine']
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
    recordInjection: vi.fn(),
    // MYT-73: default to an EMPTY working set so the merge is a no-op unless a
    // test injects items; the real cosine helper is the harmless default.
    workingSet: vi.fn<() => Promise<WorkingSetItem[]>>().mockResolvedValue([]),
    cosine: realCosine,
    ...overrides,
  }
}

/** A minimal real cosine for the working-set merge tests — same contract as the
 *  wiring's `cosineSimilarity` (empty/zero/mismatched → 0). Kept local so the
 *  ft-tools tests don't depend on lookup-wiring's export. */
function realCosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Build a WorkingSetItem with sane defaults — overridable per test. */
function makeWsItem(overrides: Partial<WorkingSetItem> = {}): WorkingSetItem {
  return {
    id: 'ws-1',
    turnId: 'turn-1',
    kind: 'fact',
    content: 'A working-set fact invented earlier this session.',
    subjectName: 'the smuggler Ket',
    tier: 'known',
    provenance: { kind: 'objective' },
    source: 'st_injection',
    embedding: [1, 0, 0],
    ...overrides,
  }
}

/** The MYT-75 combat surface added to FtToolDeps. `combatParty` projects the
 *  per-turn party-ledger snapshot to `CombatPartyMember[]`; `recordCombat` is
 *  the per-turn sink; `pendingInitiate` returns the last recorded initiate
 *  event (or null). Overridable per test so a combat-tool test can seed a
 *  pending initiate or assert what the tool recorded. */
interface CombatSurface {
  combatParty: FtToolDeps['combatParty']
  recordCombat: FtToolDeps['recordCombat']
  pendingInitiate: FtToolDeps['pendingInitiate']
}

const DEFAULT_COMBAT_PARTY: readonly CombatPartyMember[] = [
  { characterId: 'char-1', name: 'Vire', level: 3, hp: 20, maxHp: 20 },
]

function makeCombatSurface(overrides: Partial<CombatSurface> = {}): CombatSurface {
  return {
    combatParty: vi
      .fn<() => Promise<readonly CombatPartyMember[]>>()
      .mockResolvedValue(DEFAULT_COMBAT_PARTY),
    recordCombat: vi.fn(),
    pendingInitiate: vi.fn<() => InitiateCombatEvent | null>().mockReturnValue(null),
    ...overrides,
  }
}

/** SkillCheckDeps minus abortSignal — buildFtTools threads the SDK signal in.
 *  The Rules Lawyer ledger surface defaults to an all-throwing fake (tests that
 *  exercise a ledger tool pass their own stubbed ledger + tx). The MYT-72 lookup
 *  surface defaults to harmless fakes; lookup-tool tests override per case. The
 *  MYT-75 combat surface defaults to a one-PC party + a fresh recordCombat spy +
 *  no pending initiate. */
function makeDeps(
  mech: MechanicalReads,
  ledger: LedgerOps = fakeLedger(),
  runInTx: LedgerTxRunner = passthroughTx(ledger),
  lookup: LookupSurface = makeLookupSurface(),
  combat: CombatSurface = makeCombatSurface(),
  // myth-ph544 gate: default OFF (empty roster ⇒ isSilentPc always false), so
  // existing tests are unaffected; gate tests pass a roster + acting set.
  participantNames: readonly string[] = [],
  actingCharacters: ReadonlySet<string> = new Set<string>(),
): FtToolDeps {
  return {
    mech,
    sessionId: 'session-1',
    worldTone: 'grim and rain-soaked',
    ledger,
    runInTx,
    turnId: 'turn-1',
    ...lookup,
    ...combat,
    participantNames,
    actingCharacters,
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

describe('myth-ph544 — player-agency tool gate', () => {
  const ROSTER = ['Brenna Kell', 'Onwe Tass']

  it('roll_skill_check REFUSES a PC who did not act this turn', async () => {
    // acting = only Brenna; the FT tries to roll for the silent Onwe.
    const deps = makeDeps(foundMech(makeCharacter(), []), fakeLedger(), undefined, undefined, undefined, ROSTER, new Set(['brenna kell']))
    const out = (await requireExecute(buildFtTools(deps), 'roll_skill_check')(
      { character_name: 'Onwe Tass', skill: 'Arcana', context: 'recalling seal lore' },
      callOpts(),
    )) as { error?: string }
    expect(out.error).toMatch(/another player'?s character/i)
    // gated BEFORE resolution — the Haiku DC table is never touched.
    expect(mockGenerateText).not.toHaveBeenCalled()
  })

  it('roll_skill_check ALLOWS a PC who acted this turn (proceeds to resolution)', async () => {
    mockDcTableOnce()
    const mech = foundMech(makeCharacter(), [{ skill_name: 'Arcana', proficiency_level: 'proficient' }])
    const deps = makeDeps(mech, fakeLedger(), undefined, undefined, undefined, ROSTER, new Set(['onwe tass']))
    const out = (await requireExecute(buildFtTools(deps, scriptedRng(12)), 'roll_skill_check')(
      { character_name: 'Onwe Tass', skill: 'Arcana', context: 'recalling seal lore' },
      callOpts(),
    )) as { error?: string; constraint?: string }
    expect(out.error ?? '').not.toMatch(/another player'?s character/i)
    expect(out.constraint).toBeDefined()
  })

  it('search_lore REFUSES a knowledge lookup asked AS a silent PC', async () => {
    const deps = makeDeps(foundMech(makeCharacter(), []), fakeLedger(), undefined, undefined, undefined, ROSTER, new Set(['brenna kell']))
    const out = (await requireExecute(buildFtTools(deps), 'search_lore')(
      { channel: 'dm', skill: 'arcana', asker_name: 'Onwe Tass', topic: 'forged guild seals' },
      callOpts(),
    )) as { result?: string }
    expect(out.result).toMatch(/belongs to Onwe Tass'?s player|recall it on their behalf/i)
  })

  it('search_lore ALLOWS an NPC asker (name outside the PC roster)', async () => {
    // NPC asker not in the roster → gate passes → real fail-soft resolution.
    const deps = makeDeps(
      foundMech(makeCharacter(), []),
      fakeLedger(),
      undefined,
      makeLookupSurface({ resolveEntityId: vi.fn().mockResolvedValue(null) }),
      undefined,
      ROSTER,
      new Set(),
    )
    const out = (await requireExecute(buildFtTools(deps), 'search_lore')(
      { channel: 'npc', asker_name: 'Bel the keeper', topic: 'the pass road lamps' },
      callOpts(),
    )) as { result?: string }
    expect(out.result ?? '').not.toMatch(/belongs to .*player/i)
  })
})

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

describe('issue_correction tool (myth-d6knq §correction-channel)', () => {
  it('is a pure resolver that echoes the correction text as data (no emit surface)', async () => {
    const tools = buildFtTools(makeDeps(foundMech(makeCharacter(), [])))
    const correctionTool = tools.issue_correction
    if (correctionTool === undefined) throw new Error('issue_correction missing')
    for (const k of Object.keys(correctionTool)) {
      expect(['description', 'inputSchema', 'execute', 'type']).toContain(k)
    }
    const out = await requireExecute(tools, 'issue_correction')(
      { text: 'Earlier I named the ferryman Coss; it is Trask.' },
      callOpts(),
    )
    expect(out).toEqual({ text: 'Earlier I named the ferryman Coss; it is Trask.' })
  })

  it('ISSUE_CORRECTION_INPUT rejects empty text', () => {
    expect(ISSUE_CORRECTION_INPUT.safeParse({ text: '' }).success).toBe(false)
    expect(ISSUE_CORRECTION_INPUT.safeParse({ text: 'ok' }).success).toBe(true)
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
  vetMode: 'relay',
  vetTier: 'known',
}

/** A relay with NO skill-gate frame — drives `toToolResult`'s `?? null` arm
 *  (the npc-channel relay carries no skill check, so `skillGateFrame` is
 *  undefined and the tool result's `skill_gate` is null). */
const RELAY_NO_FRAME: WorldFactLookupResult = {
  relayText: 'The Steward inclines their head, recalling the old road.',
  rollHidden: true,
  vetMode: 'relay',
  vetTier: 'discoverable',
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
    expect(charactersKnownTo).toHaveBeenCalledWith('subj-1', expect.any(Number), ['known'])
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
    expect(charactersKnownTo).toHaveBeenCalledWith('subj-1', expect.any(Number), ['known'])
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
      .mockResolvedValue({ mode: 'relay', text: 't', tier: 'known', repairAttempted: false })
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

// ===========================================================================
// MYT-73 — recordInjection: a lookup whose ST-vet RELAYED or INVENTED a fact
// records it into the turn-scoped working set. The recorded fact carries the
// VETTED relay text (secret-free, from the orchestrator), the ST's tier, and
// channel-derived provenance: DM → objective; NPC → attributed (the resolved
// NPC entity id/name). `none`/fail-soft modes record NOTHING.
// ===========================================================================

/** An invent-mode result (DM channel, with a frame) — records an injection. */
const INVENT: WorldFactLookupResult = {
  relayText: 'You half-recall a smuggler named Ket who once ran these tunnels.',
  rollHidden: false,
  vetMode: 'invent',
  vetTier: 'discoverable',
}

/** A none-mode result — the truthful "nothing" relay; records NOTHING. */
const NONE: WorldFactLookupResult = {
  relayText: 'You search your memory and come up empty.',
  rollHidden: false,
  vetMode: 'none',
  vetTier: null,
}

/** A fail-soft result — degraded relay; records NOTHING. */
const FAIL_SOFT: WorldFactLookupResult = {
  relayText: "You can't quite bring it to mind.",
  rollHidden: false,
  vetMode: 'fail_soft',
  vetTier: null,
}

/** A relay with a null tier — defensive: the orchestrator never produces
 *  relay+null, but the type allows it, so the `vetTier ?? 'known'` fallback
 *  stamps 'known'. */
const RELAY_NULL_TIER: WorldFactLookupResult = {
  relayText: 'A faint recollection surfaces.',
  rollHidden: false,
  vetMode: 'relay',
  vetTier: null,
}

describe('lookup tools — recordInjection (MYT-73 working-set sink)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dm relay records an objective fact with the relay text, topic subject, and the ST tier', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const recordInjection = vi.fn()
    const mech = foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }])
    const deps = makeDeps(mech, fakeLedger(), undefined, makeLookupSurface({ recordInjection }))
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    await exec(
      { channel: 'dm', topic: 'the Ashen Compact', skill: 'history', asker_name: 'Vire' },
      callOpts(),
    )

    expect(recordInjection).toHaveBeenCalledTimes(1)
    expect(recordInjection).toHaveBeenCalledWith({
      kind: 'fact',
      content: RELAY.relayText,
      subjectName: 'the Ashen Compact',
      tier: 'known',
      provenance: { kind: 'objective' },
      source: 'st_injection',
    })
  })

  it('a relay with a null vetTier falls back to the known tier (defensive)', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY_NULL_TIER)
    const recordInjection = vi.fn()
    const mech = foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }])
    const deps = makeDeps(mech, fakeLedger(), undefined, makeLookupSurface({ recordInjection }))
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    await exec({ channel: 'dm', topic: 'the Ashen Compact', skill: 'history', asker_name: 'Vire' }, callOpts())

    expect(recordInjection).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'known', source: 'st_injection' }),
    )
  })

  it('dm invent records an objective fact (invent is recorded like relay)', async () => {
    mockRunWorldFactLookup.mockResolvedValue(INVENT)
    const recordInjection = vi.fn()
    const mech = foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }])
    const deps = makeDeps(mech, fakeLedger(), undefined, makeLookupSurface({ recordInjection }))
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    await exec({ channel: 'dm', topic: 'the tunnels', skill: 'history', asker_name: 'Vire' }, callOpts())

    expect(recordInjection).toHaveBeenCalledTimes(1)
    expect(recordInjection).toHaveBeenCalledWith(
      expect.objectContaining({
        content: INVENT.relayText,
        subjectName: 'the tunnels',
        tier: 'discoverable',
        provenance: { kind: 'objective' },
        source: 'st_injection',
      }),
    )
  })

  it('npc relay records an ATTRIBUTED fact carrying the resolved NPC entity id + name', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY_NO_FRAME)
    const recordInjection = vi.fn()
    const resolveEntityId = vi.fn().mockResolvedValue('npc-7')
    const deps = makeDeps(
      foundMech(makeCharacter(), []),
      fakeLedger(),
      undefined,
      makeLookupSurface({ recordInjection, resolveEntityId }),
    )
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    await exec({ channel: 'npc', topic: 'the old road', asker_name: 'The Steward' }, callOpts())

    expect(recordInjection).toHaveBeenCalledTimes(1)
    expect(recordInjection).toHaveBeenCalledWith({
      kind: 'fact',
      content: RELAY_NO_FRAME.relayText,
      subjectName: 'the old road',
      tier: 'discoverable',
      provenance: { kind: 'attributed', npcEntityId: 'npc-7', npcName: 'The Steward' },
      source: 'st_injection',
    })
  })

  it('characters_known_to records the SUBJECT character as subjectName', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const recordInjection = vi.fn()
    const resolveEntityId = vi.fn().mockResolvedValue('subj-1')
    const charactersKnownTo = vi.fn().mockResolvedValue([])
    const deps = makeDeps(
      foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }]),
      fakeLedger(),
      undefined,
      makeLookupSurface({ recordInjection, resolveEntityId, graph: fakeGraph({ charactersKnownTo }) }),
    )
    const exec = requireExecute(buildFtTools(deps), 'characters_known_to')

    await exec(
      { channel: 'dm', character: 'The Spymaster', skill: 'history', asker_name: 'Vire' },
      callOpts(),
    )

    expect(recordInjection).toHaveBeenCalledWith(
      expect.objectContaining({ subjectName: 'The Spymaster' }),
    )
  })

  it('faction_tree records the SUBJECT faction as subjectName', async () => {
    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const recordInjection = vi.fn()
    const resolveEntityId = vi.fn().mockResolvedValue('fac-1')
    const factionTree = vi.fn().mockResolvedValue([])
    const deps = makeDeps(
      foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }]),
      fakeLedger(),
      undefined,
      makeLookupSurface({ recordInjection, resolveEntityId, graph: fakeGraph({ factionTree }) }),
    )
    const exec = requireExecute(buildFtTools(deps), 'faction_tree')

    await exec(
      { channel: 'dm', faction: 'The Compact', skill: 'history', asker_name: 'Vire' },
      callOpts(),
    )

    expect(recordInjection).toHaveBeenCalledWith(
      expect.objectContaining({ subjectName: 'The Compact' }),
    )
  })

  it('a none-mode relay records NOTHING (no fact to inject)', async () => {
    mockRunWorldFactLookup.mockResolvedValue(NONE)
    const recordInjection = vi.fn()
    const mech = foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }])
    const deps = makeDeps(mech, fakeLedger(), undefined, makeLookupSurface({ recordInjection }))
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    await exec({ channel: 'dm', topic: 'x', skill: 'history', asker_name: 'Vire' }, callOpts())

    expect(recordInjection).not.toHaveBeenCalled()
  })

  it('a fail-soft relay records NOTHING (degraded text is never a vetted fact)', async () => {
    mockRunWorldFactLookup.mockResolvedValue(FAIL_SOFT)
    const recordInjection = vi.fn()
    const mech = foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }])
    const deps = makeDeps(mech, fakeLedger(), undefined, makeLookupSurface({ recordInjection }))
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    await exec({ channel: 'dm', topic: 'x', skill: 'history', asker_name: 'Vire' }, callOpts())

    expect(recordInjection).not.toHaveBeenCalled()
  })

  it('an asker-resolution fail-soft (vet never ran) records NOTHING', async () => {
    // dm channel without a skill → resolveAsker fail-softs, runWorldFactLookup is
    // NEVER called, so there is no orchestrator result to record.
    const recordInjection = vi.fn()
    const deps = makeDeps(foundMech(makeCharacter(), []), fakeLedger(), undefined, makeLookupSurface({ recordInjection }))
    const exec = requireExecute(buildFtTools(deps), 'search_lore')

    await exec({ channel: 'dm', topic: 'x', asker_name: 'Vire' }, callOpts())

    expect(mockRunWorldFactLookup).not.toHaveBeenCalled()
    expect(recordInjection).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// MYT-73 — search_lore working-set merge (read-after-write). The resolve closure
// the tool hands the orchestrator merges the per-turn working set (cosine-ranked
// against the SAME queryVec searchLore embedded) INTO the canon LoreHit[] BEFORE
// renderLoreHits collapses to a string. The merged working-set hits funnel to the
// ST-vet exactly as canon hits do — the tier-gate boundary is UNCHANGED. NPC-
// attributed items render as a `[claim by {npc}]` claim, never objective truth.
// We assert the `results` STRING the captured resolve closure returns (the ST-vet
// reads this rendered string), invoking it just like world-fact-lookup does.
// ===========================================================================

/** A canon hit set fixture for the merge (one objective known fact). */
const CANON_HITS = [
  {
    source: 'fact' as const,
    entityId: 'e1',
    entityName: 'Ashen Compact',
    content: 'A pact between three houses.',
    accessLevel: 'known' as const,
    score: 0.9,
  },
]

/** Drive search_lore on the DM channel with a stubbed searchLore + working set,
 *  then return the `results` string the captured resolve closure produces. */
async function resolvedSearchResults(lookup: Partial<LookupSurface>): Promise<string> {
  mockRunWorldFactLookup.mockResolvedValue(RELAY)
  const mech = foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }])
  const deps = makeDeps(mech, fakeLedger(), undefined, makeLookupSurface(lookup))
  const exec = requireExecute(buildFtTools(deps), 'search_lore')
  await exec({ channel: 'dm', topic: 'the smuggler Ket', skill: 'history', asker_name: 'Vire' }, callOpts())
  const resolved = await capturedResolve()()
  return resolved.results
}

describe('search_lore working-set merge (MYT-73)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('merges a near-query working-set item into the rendered results block', async () => {
    const searchLore = vi.fn().mockResolvedValue({ hits: CANON_HITS, queryVec: [1, 0, 0] })
    const wsItem = makeWsItem({ embedding: [1, 0, 0], content: 'Ket runs the river tunnels.' })
    const workingSet = vi.fn<() => Promise<WorkingSetItem[]>>().mockResolvedValue([wsItem])

    const results = await resolvedSearchResults({
      search: fakeSearch({ searchLore }),
      workingSet,
    })

    // Canon hit is preserved…
    expect(results).toContain('[tier=known] Ashen Compact: A pact between three houses.')
    // …and the working-set item is appended as a tier-annotated line.
    expect(results).toContain('Ket runs the river tunnels.')
    expect(results).toContain('[tier=known]')
    expect(workingSet).toHaveBeenCalledTimes(1)
  })

  it('an attributed working-set item renders a [claim by {npc}] prefix', async () => {
    const searchLore = vi.fn().mockResolvedValue({ hits: [], queryVec: [1, 0, 0] })
    const wsItem = makeWsItem({
      embedding: [1, 0, 0],
      content: 'The harbor answers to the Steward.',
      provenance: { kind: 'attributed', npcEntityId: 'npc-7', npcName: 'The Steward' },
    })
    const workingSet = vi.fn<() => Promise<WorkingSetItem[]>>().mockResolvedValue([wsItem])

    const results = await resolvedSearchResults({
      search: fakeSearch({ searchLore }),
      workingSet,
    })

    // Attributed items render as a claim — never objective truth.
    expect(results).toContain('[claim by The Steward]')
    expect(results).toContain('The harbor answers to the Steward.')
  })

  it('a secret-tier working-set item is still merged (gated DOWNSTREAM by the ST-vet, not filtered)', async () => {
    const searchLore = vi.fn().mockResolvedValue({ hits: [], queryVec: [1, 0, 0] })
    const wsItem = makeWsItem({
      embedding: [1, 0, 0],
      tier: 'secret',
      content: 'The Steward is the lost heir.',
    })
    const workingSet = vi.fn<() => Promise<WorkingSetItem[]>>().mockResolvedValue([wsItem])

    const results = await resolvedSearchResults({
      search: fakeSearch({ searchLore }),
      workingSet,
    })

    // Over-pull boundary is UNCHANGED: the secret-tier item appears in the block
    // the ST-vet reads (the vet tier-gates it; the tool never filters it out).
    expect(results).toContain('[tier=secret]')
    expect(results).toContain('The Steward is the lost heir.')
  })

  it('skips working-set items with an empty embedding (cannot be cosine-ranked)', async () => {
    const searchLore = vi.fn().mockResolvedValue({ hits: CANON_HITS, queryVec: [1, 0, 0] })
    const wsItem = makeWsItem({ embedding: [], content: 'An un-embeddable orphan fact.' })
    const workingSet = vi.fn<() => Promise<WorkingSetItem[]>>().mockResolvedValue([wsItem])

    const results = await resolvedSearchResults({
      search: fakeSearch({ searchLore }),
      workingSet,
    })

    // Canon survives; the empty-embedding ws item is skipped.
    expect(results).toContain('A pact between three houses.')
    expect(results).not.toContain('An un-embeddable orphan fact.')
  })

  it('an empty working set leaves the canon block untouched', async () => {
    const searchLore = vi.fn().mockResolvedValue({ hits: CANON_HITS, queryVec: [1, 0, 0] })
    const workingSet = vi.fn<() => Promise<WorkingSetItem[]>>().mockResolvedValue([])

    const results = await resolvedSearchResults({
      search: fakeSearch({ searchLore }),
      workingSet,
    })

    expect(results).toBe('[tier=known] Ashen Compact: A pact between three houses.')
  })

  it('drops working-set items scoring below the floor (low cosine to the query)', async () => {
    const searchLore = vi.fn().mockResolvedValue({ hits: [], queryVec: [1, 0, 0] })
    // Orthogonal embedding → cosine 0 → below the small floor → dropped.
    const wsItem = makeWsItem({ embedding: [0, 1, 0], content: 'An unrelated working-set fact.' })
    const workingSet = vi.fn<() => Promise<WorkingSetItem[]>>().mockResolvedValue([wsItem])

    const results = await resolvedSearchResults({
      search: fakeSearch({ searchLore }),
      workingSet,
    })

    expect(results).not.toContain('An unrelated working-set fact.')
  })

  it('caps the merged working-set hits at the top-K by cosine score', async () => {
    const searchLore = vi.fn().mockResolvedValue({ hits: [], queryVec: [1, 0, 0] })
    // 7 items, all above the floor (decreasing similarity); only the top 5 merge.
    const items = Array.from({ length: 7 }, (_, i) =>
      makeWsItem({
        id: `ws-${String(i)}`,
        // x-component shrinks → cosine to [1,0,0] decreases but stays > floor.
        embedding: [1, (i + 1) * 0.05, 0],
        content: `Working-set fact number ${String(i)}.`,
      }),
    )
    const workingSet = vi.fn<() => Promise<WorkingSetItem[]>>().mockResolvedValue(items)

    const results = await resolvedSearchResults({
      search: fakeSearch({ searchLore }),
      workingSet,
    })

    // The 5 highest-cosine (lowest-index) merge; the 2 weakest are dropped.
    const merged = results.split('\n').filter((l) => l.includes('Working-set fact number'))
    expect(merged).toHaveLength(5)
    expect(results).toContain('Working-set fact number 0.')
    expect(results).not.toContain('Working-set fact number 6.')
  })

  it('reports a non-empty merge even when canon is empty (working set alone)', async () => {
    const searchLore = vi.fn().mockResolvedValue({ hits: [], queryVec: [1, 0, 0] })
    const wsItem = makeWsItem({ embedding: [1, 0, 0], content: 'Only the working set knows this.' })
    const workingSet = vi.fn<() => Promise<WorkingSetItem[]>>().mockResolvedValue([wsItem])

    mockRunWorldFactLookup.mockResolvedValue(RELAY)
    const mech = foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }])
    const deps = makeDeps(mech, fakeLedger(), undefined, makeLookupSurface({ search: fakeSearch({ searchLore }), workingSet }))
    const exec = requireExecute(buildFtTools(deps), 'search_lore')
    await exec({ channel: 'dm', topic: 'the smuggler Ket', skill: 'history', asker_name: 'Vire' }, callOpts())

    const resolved = await capturedResolve()()
    // The merged block is non-empty → empty:false even though canon was empty.
    expect(resolved.empty).toBe(false)
    expect(resolved.results).toContain('Only the working set knows this.')
  })
})

// ===========================================================================
// MYT-73 — graph-closure working-set merge. characters_known_to / faction_tree
// flat-append the turn's working-set GRAPH items (entity / relationship) as
// extra tier-annotated lines. A relationship renders its edge; an entity with a
// parentName renders a structural anchor; a bare entity renders a flat node. An
// attributed item gets a `[claim by {npc}]` prefix. Fact-kind items are skipped
// (they merge into search_lore, not the graph walk).
// ===========================================================================

/** Drive a graph tool (characters_known_to / faction_tree) on the DM channel
 *  with a stubbed graph walk + working set, then return the captured resolve
 *  closure's `results` string. */
async function resolvedGraphResults(
  tool: 'characters_known_to' | 'faction_tree',
  graphOverride: Partial<GraphDeps['repo']['worldRetrieval']>,
  ws: WorkingSetItem[],
  subjectArg: Record<string, unknown>,
): Promise<{ results: string; empty: boolean }> {
  mockRunWorldFactLookup.mockResolvedValue(RELAY)
  const resolveEntityId = vi.fn().mockResolvedValue('subj-1')
  const workingSet = vi.fn<() => Promise<WorkingSetItem[]>>().mockResolvedValue(ws)
  const deps = makeDeps(
    foundMech(makeCharacter(), [{ skill_name: 'History', proficiency_level: 'proficient' }]),
    fakeLedger(),
    undefined,
    makeLookupSurface({ resolveEntityId, workingSet, graph: fakeGraph(graphOverride) }),
  )
  const exec = requireExecute(buildFtTools(deps), tool)
  await exec({ channel: 'dm', skill: 'history', asker_name: 'Vire', ...subjectArg }, callOpts())
  const resolved = await capturedResolve()()
  return { results: resolved.results, empty: resolved.empty }
}

describe('characters_known_to working-set merge (MYT-73)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('flat-appends a relationship item rendering its edge after the canon walk', async () => {
    const charactersKnownTo = vi
      .fn()
      .mockResolvedValue([
        { entity_id: 'k1', name: 'Mara', entity_type: 'npc', access_level: 'known', depth: 1 },
      ])
    const relItem = makeWsItem({
      kind: 'relationship',
      content: 'They were seen conspiring at the docks.',
      subjectName: 'The Spymaster',
      edge: { fromName: 'The Spymaster', toName: 'Doran', relType: 'allied-with' },
      tier: 'discoverable',
    })

    const { results } = await resolvedGraphResults(
      'characters_known_to',
      { charactersKnownTo },
      [relItem],
      { character: 'The Spymaster' },
    )

    // Canon walk line preserved…
    expect(results).toContain('[tier=known] Mara (depth 1)')
    // …and the relationship working-set item renders its edge.
    expect(results).toContain('The Spymaster —allied-with→ Doran')
    expect(results).toContain('[tier=discoverable]')
    expect(results).toContain('They were seen conspiring at the docks.')
  })

  it('renders an attributed entity item with a [claim by {npc}] prefix and a flat node', async () => {
    const charactersKnownTo = vi.fn().mockResolvedValue([])
    const entItem = makeWsItem({
      kind: 'entity',
      content: 'A masked courier the Spymaster uses.',
      subjectName: 'The Courier',
      provenance: { kind: 'attributed', npcEntityId: 'npc-7', npcName: 'Mara' },
      tier: 'known',
    })

    const { results } = await resolvedGraphResults(
      'characters_known_to',
      { charactersKnownTo },
      [entItem],
      { character: 'The Spymaster' },
    )

    expect(results).toContain('[claim by Mara]')
    // A bare entity (no edge/parentName) renders a flat node = subjectName.
    expect(results).toContain('The Courier: A masked courier the Spymaster uses.')
  })

  it('skips fact-kind working-set items (graph-irrelevant)', async () => {
    const charactersKnownTo = vi.fn().mockResolvedValue([])
    const factItem = makeWsItem({ kind: 'fact', content: 'A fact, not a graph edge.' })

    const { results, empty } = await resolvedGraphResults(
      'characters_known_to',
      { charactersKnownTo },
      [factItem],
      { character: 'The Spymaster' },
    )

    expect(results).not.toContain('A fact, not a graph edge.')
    // No canon rows + only a (skipped) fact item → genuinely empty.
    expect(empty).toBe(true)
  })
})

describe('faction_tree working-set merge (MYT-73)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('flat-appends an entity item with a parentName as a structural anchor', async () => {
    const factionTree = vi.fn().mockResolvedValue([
      { entity_id: 'fac-1', name: 'The Compact', entity_type: 'faction', access_level: 'known', parent_id: null, depth: 0 },
    ])
    const entItem = makeWsItem({
      kind: 'entity',
      content: 'A splinter cell formed this session.',
      subjectName: 'The Ember Hand',
      parentName: 'The Compact',
      tier: 'secret',
    })

    const { results, empty } = await resolvedGraphResults(
      'faction_tree',
      { factionTree },
      [entItem],
      { faction: 'The Compact' },
    )

    // Canon node preserved…
    expect(results).toContain('[tier=known] The Compact (parent root, depth 0)')
    // …and the working-set entity renders its parent anchor + tier.
    expect(results).toContain('The Ember Hand (under The Compact)')
    expect(results).toContain('[tier=secret]')
    expect(empty).toBe(false)
  })

  it('an empty canon walk with a working-set item alone is non-empty (ws-only recall)', async () => {
    // No canon nodes (nodes.length === 0 true) but a working-set entity present →
    // the `&& wsLines.length === 0` arm is evaluated false → empty:false.
    const factionTree = vi.fn().mockResolvedValue([])
    const entItem = makeWsItem({
      kind: 'entity',
      content: 'A cell that exists only in this session so far.',
      subjectName: 'The Ember Hand',
      tier: 'discoverable',
    })

    const { results, empty } = await resolvedGraphResults(
      'faction_tree',
      { factionTree },
      [entItem],
      { faction: 'The Compact' },
    )

    expect(empty).toBe(false)
    expect(results).toContain('The Ember Hand: A cell that exists only in this session so far.')
  })
})

// ---------------------------------------------------------------------------
// MYT-75 Task 6 — the two combat FT tools. PURE DATA RESOLVERS: execute returns
// DATA, mutates no session state, emits no frame; it records its decision into
// the per-turn `recordCombat` sink the worker reads post-turn (T7). The
// `initiate_combat` outcome comes from the REAL `resolveCombat` (Haiku DC table
// mocked at the `'ai'` boundary, same scaffold as outcome.test.ts); the
// `resolve_combat` reconciliation runs the REAL `reconcileDeltas`.
// ---------------------------------------------------------------------------

// A combat DC outcome table (the §4 four-tier shape). dc 15 lets the scripted
// roll + capability land a deterministic tier.
const COMBAT_TABLE = {
  dc: 15,
  outcomes: {
    routed: 'The party is driven from the field, but survives.',
    pyrrhic: 'The party wins, but a comrade is downed.',
    costly: 'The party wins the fight, bloodied.',
    decisive: 'The party wins cleanly.',
  },
}

function mockCombatTableOnce(table = COMBAT_TABLE): void {
  mockGenerateText.mockResolvedValueOnce({
    output: table,
    finishReason: 'stop',
    usage: HAIKU_USAGE,
  } as never)
}

const COMBAT_ENEMIES = [
  { name: 'Goblin', description: 'scrawny raider', count: 4 },
]

describe('INITIATE_COMBAT_INPUT', () => {
  it('requires at least one enemy with name/description/positive count', () => {
    expect(INITIATE_COMBAT_INPUT.safeParse({ enemies: [], environment: 'x', surprise: 'none' }).success).toBe(false)
    expect(
      INITIATE_COMBAT_INPUT.safeParse({
        enemies: [{ name: 'Goblin', description: 'raider', count: 0 }],
        environment: 'x',
        surprise: 'none',
      }).success,
    ).toBe(false)
    expect(
      INITIATE_COMBAT_INPUT.safeParse({
        enemies: [{ name: 'Goblin', description: 'raider', count: 4 }],
        environment: 'a mineshaft',
        surprise: 'none',
      }).success,
    ).toBe(true)
  })

  it('rejects an unknown surprise enum', () => {
    expect(
      INITIATE_COMBAT_INPUT.safeParse({
        enemies: [{ name: 'Goblin', description: 'raider', count: 1 }],
        environment: 'x',
        surprise: 'ambush',
      }).success,
    ).toBe(false)
  })
})

describe('RESOLVE_COMBAT_INPUT', () => {
  it('requires narration; defaults the four delta arrays to []', () => {
    expect(RESOLVE_COMBAT_INPUT.safeParse({ narration: '' }).success).toBe(false)
    const parsed = RESOLVE_COMBAT_INPUT.parse({ narration: 'The fight ends.' })
    expect(parsed.hp_changes).toEqual([])
    expect(parsed.conditions_applied).toEqual([])
    expect(parsed.conditions_removed).toEqual([])
    expect(parsed.casualties).toEqual([])
  })

  it('rejects negative damage/healing and an unknown casualty fate', () => {
    expect(
      RESOLVE_COMBAT_INPUT.safeParse({
        narration: 'x',
        hp_changes: [{ combatant_name: 'Vire', damage: -1, healing: 0 }],
      }).success,
    ).toBe(false)
    expect(
      RESOLVE_COMBAT_INPUT.safeParse({
        narration: 'x',
        casualties: [{ combatant_name: 'Goblin', fate: 'banished' }],
      }).success,
    ).toBe(false)
  })
})

describe('initiate_combat tool', () => {
  beforeEach(() => vi.clearAllMocks())

  it('execute returns {ok, enemies, initiative, outcome_tier, constraint} and records an initiate event', async () => {
    mockCombatTableOnce() // dc 15
    const recordCombat = vi.fn()
    // One PC (level 3 → capability 3). The party rolls d20=10, the enemy d20=18;
    // resolveCombat re-rolls its own d20=14 for the outcome. capability 3 + 14 =
    // 17 ≥ dc(15) but < dc+7 → costly.
    const combat = makeCombatSurface({
      combatParty: vi
        .fn<() => Promise<readonly CombatPartyMember[]>>()
        .mockResolvedValue([{ characterId: 'char-1', name: 'Vire', level: 3, hp: 30, maxHp: 30 }]),
      recordCombat,
    })
    const deps = makeDeps(foundMech(makeCharacter(), []), fakeLedger(), undefined, makeLookupSurface(), combat)
    // Scripted RNG: party initiative d20=10, enemy initiative d20=18, then the
    // resolveCombat outcome d20=14.
    const exec = requireExecute(buildFtTools(deps, scriptedRng(10, 18, 14)), 'initiate_combat')

    const result = (await exec(
      { enemies: COMBAT_ENEMIES, environment: 'a collapsed mineshaft', surprise: 'none' },
      callOpts(),
    )) as {
      ok: true
      enemies: typeof COMBAT_ENEMIES
      initiative: readonly { combatant: string; roll: number }[]
      outcome_tier: string
      constraint: string
    }

    expect(result.ok).toBe(true)
    expect(result.enemies).toEqual(COMBAT_ENEMIES)
    // Initiative: one entry per PC, then one per enemy name.
    expect(result.initiative).toEqual([
      { combatant: 'Vire', roll: 10 },
      { combatant: 'Goblin', roll: 18 },
    ])
    expect(result.outcome_tier).toBe('costly')
    expect(result.constraint).toBe(COMBAT_TABLE.outcomes.costly)

    // The sink recorded ONE initiate event with the outcome + setup.
    expect(recordCombat).toHaveBeenCalledTimes(1)
    const event = recordCombat.mock.calls[0]?.[0] as CombatEvent
    expect(event.kind).toBe('initiate')
    if (event.kind !== 'initiate') throw new Error('expected initiate event')
    expect(event.outcome.tier).toBe('costly')
    expect(event.outcome.tierProse).toBe(COMBAT_TABLE.outcomes.costly)
    expect(event.enemies).toEqual(COMBAT_ENEMIES)
    expect(event.environment).toBe('a collapsed mineshaft')
    expect(event.surprise).toBe('none')
    expect(event.initiative).toEqual(result.initiative)
  })

  it('is a pure resolver — no state mutation beyond the recordCombat sink (no frame surface)', () => {
    mockCombatTableOnce()
    const deps = makeDeps(foundMech(makeCharacter(), []))
    const initiateTool = buildFtTools(deps, scriptedRng(10, 18, 14)).initiate_combat
    if (initiateTool === undefined) throw new Error('initiate_combat missing')
    for (const k of Object.keys(initiateTool)) {
      expect(['description', 'inputSchema', 'execute', 'type']).toContain(k)
    }
  })

  it("threads the SDK's abortSignal into resolveCombat and works with production rng (no injected rng)", async () => {
    mockCombatTableOnce()
    const controller = new AbortController()
    // No injected rng → the engine uses crypto.randomInt (the `rng === undefined`
    // spread arm). The Haiku table is still mocked, so resolveCombat completes.
    const deps = makeDeps(foundMech(makeCharacter(), []))
    const exec = requireExecute(buildFtTools(deps), 'initiate_combat')

    const result = (await exec(
      { enemies: COMBAT_ENEMIES, environment: 'a mineshaft', surprise: 'none' },
      callOpts({ abortSignal: controller.signal }),
    )) as { ok: true; initiative: readonly { combatant: string; roll: number }[] }

    expect(result.ok).toBe(true)
    // The combined abort signal threaded into resolveCombat's Haiku call.
    const sdkOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as { abortSignal: AbortSignal }
    expect(sdkOpts.abortSignal).toBeInstanceOf(AbortSignal)
    expect(sdkOpts.abortSignal.aborted).toBe(false)
    controller.abort()
    expect(sdkOpts.abortSignal.aborted).toBe(true)
    // Initiative rolls are real d20s in [1, 20].
    for (const i of result.initiative) {
      expect(i.roll).toBeGreaterThanOrEqual(1)
      expect(i.roll).toBeLessThanOrEqual(20)
    }
  })

  it('on a Haiku DC-table failure, the fail-soft warn forwards through the FT logger (combatLogger adapter)', async () => {
    // resolveCombat is TOTAL: a Haiku reject falls back to the tier-neutral table
    // and warns through the injected logger. The combat tool adapts the FT
    // logger's `(o: Record, …)` warn to resolveCombat's `(o: unknown, …)`.
    mockGenerateText.mockRejectedValueOnce(new Error('haiku 529 overloaded'))
    const warn = vi.fn<(o: Record<string, unknown>, m: string) => void>()
    const recordCombat = vi.fn()
    const deps: FtToolDeps = {
      ...makeDeps(foundMech(makeCharacter(), []), fakeLedger(), undefined, makeLookupSurface(), makeCombatSurface({ recordCombat })),
      logger: { warn },
    }
    const exec = requireExecute(buildFtTools(deps, scriptedRng(10, 18, 14)), 'initiate_combat')

    const result = (await exec(
      { enemies: COMBAT_ENEMIES, environment: 'a mineshaft', surprise: 'none' },
      callOpts(),
    )) as { ok: true; outcome_tier: string }

    // Still produced an outcome (fail-soft fallback, dc 15).
    expect(result.ok).toBe(true)
    // The adapter forwarded the fail-soft warn (object bindings narrowed via
    // asLogObject), proving line 1031 + asLogObject's object arm.
    expect(warn).toHaveBeenCalledWith(
      { err: new Error('haiku 529 overloaded') },
      'combat-outcome: DC table failed; using fallback',
    )
    expect(recordCombat).toHaveBeenCalledTimes(1)
  })
})

describe('resolve_combat tool', () => {
  beforeEach(() => vi.clearAllMocks())

  /** A fixed initiate event the pendingInitiate stub returns — a costly outcome
   *  (partyWins, no death narration) over a one-Goblin fight. */
  function pendingInitiateEvent(): InitiateCombatEvent {
    return {
      kind: 'initiate',
      outcome: {
        tier: 'costly',
        dc: 15,
        roll: 14,
        total: 17,
        tierProse: COMBAT_TABLE.outcomes.costly,
        envelope: {
          partyWins: true,
          minDownedPcs: 0,
          minAggregateHpLossFraction: 0.3,
          allowPcDeathNarration: false,
        },
      },
      enemies: COMBAT_ENEMIES,
      environment: 'a collapsed mineshaft',
      surprise: 'none',
      initiative: [{ combatant: 'Vire', roll: 10 }],
    }
  }

  it('execute with a pending initiate returns {ok, narration, outcome_kind} and records a resolve event with reconciled deltas', async () => {
    const recordCombat = vi.fn()
    const combat = makeCombatSurface({
      combatParty: vi
        .fn<() => Promise<readonly CombatPartyMember[]>>()
        .mockResolvedValue([{ characterId: 'char-1', name: 'Vire', level: 3, hp: 30, maxHp: 30 }]),
      recordCombat,
      pendingInitiate: vi.fn<() => InitiateCombatEvent | null>().mockReturnValue(pendingInitiateEvent()),
    })
    const deps = makeDeps(foundMech(makeCharacter(), []), fakeLedger(), undefined, makeLookupSurface(), combat)
    const exec = requireExecute(buildFtTools(deps), 'resolve_combat')

    // Parse through the schema the way the SDK does before calling execute —
    // the .default([]) arms fill the unsupplied delta arrays.
    const result = (await exec(
      RESOLVE_COMBAT_INPUT.parse({
        narration: 'The goblins fall, but Vire takes a nasty gash.',
        hp_changes: [{ combatant_name: 'Vire', damage: 8, healing: 0 }],
        casualties: [{ combatant_name: 'Goblin', fate: 'dead' }],
      }),
      callOpts(),
    )) as { ok: true; narration: string; outcome_kind: string }

    expect(result.ok).toBe(true)
    expect(result.narration).toBe('The goblins fall, but Vire takes a nasty gash.')
    // costly envelope wins → victory.
    expect(result.outcome_kind).toBe('victory')

    expect(recordCombat).toHaveBeenCalledTimes(1)
    const event = recordCombat.mock.calls[0]?.[0] as CombatEvent
    expect(event.kind).toBe('resolve')
    if (event.kind !== 'resolve') throw new Error('expected resolve event')
    expect(event.narration).toBe('The goblins fall, but Vire takes a nasty gash.')
    expect(event.reconciled.outcomeKind).toBe('victory')
    // The FT's 8 damage on Vire reconciled through (envelope floor 0.3*30=9 may
    // top it up, but Vire's damage is at least the reported 8 and ≤ 30).
    const vire = event.reconciled.pcDamage.find((d) => d.name === 'Vire')
    expect(vire).toBeDefined()
    expect(vire?.amount).toBeGreaterThanOrEqual(8)
    expect(vire?.characterId).toBe('char-1')
    // The enemy casualty passes through narratively.
    expect(event.reconciled.enemyCasualties).toEqual([{ name: 'Goblin', fate: 'dead' }])
  })

  it('applies schema defaults (empty delta arrays) when only narration is supplied', async () => {
    const recordCombat = vi.fn()
    const combat = makeCombatSurface({
      recordCombat,
      pendingInitiate: vi.fn<() => InitiateCombatEvent | null>().mockReturnValue(pendingInitiateEvent()),
    })
    const deps = makeDeps(foundMech(makeCharacter(), []), fakeLedger(), undefined, makeLookupSurface(), combat)
    const exec = requireExecute(buildFtTools(deps), 'resolve_combat')

    const result = (await exec(RESOLVE_COMBAT_INPUT.parse({ narration: 'The fight ends.' }), callOpts())) as {
      ok: true
      narration: string
    }

    expect(result.ok).toBe(true)
    expect(recordCombat).toHaveBeenCalledTimes(1)
    const event = recordCombat.mock.calls[0]?.[0] as CombatEvent
    if (event.kind !== 'resolve') throw new Error('expected resolve event')
    expect(event.reconciled.enemyCasualties).toEqual([])
  })

  it('with no pending initiate returns {error} and records nothing', async () => {
    const recordCombat = vi.fn()
    const combat = makeCombatSurface({
      recordCombat,
      pendingInitiate: vi.fn<() => InitiateCombatEvent | null>().mockReturnValue(null),
    })
    const deps = makeDeps(foundMech(makeCharacter(), []), fakeLedger(), undefined, makeLookupSurface(), combat)
    const exec = requireExecute(buildFtTools(deps), 'resolve_combat')

    const result = (await exec({ narration: 'x' }, callOpts())) as { error: string }

    expect(result.error).toBe('no combat in progress to resolve')
    expect(recordCombat).not.toHaveBeenCalled()
  })
})
