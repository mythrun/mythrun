/* eslint-disable @typescript-eslint/no-deprecated, @typescript-eslint/require-await, @typescript-eslint/prefer-promise-reject-errors, max-lines -- test fixture file: mocks the SDK's deprecated streamObject (design §4.1 mandate); uses async generators + Promise.reject for fake stream shape; size is dominated by repair-fallback case enumeration. */
// backend/src/llm/__tests__/ai.test.ts
//
// Tests the schema-validated LLM wrapper (Phase 1 of myth-t1qz). The wrapper
// surfaces `generateObject`, `streamObject`, and `generateText` as the
// canonical entrypoints for all `from 'ai'` consumption inside Mythrun.
//
// Mock strategy: vi.mock('ai') replaces the SDK's `generateText`,
// `streamObject`, and `Output.object`. The wrapper invokes the SDK via these
// mocks; the repair helper (structured-output-repair.ts) is left UN-mocked
// because it also imports from 'ai' — so its own generateText call goes
// through the same SDK mock. We seed mockGenerateText with a queue of
// responses to drive both the primary call AND the repair calls.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { LlmStructuredOutputError } from '../errors.js'
import { logger } from '../logger.js'
import { HAIKU, SONNET } from '../models.js'

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateText: vi.fn(),
    streamObject: vi.fn(),
    Output: { object: vi.fn((opts: unknown) => opts) },
  }
})

import * as ai from 'ai'
import { generateObject, streamObject, generateText as wrapperGenerateText } from '../ai.js'

const mockGenerateText = vi.mocked(ai.generateText)
const mockStreamObject = vi.mocked(ai.streamObject)

const TestSchema = z.object({
  name: z.string().min(1).max(10),
})
type TestShape = z.infer<typeof TestSchema>

function makeStructuredError(rawText: string | undefined): LlmStructuredOutputError {
  // Mirrors the shape produced by middleware.ts when AI_NoObjectGeneratedError
  // surfaces from the SDK: cause.text carries the model's raw final output.
  const cause = { text: rawText, name: 'AI_NoObjectGeneratedError' }
  return new LlmStructuredOutputError('llm returned unparseable structured output', { cause })
}

function makeUsage(input = 100, output = 50): {
  inputTokens: number
  outputTokens: number
  totalTokens: number
} {
  return { inputTokens: input, outputTokens: output, totalTokens: input + output }
}

describe('generateObject', () => {
  beforeEach(() => {
    mockGenerateText.mockReset()
    mockStreamObject.mockReset()
    vi.restoreAllMocks()
  })

  it('returns { output, usage, repairAttempted: false } on happy path', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'Alice' },
      usage: makeUsage(200, 80),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/happy-path',
    })

    expect(result.output).toEqual({ name: 'Alice' })
    expect(result.usage.inputTokens).toBe(200)
    expect(result.usage.outputTokens).toBe(80)
    expect(result.repairAttempted).toBe(false)
    // Primary call only, no repair invocations.
    expect(mockGenerateText).toHaveBeenCalledOnce()
  })

  it('forwards temperature, maxRetries, providerOptions, schemaName to the SDK', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'Bob' },
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/forward-opts',
      temperature: 0.42,
      maxRetries: 2,
      providerOptions: { mythrun: { stage: 'concept_intake' } },
      schemaName: 'TestSchema',
    })

    const callArgs = mockGenerateText.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(callArgs).toMatchObject({
      model: SONNET,
      prompt: 'pick a name',
      temperature: 0.42,
      maxRetries: 2,
    })
    expect(callArgs.providerOptions).toEqual({ mythrun: { stage: 'concept_intake' } })
  })

  it('recovers via SDK-overzealous path when JSON.parse + Zod accept rawText', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    // Primary call throws LlmStructuredOutputError with parseable JSON in cause.text.
    mockGenerateText.mockRejectedValueOnce(makeStructuredError('{"name":"Carol"}'))

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/sdk-overzealous',
    })

    expect(result.output).toEqual({ name: 'Carol' })
    expect(result.repairAttempted).toBe(true)
    // Recovered without a follow-up generateText call (no Haiku/Sonnet repair).
    expect(mockGenerateText).toHaveBeenCalledOnce()
    expect(infoSpy).toHaveBeenCalled()
    const infoCall = infoSpy.mock.calls.find(
      (c) => (c[0] as { event?: string }).event === 'llm.generate_object.failed',
    )
    expect(infoCall).toBeDefined()
    expect(infoCall?.[0]).toMatchObject({
      event: 'llm.generate_object.failed',
      callSite: 'test/sdk-overzealous',
      repairOutcome: 'sdk_validated_but_zod_failed',
      repairAttempted: true,
    })
  })

  it('strips ```json fences before parsing rawText', async () => {
    mockGenerateText.mockRejectedValueOnce(
      makeStructuredError('```json\n{"name":"Dave"}\n```'),
    )

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/fences',
    })

    expect(result.output).toEqual({ name: 'Dave' })
    expect(result.repairAttempted).toBe(true)
  })

  it('repair chain: haiku-then-sonnet — Haiku repair succeeds', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    // Primary throws with rawText whose JSON parses but Zod rejects
    // (name exceeds max length).
    mockGenerateText.mockRejectedValueOnce(
      makeStructuredError('{"name":"this-name-is-way-too-long"}'),
    )
    // Haiku repair call: returns a Zod-valid shape.
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'Erin' },
      usage: makeUsage(80, 40),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a short name',
      callSite: 'test/haiku-succeeds',
      repairStrategy: 'haiku-then-sonnet',
    })

    expect(result.output).toEqual({ name: 'Erin' })
    expect(result.repairAttempted).toBe(true)
    // Exactly two calls: primary (failed) + Haiku repair (succeeded).
    expect(mockGenerateText).toHaveBeenCalledTimes(2)
    // Second call uses HAIKU.
    const repairCall = mockGenerateText.mock.calls[1]?.[0] as unknown as { model: unknown }
    expect(repairCall.model).toBe(HAIKU)
    // Log shape: INFO with repair_by_haiku outcome.
    const infoCall = infoSpy.mock.calls.find(
      (c) => (c[0] as { event?: string }).event === 'llm.generate_object.failed',
    )
    expect(infoCall?.[0]).toMatchObject({
      repairOutcome: 'repaired_by_haiku',
      repairAttempted: true,
    })
  })

  it('repair chain: haiku-then-sonnet — Haiku fails, Sonnet succeeds', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    mockGenerateText.mockRejectedValueOnce(
      makeStructuredError('{"name":"this-name-is-way-too-long"}'),
    )
    // Haiku repair returns an output that's STILL Zod-invalid.
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'still-too-long-for-zod' },
      usage: makeUsage(80, 40),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)
    // Sonnet repair succeeds.
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'Frank' },
      usage: makeUsage(150, 60),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a short name',
      callSite: 'test/sonnet-after-haiku',
      repairStrategy: 'haiku-then-sonnet',
    })

    expect(result.output).toEqual({ name: 'Frank' })
    expect(result.repairAttempted).toBe(true)
    expect(mockGenerateText).toHaveBeenCalledTimes(3)
    const haikuCall = mockGenerateText.mock.calls[1]?.[0] as unknown as { model: unknown }
    const sonnetCall = mockGenerateText.mock.calls[2]?.[0] as unknown as { model: unknown }
    expect(haikuCall.model).toBe(HAIKU)
    expect(sonnetCall.model).toBe(SONNET)
    const infoCall = infoSpy.mock.calls.find(
      (c) => (c[0] as { event?: string }).event === 'llm.generate_object.failed',
    )
    expect(infoCall?.[0]).toMatchObject({
      repairOutcome: 'repaired_by_sonnet',
      repairAttempted: true,
    })
  })

  it('repairStrategy: sonnet — skips Haiku entirely', async () => {
    mockGenerateText.mockRejectedValueOnce(
      makeStructuredError('{"name":"this-name-is-way-too-long"}'),
    )
    // Only one repair call expected — Sonnet.
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'Greta' },
      usage: makeUsage(150, 60),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a short name',
      callSite: 'test/sonnet-only',
      repairStrategy: 'sonnet',
    })

    expect(result.output).toEqual({ name: 'Greta' })
    expect(result.repairAttempted).toBe(true)
    expect(mockGenerateText).toHaveBeenCalledTimes(2)
    const repairCall = mockGenerateText.mock.calls[1]?.[0] as unknown as { model: unknown }
    expect(repairCall.model).toBe(SONNET)
  })

  it('all repair fails: rethrows original LlmStructuredOutputError + WARN log', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const originalErr = makeStructuredError('{"name":"this-name-is-way-too-long"}')
    mockGenerateText.mockRejectedValueOnce(originalErr)
    // Haiku repair: still Zod-invalid.
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'still-too-long' },
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)
    // Sonnet repair: still Zod-invalid.
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'still-too-long-x' },
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/all-fail',
        repairStrategy: 'haiku-then-sonnet',
      }),
    ).rejects.toBe(originalErr)

    expect(warnSpy).toHaveBeenCalled()
    const warnCall = warnSpy.mock.calls.find(
      (c) => (c[0] as { event?: string }).event === 'llm.generate_object.failed',
    )
    expect(warnCall?.[0]).toMatchObject({
      event: 'llm.generate_object.failed',
      callSite: 'test/all-fail',
      repairAttempted: true,
      repairOutcome: 'sonnet_failed',
    })
  })

  it('rawText is undefined: WARN log + rethrow original error (no repair attempted)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const originalErr = makeStructuredError(undefined)
    mockGenerateText.mockRejectedValueOnce(originalErr)

    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/no-raw-text',
      }),
    ).rejects.toBe(originalErr)

    expect(mockGenerateText).toHaveBeenCalledOnce()
    const warnCall = warnSpy.mock.calls.find(
      (c) => (c[0] as { event?: string }).event === 'llm.generate_object.failed',
    )
    expect(warnCall?.[0]).toMatchObject({
      repairAttempted: false,
      repairOutcome: 'none',
    })
  })

  it('JSON.parse fails entirely: WARN log + rethrow original error', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const originalErr = makeStructuredError('not json at all { broken')
    mockGenerateText.mockRejectedValueOnce(originalErr)

    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/parse-fail',
      }),
    ).rejects.toBe(originalErr)

    // Only the primary call — no repair attempts.
    expect(mockGenerateText).toHaveBeenCalledOnce()
    const warnCall = warnSpy.mock.calls.find(
      (c) => (c[0] as { event?: string }).event === 'llm.generate_object.failed',
    )
    expect(warnCall?.[0]).toMatchObject({
      repairAttempted: false,
      repairOutcome: 'parse_failed',
    })
  })

  it('rethrows non-LlmStructuredOutputError unchanged (no repair, no special log)', async () => {
    const unrelated = new Error('something else entirely')
    mockGenerateText.mockRejectedValueOnce(unrelated)

    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/unrelated-error',
      }),
    ).rejects.toBe(unrelated)
  })

  it('haiku-then-sonnet: Haiku throws (not Zod-fails) → falls through to Sonnet', async () => {
    mockGenerateText.mockRejectedValueOnce(
      makeStructuredError('{"name":"way-way-too-long"}'),
    )
    // Haiku repair call itself throws.
    mockGenerateText.mockRejectedValueOnce(new Error('haiku transport blew up'))
    // Sonnet succeeds.
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'Ivy' },
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/haiku-throws',
      repairStrategy: 'haiku-then-sonnet',
    })

    expect(result.output).toEqual({ name: 'Ivy' })
    expect(result.repairAttempted).toBe(true)
    expect(mockGenerateText).toHaveBeenCalledTimes(3)
  })

  it('threads providerOptions.mythrun.stage through to the repair call', async () => {
    mockGenerateText.mockRejectedValueOnce(
      makeStructuredError('{"name":"way-way-too-long"}'),
    )
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'Joe' },
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/stage-thread',
      providerOptions: {
        mythrun: { stage: 'world_and_factions', worldId: 'w-1' },
      },
    })

    // The repair call (second invocation) should carry the same stage.
    const repairCall = mockGenerateText.mock.calls[1]?.[0] as unknown as {
      providerOptions: { mythrun: { stage: string } }
    }
    expect(repairCall.providerOptions.mythrun.stage).toBe('world_and_factions')
  })
})

describe('streamObject', () => {
  beforeEach(() => {
    mockGenerateText.mockReset()
    mockStreamObject.mockReset()
    vi.restoreAllMocks()
  })

  function fakeStreamResult<T>(opts: {
    final: T
    partials?: readonly T[]
    objectError?: unknown
  }): ReturnType<typeof ai.streamObject> {
    const partials = opts.partials ?? [opts.final]
    async function* gen(): AsyncGenerator<T> {
      for (const p of partials) yield p
    }
    return {
      partialObjectStream: gen(),
      object:
        opts.objectError !== undefined
          ? Promise.reject(opts.objectError)
          : Promise.resolve(opts.final),
      usage: Promise.resolve(makeUsage(500, 300)),
      warnings: Promise.resolve(undefined),
    } as unknown as ReturnType<typeof ai.streamObject>
  }

  it('returns SDK shape, partialObjectStream works, object resolves on happy path', async () => {
    mockStreamObject.mockReturnValueOnce(
      fakeStreamResult<TestShape>({ final: { name: 'Jen' } }),
    )

    const result = streamObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'name something',
      callSite: 'test/stream-happy',
    })

    const partials: unknown[] = []
    for await (const p of result.partialObjectStream) partials.push(p)
    expect(partials).toEqual([{ name: 'Jen' }])

    const finalObj = await result.object
    expect(finalObj).toEqual({ name: 'Jen' })

    const usage = await result.usage
    expect(usage.inputTokens).toBe(500)
  })

  it('object repair path: SDK rejects, wrapper repairs via Sonnet, returned tree is repaired', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const objErr = makeStructuredError('{"name":"too-long-for-zod-here"}')
    mockStreamObject.mockReturnValueOnce(
      fakeStreamResult<TestShape>({
        final: { name: 'partial' },
        objectError: objErr,
      }),
    )
    // Sonnet repair call (strategy defaults to 'sonnet').
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'Kate' },
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    const result = streamObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'name something',
      callSite: 'test/stream-repair',
    })

    const finalObj = await result.object
    expect(finalObj).toEqual({ name: 'Kate' })

    const infoCall = infoSpy.mock.calls.find(
      (c) => (c[0] as { event?: string }).event === 'llm.generate_object.failed',
    )
    expect(infoCall?.[0]).toMatchObject({
      callSite: 'test/stream-repair',
      repairOutcome: 'repaired_by_sonnet',
    })
  })

  it('streaming: object repair fails → WARN log + rethrow original', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const objErr = makeStructuredError('not json {')
    mockStreamObject.mockReturnValueOnce(
      fakeStreamResult<TestShape>({
        final: { name: 'partial' },
        objectError: objErr,
      }),
    )

    const result = streamObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'name something',
      callSite: 'test/stream-fail',
    })

    await expect(result.object).rejects.toBe(objErr)
    const warnCall = warnSpy.mock.calls.find(
      (c) => (c[0] as { event?: string }).event === 'llm.generate_object.failed',
    )
    expect(warnCall?.[0]).toMatchObject({
      callSite: 'test/stream-fail',
      repairOutcome: 'parse_failed',
    })
  })

  it('streaming: SDK-overzealous on object — parses + Zod accepts → return repaired', async () => {
    const objErr = makeStructuredError('{"name":"Liam"}')
    mockStreamObject.mockReturnValueOnce(
      fakeStreamResult<TestShape>({
        final: { name: 'partial' },
        objectError: objErr,
      }),
    )

    const result = streamObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'name something',
      callSite: 'test/stream-overzealous',
    })

    const finalObj = await result.object
    expect(finalObj).toEqual({ name: 'Liam' })
    // No follow-up generateText repair call — SDK-overzealous arm is enough.
    expect(mockGenerateText).not.toHaveBeenCalled()
  })

  it('streaming: object rejects with non-LlmStructuredOutputError → passthrough', async () => {
    const unrelated = new Error('network broke')
    mockStreamObject.mockReturnValueOnce(
      fakeStreamResult<TestShape>({
        final: { name: 'partial' },
        objectError: unrelated,
      }),
    )

    const result = streamObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'name something',
      callSite: 'test/stream-passthrough',
    })

    await expect(result.object).rejects.toBe(unrelated)
  })

  it('streaming: forwards opts to the SDK', () => {
    mockStreamObject.mockReturnValueOnce(
      fakeStreamResult<TestShape>({ final: { name: 'Mo' } }),
    )

    streamObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'name something',
      callSite: 'test/stream-forward',
      temperature: 0.8,
      maxRetries: 0,
      providerOptions: { mythrun: { stage: 'world_and_factions' } },
    })

    const callArgs = mockStreamObject.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(callArgs).toMatchObject({
      model: SONNET,
      schema: TestSchema,
      prompt: 'name something',
      temperature: 0.8,
      maxRetries: 0,
    })
    expect(callArgs.providerOptions).toEqual({ mythrun: { stage: 'world_and_factions' } })
  })
})

describe('generateText (passthrough)', () => {
  beforeEach(() => {
    mockGenerateText.mockReset()
    mockStreamObject.mockReset()
    vi.restoreAllMocks()
  })

  it('forwards to the SDK and returns { text, usage }', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'hello world',
      usage: makeUsage(20, 5),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    const result = await wrapperGenerateText({
      model: SONNET,
      prompt: 'say hi',
    })
    expect(result.text).toBe('hello world')
    expect(result.usage.totalTokens).toBe(25)
  })

  it('forwards temperature/maxRetries/providerOptions through', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'x',
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    await wrapperGenerateText({
      model: SONNET,
      prompt: 'p',
      temperature: 0.2,
      maxRetries: 5,
      providerOptions: { mythrun: { stage: 'concept_intake' } },
    })

    const callArgs = mockGenerateText.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(callArgs).toMatchObject({ model: SONNET, prompt: 'p', temperature: 0.2, maxRetries: 5 })
    expect(callArgs.providerOptions).toEqual({ mythrun: { stage: 'concept_intake' } })
  })

  it('rethrows errors unchanged', async () => {
    const err = new Error('boom')
    mockGenerateText.mockRejectedValueOnce(err)
    await expect(wrapperGenerateText({ model: SONNET, prompt: 'p' })).rejects.toBe(err)
  })
})
