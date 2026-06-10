// backend/src/session/tiers/__tests__/fast-thinker.test.ts
//
// MYT-68 Task 13 — the real FastThinker (SonnetFastThinker.render) + its
// deterministic message mapping (buildModelMessages).
//
// MOCK STRATEGY (mirrors stream-text-with-tools.test.ts / ai.test.ts): we mock
// the raw `'ai'` SDK boundary — replacing `streamText` with a vi.fn() that
// returns a SCRIPTED fullStream — and let the REAL `ai.ts` wrapper
// (`streamTextWithTools`) run on top. We NEVER mock the wrapper itself. Each
// test scripts an array of fullStream parts using the REAL ai@6 field names
// (`text` on text-delta, `input` on tool-call, `output` on tool-result,
// `error` on error, `reason` on abort) so the consume loop exercises real
// property reads.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FT_MODEL, FT_MAX_TOOL_STEPS, FT_CLOSE_INSTRUCTION } from '../../ft-config.js'
import { LlmTimeoutError } from '../../../llm/errors.js'
import type {
  FtTurnContext,
  TurnEmitter,
  SkillCheckFramePayload,
  DiceRollFramePayload,
  LedgerUpdatePayload,
  ConversationMessage,
  PartyLedgerSnapshot,
} from '../types.js'

const streamTextMock = vi.fn()

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    streamText: (...args: unknown[]): unknown => streamTextMock(...args) as unknown,
  }
})

const { SonnetFastThinker, buildModelMessages, formatPartyLedger } = await import('../fast-thinker.js')

// A §7 party-ledger snapshot fixture carrying the showstopper-fix NOUNS:
// a named spell, a named equipment item, a slot ledger, conditions, and a
// tracked feature with uses.
const PARTY_LEDGER: PartyLedgerSnapshot = [
  {
    characterId: 'char-arin',
    name: 'Arin',
    hitPoints: 18,
    maxHitPoints: 24,
    hitDie: 8,
    hitDiceRemaining: 2,
    level: 3,
    gold: 47,
    slots: [
      { slotLevel: 1, slotsMax: 4, slotsRemaining: 2 },
      { slotLevel: 2, slotsMax: 2, slotsRemaining: 0 },
    ],
    conditions: [{ condition: 'poisoned', level: null }],
    trackedFeatures: [
      { name: 'Channel Divinity', maxUses: 1, usesRemaining: 1, recharge: 'short_rest' },
    ],
    spells: [
      { name: 'Sacred Flame', level: 0, prepared: true, ritual: false },
      { name: 'Detect Magic', level: 1, prepared: true, ritual: true },
      { name: 'Spiritual Weapon', level: 2, prepared: false, ritual: false },
    ],
    equipment: [
      { name: 'Healing Potion', quantity: 2, consumable: true },
      { name: 'Longsword', quantity: 1, consumable: false },
    ],
  },
]

function makeUsage(input = 100, output = 50): {
  inputTokens: number
  outputTokens: number
  totalTokens: number
} {
  return { inputTokens: input, outputTokens: output, totalTokens: input + output }
}

// Script a mock streamText result with a fullStream that yields `parts` and the
// supplied usage promises (default: settled). `usagePromise` / `totalPromise`
// are overridable for the abort/error cases where we want them to reject.
function mockResult(
  parts: readonly unknown[],
  opts: {
    usage?: Promise<unknown>
    totalUsage?: Promise<unknown>
  } = {},
): void {
  streamTextMock.mockReturnValueOnce({
    fullStream: {
      // eslint-disable-next-line @typescript-eslint/require-await -- async generator is required to satisfy AsyncIterable; the body has no await by design.
      async *[Symbol.asyncIterator]() {
        for (const p of parts) yield p
      },
    },
    usage: opts.usage ?? Promise.resolve(makeUsage()),
    totalUsage: opts.totalUsage ?? Promise.resolve(makeUsage()),
  })
}

// Capturing emitter — records the ORDER and payloads of all emissions.
interface Emission {
  readonly kind: 'text' | 'skill_check' | 'dice_roll' | 'ledger_update'
  readonly payload: unknown
}
function makeEmitter(): { emit: TurnEmitter; seen: Emission[] } {
  const seen: Emission[] = []
  const emit: TurnEmitter = {
    emitText: (text: string) => {
      seen.push({ kind: 'text', payload: text })
      return Promise.resolve()
    },
    emitSkillCheck: (payload: SkillCheckFramePayload) => {
      seen.push({ kind: 'skill_check', payload })
      return Promise.resolve()
    },
    emitDiceRoll: (payload: DiceRollFramePayload) => {
      seen.push({ kind: 'dice_roll', payload })
      return Promise.resolve()
    },
    emitLedgerUpdate: (payload: LedgerUpdatePayload) => {
      seen.push({ kind: 'ledger_update', payload })
      return Promise.resolve()
    },
  }
  return { emit, seen }
}

function makeCtx(overrides: Partial<FtTurnContext> = {}): FtTurnContext {
  return {
    campaignId: 'campaign-1',
    ftContext: 'The town of Saltmere clings to a storm-battered coast.',
    ftHistory: [{ v: 1, role: 'user', parts: [{ kind: 'text', text: 'hi' }], characterName: 'Arin' }],
    participants: ['Arin', 'Bel'],
    usage: { input: 0, output: 0 },
    workingSet: [],
    ...overrides,
  }
}

// A snake_case roll_skill_check ok-output (the shape ft-tools.ts produces).
const SKILL_OUTPUT = {
  character_name: 'Arin',
  skill: 'Persuasion',
  outcome_tier: 'success' as const,
  constraint: 'The guard relents and lets you pass.',
  roll: 14,
  roll2: null,
  roll_type: 'normal' as const,
  modifier: 3,
  total: 17,
  dc: 12,
  context: 'convincing the gate guard',
}

beforeEach(() => {
  streamTextMock.mockReset()
})

describe('SonnetFastThinker.render', () => {
  it('1. prose streams: text-delta parts emit in order; returned parts coalesce into one text part', async () => {
    mockResult([
      { type: 'text-delta', id: '1', text: 'A' },
      { type: 'text-delta', id: '1', text: 'B' },
    ])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit, seen } = makeEmitter()

    const msg = await ft.render(makeCtx(), emit)

    expect(seen).toEqual([
      { kind: 'text', payload: 'A' },
      { kind: 'text', payload: 'B' },
    ])
    expect(msg.role).toBe('assistant')
    expect(msg.parts).toEqual([{ kind: 'text', text: 'AB' }])
  })

  it('2. part-order frames: text / tool-call / tool-result / text emit in exact order with camelCase payload', async () => {
    mockResult([
      { type: 'text-delta', id: '1', text: 'X' },
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'roll_skill_check',
        input: { character_name: 'Arin', skill: 'Persuasion', context: 'gate' },
      },
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'roll_skill_check',
        input: { character_name: 'Arin', skill: 'Persuasion', context: 'gate' },
        output: SKILL_OUTPUT,
      },
      { type: 'text-delta', id: '2', text: 'Y' },
    ])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit, seen } = makeEmitter()

    const msg = await ft.render(makeCtx(), emit)

    expect(seen.map((e) => e.kind)).toEqual(['text', 'skill_check', 'text'])
    expect(seen[0]?.payload).toBe('X')
    expect(seen[2]?.payload).toBe('Y')
    const payload = seen[1]?.payload as SkillCheckFramePayload
    expect(payload).toEqual({
      characterName: 'Arin',
      skill: 'Persuasion',
      context: 'convincing the gate guard',
      roll: 14,
      roll2: null,
      rollType: 'normal',
      modifier: 3,
      total: 17,
      dc: 12,
      outcomeTier: 'success',
      constraint: 'The guard relents and lets you pass.',
    })

    expect(msg.parts).toEqual([
      { kind: 'text', text: 'X' },
      { kind: 'tool_call', toolCallId: 'c1', toolName: 'roll_skill_check', input: { character_name: 'Arin', skill: 'Persuasion', context: 'gate' } },
      { kind: 'tool_result', toolCallId: 'c1', toolName: 'roll_skill_check', output: SKILL_OUTPUT },
      { kind: 'text', text: 'Y' },
    ])
  })

  it('3. fail-soft: a tool-result with an error key emits NO skill_check frame; the loop continues and records call+result', async () => {
    mockResult([
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'roll_skill_check',
        input: { character_name: 'Arin', skill: 'Persuasion', context: 'gate' },
      },
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'roll_skill_check',
        input: { character_name: 'Arin', skill: 'Persuasion', context: 'gate' },
        output: { error: 'check could not be resolved' },
      },
      { type: 'text-delta', id: '1', text: 'open ending' },
    ])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit, seen } = makeEmitter()

    const msg = await ft.render(makeCtx(), emit)

    expect(seen.some((e) => e.kind === 'skill_check')).toBe(false)
    expect(seen).toEqual([{ kind: 'text', payload: 'open ending' }])
    expect(msg.parts).toEqual([
      { kind: 'tool_call', toolCallId: 'c1', toolName: 'roll_skill_check', input: { character_name: 'Arin', skill: 'Persuasion', context: 'gate' } },
      { kind: 'tool_result', toolCallId: 'c1', toolName: 'roll_skill_check', output: { error: 'check could not be resolved' } },
      { kind: 'text', text: 'open ending' },
    ])
  })

  it('4. dice_roll frame: built from the result output (count/sides fall back to the call input when absent)', async () => {
    mockResult([
      {
        type: 'tool-call',
        toolCallId: 'd1',
        toolName: 'roll_dice',
        input: { count: 2, sides: 6 },
      },
      {
        type: 'tool-result',
        toolCallId: 'd1',
        toolName: 'roll_dice',
        input: { count: 2, sides: 6 },
        output: { results: [3, 5], total: 8 },
      },
    ])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit, seen } = makeEmitter()

    await ft.render(makeCtx(), emit)

    expect(seen).toHaveLength(1)
    expect(seen[0]?.kind).toBe('dice_roll')
    expect(seen[0]?.payload).toEqual({ count: 2, sides: 6, results: [3, 5], total: 8 })
  })

  it('5. error part: render rejects with the in-band error; emissions before it still happened', async () => {
    const boom = new Error('mapped upstream failure')
    mockResult(
      [
        { type: 'text-delta', id: '1', text: 'first beat' },
        { type: 'error', error: boom },
      ],
      // On a failure the SDK rejects the usage promises; the consume loop
      // throws before awaiting them.
      { usage: Promise.reject(boom), totalUsage: Promise.reject(boom) },
    )
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit, seen } = makeEmitter()

    await expect(ft.render(makeCtx(), emit)).rejects.toBe(boom)
    expect(seen).toEqual([{ kind: 'text', payload: 'first beat' }])
  })

  it('6. abort part: render rejects with LlmTimeoutError', async () => {
    mockResult(
      [
        { type: 'text-delta', id: '1', text: 'half' },
        { type: 'abort', reason: 'turn budget exceeded' },
      ],
      { usage: Promise.reject(new Error('aborted')), totalUsage: Promise.reject(new Error('aborted')) },
    )
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit } = makeEmitter()

    await expect(ft.render(makeCtx(), emit)).rejects.toBeInstanceOf(LlmTimeoutError)
  })

  it('7. prepareStep boundary: final step injects FT_CLOSE_INSTRUCTION with no toolChoice; earlier steps return undefined', async () => {
    mockResult([{ type: 'text-delta', id: '1', text: 'ok' }])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit } = makeEmitter()

    await ft.render(makeCtx(), emit)

    const callArgs = streamTextMock.mock.calls[0]?.[0] as {
      prepareStep: (o: {
        stepNumber: number
        messages: import('../../../llm/ai.js').ModelMessage[]
        steps: unknown[]
        model: unknown
      }) => unknown
    }
    const prepareStep = callArgs.prepareStep
    expect(typeof prepareStep).toBe('function')

    const baseMessages: import('../../../llm/ai.js').ModelMessage[] = [
      { role: 'user', content: 'hi' },
    ]

    // Final step (stepNumber === FT_MAX_TOOL_STEPS - 1).
    const finalResult = (await prepareStep({
      stepNumber: FT_MAX_TOOL_STEPS - 1,
      messages: baseMessages,
      steps: [],
      model: FT_MODEL,
    })) as { messages?: import('../../../llm/ai.js').ModelMessage[]; toolChoice?: unknown } | undefined

    expect(finalResult).toBeDefined()
    const boundFinal = finalResult
    if (boundFinal === undefined) throw new Error('expected final-step override')
    expect(boundFinal.toolChoice).toBeUndefined()
    expect(boundFinal.messages).toHaveLength(2)
    const injected = boundFinal.messages?.[1]
    expect(injected).toEqual({ role: 'user', content: FT_CLOSE_INSTRUCTION })

    // Earlier steps → undefined.
    for (const stepNumber of [0, 1, FT_MAX_TOOL_STEPS - 2]) {
      const earlier = await prepareStep({ stepNumber, messages: baseMessages, steps: [], model: FT_MODEL })
      expect(earlier).toBeUndefined()
    }
  })

  it('8. dangling final tool_call (no result) is filtered from returned parts and a warn is logged', async () => {
    const warn = vi.fn()
    mockResult([
      { type: 'text-delta', id: '1', text: 'narration' },
      {
        type: 'tool-call',
        toolCallId: 'orphan',
        toolName: 'roll_skill_check',
        input: { character_name: 'Arin', skill: 'Stealth', context: 'sneak' },
      },
    ])
    const ft = new SonnetFastThinker({ tools: {}, logger: { warn } })
    const { emit } = makeEmitter()

    const msg = await ft.render(makeCtx(), emit)

    // Only the text part survives; the dangling tool_call is dropped.
    expect(msg.parts).toEqual([{ kind: 'text', text: 'narration' }])
    expect(warn).toHaveBeenCalledTimes(1)
    const warnArg = warn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(warnArg.toolCallId).toBe('orphan')
  })

  it('10. usage: returned usage maps from totalUsage (cumulative across steps)', async () => {
    mockResult([{ type: 'text-delta', id: '1', text: 'x' }], {
      usage: Promise.resolve(makeUsage(50, 20)),
      totalUsage: Promise.resolve(makeUsage(900, 333)),
    })
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit } = makeEmitter()

    const msg = await ft.render(makeCtx(), emit)

    expect(msg.usage).toEqual({ input: 900, output: 333 })
  })

  it('10b. usage: missing token counts default to 0', async () => {
    mockResult([{ type: 'text-delta', id: '1', text: 'x' }], {
      usage: Promise.resolve({}),
      totalUsage: Promise.resolve({}),
    })
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit } = makeEmitter()

    const msg = await ft.render(makeCtx(), emit)

    expect(msg.usage).toEqual({ input: 0, output: 0 })
  })

  it('11. advantage check: a non-null roll2 maps through to the frame (not nulled)', async () => {
    const advantageOutput = {
      ...SKILL_OUTPUT,
      roll_type: 'advantage' as const,
      roll: 14,
      roll2: 9,
    }
    mockResult([
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'roll_skill_check',
        input: { character_name: 'Arin', skill: 'Persuasion', context: 'gate', advantage: true },
      },
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'roll_skill_check',
        input: { character_name: 'Arin', skill: 'Persuasion', context: 'gate', advantage: true },
        output: advantageOutput,
      },
    ])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit, seen } = makeEmitter()

    await ft.render(makeCtx(), emit)

    expect(seen).toHaveLength(1)
    expect(seen[0]?.kind).toBe('skill_check')
    const payload = seen[0]?.payload as SkillCheckFramePayload
    expect(payload.rollType).toBe('advantage')
    expect(payload.roll2).toBe(9)
  })

  it('12. dice_roll output without results: frame falls back to an empty results array', async () => {
    mockResult([
      {
        type: 'tool-call',
        toolCallId: 'd1',
        toolName: 'roll_dice',
        input: { count: 1, sides: 20 },
      },
      {
        type: 'tool-result',
        toolCallId: 'd1',
        toolName: 'roll_dice',
        input: { count: 1, sides: 20 },
        output: { count: 1, sides: 20, total: 17 },
      },
    ])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit, seen } = makeEmitter()

    await ft.render(makeCtx(), emit)

    expect(seen).toHaveLength(1)
    expect(seen[0]?.kind).toBe('dice_roll')
    expect(seen[0]?.payload).toEqual({ count: 1, sides: 20, results: [], total: 17 })
  })

  it('13. error part with a non-Error value: render rejects with a wrapped Error carrying the stringified value', async () => {
    mockResult(
      [{ type: 'error', error: 'boom' }],
      {
        usage: Promise.reject(new Error('failed')),
        totalUsage: Promise.reject(new Error('failed')),
      },
    )
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit } = makeEmitter()

    const rejection = ft.render(makeCtx(), emit)
    await expect(rejection).rejects.toBeInstanceOf(Error)
    await expect(rejection).rejects.toThrow('boom')
  })

  it('14. tool-result with a non-object output: no frame is emitted and the loop continues', async () => {
    mockResult([
      {
        type: 'tool-call',
        toolCallId: 'f1',
        toolName: 'some_future_tool',
        input: { anything: true },
      },
      {
        type: 'tool-result',
        toolCallId: 'f1',
        toolName: 'some_future_tool',
        input: { anything: true },
        output: null,
      },
      { type: 'text-delta', id: '1', text: 'still narrating' },
    ])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit, seen } = makeEmitter()

    const msg = await ft.render(makeCtx(), emit)

    // No skill_check / dice_roll frame for a null output on an unregistered
    // tool name; the loop continued through to the trailing prose.
    expect(seen).toEqual([{ kind: 'text', payload: 'still narrating' }])
    // The result is still recorded in the returned parts (data, not frames).
    expect(msg.parts).toEqual([
      { kind: 'tool_call', toolCallId: 'f1', toolName: 'some_future_tool', input: { anything: true } },
      { kind: 'tool_result', toolCallId: 'f1', toolName: 'some_future_tool', output: null },
      { kind: 'text', text: 'still narrating' },
    ])
  })

  it('15. standing directive: rides the streamText messages but is NEVER echoed into the returned parts', async () => {
    mockResult([{ type: 'text-delta', id: '1', text: 'narration' }])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit } = makeEmitter()

    const msg = await ft.render(makeCtx({ standingDirective: 'Wind toward a close' }), emit)

    // The tail is present in the model messages the FT sent.
    const callArgs = streamTextMock.mock.calls[0]?.[0] as {
      messages: import('../../../llm/ai.js').ModelMessage[]
    }
    const last = callArgs.messages[callArgs.messages.length - 1]
    expect(last).toEqual({ role: 'user', content: '[DM direction: Wind toward a close]' })

    // …but the FT never echoes a DM direction into the transcript it returns.
    expect(msg.parts).toEqual([{ kind: 'text', text: 'narration' }])
    for (const part of msg.parts) {
      if (part.kind === 'text') expect(part.text.startsWith('[DM direction:')).toBe(false)
    }
  })

  it('16. party ledger: rides the streamText messages but is NEVER echoed into the returned parts', async () => {
    mockResult([{ type: 'text-delta', id: '1', text: 'narration' }])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit } = makeEmitter()

    const msg = await ft.render(makeCtx({ partyLedger: PARTY_LEDGER }), emit)

    // The ledger tail is present in the model messages the FT sent.
    const callArgs = streamTextMock.mock.calls[0]?.[0] as {
      messages: import('../../../llm/ai.js').ModelMessage[]
    }
    const ledgerMsg = callArgs.messages.find(
      (m) => typeof m.content === 'string' && m.content.startsWith('[Party ledger:'),
    )
    expect(ledgerMsg).toBeDefined()

    // …but the FT never echoes the ledger block into the transcript it returns.
    expect(msg.parts).toEqual([{ kind: 'text', text: 'narration' }])
    for (const part of msg.parts) {
      if (part.kind === 'text') expect(part.text.startsWith('[Party ledger:')).toBe(false)
    }
  })

  // ── MYT-70 Task 15: ledger_update emission (§8) ────────────────────────────

  it('18. ledger_update: an ok:true ledger tool-result emits ONE emitLedgerUpdate with the payload, in stream-part order', async () => {
    const payload: LedgerUpdatePayload = {
      characterName: 'Arin',
      kind: 'spell_slot',
      summary: 'Arin casts Detect Magic, spending a level-1 slot.',
      slotLevel: 1,
      slotsRemaining: 1,
    }
    mockResult([
      { type: 'text-delta', id: '1', text: 'before' },
      {
        type: 'tool-call',
        toolCallId: 's1',
        toolName: 'cast_spell',
        input: { character_name: 'Arin', spell_name: 'Detect Magic' },
      },
      {
        type: 'tool-result',
        toolCallId: 's1',
        toolName: 'cast_spell',
        input: { character_name: 'Arin', spell_name: 'Detect Magic' },
        output: { ok: true, payload },
      },
      { type: 'text-delta', id: '2', text: 'after' },
    ])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit, seen } = makeEmitter()

    await ft.render(makeCtx(), emit)

    expect(seen.map((e) => e.kind)).toEqual(['text', 'ledger_update', 'text'])
    expect(seen[1]?.payload).toEqual(payload)
  })

  it('19. ledger_update: an ok:false ledger tool-result emits NO emitLedgerUpdate (the loop continues)', async () => {
    mockResult([
      {
        type: 'tool-call',
        toolCallId: 's1',
        toolName: 'spend_resource',
        input: { kind: 'gold', character_name: 'Arin', amount: 500 },
      },
      {
        type: 'tool-result',
        toolCallId: 's1',
        toolName: 'spend_resource',
        input: { kind: 'gold', character_name: 'Arin', amount: 500 },
        output: { ok: false, binding: true, found: true, constraint: 'Arin has only 47gp.' },
      },
      { type: 'text-delta', id: '1', text: 'narrating the shortfall' },
    ])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit, seen } = makeEmitter()

    await ft.render(makeCtx(), emit)

    expect(seen.some((e) => e.kind === 'ledger_update')).toBe(false)
    expect(seen).toEqual([{ kind: 'text', payload: 'narrating the shortfall' }])
  })

  it('20. ledger_update: an update_condition no-op (changed:false) emits NO emitLedgerUpdate', async () => {
    mockResult([
      {
        type: 'tool-call',
        toolCallId: 'u1',
        toolName: 'update_condition',
        input: { character_name: 'Arin', condition: 'prone', action: 'clear' },
      },
      {
        type: 'tool-result',
        toolCallId: 'u1',
        toolName: 'update_condition',
        input: { character_name: 'Arin', condition: 'prone', action: 'clear' },
        output: {
          ok: true,
          payload: {
            characterName: 'Arin',
            kind: 'condition',
            summary: 'Arin was not prone; nothing changed.',
            condition: 'prone',
            changed: false,
          },
        },
      },
    ])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit, seen } = makeEmitter()

    await ft.render(makeCtx(), emit)

    expect(seen.some((e) => e.kind === 'ledger_update')).toBe(false)
  })

  it('21. ledger_update: an update_condition real change (changed:true) emits ONE emitLedgerUpdate', async () => {
    const payload = {
      characterName: 'Arin',
      kind: 'condition' as const,
      summary: 'Arin is now poisoned.',
      condition: 'poisoned',
      changed: true,
    }
    mockResult([
      {
        type: 'tool-call',
        toolCallId: 'u1',
        toolName: 'update_condition',
        input: { character_name: 'Arin', condition: 'poisoned', action: 'apply' },
      },
      {
        type: 'tool-result',
        toolCallId: 'u1',
        toolName: 'update_condition',
        input: { character_name: 'Arin', condition: 'poisoned', action: 'apply' },
        output: { ok: true, payload },
      },
    ])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit, seen } = makeEmitter()

    await ft.render(makeCtx(), emit)

    expect(seen.map((e) => e.kind)).toEqual(['ledger_update'])
    // The publisher-facing payload carries the base LedgerUpdatePayload fields
    // (the extra `changed` flag rides along harmlessly — it is not a frame field).
    const seenPayload = seen[0]?.payload as LedgerUpdatePayload
    expect(seenPayload.characterName).toBe('Arin')
    expect(seenPayload.kind).toBe('condition')
    expect(seenPayload.summary).toBe('Arin is now poisoned.')
  })

  it('22. ledger_update: a take_rest ok:true with TWO characters emits emitLedgerUpdate twice (one per character, §8)', async () => {
    const arin: LedgerUpdatePayload = {
      characterName: 'Arin',
      kind: 'rest',
      summary: 'Arin takes a long rest: HP and slots restored.',
    }
    const bel: LedgerUpdatePayload = {
      characterName: 'Bel',
      kind: 'rest',
      summary: 'Bel takes a long rest: HP and slots restored.',
    }
    mockResult([
      {
        type: 'tool-call',
        toolCallId: 'r1',
        toolName: 'take_rest',
        input: { type: 'long' },
      },
      {
        type: 'tool-result',
        toolCallId: 'r1',
        toolName: 'take_rest',
        input: { type: 'long' },
        output: { ok: true, payload: [arin, bel] },
      },
    ])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit, seen } = makeEmitter()

    await ft.render(makeCtx(), emit)

    expect(seen.map((e) => e.kind)).toEqual(['ledger_update', 'ledger_update'])
    expect(seen[0]?.payload).toEqual(arin)
    expect(seen[1]?.payload).toEqual(bel)
  })

  it('23. ledger_update: a take_rest with an empty payload array emits nothing', async () => {
    mockResult([
      {
        type: 'tool-call',
        toolCallId: 'r1',
        toolName: 'take_rest',
        input: { type: 'short' },
      },
      {
        type: 'tool-result',
        toolCallId: 'r1',
        toolName: 'take_rest',
        input: { type: 'short' },
        output: { ok: true, payload: [] },
      },
    ])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit, seen } = makeEmitter()

    await ft.render(makeCtx(), emit)

    expect(seen.some((e) => e.kind === 'ledger_update')).toBe(false)
  })

  it('24. ledger_update: an adjust_hp result carrying diceRolled threads the rolled faces onto the frame', async () => {
    const payload = {
      characterName: 'Arin',
      kind: 'hp' as const,
      summary: 'Arin takes 7 damage.',
      hp: 11,
      maxHp: 18,
      diceRolled: [3, 4],
    }
    mockResult([
      {
        type: 'tool-call',
        toolCallId: 'h1',
        toolName: 'adjust_hp',
        input: { character_name: 'Arin', amount: '2d6' },
      },
      {
        type: 'tool-result',
        toolCallId: 'h1',
        toolName: 'adjust_hp',
        input: { character_name: 'Arin', amount: '2d6' },
        output: { ok: true, payload },
      },
    ])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit, seen } = makeEmitter()

    await ft.render(makeCtx(), emit)

    expect(seen.map((e) => e.kind)).toEqual(['ledger_update'])
    const seenPayload = seen[0]?.payload as LedgerUpdatePayload
    expect(seenPayload.diceRolled).toEqual([3, 4])
    expect(seenPayload.hp).toBe(11)
  })

  it('25. ledger_update: a payload carrying gold/item/feature value fields threads them all onto the frame', async () => {
    // A single ok:true payload exercising the remaining optional-field
    // present-arms in toLedgerUpdatePayload (gold, itemName, quantity,
    // featureName, usesRemaining).
    const payload = {
      characterName: 'Arin',
      kind: 'feature' as const,
      summary: 'Arin spends a Channel Divinity use, buys a torch, and pays 5 gold.',
      gold: 42,
      itemName: 'Torch',
      quantity: 3,
      featureName: 'Channel Divinity',
      usesRemaining: 0,
    }
    mockResult([
      {
        type: 'tool-call',
        toolCallId: 's1',
        toolName: 'spend_resource',
        input: { kind: 'feature', character_name: 'Arin', name: 'Channel Divinity' },
      },
      {
        type: 'tool-result',
        toolCallId: 's1',
        toolName: 'spend_resource',
        input: { kind: 'feature', character_name: 'Arin', name: 'Channel Divinity' },
        output: { ok: true, payload },
      },
    ])
    const ft = new SonnetFastThinker({ tools: {} })
    const { emit, seen } = makeEmitter()

    await ft.render(makeCtx(), emit)

    expect(seen.map((e) => e.kind)).toEqual(['ledger_update'])
    const seenPayload = seen[0]?.payload as LedgerUpdatePayload
    expect(seenPayload.gold).toBe(42)
    expect(seenPayload.itemName).toBe('Torch')
    expect(seenPayload.quantity).toBe(3)
    expect(seenPayload.featureName).toBe('Channel Divinity')
    expect(seenPayload.usesRemaining).toBe(0)
  })
})

describe('formatPartyLedger', () => {
  it('17. carries the NOUNS: a spell name, an equipment name, and a slot-ledger string (the §7 showstopper fix)', () => {
    const block = formatPartyLedger(PARTY_LEDGER)
    // Spell name (cast_spell must be drivable from paraphrase → exact match).
    expect(block).toContain('Spiritual Weapon')
    // Equipment name (spend/use must be drivable from paraphrase).
    expect(block).toContain('Healing Potion')
    // Slot ledger in the `L1 2/4` style.
    expect(block).toContain('L1 2/4')
    expect(block).toContain('L2 0/2')
    // HP cur/max + the character name + a condition + a tracked feature.
    expect(block).toContain('Arin')
    expect(block).toContain('18/24')
    expect(block).toContain('poisoned')
    expect(block).toContain('Channel Divinity')
  })

  it('renders "none" for every empty sub-list (all sub-lists empty)', () => {
    const empty: PartyLedgerSnapshot = [
      {
        characterId: 'char-bare',
        name: 'Bare',
        hitPoints: 8,
        maxHitPoints: 8,
        hitDie: 6,
        hitDiceRemaining: 1,
        level: 1,
        gold: 0,
        slots: [],
        conditions: [],
        trackedFeatures: [],
        spells: [],
        equipment: [],
      },
    ]
    const block = formatPartyLedger(empty)
    expect(block).toContain('slots none')
    expect(block).toContain('conditions none')
    expect(block).toContain('features none')
    expect(block).toContain('spells none')
    expect(block).toContain('equipment none')
  })

  it('groups two spells at the same level into one Ln bucket and numbers exhaustion', () => {
    const grouped: PartyLedgerSnapshot = [
      {
        characterId: 'char-mage',
        name: 'Mage',
        hitPoints: 10,
        maxHitPoints: 10,
        hitDie: 6,
        hitDiceRemaining: 1,
        level: 3,
        gold: 5,
        slots: [{ slotLevel: 1, slotsMax: 4, slotsRemaining: 4 }],
        conditions: [{ condition: 'exhaustion', level: 2 }],
        trackedFeatures: [
          { name: 'Arcane Recovery', maxUses: 1, usesRemaining: 1, recharge: 'long_rest' },
        ],
        // Two level-1 spells → the second hits the existing-bucket push arm.
        spells: [
          { name: 'Magic Missile', level: 1, prepared: true, ritual: false },
          { name: 'Shield', level: 1, prepared: false, ritual: false },
        ],
        equipment: [{ name: 'Dagger', quantity: 1, consumable: false }],
      },
    ]
    const block = formatPartyLedger(grouped)
    // Both same-level spells render in one L1 bucket.
    expect(block).toContain('Magic Missile')
    expect(block).toContain('Shield')
    expect(block).toMatch(/L1: .*Magic Missile.*Shield/)
    // A leveled condition (exhaustion) renders with its numeric level.
    expect(block).toContain('exhaustion 2')
  })
})

describe('buildModelMessages', () => {
  const ANTHROPIC_CACHE = { anthropic: { cacheControl: { type: 'ephemeral' } } }

  it('9. system message carries ft_context + roster + the anthropic cacheControl breakpoint', () => {
    const ctx = makeCtx({
      ftContext: 'UNIQUE_CONTEXT_MARKER',
      participants: ['Arin', 'Bel'],
      ftHistory: [
        { v: 1, role: 'user', parts: [{ kind: 'text', text: 'hi' }], characterName: 'Arin' },
      ],
    })
    const messages = buildModelMessages(ctx)

    const system = messages[0]
    expect(system?.role).toBe('system')
    expect(typeof system?.content).toBe('string')
    expect(system?.content as string).toContain('UNIQUE_CONTEXT_MARKER')
    expect(system?.content as string).toContain('Arin, Bel')
    expect(system?.providerOptions).toEqual(ANTHROPIC_CACHE)
  })

  it('9b. the second-to-last message (last SETTLED) carries the cacheControl breakpoint', () => {
    const ctx = makeCtx({
      ftHistory: [
        { v: 1, role: 'user', parts: [{ kind: 'text', text: 'one' }], characterName: 'Arin' },
        { v: 1, role: 'assistant', parts: [{ kind: 'text', text: 'reply' }] },
        { v: 1, role: 'user', parts: [{ kind: 'text', text: 'two' }], characterName: 'Bel' },
      ],
    })
    const messages = buildModelMessages(ctx)

    const secondToLast = messages[messages.length - 2]
    const last = messages[messages.length - 1]
    expect(secondToLast?.providerOptions).toEqual(ANTHROPIC_CACHE)
    // The last (unsettled current batch) does NOT carry the breakpoint.
    expect(last?.providerOptions).toBeUndefined()
  })

  it('9c. user messages render as "CharacterName: text" (Player fallback when name absent)', () => {
    const ctx = makeCtx({
      ftHistory: [
        { v: 1, role: 'user', parts: [{ kind: 'text', text: 'hi' }], characterName: 'Arin' },
        { v: 1, role: 'user', parts: [{ kind: 'text', text: 'anon' }] },
      ],
    })
    const messages = buildModelMessages(ctx)

    const named = messages[1]
    const anon = messages[2]
    expect(named?.role).toBe('user')
    expect(named?.content).toBe('Arin: hi')
    expect(anon?.content).toBe('Player: anon')
  })

  it('9d. assistant with tool parts splits into an assistant ModelMessage + a tool ModelMessage', () => {
    const history: ConversationMessage[] = [
      { v: 1, role: 'user', parts: [{ kind: 'text', text: 'do a thing' }], characterName: 'Arin' },
      {
        v: 1,
        role: 'assistant',
        parts: [
          { kind: 'text', text: 'You try.' },
          { kind: 'tool_call', toolCallId: 'c1', toolName: 'roll_skill_check', input: { skill: 'Persuasion' } },
          { kind: 'tool_result', toolCallId: 'c1', toolName: 'roll_skill_check', output: SKILL_OUTPUT },
        ],
      },
    ]
    const messages = buildModelMessages(makeCtx({ ftHistory: history }))

    // system, user, assistant, tool
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])

    const assistant = messages[2]
    expect(Array.isArray(assistant?.content)).toBe(true)
    const aContent = assistant?.content as { type: string }[]
    expect(aContent.map((c) => c.type)).toEqual(['text', 'tool-call'])

    const toolMsg = messages[3]
    const tContent = toolMsg?.content as { type: string; output: { type: string; value: unknown } }[]
    expect(tContent[0]?.type).toBe('tool-result')
    expect(tContent[0]?.output).toEqual({ type: 'json', value: SKILL_OUTPUT })
  })

  it('9e. determinism: same ctx → byte-identical JSON', () => {
    const ctx = makeCtx({
      ftHistory: [
        { v: 1, role: 'user', parts: [{ kind: 'text', text: 'one' }], characterName: 'Arin' },
        { v: 1, role: 'assistant', parts: [{ kind: 'text', text: 'reply' }] },
      ],
    })
    const a = JSON.stringify(buildModelMessages(ctx))
    const b = JSON.stringify(buildModelMessages(ctx))
    expect(a).toBe(b)
  })

  it('15. standing directive: appends ONE raw uncached [DM direction: …] tail as the LAST message', () => {
    const ctx = makeCtx({
      ftHistory: [
        { v: 1, role: 'user', parts: [{ kind: 'text', text: 'one' }], characterName: 'Arin' },
        { v: 1, role: 'assistant', parts: [{ kind: 'text', text: 'reply' }] },
        { v: 1, role: 'user', parts: [{ kind: 'text', text: 'two' }], characterName: 'Bel' },
      ],
      standingDirective: 'Steer toward a close',
    })
    const messages = buildModelMessages(ctx)

    const last = messages[messages.length - 1]
    expect(last).toEqual({ role: 'user', content: '[DM direction: Steer toward a close]' })
    // The standing tail rides the always-uncached zone: NO providerOptions.
    expect(last?.providerOptions).toBeUndefined()
  })

  it('15b. standing directive does NOT shift the breakpoint: the same HISTORY message carries it with or without the tail', () => {
    const history: ConversationMessage[] = [
      { v: 1, role: 'user', parts: [{ kind: 'text', text: 'one' }], characterName: 'Arin' },
      { v: 1, role: 'assistant', parts: [{ kind: 'text', text: 'reply' }] },
      { v: 1, role: 'user', parts: [{ kind: 'text', text: 'two' }], characterName: 'Bel' },
    ]
    const without = buildModelMessages(makeCtx({ ftHistory: history }))
    const withTail = buildModelMessages(makeCtx({ ftHistory: history, standingDirective: 'Steer toward a close' }))

    // Without the tail: breakpoint on the second-to-last message (the last
    // settled history message). It must remain on the SAME content message
    // when the tail is appended — i.e. the breakpointed message is identical.
    const baselineBreakpointed = without.find((m) => m.providerOptions !== undefined && m.role !== 'system')
    expect(baselineBreakpointed).toBeDefined()
    const tailedBreakpointed = withTail.find((m) => m.providerOptions !== undefined && m.role !== 'system')
    expect(tailedBreakpointed).toEqual(baselineBreakpointed)
    // And the breakpoint is NOT on the appended tail.
    expect(withTail[withTail.length - 1]?.providerOptions).toBeUndefined()
  })

  it('15c. no standing directive: no extra tail message (unchanged shape)', () => {
    const history: ConversationMessage[] = [
      { v: 1, role: 'user', parts: [{ kind: 'text', text: 'one' }], characterName: 'Arin' },
      { v: 1, role: 'assistant', parts: [{ kind: 'text', text: 'reply' }] },
    ]
    const without = buildModelMessages(makeCtx({ ftHistory: history }))
    // exactOptionalPropertyTypes forbids an explicit `standingDirective:
    // undefined` literal — "absent key" IS the undefined case, covered by
    // `without` above. The runtime guard's empty-string arm is tested here.
    const withEmpty = buildModelMessages(makeCtx({ ftHistory: history, standingDirective: '' }))

    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(without))
    // No tail message wrapped as a DM direction.
    expect(without.some((m) => typeof m.content === 'string' && m.content.startsWith('[DM direction:'))).toBe(false)
  })

  it('16. party ledger only: appends ONE raw uncached [Party ledger: …] tail as the LAST message', () => {
    const ctx = makeCtx({
      ftHistory: [
        { v: 1, role: 'user', parts: [{ kind: 'text', text: 'one' }], characterName: 'Arin' },
        { v: 1, role: 'assistant', parts: [{ kind: 'text', text: 'reply' }] },
        { v: 1, role: 'user', parts: [{ kind: 'text', text: 'two' }], characterName: 'Bel' },
      ],
      partyLedger: PARTY_LEDGER,
    })
    const messages = buildModelMessages(ctx)

    const last = messages[messages.length - 1]
    expect(typeof last?.content).toBe('string')
    expect((last?.content as string).startsWith('[Party ledger:')).toBe(true)
    // The ledger tail rides the always-uncached zone: NO providerOptions.
    expect(last?.providerOptions).toBeUndefined()
    // It carries the showstopper-fix nouns.
    expect(last?.content as string).toContain('Spiritual Weapon')
    expect(last?.content as string).toContain('Healing Potion')
    expect(last?.content as string).toContain('L1 2/4')
  })

  it('16b. merge order: party ledger FIRST, standing directive LAST (the DM instruction is closest to generation)', () => {
    const ctx = makeCtx({
      ftHistory: [
        { v: 1, role: 'user', parts: [{ kind: 'text', text: 'one' }], characterName: 'Arin' },
        { v: 1, role: 'assistant', parts: [{ kind: 'text', text: 'reply' }] },
        { v: 1, role: 'user', parts: [{ kind: 'text', text: 'two' }], characterName: 'Bel' },
      ],
      partyLedger: PARTY_LEDGER,
      standingDirective: 'Steer toward a close',
    })
    const messages = buildModelMessages(ctx)

    const last = messages[messages.length - 1]
    const secondToLast = messages[messages.length - 2]
    // Standing directive LAST.
    expect(last).toEqual({ role: 'user', content: '[DM direction: Steer toward a close]' })
    // Party ledger immediately BEFORE it.
    expect(typeof secondToLast?.content).toBe('string')
    expect((secondToLast?.content as string).startsWith('[Party ledger:')).toBe(true)
    expect(secondToLast?.providerOptions).toBeUndefined()
  })

  it('16c. party ledger does NOT shift the breakpoint: the same HISTORY message carries it with or without the tail', () => {
    const history: ConversationMessage[] = [
      { v: 1, role: 'user', parts: [{ kind: 'text', text: 'one' }], characterName: 'Arin' },
      { v: 1, role: 'assistant', parts: [{ kind: 'text', text: 'reply' }] },
      { v: 1, role: 'user', parts: [{ kind: 'text', text: 'two' }], characterName: 'Bel' },
    ]
    const without = buildModelMessages(makeCtx({ ftHistory: history }))
    const withTail = buildModelMessages(makeCtx({ ftHistory: history, partyLedger: PARTY_LEDGER }))

    const baselineBreakpointed = without.find((m) => m.providerOptions !== undefined && m.role !== 'system')
    expect(baselineBreakpointed).toBeDefined()
    const tailedBreakpointed = withTail.find((m) => m.providerOptions !== undefined && m.role !== 'system')
    expect(tailedBreakpointed).toEqual(baselineBreakpointed)
    // And the breakpoint is NOT on the appended ledger tail.
    expect(withTail[withTail.length - 1]?.providerOptions).toBeUndefined()
  })

  it('16d. no party ledger: no extra tail message (unchanged shape)', () => {
    const history: ConversationMessage[] = [
      { v: 1, role: 'user', parts: [{ kind: 'text', text: 'one' }], characterName: 'Arin' },
      { v: 1, role: 'assistant', parts: [{ kind: 'text', text: 'reply' }] },
    ]
    const without = buildModelMessages(makeCtx({ ftHistory: history }))
    const withEmpty = buildModelMessages(makeCtx({ ftHistory: history, partyLedger: [] }))

    // An empty roster snapshot renders no tail (no characters to show).
    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(without))
    expect(without.some((m) => typeof m.content === 'string' && m.content.startsWith('[Party ledger:'))).toBe(false)
  })
})
