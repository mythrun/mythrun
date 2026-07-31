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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { LlmStructuredOutputError } from '../errors.js'
import { logger } from '../logger.js'
import { HAIKU, SONNET } from '../models.js'
import type { LlmCallDiagnostic } from '../ai.js'

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
  extractStage,
  setLlmHealthSink,
} from '../ai.js'
import { LlmTimeoutError } from '../errors.js'

const mockGenerateText = vi.mocked(ai.generateText)
const mockStreamObject = vi.mocked(ai.streamObject)
const mockStreamText = vi.mocked(ai.streamText)

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

  it('forwards maxRetries, providerOptions, schemaName to the SDK', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'Bob' },
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/forward-opts',
      maxRetries: 2,
      providerOptions: { mythrun: { stage: 'concept_intake' } },
      schemaName: 'TestSchema',
    })

    const callArgs = mockGenerateText.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(callArgs).toMatchObject({
      model: SONNET,
      prompt: 'pick a name',
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

  // myth-t1qz Phase 4: the wrapper attaches a `.diagnostic` field to the
  // rethrown LlmStructuredOutputError so downstream consumers (the world-gen
  // processor's sanitizeError + stage-failed event) can surface call-site,
  // raw text, and Zod issues without parsing pino logs.
  it('attaches .diagnostic to rethrown error on terminal repair failure', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const originalErr = makeStructuredError('{"name":"this-name-is-way-too-long"}')
    mockGenerateText.mockRejectedValueOnce(originalErr)
    // Sonnet repair: still Zod-invalid.
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'still-too-long-x' },
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    let caught: unknown
    try {
      await generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/diagnostic-attached',
        schemaName: 'TestSchema',
        repairStrategy: 'sonnet',
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(originalErr)
    const diag = (caught as { diagnostic?: LlmCallDiagnostic }).diagnostic
    expect(diag).toBeDefined()
    expect(diag?.callSite).toBe('test/diagnostic-attached')
    expect(diag?.schemaName).toBe('TestSchema')
    expect(diag?.repairStrategy).toBe('sonnet')
    expect(diag?.repairAttempted).toBe(true)
    expect(diag?.repairOutcome).toBe('sonnet_failed')
    expect(diag?.rawTextSnippet).toBe('{"name":"this-name-is-way-too-long"}')
    expect(diag?.zodIssues).not.toBeNull()
    expect(diag?.zodIssues?.length ?? 0).toBeGreaterThan(0)
    expect(diag?.zodIssues?.[0]).toMatchObject({
      path: expect.any(String) as unknown,
      message: expect.any(String) as unknown,
    })
  })

  // MYT-72 T4a: the ST-vet call reasons over secrets (the sd_playbook) in its
  // raw model output. `redactRawText: true` must keep that raw text (and any
  // Zod issue messages that could echo input) out of BOTH the rethrown error's
  // `.diagnostic.rawTextSnippet` and the WARN log line.
  it('redactRawText: true — rawTextSnippet is null and the secret never reaches diagnostic or the WARN log', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    // Over-long `name` value survives JSON.parse, fails Zod max(10), and the
    // value embeds the secret we must never surface.
    const originalErr = makeStructuredError('{"name":"SECRET-PLOT-the-duke-is-the-traitor"}')
    mockGenerateText.mockRejectedValueOnce(originalErr)
    // Sonnet repair: still Zod-invalid → terminal sonnet_failed.
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'SECRET-PLOT-still-too-long' },
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    let caught: unknown
    try {
      await generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/redact-raw-text',
        schemaName: 'TestSchema',
        repairStrategy: 'sonnet',
        redactRawText: true,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(originalErr)
    const diag = (caught as { diagnostic?: LlmCallDiagnostic }).diagnostic
    expect(diag).toBeDefined()
    expect(diag?.callSite).toBe('test/redact-raw-text')
    expect(diag?.repairOutcome).toBe('sonnet_failed')
    // Raw snippet redacted to null — the secret is not in the diagnostic.
    expect(diag?.rawTextSnippet).toBeNull()
    // Belt-and-suspenders: zodIssues redacted too (a future .refine could echo input).
    expect(diag?.zodIssues).toBeNull()
    expect(JSON.stringify(diag)).not.toContain('SECRET-PLOT')
    // The WARN log carries no trace of the secret in any argument.
    expect(warnSpy).toHaveBeenCalled()
    for (const call of warnSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('SECRET-PLOT')
    }
  })

  // CONTROL: without redactRawText, the existing behavior is unchanged — the
  // snippet (and thus the secret) IS captured into the diagnostic.
  it('redactRawText absent (default) — rawTextSnippet IS captured (control)', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const originalErr = makeStructuredError('{"name":"SECRET-PLOT-the-duke-is-the-traitor"}')
    mockGenerateText.mockRejectedValueOnce(originalErr)
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'SECRET-PLOT-still-too-long' },
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    let caught: unknown
    try {
      await generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/redact-raw-text-control',
        schemaName: 'TestSchema',
        repairStrategy: 'sonnet',
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(originalErr)
    const diag = (caught as { diagnostic?: LlmCallDiagnostic }).diagnostic
    expect(diag?.repairOutcome).toBe('sonnet_failed')
    expect(diag?.rawTextSnippet).toBe('{"name":"SECRET-PLOT-the-duke-is-the-traitor"}')
    expect(diag?.zodIssues).not.toBeNull()
  })

  it('attaches .diagnostic with repairAttempted=false + outcome=parse_failed when rawText is non-JSON', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const originalErr = makeStructuredError('not json at all { broken')
    mockGenerateText.mockRejectedValueOnce(originalErr)

    let caught: unknown
    try {
      await generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/diagnostic-parse-failed',
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(originalErr)
    const diag = (caught as { diagnostic?: LlmCallDiagnostic }).diagnostic
    expect(diag?.repairAttempted).toBe(false)
    expect(diag?.repairOutcome).toBe('parse_failed')
    expect(diag?.rawTextSnippet).toBe('not json at all { broken')
    expect(diag?.zodIssues).toBeNull()
  })

  it('attaches .diagnostic with rawTextSnippet=null when rawText is undefined', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const originalErr = makeStructuredError(undefined)
    mockGenerateText.mockRejectedValueOnce(originalErr)

    let caught: unknown
    try {
      await generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/diagnostic-no-raw-text',
      })
    } catch (err) {
      caught = err
    }
    const diag = (caught as { diagnostic?: LlmCallDiagnostic }).diagnostic
    expect(diag?.repairAttempted).toBe(false)
    expect(diag?.repairOutcome).toBe('none')
    expect(diag?.rawTextSnippet).toBeNull()
    expect(diag?.zodIssues).toBeNull()
  })

  it('does NOT attach .diagnostic to non-LlmStructuredOutputError', async () => {
    const unrelated = new Error('something else entirely')
    mockGenerateText.mockRejectedValueOnce(unrelated)
    let caught: unknown
    try {
      await generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/diagnostic-unrelated',
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(unrelated)
    expect((caught as { diagnostic?: unknown }).diagnostic).toBeUndefined()
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

  it('maps a raw AI_NoObjectGeneratedError to LlmStructuredOutputError so repair fires (myth-pfke)', async () => {
    // myth-pfke smoke surfaced: Output.object validation in the SDK throws
    // AI_NoObjectGeneratedError DIRECTLY (bypassing middleware which only
    // wraps the inner LanguageModel). Without the catch routing through
    // mapToMythrunError, the wrapper's `instanceof LlmStructuredOutputError`
    // check rethrew the unmapped error and repair never fired. This test
    // simulates the bypassed-middleware path by throwing a name-tagged Error
    // directly from the mocked SDK and asserts the wrapper recovers via
    // Sonnet repair.
    const rawError = new Error('No object generated: response did not match schema.')
    Object.assign(rawError, {
      name: 'AI_NoObjectGeneratedError',
      text: '{"name":"too-long-for-zod"}',
    })
    // Override cause to mimic SDK shape exposing `text` on the throw itself
    // (mapToMythrunError wraps as { cause: rawError }, attemptRepair reads
    // `mapped.cause.text`).
    Object.defineProperty(rawError, 'cause', { value: { text: '{"name":"too-long-for-zod"}', name: 'AI_NoObjectGeneratedError' }, enumerable: true })
    mockGenerateText.mockRejectedValueOnce(rawError)
    // Sonnet repair call succeeds.
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'Ada' },
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'name something',
      callSite: 'test/no-object-error-mapping',
    })
    expect(result.output).toEqual({ name: 'Ada' })
    expect(result.repairAttempted).toBe(true)
    expect(infoSpy).toHaveBeenCalled()
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

  it('streaming: rejecting object with NO awaiter never detaches (worker-killer regression)', async () => {
    // Live incident: prep read partialObjectStream only; the wrapped
    // `.object` rejected after the repair chain with no awaiter attached →
    // detached rejection → --unhandled-rejections=throw killed the worker.
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
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
        callSite: 'test/stream-detached',
      })

      // Consume ONLY the partial stream — exactly the incident shape; give
      // the rejection multiple macrotask turns to surface as unhandled.
      for await (const p of result.partialObjectStream) void p
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      expect(unhandled).not.toHaveBeenCalled()

      // A late awaiter must still observe the rejection.
      await expect(result.object).rejects.toBe(objErr)
    } finally {
      process.removeListener('unhandledRejection', unhandled)
    }
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

  it('streaming: attaches .diagnostic to rethrown error on terminal repair failure', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const objErr = makeStructuredError('{"name":"this-name-is-far-too-long-for-zod"}')
    mockStreamObject.mockReturnValueOnce(
      fakeStreamResult<TestShape>({
        final: { name: 'partial' },
        objectError: objErr,
      }),
    )
    // Sonnet repair returns still-invalid Zod output.
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'still-too-long-x' },
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    const result = streamObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'name something',
      callSite: 'test/stream-diagnostic',
      schemaName: 'TestSchema',
    })

    let caught: unknown
    try {
      await result.object
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(objErr)
    const diag = (caught as { diagnostic?: LlmCallDiagnostic }).diagnostic
    expect(diag).toBeDefined()
    expect(diag?.callSite).toBe('test/stream-diagnostic')
    expect(diag?.schemaName).toBe('TestSchema')
    expect(diag?.repairOutcome).toBe('sonnet_failed')
    expect(diag?.rawTextSnippet).toBe('{"name":"this-name-is-far-too-long-for-zod"}')
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

  it('preserves SDK prototype getters (regression: wrapper must not spread the SDK result)', async () => {
    // Real SDK returns a DefaultStreamObjectResult class instance whose
    // partialObjectStream / textStream / fullStream / warnings / usage
    // are PROTOTYPE getters. Object spread copies own enumerable
    // properties only and would silently drop all of those, leaving the
    // consumer reading `undefined.Symbol.asyncIterator`. This fixture
    // simulates the prototype-getter shape so the spread bug cannot
    // sneak back in unnoticed.
    class FakeSdkStreamResult<T> {
      readonly #partials: readonly T[]
      readonly #final: T
      constructor(partials: readonly T[], final: T) {
        this.#partials = partials
        this.#final = final
      }
      get partialObjectStream(): AsyncGenerator<T> {
        const partials = this.#partials
        async function* gen(): AsyncGenerator<T> {
          for (const p of partials) yield p
        }
        return gen()
      }
      get object(): Promise<T> {
        return Promise.resolve(this.#final)
      }
      get usage(): Promise<ReturnType<typeof makeUsage>> {
        return Promise.resolve(makeUsage(100, 50))
      }
      get warnings(): Promise<undefined> {
        return Promise.resolve(undefined)
      }
    }

    const sdkResult = new FakeSdkStreamResult<TestShape>(
      [{ name: 'partial' }, { name: 'Riley' }],
      { name: 'Riley' },
    )
    mockStreamObject.mockReturnValueOnce(
      sdkResult as unknown as ReturnType<typeof ai.streamObject>,
    )

    const result = streamObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'name something',
      callSite: 'test/stream-prototype-getters',
    })

    // The bug-mode would fail HERE — `result.partialObjectStream` would
    // be undefined and the for-await would throw on Symbol.asyncIterator.
    // partials are typed `unknown[]` to match the SDK's DeepPartial<T>
    // shape on partialObjectStream (other streamObject tests in this file
    // do the same).
    expect(result.partialObjectStream).toBeDefined()
    const partials: unknown[] = []
    for await (const p of result.partialObjectStream) partials.push(p)
    expect(partials).toEqual([{ name: 'partial' }, { name: 'Riley' }])

    // usage + warnings (also prototype getters) must survive.
    const usage = await result.usage
    expect(usage.inputTokens).toBe(100)
    await expect(result.warnings).resolves.toBeUndefined()

    // The wrapped `object` shadow must still resolve.
    await expect(result.object).resolves.toEqual({ name: 'Riley' })
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
      maxRetries: 0,
      providerOptions: { mythrun: { stage: 'world_and_factions' } },
    })

    const callArgs = mockStreamObject.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(callArgs).toMatchObject({
      model: SONNET,
      schema: TestSchema,
      prompt: 'name something',
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

  it('forwards maxRetries/providerOptions through', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'x',
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    await wrapperGenerateText({
      model: SONNET,
      prompt: 'p',
      maxRetries: 5,
      providerOptions: { mythrun: { stage: 'concept_intake' } },
    })

    const callArgs = mockGenerateText.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(callArgs).toMatchObject({ model: SONNET, prompt: 'p', maxRetries: 5 })
    expect(callArgs.providerOptions).toEqual({ mythrun: { stage: 'concept_intake' } })
  })

  it('rethrows errors unchanged', async () => {
    const err = new Error('boom')
    mockGenerateText.mockRejectedValueOnce(err)
    await expect(wrapperGenerateText({ model: SONNET, prompt: 'p' })).rejects.toBe(err)
  })
})

describe('maxOutputTokens forwarding', () => {
  beforeEach(() => {
    mockGenerateText.mockReset()
    mockStreamObject.mockReset()
    vi.restoreAllMocks()
  })

  function fakeStreamResult(final: TestShape): ReturnType<typeof ai.streamObject> {
    async function* gen(): AsyncGenerator<TestShape> {
      yield final
    }
    return {
      partialObjectStream: gen(),
      object: Promise.resolve(final),
      usage: Promise.resolve(makeUsage()),
      warnings: Promise.resolve(undefined),
    } as unknown as ReturnType<typeof ai.streamObject>
  }

  it('streamObject forwards maxOutputTokens to the SDK', () => {
    mockStreamObject.mockReturnValueOnce(fakeStreamResult({ name: 'x' }))

    streamObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'p',
      callSite: 'test/stream-maxout',
      maxOutputTokens: 16384,
    })

    expect(mockStreamObject.mock.calls[0]?.[0]).toMatchObject({ maxOutputTokens: 16384 })
  })

  it('streamObject omits maxOutputTokens when unset', () => {
    mockStreamObject.mockReturnValueOnce(fakeStreamResult({ name: 'x' }))

    streamObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'p',
      callSite: 'test/stream-no-maxout',
    })

    expect(mockStreamObject.mock.calls[0]?.[0]).not.toHaveProperty('maxOutputTokens')
  })

  it('generateObject forwards maxOutputTokens to the SDK', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'x' },
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'p',
      callSite: 'test/gen-maxout',
      maxOutputTokens: 16384,
    })

    expect(mockGenerateText.mock.calls[0]?.[0]).toMatchObject({ maxOutputTokens: 16384 })
  })

  it('generateObject omits maxOutputTokens when unset', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'x' },
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'p',
      callSite: 'test/gen-no-maxout',
    })

    expect(mockGenerateText.mock.calls[0]?.[0]).not.toHaveProperty('maxOutputTokens')
  })

  // myth-umggn: an external abort (the synthesize stream's SSE client-
  // disconnect signal) must reach the SDK call — combined with the internal
  // timeout via AbortSignal.any, so EITHER firing aborts the Anthropic call.
  it('streamObject combines an external abortSignal with the timeout signal', () => {
    mockStreamObject.mockReturnValueOnce(fakeStreamResult({ name: 'x' }))
    const external = new AbortController()

    streamObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'p',
      callSite: 'test/stream-abort',
      abortSignal: external.signal,
    })

    const sdkSignal = (
      mockStreamObject.mock.calls[0]?.[0] as unknown as { abortSignal: AbortSignal }
    ).abortSignal
    expect(sdkSignal.aborted).toBe(false)
    external.abort()
    expect(sdkSignal.aborted).toBe(true)
  })
})

// --- outage-resilience Task 4: the ai.ts attempt loop (design §1.3) --------
//
// stageBudgetMs arms a wrapper-owned attempt loop that drives generateObject
// through STREAMING transport internally (§1.0: streamText + Output.object),
// classifies every failed attempt (§1.2), and reports connectivity-class
// failures to the boot-injected health sink (§1.4). Absent stageBudgetMs,
// the legacy single-shot generateText path is byte-identical — the rest of
// this file is that oracle.

function makeConnErr(code: string, msg = 'transport died'): Error {
  return Object.assign(new Error(msg), { code })
}

function failingStreamResult(err: unknown): ReturnType<typeof ai.streamText> {
  const output = Promise.reject(err)
  // Pre-handle so the rejection can never surface as unhandled while the
  // wrapper is still between microtasks; the wrapper's own await still
  // observes it.
  void output.catch(() => undefined)
  return {
    output,
    totalUsage: new Promise(() => undefined),
  } as unknown as ReturnType<typeof ai.streamText>
}

function okStreamResult(final: unknown, usage = makeUsage()): ReturnType<typeof ai.streamText> {
  return {
    output: Promise.resolve(final),
    totalUsage: Promise.resolve(usage),
  } as unknown as ReturnType<typeof ai.streamText>
}

function hangingStreamResult(signal: AbortSignal | undefined): ReturnType<typeof ai.streamText> {
  return {
    output: new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      })
    }),
    totalUsage: new Promise(() => undefined),
  } as unknown as ReturnType<typeof ai.streamText>
}

describe('generateObject attempt loop (stageBudgetMs)', () => {
  beforeEach(() => {
    mockGenerateText.mockReset()
    mockStreamObject.mockReset()
    mockStreamText.mockReset()
    vi.restoreAllMocks()
    setLlmHealthSink(null)
  })

  afterEach(() => {
    setLlmHealthSink(null)
    vi.useRealTimers()
  })

  it('loop-scoped generateObject drives the streaming path and returns the identical validated object', async () => {
    mockStreamText.mockReturnValueOnce(okStreamResult({ name: 'Alice' }, makeUsage(200, 80)))

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/loop-streams',
      stageBudgetMs: 120_000,
    })

    expect(result.output).toEqual({ name: 'Alice' })
    expect(result.usage.inputTokens).toBe(200)
    expect(result.repairAttempted).toBe(false)
    // §1.0: the loop-scoped call goes through streamText, never generateText.
    expect(mockStreamText).toHaveBeenCalledOnce()
    expect(mockGenerateText).not.toHaveBeenCalled()
    const callArgs = mockStreamText.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    // §1.3: the loop owns attempts — SDK-internal retries are disabled.
    expect(callArgs.maxRetries).toBe(0)
    // Output.object is mocked as identity, so the schema rides `output`.
    expect(callArgs.output).toMatchObject({ schema: TestSchema })
    expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('loop: connectivity failures retry and report each failed attempt', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const sink = vi.fn()
    setLlmHealthSink(sink)
    mockStreamText
      .mockReturnValueOnce(failingStreamResult(makeConnErr('ECONNRESET')))
      .mockReturnValueOnce(failingStreamResult(makeConnErr('ETIMEDOUT')))
      .mockReturnValueOnce(okStreamResult({ name: 'Ana' }))

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/loop-retries',
      stageBudgetMs: 600_000,
      providerOptions: { mythrun: { stage: 'concept_intake', worldId: 'w-1' } },
    })

    expect(result.output).toEqual({ name: 'Ana' })
    expect(mockStreamText).toHaveBeenCalledTimes(3)
    expect(sink).toHaveBeenCalledTimes(2)
    expect(sink.mock.calls[0]?.[0]).toEqual({
      callsite: 'test/loop-retries',
      jobId: 'w-1',
      modelId: expect.any(String) as unknown,
      mode: null,
      failureClass: 'connectivity',
    })
  })

  it('loop: every attempt gets the FULL remaining budget (no division)', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const sink = vi.fn()
    setLlmHealthSink(sink)
    let attempt2Signal: AbortSignal | undefined
    mockStreamText
      .mockImplementationOnce(() => failingStreamResult(makeConnErr('ECONNRESET')))
      .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        attempt2Signal = opts.abortSignal
        return hangingStreamResult(opts.abortSignal)
      })

    const outcome = generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/loop-full-budget',
      stageBudgetMs: 300_000,
    }).then(
      (r) => ({ ok: r }),
      (e: unknown) => ({ err: e }),
    )

    // Attempt 1 fails immediately; jitter is 0 so attempt 2 starts right away.
    await vi.advanceTimersByTimeAsync(1)
    expect(mockStreamText).toHaveBeenCalledTimes(2)

    // A divided budget (300s/3 attempts = 100s, or /2 = 150s) would have
    // aborted by now; the full-remaining-budget contract keeps it alive.
    await vi.advanceTimersByTimeAsync(200_000)
    expect(attempt2Signal?.aborted).toBe(false)

    // Past the stage deadline the per-attempt controller fires.
    await vi.advanceTimersByTimeAsync(100_001)
    expect(attempt2Signal?.aborted).toBe(true)

    const settled = await outcome
    expect((settled as { err?: unknown }).err).toBeInstanceOf(LlmTimeoutError)
    // Only attempt 1 was connectivity-class; the budget abort (no transport
    // context) classifies as abort — no report.
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('loop: retry gate blocks when remaining < expectedHealthyDurationMs and pins llmFailureClass', async () => {
    const sink = vi.fn()
    setLlmHealthSink(sink)
    const connErr = makeConnErr('ECONNREFUSED')
    mockStreamText.mockReturnValueOnce(failingStreamResult(connErr))

    let caught: unknown
    try {
      await generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/loop-gate',
        // Below the 60s default expectedHealthyDurationMs: the first attempt
        // always runs, but no retry may start.
        stageBudgetMs: 50_000,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(connErr)
    expect(mockStreamText).toHaveBeenCalledOnce()
    // The one attempt still classified and reported.
    expect(sink).toHaveBeenCalledTimes(1)
    // Task 8 contract: the surfaced error carries its §1.2 failure class.
    expect((caught as { llmFailureClass?: string }).llmFailureClass).toBe('connectivity')
  })

  it('loop: external abort bails without retry or report', async () => {
    const sink = vi.fn()
    setLlmHealthSink(sink)
    const external = new AbortController()
    const connErr = makeConnErr('ECONNRESET')
    mockStreamText.mockImplementationOnce(() => {
      external.abort()
      return failingStreamResult(connErr)
    })

    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/loop-external-abort',
        stageBudgetMs: 600_000,
        abortSignal: external.signal,
      }),
    ).rejects.toBe(connErr)

    expect(mockStreamText).toHaveBeenCalledOnce()
    expect(sink).not.toHaveBeenCalled()
  })

  it('loop: 429 waits max(jitter, retry-after) before the retry', async () => {
    vi.useFakeTimers()
    // Jitter would be 0.25 * 2000 = 500ms; retry-after 3s must win.
    vi.spyOn(Math, 'random').mockReturnValue(0.25)
    const rateLimited = new Error('rate limited')
    Object.assign(rateLimited, {
      cause: {
        name: 'AI_APICallError',
        statusCode: 429,
        responseHeaders: { 'retry-after': '3' },
      },
    })
    mockStreamText
      .mockReturnValueOnce(failingStreamResult(rateLimited))
      .mockReturnValueOnce(okStreamResult({ name: 'Ana' }))

    const outcome = generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/loop-429-wait',
      stageBudgetMs: 600_000,
    })
    const guarded = outcome.then(
      (r) => ({ ok: r }),
      (e: unknown) => ({ err: e }),
    )

    await vi.advanceTimersByTimeAsync(1)
    expect(mockStreamText).toHaveBeenCalledTimes(1)
    // 2.9s in: a jitter-only wait (500ms) would already have retried.
    await vi.advanceTimersByTimeAsync(2_900)
    expect(mockStreamText).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(mockStreamText).toHaveBeenCalledTimes(2)

    const settled = await guarded
    expect((settled as { ok?: { output?: unknown } }).ok?.output).toEqual({ name: 'Ana' })
  })

  it('loop: the 429 wait is accounted against the retry gate', async () => {
    const sink = vi.fn()
    setLlmHealthSink(sink)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const rateLimited = new Error('rate limited')
    Object.assign(rateLimited, {
      cause: {
        name: 'AI_APICallError',
        statusCode: 429,
        responseHeaders: { 'retry-after': '3' },
      },
    })
    mockStreamText.mockReturnValueOnce(failingStreamResult(rateLimited))

    // 62s budget: without wait accounting, remaining (≈62s) ≥ 60s would allow
    // the retry; with the 3s wait accounted, 62 − 3 = 59s < 60s blocks it.
    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/loop-429-gate',
        stageBudgetMs: 62_000,
      }),
    ).rejects.toBe(rateLimited)

    expect(mockStreamText).toHaveBeenCalledOnce()
    // 429 is retry-worthy but never outage signal — no report.
    expect(sink).not.toHaveBeenCalled()
  })

  it('loop: repair-chain connectivity failure surfaces to the loop and retries', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const sink = vi.fn()
    setLlmHealthSink(sink)
    mockStreamText
      .mockReturnValueOnce(
        failingStreamResult(makeStructuredError('{"name":"way-too-long-for-schema"}')),
      )
      .mockReturnValueOnce(okStreamResult({ name: 'Zoe' }))
    // The Sonnet repair call dies on transport.
    mockGenerateText.mockRejectedValueOnce(makeConnErr('ECONNREFUSED', 'repair transport died'))

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/loop-repair-connectivity',
      stageBudgetMs: 600_000,
      repairStrategy: 'sonnet',
    })

    expect(result.output).toEqual({ name: 'Zoe' })
    expect(mockStreamText).toHaveBeenCalledTimes(2)
    expect(mockGenerateText).toHaveBeenCalledOnce()
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]?.[0]).toMatchObject({ failureClass: 'connectivity' })
  })

  it('loop: schema failure repairs in-attempt with a timeout-bounded repair call', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    mockStreamText.mockReturnValueOnce(
      failingStreamResult(makeStructuredError('{"name":"way-too-long-for-schema"}')),
    )
    // Sonnet repair succeeds.
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'Kim' },
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/loop-repair-success',
      stageBudgetMs: 600_000,
      repairStrategy: 'sonnet',
    })

    expect(result.output).toEqual({ name: 'Kim' })
    expect(result.repairAttempted).toBe(true)
    expect(mockStreamText).toHaveBeenCalledOnce()
    // §1.2: repair calls get explicit timeouts — the repair call must carry
    // an AbortSignal now.
    const repairArgs = mockGenerateText.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(repairArgs.abortSignal).toBeInstanceOf(AbortSignal)
    const infoCall = infoSpy.mock.calls.find(
      (c) => (c[0] as { event?: string }).event === 'llm.generate_object.failed',
    )
    expect(infoCall?.[0]).toMatchObject({ repairOutcome: 'repaired_by_sonnet' })
  })

  it('loop: external abort mid-repair aborts the repair call (merged attempt signal)', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const external = new AbortController()
    let repairSignal: AbortSignal | undefined
    mockStreamText.mockReturnValueOnce(
      failingStreamResult(makeStructuredError('{"name":"way-too-long-for-schema"}')),
    )
    // The repair call hangs until its signal aborts — a schema failure just
    // before an external abort must not keep spending on the repair model.
    mockGenerateText.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      repairSignal = opts.abortSignal
      return new Promise<never>((_resolve, reject) => {
        opts.abortSignal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    })

    const guarded = generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/loop-repair-external-abort',
      stageBudgetMs: 600_000,
      abortSignal: external.signal,
      repairStrategy: 'sonnet',
    }).then(
      (r) => ({ ok: r }),
      (e: unknown) => ({ err: e }),
    )

    await vi.waitFor(() => {
      expect(mockGenerateText).toHaveBeenCalledOnce()
    })
    expect(repairSignal?.aborted).toBe(false)
    external.abort()
    expect(repairSignal?.aborted).toBe(true)
    const settled = await guarded
    expect((settled as { err?: unknown }).err).toBeInstanceOf(LlmStructuredOutputError)
  })

  it("loop: the repair call is bounded by the attempt's remaining budget, not a fixed 60s", async () => {
    vi.useFakeTimers()
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    let repairSignal: AbortSignal | undefined
    mockStreamText.mockReturnValueOnce(
      failingStreamResult(makeStructuredError('{"name":"way-too-long-for-schema"}')),
    )
    mockGenerateText.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      repairSignal = opts.abortSignal
      return new Promise<never>((_resolve, reject) => {
        opts.abortSignal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    })

    const guarded = generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/loop-repair-budget-bound',
      stageBudgetMs: 100_000,
      repairStrategy: 'sonnet',
    }).then(
      (r) => ({ ok: r }),
      (e: unknown) => ({ err: e }),
    )

    await vi.advanceTimersByTimeAsync(1)
    expect(mockGenerateText).toHaveBeenCalledOnce()
    // 99s in — well past the old fixed 60s bound — a legitimately slow repair
    // (it regenerates the whole tree, no output cap) is still alive because
    // its bound is the attempt's remaining budget.
    await vi.advanceTimersByTimeAsync(99_000)
    expect(repairSignal?.aborted).toBe(false)
    // Past the stage deadline the attempt signal fires and the merged repair
    // signal aborts with it: repair spend can never outlive the budget.
    await vi.advanceTimersByTimeAsync(1_001)
    expect(repairSignal?.aborted).toBe(true)
    const settled = await guarded
    expect((settled as { err?: unknown }).err).toBeInstanceOf(LlmStructuredOutputError)
  })

  it('loop: sink exceptions are swallowed (fire-and-forget)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    setLlmHealthSink(() => {
      throw new Error('sink blew up')
    })
    mockStreamText
      .mockReturnValueOnce(failingStreamResult(makeConnErr('ECONNRESET')))
      .mockReturnValueOnce(okStreamResult({ name: 'Ana' }))

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/loop-sink-throws',
      stageBudgetMs: 600_000,
    })
    expect(result.output).toEqual({ name: 'Ana' })
  })

  it('loop: an async sink rejection is dropped and logged — no throw, no unhandled rejection', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    // Void-return bivariance admits an async sink (the boot integration
    // injects a Redis-backed one). Its rejection must route into the same
    // drop-and-log guard as a sync throw — a floating rejection here is this
    // file's documented worker-killing failure mode.
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      setLlmHealthSink(async () => {
        throw new Error('async sink blew up')
      })
      mockStreamText
        .mockReturnValueOnce(failingStreamResult(makeConnErr('ECONNRESET')))
        .mockReturnValueOnce(okStreamResult({ name: 'Ana' }))

      const result = await generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/loop-async-sink-rejects',
        stageBudgetMs: 600_000,
      })
      expect(result.output).toEqual({ name: 'Ana' })

      // Give a floating rejection two macrotask turns to surface.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
      expect(unhandled).toEqual([])
      expect(
        warnSpy.mock.calls.some(
          (c) => (c[0] as { event?: string }).event === 'llm.health_sink.threw',
        ),
      ).toBe(true)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('loop: skipHealthReport suppresses sink reports', async () => {
    const sink = vi.fn()
    setLlmHealthSink(sink)
    const connErr = makeConnErr('ECONNREFUSED')
    mockStreamText.mockReturnValueOnce(failingStreamResult(connErr))

    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/loop-skip-report',
        stageBudgetMs: 50_000,
        skipHealthReport: true,
      }),
    ).rejects.toBe(connErr)

    expect(sink).not.toHaveBeenCalled()
  })

  it('legacy path (no stageBudgetMs) stays on generateText and never touches streamText', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'Bea' },
      usage: makeUsage(),
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>)

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/legacy-untouched',
    })

    expect(result.output).toEqual({ name: 'Bea' })
    expect(mockGenerateText).toHaveBeenCalledOnce()
    expect(mockStreamText).not.toHaveBeenCalled()
  })

  it('legacy path: repair-chain connectivity failure is still swallowed into tier failure (control)', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const originalErr = makeStructuredError('{"name":"way-too-long-for-schema"}')
    mockGenerateText.mockRejectedValueOnce(originalErr)
    // Sonnet repair dies on transport with a connectivity-classed error —
    // on the LEGACY path this converts to the terminal tier failure exactly
    // as before (only loop-scoped calls surface it).
    mockGenerateText.mockRejectedValueOnce(makeConnErr('ECONNREFUSED', 'repair transport died'))

    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/legacy-repair-swallow',
        repairStrategy: 'sonnet',
      }),
    ).rejects.toBe(originalErr)
  })

  it('legacy path: a connectivity failure classifies, attaches llmFailureClass, and reports', async () => {
    const sink = vi.fn()
    setLlmHealthSink(sink)
    const connErr = makeConnErr('ECONNRESET')
    mockGenerateText.mockRejectedValueOnce(connErr)

    let caught: unknown
    try {
      await generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/legacy-classifies',
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(connErr)
    expect((caught as { llmFailureClass?: string }).llmFailureClass).toBe('connectivity')
    // §1.2: single-attempt sites report their one attempt.
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      callsite: 'test/legacy-classifies',
      mode: null,
      failureClass: 'connectivity',
    })
  })

  it('legacy path: a connectivity failure with no sink registered still classifies and rethrows', async () => {
    // beforeEach leaves the sink null — §1.4 reporting is a no-op, not a crash.
    const connErr = makeConnErr('ECONNRESET')
    mockGenerateText.mockRejectedValueOnce(connErr)

    let caught: unknown
    try {
      await generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/legacy-no-sink',
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(connErr)
    expect((caught as { llmFailureClass?: string }).llmFailureClass).toBe('connectivity')
  })

  it('§1.4 report identity: non-object mythrun and id-less mythrun both report jobId "unknown"', async () => {
    const sink = vi.fn()
    setLlmHealthSink(sink)
    mockGenerateText
      .mockRejectedValueOnce(makeConnErr('ECONNRESET'))
      .mockRejectedValueOnce(makeConnErr('ECONNRESET'))

    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/legacy-jobid-non-object',
        providerOptions: { mythrun: 'not-an-object' },
      }),
    ).rejects.toThrow('transport died')
    await expect(
      generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/legacy-jobid-no-ids',
        providerOptions: { mythrun: { stage: 'concept_intake' } },
      }),
    ).rejects.toThrow('transport died')

    expect(sink).toHaveBeenCalledTimes(2)
    expect(sink.mock.calls[0]?.[0]).toMatchObject({ jobId: 'unknown' })
    expect(sink.mock.calls[1]?.[0]).toMatchObject({ jobId: 'unknown' })
  })

  it('loop: forwards system and maxOutputTokens to the streaming attempt', async () => {
    mockStreamText.mockReturnValueOnce(okStreamResult({ name: 'Ida' }))

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/loop-option-spreads',
      stageBudgetMs: 120_000,
      system: 'be terse',
      maxOutputTokens: 512,
    })

    expect(result.output).toEqual({ name: 'Ida' })
    const callArgs = mockStreamText.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(callArgs.system).toBe('be terse')
    expect(callArgs.maxOutputTokens).toBe(512)
  })

  it('loop: a 429 without a retry-after header falls back to the jittered wait alone', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const rateLimited = new Error('rate limited')
    Object.assign(rateLimited, { cause: { name: 'AI_APICallError', statusCode: 429 } })
    mockStreamText
      .mockReturnValueOnce(failingStreamResult(rateLimited))
      .mockReturnValueOnce(okStreamResult({ name: 'Ana' }))

    const result = await generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/loop-429-no-header',
      stageBudgetMs: 600_000,
    })

    expect(result.output).toEqual({ name: 'Ana' })
    expect(mockStreamText).toHaveBeenCalledTimes(2)
  })

  it('loop: an external abort during the backoff sleep bails before the next attempt', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const sink = vi.fn()
    setLlmHealthSink(sink)
    const external = new AbortController()
    const connErr = makeConnErr('ECONNRESET')
    mockStreamText.mockReturnValueOnce(failingStreamResult(connErr))

    const guarded = generateObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'pick a name',
      callSite: 'test/loop-abort-during-backoff',
      stageBudgetMs: 600_000,
      abortSignal: external.signal,
    }).then(
      (r) => ({ ok: r }),
      (e: unknown) => ({ err: e }),
    )

    // Attempt 1 failed (and reported) and the 1s jittered backoff is pending.
    await vi.advanceTimersByTimeAsync(1)
    expect(mockStreamText).toHaveBeenCalledOnce()
    expect(sink).toHaveBeenCalledTimes(1)

    // The abort lands mid-sleep; the post-sleep re-check must bail without
    // starting attempt 2.
    external.abort()
    await vi.advanceTimersByTimeAsync(1_000)

    const settled = await guarded
    expect((settled as { err?: unknown }).err).toBe(connErr)
    expect(mockStreamText).toHaveBeenCalledOnce()
  })

  it('loop: a non-Error connectivity throw from the repair chain is wrapped into an Error', async () => {
    mockStreamText.mockReturnValueOnce(
      failingStreamResult(makeStructuredError('{"name":"way-too-long-for-schema"}')),
    )
    // The Sonnet repair transport rejects with a bare object (no Error
    // prototype) that still classifies as connectivity by its code string —
    // tryRepairWithModel rethrows it raw and the loop's catch must wrap it.
    mockGenerateText.mockRejectedValueOnce({ code: 'ECONNREFUSED' })

    let caught: unknown
    try {
      await generateObject<TestShape>({
        model: SONNET,
        schema: TestSchema,
        prompt: 'pick a name',
        callSite: 'test/loop-repair-non-error',
        stageBudgetMs: 600_000,
        repairStrategy: 'sonnet',
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('[object Object]')
    // The wrapped error carries no connectivity shape — it classifies with a
    // null transport context and the loop does not retry.
    expect((caught as { llmFailureClass?: string }).llmFailureClass).toBe('other')
    expect(mockStreamText).toHaveBeenCalledOnce()
  })
})

describe('boundary classification on non-loop surfaces', () => {
  beforeEach(() => {
    mockGenerateText.mockReset()
    mockStreamObject.mockReset()
    mockStreamText.mockReset()
    vi.restoreAllMocks()
    setLlmHealthSink(null)
  })

  afterEach(() => {
    setLlmHealthSink(null)
  })

  it('streamObject: a connectivity stream failure classifies, attaches the class, and reports', async () => {
    const sink = vi.fn()
    setLlmHealthSink(sink)
    const connErr = Object.assign(new Error('stream died'), { code: 'ECONNRESET' })
    async function* gen(): AsyncGenerator<TestShape> {
      yield { name: 'partial' }
    }
    const objectPromise = Promise.reject(connErr)
    void objectPromise.catch(() => undefined)
    mockStreamObject.mockReturnValueOnce({
      partialObjectStream: gen(),
      object: objectPromise,
      usage: Promise.resolve(makeUsage()),
      warnings: Promise.resolve(undefined),
    } as unknown as ReturnType<typeof ai.streamObject>)

    const result = streamObject<TestShape>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'name something',
      callSite: 'test/stream-classifies',
    })

    let caught: unknown
    try {
      await result.object
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(connErr)
    expect((caught as { llmFailureClass?: string }).llmFailureClass).toBe('connectivity')
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      callsite: 'test/stream-classifies',
      failureClass: 'connectivity',
    })
  })

  it('generateText: a connectivity failure classifies, attaches the class, and reports', async () => {
    const sink = vi.fn()
    setLlmHealthSink(sink)
    const connErr = Object.assign(new Error('conn died'), { code: 'ECONNREFUSED' })
    mockGenerateText.mockRejectedValueOnce(connErr)

    let caught: unknown
    try {
      await wrapperGenerateText({
        model: SONNET,
        prompt: 'p',
        callSite: 'test/generate-text-classifies',
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(connErr)
    expect((caught as { llmFailureClass?: string }).llmFailureClass).toBe('connectivity')
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      callsite: 'test/generate-text-classifies',
      failureClass: 'connectivity',
    })
  })
})

describe('extractStage', () => {
  it('accepts session_prep without falling back', () => {
    expect(extractStage({ mythrun: { stage: 'session_prep' } })).toBe('session_prep')
  })

  it('accepts entity_consolidation without falling back', () => {
    expect(extractStage({ mythrun: { stage: 'entity_consolidation' } })).toBe(
      'entity_consolidation',
    )
  })

  // MYT-71 T10 lockstep: VALID_STAGES must include 'embed_world' so it
  // round-trips instead of falling back to the concept_intake sentinel.
  it('accepts embed_world without falling back', () => {
    expect(extractStage({ mythrun: { stage: 'embed_world' } })).toBe('embed_world')
  })

  it('falls back to concept_intake on an unrecognized stage', () => {
    expect(extractStage({ mythrun: { stage: 'not_a_stage' } })).toBe('concept_intake')
  })
})
