// backend/src/session/__tests__/world-lookup-gate.test.ts
//
// MYT-72 T3 — the contextual world-lookup skill-gate. Mock target is the `'ai'`
// SDK boundary, NOT the ai.ts wrapper: generateObject drives the SDK's
// generateText (with Output.object) and reads back `result.output`. Mirrors the
// proven skill-check.test.ts scaffold.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import {
  resolveWorldLookupGate,
  type WorldLookupGateDeps,
  type WorldLookupGateInput,
} from '../world-lookup-gate.js'
import { GATE_FALLBACK_DC, GATE_FALLBACK_OUTCOMES } from '../world-lookup-config.js'
import type { Rng } from '../dice/engine.js'
import type { Character } from '../../repo/types.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

const HAIKU_USAGE = { inputTokens: 400, outputTokens: 50, totalTokens: 450 }

const ROLL_TABLE = {
  auto_success: false,
  dc: 14,
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
    class: 'Wizard',
    species: 'Human',
    background: 'Sage',
    str: 10,
    dex: 12,
    con: 12,
    int: 16, // +3 — knowledge skills are mostly INT
    wis: 14, // +2 — insight/medicine/survival
    cha: 10,
    hitPoints: 18,
    maxHitPoints: 18,
    armorClass: 12,
    proficiencyBonus: 2,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

/** A scripted RNG that yields the queued values in order. */
function scriptedRng(...values: number[]): Rng {
  const queue = [...values]
  return () => {
    const next = queue.shift()
    if (next === undefined) throw new Error('scriptedRng: exhausted')
    return next
  }
}

function makeDeps(overrides: Partial<WorldLookupGateDeps> = {}): WorldLookupGateDeps {
  return {
    worldTone: 'grim and rain-soaked',
    ...overrides,
  }
}

type DmInput = Extract<WorldLookupGateInput, { channel: 'dm' }>
type NpcInput = Extract<WorldLookupGateInput, { channel: 'npc' }>

function dmInput(overrides: Partial<DmInput> = {}): DmInput {
  return {
    channel: 'dm',
    topic: 'the Ashen Council',
    worldTone: 'grim and rain-soaked',
    askerSummary: 'Vire, a travelling scholar of modest renown',
    dm: {
      character: makeCharacter(),
      skill: 'history',
      skills: [{ skill_name: 'History', proficiency_level: 'proficient' }],
    },
    ...overrides,
  }
}

function npcInput(entityId: string, overrides: Partial<NpcInput> = {}): NpcInput {
  return {
    channel: 'npc',
    topic: 'the Ashen Council',
    worldTone: 'grim and rain-soaked',
    askerSummary: 'A market fishmonger',
    npc: { entityId, npcName: 'Marsh the Fishmonger' },
    ...overrides,
  }
}

function mockTableOnce(table = ROLL_TABLE): void {
  mockGenerateText.mockResolvedValueOnce({
    output: table,
    finishReason: 'stop',
    usage: HAIKU_USAGE,
  } as never)
}

describe('resolveWorldLookupGate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('DM auto_success → {outcome:"auto_success"}, no roll consumed', async () => {
    mockTableOnce({ ...ROLL_TABLE, auto_success: true })
    // No rng supplied: if the gate tried to roll it would crash on undefined.
    const result = await resolveWorldLookupGate(makeDeps(), dmInput())
    expect(result.outcome).toBe('auto_success')
  })

  it('DM rollable: int-16 + proficient History (+5), roll 12 vs dc 14 → pass (total 17)', async () => {
    mockTableOnce() // dc 14
    const deps = makeDeps({ rng: scriptedRng(12) })
    const result = await resolveWorldLookupGate(deps, dmInput())

    expect(result.outcome).toBe('pass')
    if (result.outcome !== 'pass') throw new Error('expected pass')
    expect(result.rollHidden).toBe(false)
    expect(result.frame).toEqual({
      characterName: 'Vire',
      skill: 'History',
      context: 'the Ashen Council',
      roll: 12,
      roll2: null,
      rollType: 'normal',
      modifier: 5, // +3 int + 2 prof
      total: 17,
      dc: 14,
      outcomeTier: 'success',
      constraint: 'S',
    })
  })

  it('DM rollable: high dc + low roll → fail carrying the fail constraint', async () => {
    mockTableOnce({ ...ROLL_TABLE, dc: 25 })
    const deps = makeDeps({ rng: scriptedRng(3) }) // 3 + 5 = 8 < 25 → fail
    const result = await resolveWorldLookupGate(deps, dmInput())

    expect(result.outcome).toBe('fail')
    if (result.outcome !== 'fail') throw new Error('expected fail')
    expect(result.failConstraint).toBe('F')
    expect(result.frame.outcomeTier).toBe('fail')
    expect(result.frame.total).toBe(8)
    expect(result.rollHidden).toBe(false)
  })

  it('DM rollable: great_success tier when total ≥ dc+5', async () => {
    mockTableOnce() // dc 14
    const deps = makeDeps({ rng: scriptedRng(16) }) // 16 + 5 = 21 ≥ 19 → great
    const result = await resolveWorldLookupGate(deps, dmInput())

    expect(result.outcome).toBe('pass')
    if (result.outcome !== 'pass') throw new Error('expected pass')
    expect(result.frame.outcomeTier).toBe('great_success')
    expect(result.frame.constraint).toBe('G')
  })

  it('DM: knowledge-skill enum maps to canonical skill + ability locally (no second Haiku call)', async () => {
    mockTableOnce() // dc 14
    const deps = makeDeps({ rng: scriptedRng(10) })
    // insight → WIS ability (+2), no proficiency → modifier 2. 10 + 2 = 12 < 14 → fail.
    const result = await resolveWorldLookupGate(
      deps,
      dmInput({
        dm: { character: makeCharacter(), skill: 'insight', skills: [] },
      }),
    )
    expect(result.outcome).toBe('fail')
    if (result.outcome === 'auto_success') throw new Error('expected a rolled outcome')
    expect(result.frame.skill).toBe('Insight') // canonical from the local map
    expect(result.frame.modifier).toBe(2) // WIS +2, no proficiency
    // Only the gate-table call happened — the enum map is local, not a 2nd Haiku call.
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
  })

  it('NPC channel: SAME entityId → SAME fabricated modifier across two calls; rollHidden=true', async () => {
    mockTableOnce() // dc 14
    const first = await resolveWorldLookupGate(
      makeDeps({ rng: scriptedRng(10) }),
      npcInput('entity-deadbeef'),
    )
    mockTableOnce()
    const second = await resolveWorldLookupGate(
      makeDeps({ rng: scriptedRng(10) }),
      npcInput('entity-deadbeef'),
    )

    if (first.outcome === 'auto_success' || second.outcome === 'auto_success') {
      throw new Error('expected a rolled outcome')
    }
    expect(first.frame.modifier).toBe(second.frame.modifier)
    expect(first.frame.total).toBe(second.frame.total) // same roll + same modifier
    expect(first.rollHidden).toBe(true)
    expect(second.rollHidden).toBe(true)
    expect(first.frame.characterName).toBe('Marsh the Fishmonger')
  })

  it('NPC: different entityId can yield a different fabricated modifier (deterministic per id)', async () => {
    mockTableOnce()
    const a = await resolveWorldLookupGate(
      makeDeps({ rng: scriptedRng(10) }),
      npcInput('entity-aaaa'),
    )
    mockTableOnce()
    const b = await resolveWorldLookupGate(
      makeDeps({ rng: scriptedRng(10) }),
      npcInput('entity-zzzz'),
    )
    if (a.outcome === 'auto_success' || b.outcome === 'auto_success') {
      throw new Error('expected rolled outcomes')
    }
    // Both modifiers are within the configured band.
    for (const m of [a.frame.modifier, b.frame.modifier]) {
      expect(m).toBeGreaterThanOrEqual(-1)
      expect(m).toBeLessThanOrEqual(4)
    }
  })

  it('gate LLM throws → fail-soft to GATE_FALLBACK (NOT auto-success); the roll STILL runs', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('haiku 529 overloaded'))
    // Fallback dc 13. roll 20 + modifier 5 = 25 ≥ 13+5 → great_success → pass.
    const deps = makeDeps({ rng: scriptedRng(20) })
    const result = await resolveWorldLookupGate(deps, dmInput())

    expect(result.outcome).toBe('pass') // NOT auto_success
    if (result.outcome !== 'pass') throw new Error('expected pass')
    expect(result.frame.dc).toBe(GATE_FALLBACK_DC)
    expect(result.frame.outcomeTier).toBe('great_success')
    expect(result.frame.constraint).toBe(GATE_FALLBACK_OUTCOMES.great_success)
    expect(result.frame.total).toBe(25)
  })

  it('gate LLM failure logs via the injected logger', async () => {
    const warn = vi.fn()
    mockGenerateText.mockRejectedValueOnce(new Error('haiku down'))
    await resolveWorldLookupGate(
      makeDeps({ rng: scriptedRng(10), logger: { warn } }),
      dmInput(),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'the Ashen Council' }),
      expect.stringContaining('world-lookup-gate'),
    )
  })

  it('threads the public-standing prompt vars + external abort signal to the SDK', async () => {
    mockTableOnce()
    const controller = new AbortController()
    const deps = makeDeps({ rng: scriptedRng(10), abortSignal: controller.signal })
    await resolveWorldLookupGate(
      deps,
      dmInput({ askerSummary: 'Vire, head archivist of the Ashen Council' }),
    )

    const callOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as {
      prompt: string
      abortSignal: AbortSignal
    }
    expect(callOpts.prompt).toContain('Vire, head archivist of the Ashen Council')
    expect(callOpts.prompt).toContain('the Ashen Council')
    expect(callOpts.prompt).toContain('dm') // channel
    expect(callOpts.prompt).toContain('grim and rain-soaked') // world tone
    expect(callOpts.abortSignal).toBeInstanceOf(AbortSignal)
    expect(callOpts.abortSignal.aborted).toBe(false)
    controller.abort()
    expect(callOpts.abortSignal.aborted).toBe(true)
  })

  it('DM rollable: expertise doubles the proficiency bonus', async () => {
    mockTableOnce() // dc 14
    const deps = makeDeps({ rng: scriptedRng(8) })
    const result = await resolveWorldLookupGate(
      deps,
      dmInput({
        dm: {
          character: makeCharacter(), // int 16 → +3, PB 2
          skill: 'arcana',
          skills: [{ skill_name: 'Arcana', proficiency_level: 'expertise' }],
        },
      }),
    )
    if (result.outcome === 'auto_success') throw new Error('expected a rolled outcome')
    expect(result.frame.modifier).toBe(7) // +3 int + (2×2) expertise
    expect(result.frame.skill).toBe('Arcana')
  })
})
