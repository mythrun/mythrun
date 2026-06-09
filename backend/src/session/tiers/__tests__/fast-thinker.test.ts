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
  ConversationMessage,
} from '../types.js'

const streamTextMock = vi.fn()

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    streamText: (...args: unknown[]): unknown => streamTextMock(...args) as unknown,
  }
})

const { SonnetFastThinker, buildModelMessages } = await import('../fast-thinker.js')

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
  readonly kind: 'text' | 'skill_check' | 'dice_roll'
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
})
