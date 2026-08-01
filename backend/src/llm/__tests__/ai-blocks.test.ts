/* eslint-disable @typescript-eslint/no-deprecated, max-lines -- test fixture file: mocks the SDK's deprecated streamObject (design §4.1 mandate); size is dominated by blocks-contract case enumeration. */
// backend/src/llm/__tests__/ai-blocks.test.ts
//
// Cost-wave1 §2 — the blocks seam. `PromptBlocks` compile INSIDE ai.ts to the
// SDK messages form with per-MESSAGE `providerOptions.anthropic.cacheControl`
// on breakpoint blocks (the FT's proven mechanism — fast-thinker.ts). Pinned
// here:
//   1. compilation shape (the SDK mock captures the messages array),
//   2. exact breakpoint placement (per-message; ABSENT on unmarked blocks),
//   3. the ≤4-breakpoint assert (throw, not the provider's warn),
//   4. blocks ⊕ prompt/system mutual exclusion (runtime assert at entry,
//      BEFORE any transport/loop machinery),
//   5. legacy flat-prompt byte-identity (the args each SDK mock receives are
//      pinned to the pre-blocks shape — keys AND values),
//   6. loop-path threading (stageBudgetMs attempts carry the same messages).
//
// CORRECTED PREMISE (spec §2): call-level providerOptions.anthropic.
// cacheControl is NOT inert on the installed provider — it maps to top-level
// auto-caching of the LAST cacheable block (wrong placement: buys the write
// premium with near-zero reads on a volatile-suffixed flat prompt). The only
// correct mechanism is per-message placement, i.e. the BLOCKS path asserted
// here.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateText: vi.fn(),
    streamObject: vi.fn(),
    streamText: vi.fn(),
    Output: { object: vi.fn((opts: unknown) => opts) },
  }
})

import * as ai from 'ai'
import {
  generateObject,
  streamObject,
  generateText as wrapperGenerateText,
  setLlmHealthSink,
  type PromptBlocks,
} from '../ai.js'
import { SONNET } from '../models.js'

const mockGenerateText = vi.mocked(ai.generateText)
const mockStreamObject = vi.mocked(ai.streamObject)
const mockStreamText = vi.mocked(ai.streamText)

const TestSchema = z.object({ name: z.string().min(1).max(10) })
type TestShape = z.infer<typeof TestSchema>

/** The FT-proven per-message breakpoint shape (fast-thinker.ts §3.9). */
const BREAKPOINT = { anthropic: { cacheControl: { type: 'ephemeral' } } }

function makeUsage(input = 100, output = 50): {
  inputTokens: number
  outputTokens: number
  totalTokens: number
} {
  return { inputTokens: input, outputTokens: output, totalTokens: input + output }
}

function okGenerateResult(name: string): Awaited<ReturnType<typeof ai.generateText>> {
  return {
    output: { name },
    usage: makeUsage(),
  } as unknown as Awaited<ReturnType<typeof ai.generateText>>
}

function okStreamTextResult(name: string): ReturnType<typeof ai.streamText> {
  return {
    output: Promise.resolve({ name }),
    totalUsage: Promise.resolve(makeUsage()),
  } as unknown as ReturnType<typeof ai.streamText>
}

function failingStreamTextResult(err: Error): ReturnType<typeof ai.streamText> {
  const output = Promise.reject(err)
  // Pre-handle so the rejection can't surface as unhandled between microtasks.
  void output.catch(() => undefined)
  return {
    output,
    totalUsage: new Promise(() => undefined),
  } as unknown as ReturnType<typeof ai.streamText>
}

function fakeStreamObjectResult(name: string): ReturnType<typeof ai.streamObject> {
  async function* gen(): AsyncGenerator<{ name: string }> {
    yield await Promise.resolve({ name })
  }
  return {
    partialObjectStream: gen(),
    object: Promise.resolve({ name }),
    usage: Promise.resolve(makeUsage()),
    warnings: Promise.resolve(undefined),
  } as unknown as ReturnType<typeof ai.streamObject>
}

/** system head (breakpointed) + stable span (breakpointed) + volatile tail. */
const THREE_BLOCKS: PromptBlocks = [
  { role: 'system', text: 'system head', cacheBreakpoint: true },
  { role: 'user', text: 'stable span', cacheBreakpoint: true },
  { role: 'user', text: 'volatile tail' },
]

const EXPECTED_THREE_MESSAGES = [
  { role: 'system', content: 'system head', providerOptions: BREAKPOINT },
  { role: 'user', content: 'stable span', providerOptions: BREAKPOINT },
  { role: 'user', content: 'volatile tail' },
]

/** `total` user blocks, the first `breakpointed` of them marked. */
function userBlocks(total: number, breakpointed: number): PromptBlocks {
  return Array.from({ length: total }, (_, i) => ({
    role: 'user' as const,
    text: `block ${String(i)}`,
    ...(i < breakpointed ? { cacheBreakpoint: true } : {}),
  }))
}

function argsOf(mock: { mock: { calls: unknown[][] } }, call = 0): Record<string, unknown> {
  return mock.mock.calls[call]?.[0] as Record<string, unknown>
}

beforeEach(() => {
  mockGenerateText.mockReset()
  mockStreamObject.mockReset()
  mockStreamText.mockReset()
  vi.restoreAllMocks()
  setLlmHealthSink(null)
})

describe('blocks compilation — generateObject (legacy transport)', () => {
  it('compiles blocks to the FT-shaped messages array with per-message breakpoints', async () => {
    mockGenerateText.mockResolvedValueOnce(okGenerateResult('Alice'))

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      blocks: THREE_BLOCKS,
      callSite: 'test/blocks-compile',
    })

    expect(result.output).toEqual({ name: 'Alice' })
    const args = argsOf(mockGenerateText)
    expect(args.messages).toEqual(EXPECTED_THREE_MESSAGES)
    // The blocks path never sends the flat-prompt keys.
    expect('prompt' in args).toBe(false)
    expect('system' in args).toBe(false)
  })

  it('breakpoint placement is exact: unmarked blocks carry NO providerOptions key', async () => {
    mockGenerateText.mockResolvedValueOnce(okGenerateResult('Bea'))

    await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      blocks: [
        { role: 'system', text: 'head' },
        { role: 'user', text: 'middle', cacheBreakpoint: true },
        { role: 'user', text: 'explicit-false', cacheBreakpoint: false },
        { role: 'user', text: 'tail' },
      ],
      callSite: 'test/blocks-placement',
    })

    const messages = argsOf(mockGenerateText).messages as Record<string, unknown>[]
    // toEqual treats `providerOptions: undefined` as equal to an absent key,
    // so pin key ABSENCE explicitly — a stray undefined-valued key would
    // still serialize into the wire request.
    expect(messages.map((m) => Object.keys(m))).toEqual([
      ['role', 'content'],
      ['role', 'content', 'providerOptions'],
      ['role', 'content'],
      ['role', 'content'],
    ])
    expect(messages[1]?.providerOptions).toEqual(BREAKPOINT)
  })

  it('exactly 4 breakpoints is allowed', async () => {
    mockGenerateText.mockResolvedValueOnce(okGenerateResult('Cara'))

    await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      blocks: userBlocks(5, 4),
      callSite: 'test/blocks-four',
    })

    const messages = argsOf(mockGenerateText).messages as Record<string, unknown>[]
    expect(messages.filter((m) => 'providerOptions' in m)).toHaveLength(4)
  })

  it('more than 4 breakpoints throws before any SDK call', async () => {
    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        blocks: userBlocks(6, 5),
        callSite: 'test/blocks-five',
      }),
    ).rejects.toThrow(/5 cache breakpoints exceeds the provider limit of 4/)
    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(mockStreamText).not.toHaveBeenCalled()
  })

  it('blocks + prompt throws the mutual-exclusion assert', async () => {
    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'flat prompt',
        blocks: THREE_BLOCKS,
        callSite: 'test/blocks-plus-prompt',
      }),
    ).rejects.toThrow(/blocks and prompt\/system are mutually exclusive/)
    expect(mockGenerateText).not.toHaveBeenCalled()
  })

  it('blocks + system throws the mutual-exclusion assert', async () => {
    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        system: 'sys',
        blocks: THREE_BLOCKS,
        callSite: 'test/blocks-plus-system',
      }),
    ).rejects.toThrow(/blocks and prompt\/system are mutually exclusive/)
    expect(mockGenerateText).not.toHaveBeenCalled()
  })

  it('neither blocks nor prompt throws', async () => {
    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        callSite: 'test/blocks-neither',
      }),
    ).rejects.toThrow(/exactly one of blocks or prompt is required/)
    expect(mockGenerateText).not.toHaveBeenCalled()
  })

  it('empty blocks throws', async () => {
    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        blocks: [],
        callSite: 'test/blocks-empty',
      }),
    ).rejects.toThrow(/blocks must be non-empty/)
    expect(mockGenerateText).not.toHaveBeenCalled()
  })

  it('zero user blocks throws (all-system compiles to empty messages)', async () => {
    // The provider hoists leading system blocks into the top-level system
    // param — an all-system list compiles to messages: [] and is a
    // guaranteed runtime rejection. The seam throws at entry instead.
    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        blocks: [
          { role: 'system', text: 'head', cacheBreakpoint: true },
          { role: 'system', text: 'more head' },
        ],
        callSite: 'test/blocks-no-user',
      }),
    ).rejects.toThrow(/at least one user block is required/)
    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(mockStreamText).not.toHaveBeenCalled()
  })

  it('a system block after a user block throws (mid-conversation system is model-gated)', async () => {
    // A system message after a user message makes the provider silently add
    // the model-gated mid-conversation-system beta header — a 400 on
    // Haiku/Sonnet and an unasserted wire-shape change on any model.
    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        blocks: [
          { role: 'system', text: 'head', cacheBreakpoint: true },
          { role: 'user', text: 'stable span' },
          { role: 'system', text: 'interleaved' },
          { role: 'user', text: 'volatile tail' },
        ],
        callSite: 'test/blocks-interleaved-system',
      }),
    ).rejects.toThrow(/system blocks must precede the first user block/)
    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(mockStreamText).not.toHaveBeenCalled()
  })
})

describe('blocks on streamObject', () => {
  it('compiles blocks to messages on the streamObject transport', async () => {
    mockStreamObject.mockReturnValueOnce(fakeStreamObjectResult('Dana'))

    const result = streamObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      blocks: THREE_BLOCKS,
      callSite: 'test/stream-blocks',
    })

    await expect(result.object).resolves.toEqual({ name: 'Dana' })
    const args = argsOf(mockStreamObject)
    expect(args.messages).toEqual(EXPECTED_THREE_MESSAGES)
    expect('prompt' in args).toBe(false)
  })

  it('blocks + prompt throws synchronously (streamObject is sync)', () => {
    expect(() =>
      streamObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'flat',
        blocks: THREE_BLOCKS,
        callSite: 'test/stream-blocks-exclusive',
      }),
    ).toThrow(/blocks and prompt\/system are mutually exclusive/)
    expect(mockStreamObject).not.toHaveBeenCalled()
  })
})

describe('blocks on generateText', () => {
  it('compiles blocks to messages on the generateText transport', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'prose',
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    const result = await wrapperGenerateText({
      model: SONNET,
      blocks: THREE_BLOCKS,
      callSite: 'test/text-blocks',
    })

    expect(result.text).toBe('prose')
    const args = argsOf(mockGenerateText)
    expect(args.messages).toEqual(EXPECTED_THREE_MESSAGES)
    expect('prompt' in args).toBe(false)
    expect('system' in args).toBe(false)
  })

  it('blocks + system throws', async () => {
    await expect(
      wrapperGenerateText({
        model: SONNET,
        system: 'sys',
        blocks: THREE_BLOCKS,
        callSite: 'test/text-blocks-exclusive',
      }),
    ).rejects.toThrow(/blocks and prompt\/system are mutually exclusive/)
    expect(mockGenerateText).not.toHaveBeenCalled()
  })
})

describe('loop path (stageBudgetMs) threads blocks through the streaming attempt', () => {
  it('a loop attempt sends the compiled messages, never a flat prompt', async () => {
    mockStreamText.mockReturnValueOnce(okStreamTextResult('Elle'))

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      blocks: THREE_BLOCKS,
      callSite: 'test/loop-blocks',
      stageBudgetMs: 120_000,
    })

    expect(result.output).toEqual({ name: 'Elle' })
    expect(mockGenerateText).not.toHaveBeenCalled()
    const args = argsOf(mockStreamText)
    expect(args.messages).toEqual(EXPECTED_THREE_MESSAGES)
    expect('prompt' in args).toBe(false)
    expect('system' in args).toBe(false)
    // Loop invariants hold on the blocks path too.
    expect(args.maxRetries).toBe(0)
  })

  it('a retried attempt carries the identical compiled messages', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    mockStreamText
      .mockReturnValueOnce(
        failingStreamTextResult(Object.assign(new Error('transport died'), { code: 'ECONNRESET' })),
      )
      .mockReturnValueOnce(okStreamTextResult('Faye'))

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      blocks: THREE_BLOCKS,
      callSite: 'test/loop-blocks-retry',
      stageBudgetMs: 600_000,
    })

    expect(result.output).toEqual({ name: 'Faye' })
    expect(mockStreamText).toHaveBeenCalledTimes(2)
    expect(argsOf(mockStreamText, 0).messages).toEqual(EXPECTED_THREE_MESSAGES)
    expect(argsOf(mockStreamText, 1).messages).toEqual(EXPECTED_THREE_MESSAGES)
  })

  it('contract violations throw at entry, before any loop attempt runs', async () => {
    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'flat',
        blocks: THREE_BLOCKS,
        callSite: 'test/loop-blocks-entry-assert',
        stageBudgetMs: 600_000,
      }),
    ).rejects.toThrow(/blocks and prompt\/system are mutually exclusive/)
    expect(mockStreamText).not.toHaveBeenCalled()
  })
})

// Legacy byte-identity: flat-prompt calls must produce EXACTLY the pre-blocks
// SDK args — same keys in the same order, same values. These four tests were
// authored and run GREEN against the pre-seam ai.ts, then kept as the oracle.
describe('legacy flat-prompt byte-identity', () => {
  it('generateObject (legacy transport) args are unchanged', async () => {
    mockGenerateText.mockResolvedValueOnce(okGenerateResult('Gwen'))

    await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      system: 'be terse',
      callSite: 'test/identity-generate',
      maxRetries: 2,
      maxOutputTokens: 900,
      providerOptions: { mythrun: { stage: 'concept_intake' } },
    })

    const args = argsOf(mockGenerateText)
    expect(Object.keys(args)).toEqual([
      'model',
      'output',
      'prompt',
      'abortSignal',
      'system',
      'maxRetries',
      'maxOutputTokens',
      'providerOptions',
    ])
    expect(args.model).toBe(SONNET)
    expect(args.output).toMatchObject({ schema: TestSchema })
    expect(args.prompt).toBe('pick a name')
    expect(args.system).toBe('be terse')
    expect(args.maxRetries).toBe(2)
    expect(args.maxOutputTokens).toBe(900)
    expect(args.providerOptions).toEqual({ mythrun: { stage: 'concept_intake' } })
    expect(args.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('streamObject args are unchanged', async () => {
    mockStreamObject.mockReturnValueOnce(fakeStreamObjectResult('Hana'))

    const result = streamObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'stream a name',
      callSite: 'test/identity-stream',
      maxRetries: 1,
      maxOutputTokens: 700,
      providerOptions: { mythrun: { stage: 'session_prep' } },
    })
    await result.object

    const args = argsOf(mockStreamObject)
    expect(Object.keys(args)).toEqual([
      'model',
      'schema',
      'prompt',
      'abortSignal',
      'maxRetries',
      'maxOutputTokens',
      'providerOptions',
    ])
    expect(args.model).toBe(SONNET)
    expect(args.schema).toBe(TestSchema)
    expect(args.prompt).toBe('stream a name')
    expect(args.maxRetries).toBe(1)
    expect(args.maxOutputTokens).toBe(700)
    expect(args.providerOptions).toEqual({ mythrun: { stage: 'session_prep' } })
    expect(args.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('generateText args are unchanged', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'prose',
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    await wrapperGenerateText({
      model: SONNET,
      prompt: 'say something',
      system: 'be brief',
      maxRetries: 3,
      providerOptions: { mythrun: { stage: 'concept_intake' } },
    })

    const args = argsOf(mockGenerateText)
    expect(Object.keys(args)).toEqual([
      'model',
      'prompt',
      'abortSignal',
      'system',
      'maxRetries',
      'providerOptions',
    ])
    expect(args.model).toBe(SONNET)
    expect(args.prompt).toBe('say something')
    expect(args.system).toBe('be brief')
    expect(args.maxRetries).toBe(3)
    expect(args.providerOptions).toEqual({ mythrun: { stage: 'concept_intake' } })
    expect(args.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('loop-path (stageBudgetMs) flat-prompt streamText args are unchanged', async () => {
    mockStreamText.mockReturnValueOnce(okStreamTextResult('Iris'))

    await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      system: 'be terse',
      callSite: 'test/identity-loop',
      stageBudgetMs: 120_000,
      maxOutputTokens: 800,
      providerOptions: { mythrun: { stage: 'concept_intake' } },
    })

    const args = argsOf(mockStreamText)
    expect(Object.keys(args)).toEqual([
      'model',
      'prompt',
      'output',
      'abortSignal',
      'maxRetries',
      'onError',
      'system',
      'maxOutputTokens',
      'providerOptions',
    ])
    expect(args.model).toBe(SONNET)
    expect(args.prompt).toBe('pick a name')
    expect(args.system).toBe('be terse')
    expect(args.maxRetries).toBe(0)
    expect(args.maxOutputTokens).toBe(800)
    expect(args.providerOptions).toEqual({ mythrun: { stage: 'concept_intake' } })
    expect(typeof args.onError).toBe('function')
  })
})
