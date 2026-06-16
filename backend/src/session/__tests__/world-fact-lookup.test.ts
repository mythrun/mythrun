// backend/src/session/__tests__/world-fact-lookup.test.ts
//
// MYT-72 T5 — the shared world-fact-lookup ORCHESTRATOR spine (gate → resolve →
// ST-vet → relay). A PURE orchestration unit: the gate is mocked at the module
// boundary (`vi.mock('../world-lookup-gate.js')`), the resolver is an injected
// closure (`input.resolve`), and the vet is an injected closure (`deps.vet`).
// NO real LLM, NO DB. Every assertion is on the orchestrator's fail-soft +
// pass-through contract, NOT on any downstream behavior.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  runWorldFactLookup,
  type ResolverResult,
  type WorldFactLookupDeps,
  type WorldFactLookupInput,
  type WorldFactLookupVet,
} from '../world-fact-lookup.js'
import type { WorldLookupGateResolution } from '../world-lookup-gate.js'
import { resolveWorldLookupGate } from '../world-lookup-gate.js'
import type { SkillCheckFramePayload } from '../tiers/types.js'
import type { Character } from '../../repo/types.js'

vi.mock('../world-lookup-gate.js', () => ({
  resolveWorldLookupGate: vi.fn(),
}))

const mockGate = vi.mocked(resolveWorldLookupGate)

/** A complete pass/fail frame. The orchestrator only passes this through. */
function makeFrame(overrides: Partial<SkillCheckFramePayload> = {}): SkillCheckFramePayload {
  return {
    characterName: 'Vire',
    skill: 'History',
    context: 'the Ashen Council',
    roll: 12,
    roll2: null,
    rollType: 'normal',
    modifier: 5,
    total: 17,
    dc: 14,
    outcomeTier: 'success',
    constraint: 'You recall the Council was disbanded a decade past.',
    ...overrides,
  }
}

function mockGateOnce(resolution: WorldLookupGateResolution): void {
  mockGate.mockResolvedValueOnce(resolution)
}

/** A vet closure that returns a fixed relay/none/invent verdict. */
function makeVet(
  out: { mode: 'relay' | 'none' | 'invent'; text: string; repairAttempted: boolean },
  spy?: ReturnType<typeof vi.fn>,
): WorldFactLookupVet {
  return (input) => {
    spy?.(input)
    return Promise.resolve(out)
  }
}

/** A vet closure that throws. */
function throwingVet(spy?: ReturnType<typeof vi.fn>): WorldFactLookupVet {
  return (input) => {
    spy?.(input)
    return Promise.reject(new Error('opus 529 overloaded'))
  }
}

function makeResolved(overrides: Partial<ResolverResult> = {}): ResolverResult {
  return { results: 'TIER:known — the Council disbanded a decade past', degraded: false, empty: false, ...overrides }
}

function makeDeps(overrides: Partial<WorldFactLookupDeps> = {}): WorldFactLookupDeps {
  return {
    gateDeps: { worldTone: 'grim and rain-soaked' },
    vet: makeVet({ mode: 'relay', text: 'VET RELAY', repairAttempted: false }),
    worldTone: 'grim and rain-soaked',
    ...overrides,
  }
}

function dmInput(overrides: Partial<WorldFactLookupInput> = {}): WorldFactLookupInput {
  return {
    gate: {
      channel: 'dm',
      topic: 'the Ashen Council',
      worldTone: 'grim and rain-soaked',
      askerSummary: 'Vire, a travelling scholar of modest renown',
      dm: {
        // The mocked gate never reads the character; a minimal stand-in suffices.
        character: { name: 'Vire' } as unknown as Character,
        skill: 'history',
        skills: [{ skill_name: 'History', proficiency_level: 'proficient' }],
      },
    },
    question: 'What do you know of the Ashen Council?',
    recentNarrative: 'The rain had not let up for three days.',
    npcFraming: '',
    resolve: () => Promise.resolve(makeResolved()),
    ...overrides,
  }
}

function npcInput(overrides: Partial<WorldFactLookupInput> = {}): WorldFactLookupInput {
  return dmInput({
    gate: {
      channel: 'npc',
      topic: 'the Ashen Council',
      worldTone: 'grim and rain-soaked',
      askerSummary: 'A market fishmonger',
      npc: { entityId: 'entity-1', npcName: 'Marsh the Fishmonger' },
    },
    npcFraming: 'Marsh, a fishmonger who knows the docks well',
    ...overrides,
  })
}

describe('runWorldFactLookup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('gate fail → returns the fail constraint + frame + rollHidden; resolver + vet SKIPPED', async () => {
    const frame = makeFrame({ outcomeTier: 'fail', constraint: 'It eludes you.' })
    mockGateOnce({ outcome: 'fail', frame, rollHidden: false, failConstraint: 'It eludes you.' })

    const resolve = vi.fn(() => Promise.resolve(makeResolved()))
    const vetSpy = vi.fn()
    const result = await runWorldFactLookup(
      makeDeps({ vet: makeVet({ mode: 'relay', text: 'VET RELAY', repairAttempted: false }, vetSpy) }),
      dmInput({ resolve }),
    )

    expect(result).toEqual({ relayText: 'It eludes you.', skillGateFrame: frame, rollHidden: false })
    expect(resolve).not.toHaveBeenCalled()
    expect(vetSpy).not.toHaveBeenCalled()
  })

  it('gate auto_success → resolver + vet run; skillGateFrame ABSENT; rollHidden false; relayText = vet relay', async () => {
    mockGateOnce({ outcome: 'auto_success' })

    const resolve = vi.fn(() => Promise.resolve(makeResolved()))
    const result = await runWorldFactLookup(
      makeDeps({ vet: makeVet({ mode: 'relay', text: 'VET RELAY', repairAttempted: false }) }),
      dmInput({ resolve }),
    )

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(result.relayText).toBe('VET RELAY')
    expect(result.rollHidden).toBe(false)
    expect('skillGateFrame' in result).toBe(false)
  })

  it('gate pass → resolver + vet run; skillGateFrame present; rollHidden = gate.rollHidden; relayText = vet relay', async () => {
    const frame = makeFrame()
    mockGateOnce({ outcome: 'pass', frame, rollHidden: true })

    const result = await runWorldFactLookup(
      makeDeps({ vet: makeVet({ mode: 'relay', text: 'VET RELAY', repairAttempted: false }) }),
      npcInput(),
    )

    expect(result.skillGateFrame).toEqual(frame)
    expect(result.rollHidden).toBe(true)
    expect(result.relayText).toBe('VET RELAY')
  })

  it('resolver throws → caught → resolverDegraded:true passed to the vet; never an unvetted leak', async () => {
    mockGateOnce({ outcome: 'auto_success' })
    const vetSpy = vi.fn()
    const result = await runWorldFactLookup(
      makeDeps({ vet: makeVet({ mode: 'relay', text: 'VET RELAY', repairAttempted: false }, vetSpy) }),
      dmInput({
        resolve: () => Promise.reject(new Error('pg pool exhausted')),
      }),
    )

    expect(vetSpy).toHaveBeenCalledTimes(1)
    expect(vetSpy.mock.calls[0]?.[0]).toMatchObject({ resolverDegraded: true, results: '' })
    expect(result.relayText).toBe('VET RELAY')
  })

  it('resolver throws → logs via the injected logger', async () => {
    mockGateOnce({ outcome: 'auto_success' })
    const warn = vi.fn()
    await runWorldFactLookup(
      makeDeps({ vet: makeVet({ mode: 'relay', text: 'VET RELAY', repairAttempted: false }), logger: { warn } }),
      dmInput({
        resolve: () => Promise.reject(new Error('pg pool exhausted')),
      }),
    )
    expect(warn).toHaveBeenCalled()
  })

  it('resolver reports its own degraded flag → forwarded to the vet resolverDegraded', async () => {
    mockGateOnce({ outcome: 'auto_success' })
    const vetSpy = vi.fn()
    await runWorldFactLookup(
      makeDeps({ vet: makeVet({ mode: 'relay', text: 'VET RELAY', repairAttempted: false }, vetSpy) }),
      dmInput({ resolve: () => Promise.resolve(makeResolved({ degraded: true, empty: true, results: '' })) }),
    )

    expect(vetSpy.mock.calls[0]?.[0]).toMatchObject({ resolverDegraded: true })
  })

  it('healthy resolver → resolverDegraded false forwarded to the vet', async () => {
    mockGateOnce({ outcome: 'auto_success' })
    const vetSpy = vi.fn()
    await runWorldFactLookup(
      makeDeps({ vet: makeVet({ mode: 'relay', text: 'VET RELAY', repairAttempted: false }, vetSpy) }),
      dmInput({ resolve: () => Promise.resolve(makeResolved({ degraded: false })) }),
    )

    expect(vetSpy.mock.calls[0]?.[0]).toMatchObject({ resolverDegraded: false })
  })

  it('vet throws (DM channel) → DM fail-soft relay; never raw error / unvetted result; carries frame + rollHidden', async () => {
    const frame = makeFrame()
    mockGateOnce({ outcome: 'pass', frame, rollHidden: false })

    const result = await runWorldFactLookup(
      makeDeps({ vet: throwingVet() }),
      dmInput(),
    )

    expect(result.relayText).toBe("You can't quite bring it to mind.")
    expect(result.relayText).not.toContain('529')
    expect(result.skillGateFrame).toEqual(frame)
    expect(result.rollHidden).toBe(false)
  })

  it('vet throws (NPC channel) → NPC-flavored fail-soft relay (DIFFERS from DM)', async () => {
    mockGateOnce({ outcome: 'auto_success' })

    const result = await runWorldFactLookup(makeDeps({ vet: throwingVet() }), npcInput())

    expect(result.relayText).toBe("They don't seem to know.")
    expect('skillGateFrame' in result).toBe(false)
    expect(result.rollHidden).toBe(false)
  })

  it('vet throws → logs via the injected logger', async () => {
    mockGateOnce({ outcome: 'auto_success' })
    const warn = vi.fn()
    await runWorldFactLookup(makeDeps({ vet: throwingVet(), logger: { warn } }), dmInput())
    expect(warn).toHaveBeenCalled()
  })

  it('vet repairAttempted:true → fail-soft relay (repair-authored text is NEVER surfaced)', async () => {
    const frame = makeFrame()
    mockGateOnce({ outcome: 'pass', frame, rollHidden: true })

    const result = await runWorldFactLookup(
      makeDeps({
        vet: makeVet({ mode: 'relay', text: 'REPAIR-AUTHORED PROSE — must not surface', repairAttempted: true }),
      }),
      dmInput(),
    )

    expect(result.relayText).toBe("You can't quite bring it to mind.")
    expect(result.relayText).not.toContain('REPAIR-AUTHORED')
    expect(result.skillGateFrame).toEqual(frame)
    expect(result.rollHidden).toBe(true)
  })

  it('vet repairAttempted:true → logs via the injected logger', async () => {
    mockGateOnce({ outcome: 'auto_success' })
    const warn = vi.fn()
    await runWorldFactLookup(
      makeDeps({
        vet: makeVet({ mode: 'relay', text: 'REPAIR-AUTHORED PROSE', repairAttempted: true }),
        logger: { warn },
      }),
      dmInput(),
    )
    expect(warn).toHaveBeenCalled()
  })

  it('vet mode:invent → relayText = the invention (orchestrator does NOT re-author)', async () => {
    mockGateOnce({ outcome: 'auto_success' })
    const result = await runWorldFactLookup(
      makeDeps({ vet: makeVet({ mode: 'invent', text: 'An invented but tier-safe morsel.', repairAttempted: false }) }),
      dmInput(),
    )
    expect(result.relayText).toBe('An invented but tier-safe morsel.')
  })

  it('vet mode:none → relayText = the truthful "nothing" text (orchestrator does NOT re-author)', async () => {
    mockGateOnce({ outcome: 'auto_success' })
    const result = await runWorldFactLookup(
      makeDeps({ vet: makeVet({ mode: 'none', text: 'You search your memory and come up empty.', repairAttempted: false }) }),
      dmInput(),
    )
    expect(result.relayText).toBe('You search your memory and come up empty.')
  })

  it('passes question / recentNarrative / channel / npcFraming / results / worldTone to the vet (no sdPlaybook)', async () => {
    mockGateOnce({ outcome: 'auto_success' })
    const vetSpy = vi.fn()
    await runWorldFactLookup(
      makeDeps({ vet: makeVet({ mode: 'relay', text: 'VET RELAY', repairAttempted: false }, vetSpy) }),
      npcInput({ resolve: () => Promise.resolve(makeResolved({ results: 'TIER:known — docks gossip' })) }),
    )

    const vetArg = vetSpy.mock.calls[0]?.[0] as Record<string, unknown>
    expect(vetArg).toMatchObject({
      question: 'What do you know of the Ashen Council?',
      recentNarrative: 'The rain had not let up for three days.',
      channel: 'npc',
      npcFraming: 'Marsh, a fishmonger who knows the docks well',
      results: 'TIER:known — docks gossip',
      resolverDegraded: false,
      worldTone: 'grim and rain-soaked',
    })
    expect('sdPlaybook' in vetArg).toBe(false)
  })
})
